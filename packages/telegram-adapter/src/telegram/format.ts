// Telegram メッセージの整形。parse_mode は HTML(エスケープが & < > のみで安全側)。
// 4096 字/msg 制限に対し、プレビューは 3000 字で切詰めてフッタ・タグ膨張のマージンを残す。
import type { ApprovalRecord } from '../hub/types'

export const PREVIEW_MAX_CHARS = 3_000
export const TRUNCATION_NOTICE = '…(切詰め・全文は PC で確認)'

/**
 * G2 ミニアプリ(telegram トランスポート)向けの機種別安定マーカー。
 * ミニアプリはメッセージ種別の判定をこの行のみに依存する(本文・フッタ文言の
 * パース禁止）。文言変更禁止。
 * 承認メッセージは inline keyboard の callback_data で判定できるためマーカー不要。
 */
export const G2_MARKER = {
  stop: '· cc-g2:stop',
  generic: '· cc-g2:generic',
  image: '· cc-g2:image',
  // 承認もマーカーで判定する: decide 後の editMessageText で inline keyboard が
  // 消えるため、ボタン有無だけでは閉じた承認を判別できない
  approval: '· cc-g2:approval',
  // ピン留めステータス(ctx% / session-activity)。StatusFlow が定期 edit する 1 件のみ
  status: '· cc-g2:status',
} as const

/**
 * 任意のセッションタグ meta 行。種別マーカー行の直後に付き、ミニアプリの
 * セッション別絞り込みに使う(NotificationItem.metadata.sessionLabel)。
 * 後方互換: meta 行が無い旧メッセージも従来どおり分類・表示できる。
 * ミニアプリ側 TG_META(src/transport/telegram/model.ts)と一致していること
 * (test/telegram-model.test.ts で相互検証)。プレフィックス文言は変更禁止。
 */
export const G2_META = {
  /** この後に <slug> が続く。例: `· cc-g2:meta sess=cc-g2` */
  sessPrefix: '· cc-g2:meta sess=',
} as const

/** セッションスラグの最大長(meta 行の肥大防止) */
const SESSION_SLUG_MAX_CHARS = 24

/**
 * セッションラベルを meta 行に載せられるスラグへ正規化する。
 * 空白は `-` に畳み、`[A-Za-z0-9._-]` 以外を除去し、最大 24 文字に切る。
 * 空になった場合は空文字(呼び出し側は meta 行自体を付けない)。
 */
export function sanitizeSessionSlug(raw: string | undefined): string {
  if (!raw) return ''
  return raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, SESSION_SLUG_MAX_CHARS)
}

/**
 * セッションラベル(無ければ cwd の末尾 repo 名)から meta 行を組む。
 * スラグが空になるときは null を返し、呼び出し側は行を付けない。
 */
export function sessionMetaLine(sessionLabel: string | undefined, cwd?: string): string | null {
  const slug = sanitizeSessionSlug(sessionLabel || repoNameFromCwd(cwd))
  if (!slug) return null
  return `${G2_META.sessPrefix}${slug}`
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function truncateText(text: string, maxChars = PREVIEW_MAX_CHARS): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + TRUNCATION_NOTICE
}

