// 起動時 / 定期 / SSE 再接続時の pending 突合(plan §5.3)。
// SSE に replay がないため、これが取りこぼしゼロの土台になる。
import type { Logger } from '../logger'
import { errorMessage } from '../logger'
import type { ApprovalFlow } from '../core/approval-flow'
import type { ApprovalEntry, StateStore } from '../core/state'
import type { HubClient } from './client'
import type { ApprovalRecord } from './types'

export interface ReconcileActions {
  /** 未投稿の pending(post cutoff 未満) */
  toPost: ApprovalRecord[]
  /** 投稿済みだが pending 一覧から消えた(別経路決着/自動クローズ)→ 終状態を反映 */
  toClose: string[]
  /** 投稿済みのまま stale 閾値を超えた(hook timeout 済みの「死んだ承認」)→ 期限切れ化 */
  toExpire: string[]
  /** 未投稿かつ post cutoff 超過 → 投稿しない(ログのみ) */
  skippedStale: ApprovalRecord[]
}

export function diffApprovals(
  pending: ApprovalRecord[],
  posted: Readonly<Record<string, ApprovalEntry>>,
  nowMs: number,
  thresholds: { postCutoffMs: number; staleMs: number },
): ReconcileActions {
  const actions: ReconcileActions = { toPost: [], toClose: [], toExpire: [], skippedStale: [] }
  const pendingIds = new Set<string>()
  for (const approval of pending) {
    pendingIds.add(approval.id)
    const createdMs = Date.parse(approval.createdAt)
    const ageMs = Number.isFinite(createdMs) ? nowMs - createdMs : 0
    const entry = posted[approval.id]
    if (!entry) {
      if (ageMs >= thresholds.postCutoffMs) actions.skippedStale.push(approval)
      else actions.toPost.push(approval)
    } else if (entry.status === 'posted' && ageMs >= thresholds.staleMs) {
      actions.toExpire.push(approval.id)
    }
  }
  for (const [approvalId, entry] of Object.entries(posted)) {
    if (entry.status === 'posted' && !pendingIds.has(approvalId)) {
      actions.toClose.push(approvalId)
    }
  }
  return actions
}

export interface ReconcilerOptions {
  hub: HubClient
  flow: ApprovalFlow
  state: StateStore
  intervalMs: number
  postCutoffMs: number
  staleMs: number
  logger: Logger
  now?: () => Date
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly now: () => Date

  constructor(private readonly options: ReconcilerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /**
   * 定期実行のみを開始する。初回実行は呼び出し側の責務:
   * main.ts は long-polling 開始前に runOnce() を await し(stale 承認の expire を
   * 反映してから queued callback を受ける)、SSE onConnect も接続ごとに runOnce() を叩く。
   */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.options.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 多重起動ガード付きの 1 周期。Hub 不通は warn のみで次周期に任せる */
  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const { hub, flow, state, logger } = this.options
      const pending = await hub.listPendingApprovals()
      const actions = diffApprovals(pending, state.getApprovals(), this.now().getTime(), {
        postCutoffMs: this.options.postCutoffMs,
        staleMs: this.options.staleMs,
      })
      if (actions.skippedStale.length > 0) {
        // 本番 Hub には hook タイムアウト後の pending が大量に残留しうる(実測 1,000 件超)。
        // 全 id を並べると毎周期数十 KB のログになるため件数 + 先頭数件に丸め、レベルも debug に
        const sample = actions.skippedStale.slice(0, 3).map((a) => a.id)
        logger.debug(
          `reconcile: ${actions.skippedStale.length} 件の stale pending を投稿対象外にした (ids=${sample.join(',')}${actions.skippedStale.length > sample.length ? ',…' : ''})`,
        )
      }
      for (const approval of actions.toPost) {
        try {
          await flow.handleNewApproval(approval)
        } catch (err) {
          logger.warn(`reconcile post failed for ${approval.id}: ${errorMessage(err)}`)
        }
      }
      for (const approvalId of actions.toClose) {
        try {
          await flow.handleApprovalUpdate(approvalId)
        } catch (err) {
          logger.warn(`reconcile close failed for ${approvalId}: ${errorMessage(err)}`)
        }
      }
      for (const approvalId of actions.toExpire) {
        try {
          await flow.expireApproval(approvalId)
        } catch (err) {
          logger.warn(`reconcile expire failed for ${approvalId}: ${errorMessage(err)}`)
        }
      }
      state.gc(this.now().getTime())
    } catch (err) {
      this.options.logger.warn(`reconciliation failed: ${errorMessage(err)}`)
    } finally {
      this.running = false
    }
  }
}
