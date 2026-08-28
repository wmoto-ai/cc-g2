// Telegram から受信したファイル(photo / voice / audio / 対応 MIME の document)を inbox に
// 保存し、Stop 通知への返信であれば保存パスを reply relay 経由でそのセッションへ注入する。
// v1 のルーティングは StopReplyRelay(notify-flow のテキスト返信と共通)への相乗りのみで、
// reply_to なしのファイルは保存せず使い方の案内だけを返す。
// ダウンロードの検証(サイズ上限・実データの形式検証・timeout)は MediaDownloader に委譲する。
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../logger'
import { escapeHtml } from '../telegram/format'
import {
  formatByExtension,
  formatFromMime,
  type FormatSpec,
  type MediaCategory,
  type MediaDownloader,
} from '../telegram/media-downloader'
import { normalizeOneLine, type StopReplyRelay } from './stop-reply'

const SUPPORTED_FORMATS_NOTE =
  '画像(JPEG / PNG / GIF / WebP)・PDF・テキスト(txt / md / csv)・音声(mp3 / m4a / wav / ogg)・動画(mp4 / mov / webm)'

const USAGE_GUIDE =
  '📥 ファイルを受け取りましたが、送り先のセッションが分かりません。' +
  'Stop 通知(🏁)への<b>返信</b>としてファイルを送ると、保存したファイルのローカルパスがそのセッションに送信されます。\n' +
  `<i>対応形式: ${SUPPORTED_FORMATS_NOTE}。` +
  'Telegram の写真送信は再圧縮されます。原本が必要な場合は「ファイルとして送信 (Send as File)」を使ってください。</i>'

/** 注入テキストと応答通知に使う種類名 */
const CATEGORY_LABEL: Record<MediaCategory, string> = {
  image: '画像',
  pdf: 'PDF',
  text: 'テキスト',
  audio: '音声',
  video: '動画',
}

/** エージェントが Read できないカテゴリには、注入テキストに扱い方の一言を添える */
const UNREADABLE_NOTES: Partial<Record<MediaCategory, string>> = {
  audio: '(音声ファイルは Read では読めません。文字起こし・分析には利用可能なツールやスキルを使ってください)',
  video: '(動画ファイルは Read では読めません。文字起こし・分析には利用可能なツールやスキルを使ってください)',
}

export interface IncomingMedia {
  kind: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note'
  fileId: string
  fileUniqueId: string
  /** Telegram が申告するサイズ(検証は MediaDownloader が実バイト数まで行う) */
  fileSize?: number
  /** document / voice / audio の申告 MIME */
  mimeType?: string
  /** document / audio のファイル名。信用せず、text/plain の保存拡張子の補助にのみ使う */
  fileName?: string
  caption?: string
}

export interface MediaFlowOptions {
  stopReply: StopReplyRelay
  downloader: MediaDownloader
  inboxDir: string
  logger: Logger
}

export class MediaFlow {
  private readonly stopReply: StopReplyRelay
  private readonly downloader: MediaDownloader
  private readonly inboxDir: string
  private readonly logger: Logger

  constructor(options: MediaFlowOptions) {
    this.stopReply = options.stopReply
    this.downloader = options.downloader
    this.inboxDir = options.inboxDir
    this.logger = options.logger
  }

