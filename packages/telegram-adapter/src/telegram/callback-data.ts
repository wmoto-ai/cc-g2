// callback_data の 64 バイト制約(Bot API)を一手に引き受ける encode/decode。
// 形式: `<prefix>|<approvalId(UUID)>` = 4 + 36 = 40 バイト。
import { InlineKeyboard } from 'grammy'

export type CallbackAction = 'approve' | 'deny' | 'comment'

const PREFIX: Record<CallbackAction, string> = { approve: 'apr', deny: 'dny', comment: 'cmt' }
const PREFIX_TO_ACTION = new Map<string, CallbackAction>(
  (Object.entries(PREFIX) as Array<[CallbackAction, string]>).map(([action, prefix]) => [
    prefix,
    action,
  ]),
)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function encodeCallback(action: CallbackAction, approvalId: string): string {
  const data = `${PREFIX[action]}|${approvalId}`
  // 将来の形式変更で 64B を超える事故を encode 側で止める
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error(`callback_data exceeds 64 bytes (${Buffer.byteLength(data, 'utf8')})`)
  }
  return data
}

export function decodeCallback(
  data: string,
): { action: CallbackAction; approvalId: string } | null {
  const separatorIndex = data.indexOf('|')
  if (separatorIndex === -1) return null
  const action = PREFIX_TO_ACTION.get(data.slice(0, separatorIndex))
  const approvalId = data.slice(separatorIndex + 1)
  if (!action || !UUID_RE.test(approvalId)) return null
  return { action, approvalId }
}

export function approvalKeyboard(approvalId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Approve', encodeCallback('approve', approvalId))
    .text('❌ Deny', encodeCallback('deny', approvalId))
    .row()
    .text('💬 コメント付き Deny', encodeCallback('comment', approvalId))
}
