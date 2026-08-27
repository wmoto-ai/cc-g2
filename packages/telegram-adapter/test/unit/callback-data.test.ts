import { describe, expect, it } from 'vitest'
import {
  approvalKeyboard,
  decodeCallback,
  encodeCallback,
} from '../../src/telegram/callback-data'

const APPROVAL_ID = '123e4567-e89b-42d3-a456-426614174000'

describe('encodeCallback / decodeCallback', () => {
  it('往復で一致し、64 バイト以内に収まる', () => {
    for (const action of ['approve', 'deny', 'comment'] as const) {
      const data = encodeCallback(action, APPROVAL_ID)
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
      expect(decodeCallback(data)).toEqual({ action, approvalId: APPROVAL_ID })
    }
  })

  it('64 バイト超は encode 側で throw(将来の形式変更事故を止める)', () => {
    expect(() => encodeCallback('approve', 'x'.repeat(80))).toThrow(/64 bytes/)
  })

  it('不正なデータは null(未知 prefix / UUID でない / 区切りなし)', () => {
    expect(decodeCallback(`zzz|${APPROVAL_ID}`)).toBeNull()
    expect(decodeCallback('apr|not-a-uuid')).toBeNull()
    expect(decodeCallback('aprnodivider')).toBeNull()
    expect(decodeCallback('')).toBeNull()
  })

  it('approvalKeyboard は 2 段構成(Approve/Deny + コメント付き Deny)', () => {
    const keyboard = approvalKeyboard(APPROVAL_ID).inline_keyboard
    expect(keyboard).toHaveLength(2)
    expect(keyboard[0]).toHaveLength(2)
    expect(keyboard[1]).toHaveLength(1)
    const first = keyboard[0]?.[0] as { callback_data?: string }
    expect(first.callback_data).toBe(`apr|${APPROVAL_ID}`)
  })
})
