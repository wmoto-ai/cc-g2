/**
 * セッション別通知一覧の純ロジック（グルーピング・行生成・バイト予算）
 *
 * SDK・DOM・モジュール状態に依存しない関数のみ。session-list 画面と
 * 絞り込み通知一覧が共用する。セッションキーの導出は deriveSessionLabel
 * （サーバー実装と同一・test/derive-session-label-cross.test.ts が監視）を再利用する。
 * バイト計算はすべて UTF-8 基準。
 */
import type { NotificationItem } from '../notifications'
import { deriveSessionLabel, byteLen, truncateByBytes } from './text-format'
import { t } from '../i18n'

export type SessionActivityState = 'active' | 'idle' | 'error' | 'dead'

/** セッション状態マーク（session-list 行・通知一覧ヘッダで共用） */
export const SESSION_STATE_MARK: Record<SessionActivityState, string> = {
  active: '▶',
  idle: '○',
  error: '!',
  dead: 'X',
}

export type SessionActivityLike = { tmuxTarget: string; label: string; state: SessionActivityState }

/** 絞り込みフィルタ（key=null は全件表示） */
export type SessionFilter = { key: string | null; label: string }
export const ALL_FILTER: SessionFilter = { key: null, label: '' }

/** session-list の 1 行モデル（key=null は先頭の All 行） */
export type SessionGroup = {
  key: string | null
  label: string
  state: SessionActivityState | null
  count: number
}

/** cwd の basename（キー導出用。表示短縮はしない） */
function basename(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? ''
}

/**
 * tmuxTarget からグラス表示用の短いセッション名を導出する。
 * "g2-cc-g2-4c4a:0.0" → "cc-g2" , "g2-minimalmem-246c:0.0" → "minima"。
 * herdr エントリ("herdr:w4:p1" 等)はセッション名部が常に "herdr" になるため、
 * label(Hub が cwd basename を入れる)を優先する。
 * （旧 src/g2/screens/notification.ts のローカル実装を移設・単一の出所にする）
 */
export function sessionShortName(entry: { tmuxTarget: string; label?: string }): string {
  const session = entry.tmuxTarget.split(':')[0] || ''
  const slug =
    session === 'herdr' && entry.label?.trim()
      ? entry.label.trim()
      : session.replace(/^g2-/, '').replace(/-[0-9a-f]{4}$/, '')
  if (slug.length <= 5) return slug
  return slug.slice(0, 6).replace(/-$/, '')
}

/**
 * 通知の metadata からセッションキーを導出する（グルーピングの共通関数）。
 * 優先順: sessionLabel > deriveSessionLabel(tmuxTarget) > basename(cwd) > 'other'。
 * deriveSessionLabel はサーバーの session-activity ラベルと同一ロジックのため、
 * hub モードでは通知キーと sessionActivities のキーが自然に一致する。
 */
export function deriveSessionKey(metadata: Record<string, unknown> | undefined): string {
  const meta = metadata ?? {}
  const sessionLabel = typeof meta.sessionLabel === 'string' ? meta.sessionLabel.trim() : ''
  if (sessionLabel) return sessionLabel
  const tmuxTarget = typeof meta.tmuxTarget === 'string' ? meta.tmuxTarget.trim() : ''
  if (tmuxTarget && tmuxTarget !== '[REDACTED]') {
    const derived = deriveSessionLabel(tmuxTarget)
    if (derived) return derived
  }
  const cwd = typeof meta.cwd === 'string' ? meta.cwd.trim() : ''
  if (cwd && cwd !== '[REDACTED]') {
    const base = basename(cwd)
    if (base) return base
  }
  return 'other'
}

/**
 * sessionActivities エントリのセッションキー（通知キーと同じ導出で突き合わせる）。
 * herdr エントリ("herdr:w4:p1" 等)は deriveSessionLabel が '' を返し 'other' に
 * 落ちてタグなし通知と衝突するため、label(Hub が cwd basename を入れる)へ
 * フォールバックする — herdr セッションの通知側キーも cwd basename に落ちるので一致する。
 */
export function activitySessionKey(activity: SessionActivityLike): string {
  const derived = deriveSessionKey({ tmuxTarget: activity.tmuxTarget })
  if (derived !== 'other') return derived
  const label = activity.label.trim()
  return label || 'other'
}

/** sessionFilter に一致する通知だけ返す（null は全件） */
export function filterItemsBySession(
  items: NotificationItem[],
  sessionFilter: string | null,
): NotificationItem[] {
  if (sessionFilter === null) return items
  return items.filter((it) => deriveSessionKey(it.metadata) === sessionFilter)
}

/**
 * session-list の行モデルを構築する。
 * 先頭は「All（すべて）」行、以降は「sessionActivities のキー ∪ 通知のキー」の和集合。
 * 各行の状態マークは一致する activity から、件数は通知から数える。
 * 並び順は件数降順→ラベル昇順で決定的にする。
 */
export function buildSessionGroups(
  items: NotificationItem[],
  activities: SessionActivityLike[],
): SessionGroup[] {
  const counts = new Map<string, number>()
  for (const it of items) {
    const k = deriveSessionKey(it.metadata)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }

  // 同一キーの activity は最初の 1 件を代表にする（状態マーク・表示ラベル用）
  const actByKey = new Map<string, SessionActivityLike>()
  for (const a of activities) {
    const k = activitySessionKey(a)
    if (!actByKey.has(k)) actByKey.set(k, a)
  }

  const keys = new Set<string>([...counts.keys(), ...actByKey.keys()])
  const groups: SessionGroup[] = []
  for (const k of keys) {
    const act = actByKey.get(k)
    groups.push({
      key: k,
      label: act ? sessionShortName(act) : k,
      state: act ? act.state : null,
      count: counts.get(k) ?? 0,
    })
  }
  groups.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.label.localeCompare(b.label)))

  const all: SessionGroup = { key: null, label: t('sess_all'), state: null, count: items.length }
  return [all, ...groups]
}

/**
 * session-list の 1 行テキストを生成する（状態マーク + ラベル + 件数）。
 * §10 の 1 アイテム上限に合わせ既定 45 バイト以内に収める（renderHeaderListPage 側でも
 * 再度切り詰めるが、行単体でも予算内に収めておく）。
 */
export function formatSessionRow(group: SessionGroup, maxBytes = 45): string {
  const mark = group.state ? SESSION_STATE_MARK[group.state] : group.key === null ? '☰' : '·'
  const prefix = `${mark} `
  const suffix = ` (${group.count})`
  const available = Math.max(4, maxBytes - byteLen(prefix) - byteLen(suffix))
  return `${prefix}${truncateByBytes(group.label, available)}${suffix}`
}
