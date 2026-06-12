/**
 * スマホ側 UI のラベル・メッセージ整形の純粋関数群
 *
 * DOM・モジュール状態に依存しない関数のみを置く（リファクタ Phase 2 で
 * main.ts から無編集移動）。
 */
import type { NotificationUIState } from '../glasses-ui'
import type { NotificationItem } from '../notifications'

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function screenLabel(screen: NotificationUIState['screen']): string {
  switch (screen) {
    case 'idle': return 'idle'
    case 'list': return 'list'
    case 'detail': return 'detail'
    case 'detail-actions': return 'actions'
    case 'image-detail': return 'image'
    case 'ask-question': return 'ask-q'
    case 'ask-question-detail': return 'ask-q-detail'
    case 'reply-recording': return 'recording'
    case 'reply-confirm': return 'confirm'
    case 'reply-confirm-actions': return 'confirm-actions'
    case 'reply-sending': return 'sending'
  }
}

export function replyStatusLabel(item: NotificationItem): string {
  switch (item.replyStatus) {
    case 'replied': return 'replied'
    case 'delivered': return 'delivered'
    case 'decided': return 'decided'
    case 'pending': return 'pending'
    default: return 'new'
  }
}

export function formatRelativeTime(ms: number | null): string {
  if (!ms) return 'まだありません'
  const diff = Date.now() - ms
  if (diff < 5_000) return 'たった今'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分前`
  return new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

export function getReplyResultMessage(res: { reply?: { status?: string; result?: string; error?: string; ignoredReason?: string } } | undefined): { ok: boolean; message?: string } {
  const reply = res?.reply
  if (!reply) return { ok: true }
  if (reply.status === 'failed') {
    return { ok: false, message: reply.error || 'reply failed' }
  }
  if (reply.result === 'ignored') {
    if (reply.ignoredReason === 'approval-not-pending') {
      return { ok: false, message: 'この承認は既に無効です' }
    }
    if (reply.ignoredReason === 'approval-link-not-found') {
      return { ok: false, message: '承認リンクが見つかりません' }
    }
    return { ok: false, message: reply.error || 'reply ignored' }
  }
  return { ok: true }
}
