// ピン留めステータスメッセージの維持。
// Hub の /api/context-status と /api/session-activity を定期取得し、チャットの
// ステータスメッセージ 1 件を editMessageText で更新し続ける。edit はプッシュ通知
// されないため、通知ノイズなしで G2 ミニアプリに ctx% / セッション状態が届く。
import type { HubClient } from '../hub/client'
import type { Logger } from '../logger'
import { errorMessage } from '../logger'
import type { StateStore } from './state'
import type { TelegramSender } from '../telegram/sender'
import { buildStatusPayload, formatStatusMessage } from '../telegram/format'

export interface StatusFlowDeps {
  hub: Pick<HubClient, 'getContextStatus' | 'getSessionActivity'>
  sender: Pick<TelegramSender, 'sendMessage' | 'editMessageText' | 'pinChatMessage'>
  state: Pick<StateStore, 'getStatusMessage' | 'setStatusMessage'>
  chatId: number
  intervalMs: number
  logger: Logger
}

/**
 * 内容不変時に edit をスキップできる上限。ミニアプリは ts が 5 分(STATUS_STALE_SEC=300)
 * より古いペイロードを stale として捨てるため、それより十分短い間隔で ts だけでも
 * 更新し続ける(でないとアイドル時にこそ ctx% が消える)。
 */
export const STATUS_HEARTBEAT_MS = 120_000

export class StatusFlow {
  private timer: NodeJS.Timeout | null = null
  private lastText: string | null = null
  private lastEditAtMs = 0
  private running = false

  constructor(private readonly deps: StatusFlowDeps) {}

  start(): void {
    if (this.deps.intervalMs <= 0 || this.timer) return
    this.timer = setInterval(() => void this.runOnce(), this.deps.intervalMs)
    this.timer.unref?.()
    void this.runOnce()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 1 回分の更新。実行が重なった場合は後発をスキップ(edit は冪等なので取りこぼし無害) */
  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.update()
    } catch (err) {
      this.deps.logger.warn(`status flow: 更新失敗: ${errorMessage(err)}`)
    } finally {
      this.running = false
    }
  }

  private async update(): Promise<void> {
    const { hub, sender, state, chatId, logger } = this.deps
    // 片方の失敗は null(=前回値の維持をミニアプリに指示)で続行(Hub 再起動タイミング等)。
    // 空配列 [] は「取得できて 0 件」の意味で、ミニアプリは表示をクリアする(区別が重要)
    const [ctxResult, activityResult] = await Promise.allSettled([
      hub.getContextStatus(),
      hub.getSessionActivity(),
    ])
    if (ctxResult.status === 'rejected' && activityResult.status === 'rejected') {
      logger.debug(`status flow: hub 未到達のためスキップ: ${errorMessage(ctxResult.reason)}`)
      return
    }
    const payload = buildStatusPayload(
      ctxResult.status === 'fulfilled' ? ctxResult.value : null,
      activityResult.status === 'fulfilled' ? activityResult.value : null,
      new Date(),
    )
    const text = formatStatusMessage(payload)
    // ts 以外に変化がなければ edit を省く(Bot API の編集レート消費を抑える)。ただし
    // ミニアプリの stale 判定(ts 基準)を生かすため STATUS_HEARTBEAT_MS ごとに必ず edit する
    const heartbeatDue = Date.now() - this.lastEditAtMs >= STATUS_HEARTBEAT_MS
    if (!heartbeatDue && this.lastText != null && stripTimestamp(this.lastText) === stripTimestamp(text)) {
      return
    }

    const existing = state.getStatusMessage()
    if (existing && existing.chatId === chatId) {
      try {
        await sender.editMessageText(chatId, existing.messageId, text)
        this.lastText = text
        this.lastEditAtMs = Date.now()
        return
      } catch (err) {
        const msg = errorMessage(err)
        // 同一内容(is not modified)は成功扱い
        if (/is not modified/i.test(msg)) {
          this.lastText = text
          this.lastEditAtMs = Date.now()
          return
        }
        // メッセージ消失系のみ再投稿へフォールバック。429/タイムアウト等の一過性エラーで
        // 再投稿すると重複ステータスが溜まるため、それ以外は次周期の edit 再試行に任せる
        if (/message to edit not found|MESSAGE_ID_INVALID/i.test(msg)) {
          logger.warn(`status flow: ステータスメッセージ消失 — 再投稿します: ${msg}`)
          state.setStatusMessage(undefined)
        } else {
          logger.warn(`status flow: edit 失敗(次周期に再試行): ${msg}`)
          return
        }
      }
    }

    const { messageId } = await sender.sendMessage(chatId, text, { disableNotification: true })
    state.setStatusMessage({ chatId, messageId })
    this.lastText = text
    this.lastEditAtMs = Date.now()
    // pin は G2 ミニアプリの初期取得(履歴 50 件圏外への脱落対策)に必要。失敗しても致命ではない
    try {
      await sender.pinChatMessage(chatId, messageId)
    } catch (err) {
      logger.warn(`status flow: pin 失敗(継続します): ${errorMessage(err)}`)
    }
    logger.info(`status flow: ステータスメッセージを投稿 (message_id=${messageId})`)
  }
}

/** ペイロード中の ts と表示時刻を除いた比較用テキスト */
function stripTimestamp(text: string): string {
  return text.replace(/"ts":\d+/, '"ts":0').replace(/\(\d{2}:\d{2}\)/, '(--:--)')
}
