// Notification Hub API の契約型。
export type ApprovalDecision = 'approve' | 'deny'
export type ApprovalStatus = 'pending' | 'decided'

export interface ApprovalRecord {
  id: string
  notificationId: string
  source: string
  toolName: string
  toolInput: unknown
  toolId: string
  cwd: string
  reason: string
  agentName: string
  status: ApprovalStatus
  createdAt: string
  decision?: ApprovalDecision
  /** decide 以外の自動クローズ理由: terminal-disconnect / session-ended など */
  resolution?: string
  comment?: string
  decidedBy?: string
  decidedAt?: string
  deliveredAt?: string
}

export interface NotificationMetadata {
  hookType?: string
  approvalId?: string
  toolName?: string
  cwd?: string
  agentName?: string
  sessionId?: string
  tmuxTarget?: string
  sessionLabel?: string
  imageId?: string
  externalId?: string
  [key: string]: unknown
}

/** SSE の notification-added / notification-updated と一覧 API の要素。fullText を含まない */
export interface NotificationListItem {
  id: string
  source: string
  title: string
  summary: string
  createdAt: string
  replyCapable: boolean
  metadata?: NotificationMetadata
  replyStatus?: string
}

/** GET /api/notifications/:id。hook 整形済みプレビューが fullText に入る */
export interface NotificationDetail extends NotificationListItem {
  fullText?: string
}

export type ReplyRelayStatus = 'stubbed' | 'forwarded' | 'failed'

export interface ReplyRecord {
  id: string
  notificationId: string
  replyText: string
  createdAt: string
  status: ReplyRelayStatus
  action?: string
  result?: string
  error?: string
  source?: string
}

export type DecideOutcome =
  | { outcome: 'decided'; approval: ApprovalRecord }
  | { outcome: 'already-decided'; approval: ApprovalRecord }
  | { outcome: 'not-found' }

/** GET /api/context-status の要素(Hub 参照実装: cc-g2 src/app/context.ts ContextSession) */
export interface ContextSessionRecord {
  sessionId: string
  cwd: string
  usedPercentage: number
  model: string
}

/** GET /api/session-activity の要素(state は active/idle/error/dead を想定、前方互換で string) */
export interface SessionActivityRecord {
  tmuxTarget: string
  label: string
  state: string
}
