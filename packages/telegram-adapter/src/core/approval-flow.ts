// 承認 1 件のライフサイクルを所有する中核フロー(plan §5.4)。
// approvalId 単位で処理を直列化し、SSE と reconciliation の同時着火による二重投稿を防ぐ。
// decide は自動リトライしない — 失敗はユーザーに提示して再タップさせる(二重送信より安全)。
import type { HubClient } from '../hub/client'
import type { ApprovalDecision, ApprovalRecord } from '../hub/types'
import type { Logger } from '../logger'
import { errorMessage } from '../logger'
import { approvalKeyboard } from '../telegram/callback-data'
import type { CommentPromptStore } from '../telegram/comment-prompt'
import {
  formatApprovalMessage,
  formatOutcomeFooter,
  outcomeFromApproval,
  type ClosedOutcome,
} from '../telegram/format'
import type { TelegramSender } from '../telegram/sender'
import type { ApprovalEntry, StateStore } from './state'

const COMMENT_MAX_CHARS = 1_000

/** preDecideGuard がクローズした理由をユーザー向け文言にする */
function guardClosedMessage(reason: 'expired' | 'decided' | 'not-found'): string {
  switch (reason) {
    case 'expired':
      return '⏰ 期限切れです — ターミナル側で対応してください'
    case 'decided':
      return '別経路で対応済みでした'
    case 'not-found':
      return 'Hub 上に見つかりませんでした'
  }
}

export interface ApprovalFlowOptions {
  hub: HubClient
  sender: TelegramSender
  state: StateStore
  prompts: CommentPromptStore
  chatId: number
  /** これより古い pending は新規投稿しない(境界レース対策で staleMs より短い値) */
  postCutoffMs: number
  /** hook タイムアウト境界。これより古い承認は decide しても CC に届かない「死んだ承認」 */
  staleMs: number
  /**
   * decide 操作の安全マージン。hook の decide 監視は 2 秒間隔ポーリングのため、
   * staleMs ちょうどまで decide を受け付けると「Hub は decided だが hook は観測前に
   * タイムアウト」の境界レースが残る。ガードは staleMs - このマージン で遮断する
   */
  decideMarginMs: number
  logger: Logger
  now?: () => Date
}

export class ApprovalFlow {
  private readonly hub: HubClient
  private readonly sender: TelegramSender
  private readonly state: StateStore
  private readonly prompts: CommentPromptStore
  private readonly chatId: number
  private readonly postCutoffMs: number
  private readonly staleMs: number
  private readonly decideMarginMs: number
  private readonly logger: Logger
  private readonly now: () => Date
  private readonly queues = new Map<string, Promise<void>>()

  constructor(options: ApprovalFlowOptions) {
    this.hub = options.hub
    this.sender = options.sender
    this.state = options.state
    this.prompts = options.prompts
    this.chatId = options.chatId
    this.postCutoffMs = options.postCutoffMs
    this.staleMs = options.staleMs
    this.decideMarginMs = options.decideMarginMs
    this.logger = options.logger
    this.now = options.now ?? (() => new Date())
  }

