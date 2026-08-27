// SSE イベント → 承認 / Stop / 画像 / 既決更新 への振り分け(plan §5.4/§5.5)。
// notification-added / notification-updated 以外のイベント(session-activity 等)は無視する。
import type { HubClient } from '../hub/client'
import type { SseEvent } from '../hub/sse'
import type { NotificationListItem } from '../hub/types'
import type { Logger } from '../logger'
import { errorMessage } from '../logger'
import type { ApprovalFlow } from './approval-flow'
import type { NotifyFlow } from './notify-flow'

export interface RouterOptions {
  hub: HubClient
  approvalFlow: ApprovalFlow
  notifyFlow: NotifyFlow
  logger: Logger
}

export class Router {
  private readonly hub: HubClient
  private readonly approvalFlow: ApprovalFlow
  private readonly notifyFlow: NotifyFlow
  private readonly logger: Logger

  constructor(options: RouterOptions) {
    this.hub = options.hub
    this.approvalFlow = options.approvalFlow
    this.notifyFlow = options.notifyFlow
    this.logger = options.logger
  }

  handleSseEvent(event: SseEvent): void {
    if (event.event === 'notification-added') {
      void this.onAdded(event.data).catch((err) =>
        this.logger.warn(`notification-added handling failed: ${errorMessage(err)}`),
      )
    } else if (event.event === 'notification-updated') {
      void this.onUpdated(event.data).catch((err) =>
        this.logger.warn(`notification-updated handling failed: ${errorMessage(err)}`),
      )
    }
    // それ以外(session-activity / g2-display 等)は無視
  }

  private parseItem(data: string): NotificationListItem | null {
    try {
      const parsed: unknown = JSON.parse(data)
      if (parsed && typeof parsed === 'object' && typeof (parsed as { id?: unknown }).id === 'string') {
        return parsed as NotificationListItem
      }
    } catch {
      // fallthrough
    }
    this.logger.warn(`SSE data parse failed: ${data.slice(0, 200)}`)
    return null
  }

  private async onAdded(data: string): Promise<void> {
    const item = this.parseItem(data)
    if (!item) return
    const approvalId = item.metadata?.approvalId
    if (typeof approvalId === 'string' && approvalId) {
      let approval
      try {
        approval = await this.hub.getApproval(approvalId)
      } catch (err) {
        // 取得失敗は reconciliation がバックストップとして拾う
        this.logger.warn(`approval fetch failed for ${approvalId}: ${errorMessage(err)}`)
        return
      }
      if (approval?.status === 'pending') await this.approvalFlow.handleNewApproval(approval)
      return
    }
    await this.notifyFlow.handleNotification(item)
  }

  private async onUpdated(data: string): Promise<void> {
    const item = this.parseItem(data)
    if (!item) return
    const approvalId = item.metadata?.approvalId
    if (typeof approvalId === 'string' && approvalId) {
      await this.approvalFlow.handleApprovalUpdate(approvalId)
    }
  }
}