export function repoNameFromCwd(cwd: string | undefined): string {
  if (!cwd) return ''
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export interface ApprovalView {
  toolName: string
  agentName?: string
  cwd?: string
  sessionLabel?: string
  preview?: string
}

export function formatApprovalMessage(view: ApprovalView): string {
  const repo = repoNameFromCwd(view.cwd)
  const agentBits = [view.agentName, view.sessionLabel].filter(Boolean).join(' ')
  const lines = [
    `🔐 <b>${escapeHtml(view.toolName)}</b>` +
      (repo ? ` — ${escapeHtml(repo)}` : '') +
      (agentBits ? ` <i>(${escapeHtml(agentBits)})</i>` : ''),
  ]
  if (view.cwd) lines.push(`<code>${escapeHtml(view.cwd)}</code>`)
  const preview = (view.preview ?? '').trim()
  if (preview) {
    lines.push(`<blockquote expandable><pre>${escapeHtml(truncateText(preview))}</pre></blockquote>`)
  }
  lines.push(`<i>${escapeHtml(G2_MARKER.approval)}</i>`)
  const meta = sessionMetaLine(view.sessionLabel, view.cwd)
  if (meta) lines.push(`<i>${escapeHtml(meta)}</i>`)
  return lines.join('\n')
}

export interface StopView {
  title: string
  body?: string
  cwd?: string
  sessionLabel?: string
  tmuxTarget?: string
}

export function formatStopMessage(view: StopView): string {
  const location = repoNameFromCwd(view.cwd) || view.sessionLabel || view.tmuxTarget || ''
  const lines = [
    `🏁 <b>${escapeHtml(view.title)}</b>` + (location ? ` — ${escapeHtml(location)}` : ''),
  ]
  const body = (view.body ?? '').trim()
  if (body) lines.push(`<blockquote expandable>${escapeHtml(truncateText(body))}</blockquote>`)
  lines.push('<i>このメッセージに返信するとセッションへ送信されます</i>')
  lines.push(`<i>${escapeHtml(G2_MARKER.stop)}</i>`)
  const meta = sessionMetaLine(view.sessionLabel, view.cwd)
  if (meta) lines.push(`<i>${escapeHtml(meta)}</i>`)
  return lines.join('\n')
}

export interface GenericView {
  title: string
  body?: string
  source?: string
}

/** Stop/画像/承認以外の汎用通知(運用ジョブの通知など)。返信中継は対象外なのでフッタなし */
export function formatGenericMessage(view: GenericView): string {
  const lines = [
    `📣 <b>${escapeHtml(view.title)}</b>` +
      (view.source ? ` <i>(${escapeHtml(view.source)})</i>` : ''),
  ]
  const body = (view.body ?? '').trim()
  if (body) lines.push(`<blockquote expandable>${escapeHtml(truncateText(body))}</blockquote>`)
  lines.push(`<i>${escapeHtml(G2_MARKER.generic)}</i>`)
  return lines.join('\n')
}

export interface ImageCaptionView {
  title: string
  cwd?: string
  sessionLabel?: string
}

/**
 * 画像投稿(sendPhoto)の caption。parse_mode 無しのプレーンテキストで、
 * タイトル + 種別マーカー(+ セッション情報が届いていれば meta 行)を返す。
 */
export function formatImageCaption(view: ImageCaptionView): string {
  const lines = [view.title, G2_MARKER.image]
  const meta = sessionMetaLine(view.sessionLabel, view.cwd)
  if (meta) lines.push(meta)
  return lines.join('\n')
}

// --- ピン留めステータスメッセージ(G2 ミニアプリの ctx% / セッション状態ヘッダ用) ---

/** JSON ペイロードの肥大防止(Telegram 4096 字制限へのマージン) */
export const STATUS_MAX_SESSIONS = 8
const STATUS_LABEL_MAX_CHARS = 32

export interface StatusContextSession {
  sessionId: string
  cwd: string
  usedPercentage: number
  model: string
}

export interface StatusSessionActivity {
  tmuxTarget: string
  label: string
  state: string
}

/**
 * ミニアプリが機械的に読む JSON ペイロード(1 行)。
 * バージョン v を持ち、ミニアプリ側(src/transport/telegram/model.ts)の
 * パーサと相互検証テストで同期する。
 *
 * ctx / activity の意味論: **フィールド欠落 = 取得失敗(ミニアプリは前回値を維持)**、
 * **空配列 [] = 取得できて 0 件(ミニアプリは表示をクリア)**。
 */
export interface StatusPayload {
  v: 1
  /** 生成時刻(unix 秒)。ミニアプリは古すぎるペイロードを無視する */
  ts: number
  ctx?: StatusContextSession[]
  activity?: StatusSessionActivity[]
}

export function buildStatusPayload(
  ctxSessions: StatusContextSession[] | null,
  activities: StatusSessionActivity[] | null,
  at: Date,
): StatusPayload {
  return {
    v: 1,
    ts: Math.floor(at.getTime() / 1000),
    ...(ctxSessions != null
      ? {
          ctx: ctxSessions.slice(0, STATUS_MAX_SESSIONS).map((s) => ({
            sessionId: s.sessionId,
            cwd: s.cwd,
            usedPercentage: s.usedPercentage,
            model: s.model,
          })),
        }
      : {}),
    ...(activities != null
      ? {
          activity: activities.slice(0, STATUS_MAX_SESSIONS).map((a) => ({
            tmuxTarget: a.tmuxTarget,
            label: a.label.slice(0, STATUS_LABEL_MAX_CHARS),
            state: a.state,
          })),
        }
      : {}),
  }
}

/**
 * ステータスメッセージ本文。人間向けサマリ行 + JSON 1 行 + 安定マーカー。
 * ミニアプリは JSON 行とマーカーのみに依存する(サマリ文言は変更可)。
 */
export function formatStatusMessage(payload: StatusPayload): string {
  const ctx = payload.ctx ?? []
  const activity = payload.activity ?? []
  const maxPct = ctx.length > 0 ? Math.max(...ctx.map((s) => s.usedPercentage)) : null
  const activeCount = activity.filter((a) => a.state === 'active').length
  const summaryBits = [
    maxPct != null ? `ctx ${Math.round(maxPct)}%` : 'ctx -',
    `${activeCount}/${activity.length} active`,
  ]
  const lines = [
    `📊 <b>cc-g2 status</b> — ${escapeHtml(summaryBits.join(' · '))} (${formatTime(new Date(payload.ts * 1000))})`,
    `<code>${escapeHtml(JSON.stringify(payload))}</code>`,
    `<i>${escapeHtml(G2_MARKER.status)}</i>`,
  ]
  return lines.join('\n')
}

/** クローズ時にメッセージ末尾へ付けるフッタの種別 */
export type ClosedOutcome =
  | { kind: 'approved-via-telegram' }
  | { kind: 'denied-via-telegram'; comment?: string }
  | { kind: 'decided-elsewhere'; decision: 'approve' | 'deny'; decidedBy?: string; comment?: string }
  | { kind: 'terminal-disconnect' }
  | { kind: 'session-ended' }
  | { kind: 'expired' }
  | { kind: 'not-found' }
  | { kind: 'closed-other'; note?: string }

export function formatOutcomeFooter(outcome: ClosedOutcome, at: Date): string {
  const time = formatTime(at)
  switch (outcome.kind) {
    case 'approved-via-telegram':
      return `✅ <b>Approved</b> via Telegram (${time})`
    case 'denied-via-telegram':
      return (
        `⛔ <b>Denied</b> via Telegram (${time})` +
        (outcome.comment ? `\n💬 ${escapeHtml(outcome.comment)}` : '')
      )
    case 'decided-elsewhere': {
      const head = outcome.decision === 'approve' ? '✅ <b>Approved</b>' : '⛔ <b>Denied</b>'
      return (
        `${head} — 別経路 (${escapeHtml(outcome.decidedBy || 'unknown')}) で対応済み (${time})` +
        (outcome.comment ? `\n💬 ${escapeHtml(outcome.comment)}` : '')
      )
    }
    case 'terminal-disconnect':
      return `🖥 PC 側で対応済み (${time})`
    case 'session-ended':
      return `🧹 セッション終了により自動クローズ (${time})`
    case 'expired':
      return `⏰ 期限切れ — ターミナル側で対応してください (${time})`
    case 'not-found':
      return `❓ Hub 上に見つかりませんでした (${time})`
    case 'closed-other':
      return `☑️ クローズ済み${outcome.note ? ` (${escapeHtml(outcome.note)})` : ''} (${time})`
  }
}

/** Hub 上で決着済みの approval からフッタ種別を導出する(decide 以外の自動クローズ含む) */
export function outcomeFromApproval(approval: ApprovalRecord): ClosedOutcome {
  if (approval.decision === 'approve' || approval.decision === 'deny') {
    return {
      kind: 'decided-elsewhere',
      decision: approval.decision,
      decidedBy: approval.decidedBy,
      comment: approval.comment,
    }
  }
  if (approval.resolution === 'terminal-disconnect') return { kind: 'terminal-disconnect' }
  if (approval.resolution === 'session-ended') return { kind: 'session-ended' }
  return { kind: 'closed-other', note: approval.resolution }
}
