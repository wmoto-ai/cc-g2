// Stop 通知の転送・返信中継と画像通知の sendPhoto(plan §5.5)。
// 既読管理(seenNotificationIds)で SSE 重複・再配信を冪等化する。
import type { HubClient } from '../hub/client'
import type { NotificationListItem } from '../hub/types'
import type { Logger } from '../logger'
import { errorMessage } from '../logger'
import {
  escapeHtml,
  formatGenericMessage,
  formatImageCaption,
  formatStopMessage,
} from '../telegram/format'
import type { TelegramSender } from '../telegram/sender'
import type { StateStore } from './state'
import { normalizeOneLine, type StopReplyRelay } from './stop-reply'

export interface NotifyFlowOptions {
  hub: HubClient
  sender: TelegramSender
  state: StateStore
  stopReply: StopReplyRelay
  chatId: number
  logger: Logger
}

export class NotifyFlow {
  private readonly hub: HubClient
  private readonly sender: TelegramSender
  private readonly state: StateStore
  private readonly stopReply: StopReplyRelay
  private readonly chatId: number
  private readonly logger: Logger

  constructor(options: NotifyFlowOptions) {
    this.hub = options.hub
    this.sender = options.sender
    this.state = options.state
    this.stopReply = options.stopReply
    this.chatId = options.chatId
    this.logger = options.logger
  }

  /** 承認以外の notification-added の振り分け(Stop / 画像 / それ以外は汎用転送) */
  async handleNotification(item: NotificationListItem): Promise<void> {
    if (this.state.hasSeen(item.id)) return
    this.state.markSeen(item.id)
    const metadata = item.metadata ?? {}
    if (metadata.hookType === 'stop') {
      await this.handleStop(item)
      return
    }
    if (typeof metadata.imageId === 'string' && metadata.imageId) {
      await this.handleImage(item, metadata.imageId)
      return
    }
    if (metadata.hookType === 'permission-request') {
      // 承認は approval イベント側のフローが inline keyboard 付きで扱う(二重投稿防止)
      this.logger.debug(`notification ${item.id} ignored (permission-request)`)
      return
    }
    await this.handleGeneric(item)
  }

  private async handleStop(item: NotificationListItem): Promise<void> {
    let body = item.summary
    try {
      const detail = await this.hub.getNotification(item.id)
      if (detail?.fullText) body = detail.fullText
    } catch (err) {
      this.logger.warn(`stop detail fetch failed for ${item.id}: ${errorMessage(err)}`)
    }
    const metadata = item.metadata ?? {}
    const text = formatStopMessage({
      title: item.title,
      body,
      cwd: metadata.cwd,
      sessionLabel: metadata.sessionLabel,
      tmuxTarget: metadata.tmuxTarget,
    })
    const { messageId } = await this.sender.sendMessage(this.chatId, text)
    this.state.addStopMessage(this.chatId, messageId, item.id)
    this.logger.info(`stop notification ${item.id} posted (msg=${messageId})`)
  }

  /** Stop/画像/承認以外の汎用通知(brew-security-check 等の運用通知)をそのまま転送する */
  private async handleGeneric(item: NotificationListItem): Promise<void> {
    let body = item.summary
    try {
      const detail = await this.hub.getNotification(item.id)
      if (detail?.fullText) body = detail.fullText
    } catch (err) {
      this.logger.warn(`generic detail fetch failed for ${item.id}: ${errorMessage(err)}`)
    }
    const metadata = item.metadata ?? {}
    const text = formatGenericMessage({
      title: item.title,
      body,
      source: typeof metadata.source === 'string' ? metadata.source : undefined,
    })
    const { messageId } = await this.sender.sendMessage(this.chatId, text)
    this.logger.info(`generic notification ${item.id} posted (msg=${messageId})`)
  }

  private async handleImage(item: NotificationListItem, imageId: string): Promise<void> {
    let image: { data: Buffer; contentType: string } | null = null
    try {
      image = await this.hub.fetchImage(imageId)
    } catch (err) {
      this.logger.warn(`image fetch failed for ${imageId}: ${errorMessage(err)}`)
    }
    if (!image) {
      await this.sender.sendMessage(
        this.chatId,
        `🖼 ${escapeHtml(item.title)}(画像の取得に失敗、または削除済み)`,
      )
      return
    }
    const filename = image.contentType === 'image/jpeg' ? 'image.jpg' : 'image.png'
    const metadata = item.metadata ?? {}
    await this.sender.sendPhoto(
      this.chatId,
      { data: image.data, filename },
      formatImageCaption({
        title: item.title,
        cwd: metadata.cwd,
        sessionLabel: metadata.sessionLabel,
      }),
    )
    this.logger.info(`image notification ${item.id} sent (${image.data.length} bytes)`)
  }

  /**
   * Stop 通知メッセージへの返信を Hub reply に中継する。
   * 該当メッセージでない・TTL 超過なら false(呼び出し側が「返信先不明」を案内)。
   */
  async handleStopReply(
    chatId: number,
    repliedMessageId: number,
    text: string,
    notify: (html: string) => Promise<void>,
  ): Promise<boolean> {
    const notificationId = this.stopReply.resolve(chatId, repliedMessageId)
    if (!notificationId) return false
    const normalized = normalizeOneLine(text)
    if (!normalized) return true
    await this.stopReply.relay(notificationId, normalized, notify)
    return true
  }
}
