// Telegram からのファイル取得(getFile → download)を安全側の検証ごと閉じ込める層。
// - サイズ上限: 申告値(update / getFile)で事前拒否 + stream 読みで実バイト数を制限
//   (超過が確定した時点で読み込みを中断し、全量を Buffer 化しない)
// - 形式検証: 送信者申告の MIME / file_name は信用せず、FormatSpec registry の
//   detect(形式ごとの実データ判定)で検証する
// - タイムアウト: ダウンロードに AbortSignal.timeout を適用
import type { Api } from 'grammy'
import { errorMessage } from '../logger'

export type MediaCategory = 'image' | 'pdf' | 'text' | 'audio' | 'video'

/** 対応形式 1 件の定義。detect は「実データがこの形式として妥当か」の判定 */
export interface FormatSpec {
  extension: string
  category: MediaCategory
  /** この形式を期待させる申告 MIME(パラメータ除去・小文字化済みで突合) */
  mimes: readonly string[]
  detect(bytes: Uint8Array): boolean
}

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false
  return magic.every((byte, i) => bytes[offset + i] === byte)
}

const isJpeg = (b: Uint8Array): boolean => startsWith(b, [0xff, 0xd8, 0xff])
const isPng = (b: Uint8Array): boolean =>
  startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// GIF87a / GIF89a
const isGif = (b: Uint8Array): boolean =>
  startsWith(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
// RIFF コンテナは offset 8 の識別子で WebP(WEBP)と WAV(WAVE)を区別する
const isWebp = (b: Uint8Array): boolean =>
  startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)
const isWav = (b: Uint8Array): boolean =>
  startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x41, 0x56, 0x45], 8)
const isPdf = (b: Uint8Array): boolean => startsWith(b, [0x25, 0x50, 0x44, 0x46]) // %PDF
const isOgg = (b: Uint8Array): boolean => startsWith(b, [0x4f, 0x67, 0x67, 0x53]) // OggS

/**
 * MP3: ID3 タグ、または MPEG audio frame header の妥当性(sync 11bit だけでは 0xff で始まる
 * 任意バイナリを通すため、version/layer/bitrate/sampling frequency の reserved 値を拒否する)
 */
function isMp3(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return true // ID3
  if (bytes.length < 3) return false
  if (bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return false // frame sync
  if (((bytes[1]! >> 3) & 0x03) === 0x01) return false // version 01 = reserved
  if (((bytes[1]! >> 1) & 0x03) === 0x00) return false // layer 00 = reserved
  if (bytes[2]! >> 4 === 0x0f) return false // bitrate index 1111 = bad
  if (((bytes[2]! >> 2) & 0x03) === 0x03) return false // sampling frequency 11 = reserved
  return true
}

function brandAt(bytes: Uint8Array, offset: number): string | null {
  if (bytes.length < offset + 4) return null
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

/** ISO-BMFF の ftyp box から major + compatible brands を列挙する(ftyp でなければ null) */
function ftypBrands(bytes: Uint8Array): string[] | null {
  if (!startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return null // ....ftyp
  const brands: string[] = []
  const major = brandAt(bytes, 8)
  if (major) brands.push(major)
  const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : bytes.length)
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const brand = brandAt(bytes, offset)
    if (brand) brands.push(brand)
  }
  return brands
}

// ISO-BMFF(ftyp)ファミリの brand 判定。M4A 系 brand を含むものは常に音声(m4a)側に倒し、
// isMp4 / isMov とは相互排他にする(offset4==ftyp だけでは MP4/AVIF/HEIC 等も通ってしまう)
const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P '])
const MP4_VIDEO_BRANDS = new Set([
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'mp4v', 'M4V ',
])

function isM4a(bytes: Uint8Array): boolean {
  const brands = ftypBrands(bytes)
  return brands !== null && brands.some((brand) => M4A_BRANDS.has(brand))
}

function isMp4(bytes: Uint8Array): boolean {
  const brands = ftypBrands(bytes)
  if (!brands || brands.some((brand) => M4A_BRANDS.has(brand))) return false
  return brands.some((brand) => MP4_VIDEO_BRANDS.has(brand))
}

/** QuickTime(.mov)。brand 'qt  '(MP4_VIDEO_BRANDS とは別扱い) */
function isMov(bytes: Uint8Array): boolean {
  const brands = ftypBrands(bytes)
  if (!brands || brands.some((brand) => M4A_BRANDS.has(brand))) return false
  return brands.includes('qt  ')
}

// EBML magic。Matroska(.mkv)も同じ magic を持つが、DocType までは検査せず video として扱う
const isWebm = (b: Uint8Array): boolean => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])

/**
 * テキストのバイナリ偽装チェック:
 * 全体に NUL バイトが無く、既知バイナリ形式の magic で始まらず、UTF-8 としてデコード可能
 */
export function isPlausibleText(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) return false
  }
  if (detectBinaryFormat(bytes) !== null) return false // %PDF 等の text/* 申告偽装
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * 対応形式 registry。detectBinaryFormat は上から順に判定するため、
 * 判定の緩い mp3(frame sync)は末尾に置く。
 */