  async handleIncomingMedia(input: {
    chatId: number
    repliedMessageId?: number
    media: IncomingMedia
    notify: (html: string) => Promise<void>
  }): Promise<void> {
    const { chatId, repliedMessageId, media, notify } = input

    // ルーティング先が確定するまでダウンロードしない(帯域と inbox の浪費を避ける)
    if (repliedMessageId === undefined) {
      await notify(USAGE_GUIDE)
      return
    }
    const notificationId = this.stopReply.resolve(chatId, repliedMessageId)
    if (!notificationId) {
      await notify(
        '返信先を特定できませんでした(追跡外・期限切れの古いメッセージの可能性)。\n' + USAGE_GUIDE,
      )
      return
    }

    const expected = resolveExpectedFormat(media)
    if (!expected) {
      await notify(
        `対応していないファイル形式です(${escapeHtml(media.mimeType ?? 'unknown')})。` +
          `${SUPPORTED_FORMATS_NOTE}のみ受け付けます`,
      )
      return
    }
    const label = CATEGORY_LABEL[expected.category]

    const result = await this.downloader.downloadMedia({
      fileId: media.fileId,
      expected,
      declaredSize: media.fileSize,
    })
    if (!result.ok) {
      if (result.reason === 'too-large') {
        const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1)
        await notify(
          `⚠️ ファイルが大きすぎます(${result.size !== undefined ? `${mb(result.size)}MB > ` : ''}上限 ${mb(result.limit)}MB)。縮小して送信してください`,
        )
      } else if (result.reason === 'type-mismatch') {
        this.logger.warn(
          `media type mismatch (${media.kind} ${media.fileUniqueId}): declared=${expected.extension} detected=${result.detected ?? 'unknown'}`,
        )
        await notify(
          `⚠️ ${label}として検証できませんでした(申告された形式と実データが一致しません)`,
        )
      } else {
        this.logger.warn(`media download failed (${media.kind} ${media.fileUniqueId}): ${result.detail}`)
        await notify('⚠️ ファイルの取得に失敗しました。もう一度送信してください')
      }
      return
    }

    const savedPath = await this.saveToInbox(media.fileUniqueId, result.format.extension, result.bytes)
    this.logger.info(`inbox saved ${savedPath} (${result.bytes.length} bytes)`)

    const caption = normalizeOneLine(media.caption ?? '')
    const relayText =
      `${label}を受信: ${savedPath}` +
      (caption ? `（キャプション: ${caption}）` : '') +
      (UNREADABLE_NOTES[expected.category] ?? '')
    await this.stopReply.relay(notificationId, relayText, notify, {
      forwardedHtml: `✅ ${label}を保存し、パスをセッションに送信しました`,
      noteHtml: `<code>${escapeHtml(savedPath)}</code>`,
    })
  }

  private async saveToInbox(fileUniqueId: string, extension: string, bytes: Buffer): Promise<string> {
    // file_unique_id はファイル毎に安定な id。パス部品に使うため英数以外を落とす
    const safeId = fileUniqueId.replace(/[^A-Za-z0-9_-]/g, '') || 'file'
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
    const filePath = path.resolve(this.inboxDir, `${stamp}-${safeId}.${extension}`)
    // 受信物は本人限定で保存する(dir 0700 / file 0600)
    await mkdir(this.inboxDir, { recursive: true, mode: 0o700 })
    await writeFile(filePath, bytes, { mode: 0o600 })
    return filePath
  }
}

/**
 * 期待形式の決定。photo は Bot API 上 JPEG 固定、voice は OGG/Opus 固定、
 * video_note は MP4 固定。document は申告 MIME から(対応外は null)、
 * audio / video は各カテゴリの MIME のみ許可。実データとの一致は MediaDownloader が検証する。
 * file_name は検証には使わず、text/plain(内容検証が拡張子に依存しない)の
 * 保存拡張子を .md / .csv に寄せる補助にのみ使う。
 */
function resolveExpectedFormat(media: IncomingMedia): FormatSpec | null {
  if (media.kind === 'photo') return formatByExtension('jpg')!
  if (media.kind === 'voice') return formatByExtension('ogg')!
  if (media.kind === 'video_note') return formatByExtension('mp4')!
  const format = formatFromMime(media.mimeType)
  if (!format) return null
  if (media.kind === 'audio' && format.category !== 'audio') return null
  if (media.kind === 'video' && format.category !== 'video') return null
  if (format.extension === 'txt') {
    const name = (media.fileName ?? '').toLowerCase()
    if (name.endsWith('.md')) return formatByExtension('md')!
    if (name.endsWith('.csv')) return formatByExtension('csv')!
  }
  return format
}