  /** approvalId 単位の直列化キュー */
  private enqueue<T>(approvalId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(approvalId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(approvalId, tail)
    void tail.then(() => {
      if (this.queues.get(approvalId) === tail) this.queues.delete(approvalId)
    })
    return run
  }

  /** pending 承認を Telegram に投稿する(SSE / reconciliation の両方から呼ばれる) */
  async handleNewApproval(approval: ApprovalRecord): Promise<void> {
    return this.enqueue(approval.id, async () => {
      if (this.state.getApproval(approval.id)) return
      const createdMs = Date.parse(approval.createdAt)
      const ageMs = Number.isFinite(createdMs) ? this.now().getTime() - createdMs : 0
      if (ageMs >= this.postCutoffMs) {
        this.logger.info(
          `approval ${approval.id} not posted (age ${Math.round(ageMs / 1000)}s >= post cutoff)`,
        )
        return
      }
      const { preview, sessionLabel } = await this.resolvePreview(approval)
      const text = formatApprovalMessage({
        toolName: approval.toolName,
        agentName: approval.agentName,
        cwd: approval.cwd,
        sessionLabel,
        preview,
      })
      // 送信成功後に state 記録(失敗時は未投稿のまま → reconciliation が再試行。plan §12)
      const { messageId } = await this.sender.sendMessage(this.chatId, text, {
        replyMarkup: approvalKeyboard(approval.id),
      })
      this.state.setApproval(approval.id, {
        messages: [{ chatId: this.chatId, messageId, text }],
        status: 'posted',
        postedAt: this.now().toISOString(),
      })
      this.logger.info(`approval ${approval.id} posted (tool=${approval.toolName} msg=${messageId})`)
    })
  }

  /** hook が整形済みの通知 fullText を優先し、取れなければ toolInput から最低限を自前整形 */
  private async resolvePreview(
    approval: ApprovalRecord,
  ): Promise<{ preview: string; sessionLabel?: string }> {
    try {
      const detail = await this.hub.getNotification(approval.notificationId)
      if (detail?.fullText) {
        return { preview: detail.fullText, sessionLabel: detail.metadata?.sessionLabel }
      }
    } catch (err) {
      this.logger.warn(
        `notification detail fetch failed for approval ${approval.id}: ${errorMessage(err)}`,
      )
    }
    const input = approval.toolInput as { command?: unknown; file_path?: unknown } | null
    if (typeof input?.command === 'string') return { preview: `$ ${input.command}` }
    if (typeof input?.file_path === 'string') return { preview: input.file_path }
    return { preview: JSON.stringify(approval.toolInput ?? {}) }
  }

  /**
   * decide 直前の鮮度確認(Codex 最終レビュー指摘)。
   * reconciliation の expire を待たずに stale 承認へ callback/comment が届くと
   * (再起動直後の queued update 等)、hook が 600s でタイムアウト済みのため
   * 「CC に届かないのに Hub 上だけ decided」になる。それを decide 前に必ず遮断する。
   * 既決/不在もここでクローズし、Hub 不通時は decide せずリトライを促す。
   */
  private async preDecideGuard(
    approvalId: string,
    entry: ApprovalEntry,
  ): Promise<
    | { verdict: 'fresh' }
    | { verdict: 'hub-error' }
    | { verdict: 'closed'; reason: 'expired' | 'decided' | 'not-found' }
  > {
    let approval: ApprovalRecord | null
    try {
      approval = await this.hub.getApproval(approvalId)
    } catch (err) {
      this.logger.warn(`pre-decide check failed for ${approvalId}: ${errorMessage(err)}`)
      return { verdict: 'hub-error' }
    }
    if (!approval) {
      await this.closeEntry(approvalId, entry, { kind: 'not-found' })
      return { verdict: 'closed', reason: 'not-found' }
    }
    if (approval.status === 'decided') {
      await this.closeEntry(approvalId, entry, outcomeFromApproval(approval))
      return { verdict: 'closed', reason: 'decided' }
    }
    const createdMs = Date.parse(approval.createdAt)
    const ageMs = Number.isFinite(createdMs) ? this.now().getTime() - createdMs : 0
    // staleMs ちょうどでの遮断では「599 秒台の decide が hook の次回ポーリング(2 秒間隔)前に
    // 600 秒タイムアウトに食われる」境界レースが残るため、マージンを引いた時点で遮断する
    const decideCutoffMs = this.staleMs - this.decideMarginMs
    if (ageMs >= decideCutoffMs) {
      this.logger.info(
        `approval ${approvalId} is stale (age ${Math.round(ageMs / 1000)}s >= decide cutoff ${Math.round(decideCutoffMs / 1000)}s); decide せず期限切れ化`,
      )
      await this.closeEntry(approvalId, entry, { kind: 'expired' })
      return { verdict: 'closed', reason: 'expired' }
    }
    return { verdict: 'fresh' }
  }

  /** Approve / Deny ボタンの callback 処理 */
  async handleCallback(input: {
    approvalId: string
    action: ApprovalDecision
    callbackQueryId: string
  }): Promise<void> {
    return this.enqueue(input.approvalId, async () => {
      const entry = this.state.getApproval(input.approvalId)
      if (!entry) {
        await this.answer(input.callbackQueryId, 'この承認は追跡されていません(期限切れの可能性)', true)
        return
      }
      if (entry.status === 'closed') {
        await this.answer(input.callbackQueryId, '既にクローズ済みです', true)
        return
      }
      const guard = await this.preDecideGuard(input.approvalId, entry)
      if (guard.verdict === 'hub-error') {
        await this.answer(
          input.callbackQueryId,
          '⚠️ Hub への確認に失敗しました。もう一度タップしてください',
          true,
        )
        return
      }
      if (guard.verdict === 'closed') {
        await this.answer(input.callbackQueryId, guardClosedMessage(guard.reason), true)
        return
      }
      let outcome
      try {
        outcome = await this.hub.decide(input.approvalId, input.action)
      } catch (err) {
        this.logger.warn(`decide failed for ${input.approvalId}: ${errorMessage(err)}`)
        // ボタンは残す(再タップで再試行できる)
        await this.answer(
          input.callbackQueryId,
          '⚠️ Hub への送信に失敗しました。もう一度タップしてください',
          true,
        )
        return
      }
      switch (outcome.outcome) {
        case 'decided':
          await this.closeEntry(
            input.approvalId,
            entry,
            input.action === 'approve'
              ? { kind: 'approved-via-telegram' }
              : { kind: 'denied-via-telegram' },
          )
          await this.answer(
            input.callbackQueryId,
            input.action === 'approve' ? '✅ 承認しました' : '⛔ 拒否しました',
          )
          break
        case 'already-decided':
          await this.closeEntry(input.approvalId, entry, outcomeFromApproval(outcome.approval))
          await this.answer(input.callbackQueryId, '別経路で対応済みでした', true)
          break
        case 'not-found':
          await this.closeEntry(input.approvalId, entry, { kind: 'not-found' })
          await this.answer(input.callbackQueryId, 'Hub 上に見つかりませんでした', true)
          break
      }
    })
  }

  /** コメント付き Deny ボタン → ForceReply プロンプト送信 */
  async startCommentPrompt(input: {
    approvalId: string
    callbackQueryId: string
    replyToMessageId?: number
  }): Promise<void> {
    return this.enqueue(input.approvalId, async () => {
      const entry = this.state.getApproval(input.approvalId)
      if (!entry || entry.status === 'closed') {
        await this.answer(input.callbackQueryId, '既にクローズ済みです', true)
        return
      }
      // stale/既決の承認にコメントを打たせない(入力後に無駄になるのを防ぐ)
      const guard = await this.preDecideGuard(input.approvalId, entry)
      if (guard.verdict === 'hub-error') {
        await this.answer(
          input.callbackQueryId,
          '⚠️ Hub への確認に失敗しました。もう一度タップしてください',
          true,
        )
        return
      }
      if (guard.verdict === 'closed') {
        await this.answer(input.callbackQueryId, guardClosedMessage(guard.reason), true)
        return
      }
      const prompt = await this.sender.sendMessage(
        this.chatId,
        '💬 コメントを入力してください(deny として送信されます)',
        {
          replyToMessageId: input.replyToMessageId,
          replyMarkup: { force_reply: true, input_field_placeholder: 'deny コメント' },
        },
      )
      this.prompts.register(this.chatId, prompt.messageId, input.approvalId)
      await this.answer(input.callbackQueryId, 'コメントを入力してください')
    })
  }

  /** コメントテキスト受信 → deny+comment(ForceReply 返信・承認メッセージ直接返信の両経路) */
  async handleCommentDeny(
    approvalId: string,
    commentRaw: string,
    notify: (html: string) => Promise<void>,
  ): Promise<void> {
    const comment = commentRaw.trim().slice(0, COMMENT_MAX_CHARS)
    return this.enqueue(approvalId, async () => {
      const entry = this.state.getApproval(approvalId)
      if (!entry) {
        await notify('この承認は追跡されていません(期限切れの可能性)')
        return
      }
      if (entry.status === 'closed') {
        await notify('この承認は既にクローズ済みです')
        return
      }
      const guard = await this.preDecideGuard(approvalId, entry)
      if (guard.verdict === 'hub-error') {
        await notify('⚠️ Hub への確認に失敗しました。もう一度返信してください')
        return
      }
      if (guard.verdict === 'closed') {
        await notify(guardClosedMessage(guard.reason))
        return
      }
      let outcome
      try {
        outcome = await this.hub.decide(approvalId, 'deny', comment)
      } catch (err) {
        this.logger.warn(`comment deny failed for ${approvalId}: ${errorMessage(err)}`)
        await notify('⚠️ Hub への送信に失敗しました。もう一度返信してください')
        return
      }
      switch (outcome.outcome) {
        case 'decided':
          await this.closeEntry(approvalId, entry, { kind: 'denied-via-telegram', comment })
          await notify('⛔ コメント付きで拒否しました')
          break
        case 'already-decided':
          await this.closeEntry(approvalId, entry, outcomeFromApproval(outcome.approval))
          await notify('別経路で対応済みでした')
          break
        case 'not-found':
          await this.closeEntry(approvalId, entry, { kind: 'not-found' })
          await notify('Hub 上に見つかりませんでした')
          break
      }
    })
  }

  /** notification-updated / reconciliation の toClose: Hub 側で決着済みの反映 */
  async handleApprovalUpdate(approvalId: string): Promise<void> {
    return this.enqueue(approvalId, async () => {
      const entry = this.state.getApproval(approvalId)
      if (!entry || entry.status === 'closed') return
      let approval: ApprovalRecord | null
      try {
        approval = await this.hub.getApproval(approvalId)
      } catch (err) {
        this.logger.warn(`approval fetch failed for ${approvalId}: ${errorMessage(err)}`)
        return // 次の reconciliation でリトライされる
      }
      if (!approval) {
        await this.closeEntry(approvalId, entry, { kind: 'not-found' })
        return
      }
      if (approval.status !== 'decided') return
      await this.closeEntry(approvalId, entry, outcomeFromApproval(approval))
    })
  }

  /** hook タイムアウト超過の「死んだ承認」をボタン無効化する */
  async expireApproval(approvalId: string): Promise<void> {
    return this.enqueue(approvalId, async () => {
      const entry = this.state.getApproval(approvalId)
      if (!entry || entry.status === 'closed') return
      await this.closeEntry(approvalId, entry, { kind: 'expired' })
    })
  }

  /** 全投稿メッセージ(重複含む)を best effort で編集してボタンを無効化する */
  private async closeEntry(
    approvalId: string,
    entry: ApprovalEntry,
    outcome: ClosedOutcome,
  ): Promise<void> {
    const footer = formatOutcomeFooter(outcome, this.now())
    for (const message of entry.messages) {
      try {
        await this.sender.editMessageText(
          message.chatId,
          message.messageId,
          `${message.text}\n\n${footer}`,
        )
      } catch (err) {
        this.logger.warn(
          `message edit failed (${message.chatId}:${message.messageId}): ${errorMessage(err)}`,
        )
      }
    }
    entry.status = 'closed'
    entry.closedAt = this.now().toISOString()
    this.state.setApproval(approvalId, entry)
    this.logger.info(`approval ${approvalId} closed (${outcome.kind})`)
  }

  private async answer(callbackQueryId: string, text: string, showAlert = false): Promise<void> {
    try {
      await this.sender.answerCallbackQuery(callbackQueryId, text, showAlert)
    } catch (err) {
      this.logger.warn(`answerCallbackQuery failed: ${errorMessage(err)}`)
    }
  }
}