export const FORMATS: readonly FormatSpec[] = [
  { extension: 'jpg', category: 'image', mimes: ['image/jpeg'], detect: isJpeg },
  { extension: 'png', category: 'image', mimes: ['image/png'], detect: isPng },
  { extension: 'gif', category: 'image', mimes: ['image/gif'], detect: isGif },
  { extension: 'webp', category: 'image', mimes: ['image/webp'], detect: isWebp },
  { extension: 'pdf', category: 'pdf', mimes: ['application/pdf'], detect: isPdf },
  { extension: 'txt', category: 'text', mimes: ['text/plain'], detect: isPlausibleText },
  { extension: 'md', category: 'text', mimes: ['text/markdown'], detect: isPlausibleText },
  { extension: 'csv', category: 'text', mimes: ['text/csv'], detect: isPlausibleText },
  { extension: 'wav', category: 'audio', mimes: ['audio/wav', 'audio/x-wav'], detect: isWav },
  { extension: 'ogg', category: 'audio', mimes: ['audio/ogg'], detect: isOgg },
  { extension: 'm4a', category: 'audio', mimes: ['audio/mp4', 'audio/x-m4a'], detect: isM4a },
  { extension: 'webm', category: 'video', mimes: ['video/webm'], detect: isWebm },
  { extension: 'mov', category: 'video', mimes: ['video/quicktime'], detect: isMov },
  { extension: 'mp4', category: 'video', mimes: ['video/mp4'], detect: isMp4 },
  { extension: 'mp3', category: 'audio', mimes: ['audio/mpeg', 'audio/mp3'], detect: isMp3 },
]

export function formatFromMime(mimeType: string | undefined): FormatSpec | undefined {
  const key = (mimeType ?? '').split(';')[0]!.trim().toLowerCase()
  if (!key) return undefined
  return FORMATS.find((spec) => spec.mimes.includes(key))
}

export function formatByExtension(extension: string): FormatSpec | undefined {
  return FORMATS.find((spec) => spec.extension === extension)
}

/** magic bytes から形式(拡張子)を判定する。テキストは magic を持たないため対象外(null) */
export function detectBinaryFormat(bytes: Uint8Array): string | null {
  for (const spec of FORMATS) {
    if (spec.category !== 'text' && spec.detect(bytes)) return spec.extension
  }
  return null
}

export type DownloadMediaResult =
  | { ok: true; bytes: Buffer; format: FormatSpec }
  | { ok: false; reason: 'too-large'; size?: number; limit: number }
  /** 実データが期待形式(申告 MIME / photo=JPEG / voice=OGG)として検証できない */
  | { ok: false; reason: 'type-mismatch'; detected: string | null }
  | { ok: false; reason: 'failed'; detail: string }

export interface MediaDownloader {
  downloadMedia(input: {
    fileId: string
    expected: FormatSpec
    /** update に載っていた申告サイズ(あれば getFile 前に事前拒否する) */
    declaredSize?: number
  }): Promise<DownloadMediaResult>
}

export interface TelegramDownloaderOptions {
  /** ダウンロード URL(https://api.telegram.org/file/bot<token>/<file_path>)の組み立てに必要 */
  token: string
  maxBytes: number
  apiRoot?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

const DOWNLOAD_TIMEOUT_MS = 30_000

export function createTelegramDownloader(
  api: Api,
  options: TelegramDownloaderOptions,
): MediaDownloader {
  const apiRoot = (options.apiRoot ?? 'https://api.telegram.org').replace(/\/+$/, '')
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const { token, maxBytes } = options
  const tooLarge = (size?: number): DownloadMediaResult => ({
    ok: false,
    reason: 'too-large',
    size,
    limit: maxBytes,
  })

  return {
    async downloadMedia({ fileId, expected, declaredSize }) {
      if (declaredSize !== undefined && declaredSize > maxBytes) return tooLarge(declaredSize)

      let bytes: Buffer
      try {
        const file = await api.getFile(fileId)
        if (!file.file_path) return { ok: false, reason: 'failed', detail: 'getFile returned no file_path' }
        if (file.file_size !== undefined && file.file_size > maxBytes) return tooLarge(file.file_size)
        // URL に bot token が含まれるため、エラーメッセージには URL を載せない
        const res = await fetchFn(`${apiRoot}/file/bot${token}/${file.file_path}`, {
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) return { ok: false, reason: 'failed', detail: `download HTTP ${res.status}` }
        const read = await readBodyLimited(res, maxBytes)
        if (!read.ok) return tooLarge()
        bytes = read.bytes
      } catch (err) {
        return { ok: false, reason: 'failed', detail: errorMessage(err) }
      }
      if (bytes.length > maxBytes) return tooLarge(bytes.length)

      if (!expected.detect(bytes)) {
        return { ok: false, reason: 'type-mismatch', detected: detectBinaryFormat(bytes) }
      }
      return { ok: true, bytes, format: expected }
    },
  }
}

/** body を stream で読み、maxBytes 超過が確定した時点で中断する */
async function readBodyLimited(
  res: Response,
  maxBytes: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  if (!res.body) {
    // fetch 実装が stream を返さない場合のフォールバック(テストスタブ等)
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > maxBytes ? { ok: false } : { ok: true, bytes: buf }
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return { ok: false }
    }
    chunks.push(value)
  }
  return { ok: true, bytes: Buffer.concat(chunks) }
}
