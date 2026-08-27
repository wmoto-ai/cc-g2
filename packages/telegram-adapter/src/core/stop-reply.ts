// Stop 通知メッセージへの返信をセッションへ中継する共通経路。
// stopMessages 逆引き + TTL 検証 + hub.reply + 中継結果に応じた応答通知を一元化し、
// テキスト返信(notify-flow)と受信画像(media-flow)の両方から使う。
import type { HubClient } from '../hub/client'
import type { Logger } from '../logger'
import { errorMessage } from '../logger'
import { escapeHtml } from '../telegram/format'
import type { StateStore } from './state'

/** reply-relay(tmux send-keys)の複数行挙動が未検証のため 1 行に正規化する(plan §8) */
export function normalizeOneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim()
}

export interface StopReplyRelayOptions {
  hub: HubClient
  state: StateStore
  /** 逆引きの有効期限。超過した Stop 通知への返信は「追跡外」として扱う */
  ttlMs: number
  logger: Logger
}

export interface RelayMessageOptions {
  /** forwarded 時のメッセージ(既定「✅ セッションに送信しました」) */
  forwardedHtml?: string
  /** 全応答の末尾に付ける追記(保存済み画像パス等) */
  noteHtml?: string
}

export class StopReplyRelay {
  private readonly hub: HubClient
  private readonly state: StateStore
  private readonly ttlMs: number
  private readonly logger: Logger

  constructor(options: StopReplyRelayOptions) {
    this.hub = options.hub
    this.state = options.state
    this.ttlMs = options.ttlMs
    this.logger = options.logger
  }

  /**
   * 返信先メッセージが追跡中かつ TTL 内の Stop 通知なら notificationId を返す。
   * 注入先セッションが既に消えている可能性が高い古いエントリは fail-closed で追跡外扱い。
   */
  resolve(chatId: number, repliedMessageId: number, nowMs = Date.now()): string | null {
    const entry = this.state.getStopMessage(chatId, repliedMessageId)
    if (!entry) return null
    const postedMs = Date.parse(entry.postedAt)
    if (!Number.isFinite(postedMs) || nowMs - postedMs > this.ttlMs) {
      this.logger.debug(
        `stop reply expired (posted=${entry.postedAt}, ttl=${this.ttlMs}ms) for ${entry.notificationId}`,
      )
      return null
    }
    return entry.notificationId
  }

  /** Hub reply に中継し、結果(forwarded / stubbed / failed / 例外)を notify で報告する */
  async relay(
    notificationId: string,
    text: string,
    notify: (html: string) => Promise<void>,
    options: RelayMessageOptions = {},
  ): Promise<void> {
    const note = options.noteHtml ? `\n${options.noteHtml}` : ''
    let reply
    try {
      reply = await this.hub.reply(notificationId, text)
    } catch (err) {
      this.logger.warn(`reply failed for ${notificationId}: ${errorMessage(err)}`)
      await notify(`⚠️ Hub への返信送信に失敗しました。もう一度返信してください${note}`)
      return
    }
    if (reply.status === 'forwarded') {
      await notify(`${options.forwardedHtml ?? '✅ セッションに送信しました'}${note}`)
    } else if (reply.status === 'stubbed') {
      await notify(
        '⚠️ Hub の relay 設定で中継されませんでした' +
          `(HUB_REPLY_RELAY_CMD / HUB_REPLY_RELAY_SOURCES に telegram が必要)${note}`,
      )
    } else {
      await notify(`⚠️ 中継失敗: ${escapeHtml(reply.error ?? 'unknown')}${note}`)
    }
  }
}
