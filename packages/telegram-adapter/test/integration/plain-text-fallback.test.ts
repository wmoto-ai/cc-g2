// reply を付けられないクライアント(ERGram 等)向けの平文フォールバック:
// 平文は最新 Stop 通知への返信としてセッションへ中継する。
// 承認の決裁は inline keyboard(callback)のみ — テキストから decide されないことも保証する。
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_ID, createHarness, USER_ID, type Harness } from '../fixtures/harness'
import { waitFor } from '../fixtures/util'

let h: Harness | undefined

afterEach(async () => {
  await h?.close()
  h = undefined
})

function decideRequestCount(harness: Harness): number {
  return harness.hub.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/decide'))
    .length
}

describe('平文テキストのフォールバック(非 reply)', () => {
  it('平文は最新 Stop 通知への返信として中継される', async () => {
    h = await createHarness()
    await h.startSse()
    h.hub.setRelay({ enabled: true, sources: ['g2', 'web', 'telegram'] })
    h.hub.pushStopNotification({ title: 'old session' })
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    const latest = h.hub.pushStopNotification({ title: 'new session' })
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 2)

    await h.dispatch(
      h.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text: '続きをお願い' }),
    )

    expect(h.hub.replies).toHaveLength(1)
    expect(h.hub.replies[0]!.notificationId).toBe(latest.id)
    expect(h.hub.replies[0]!.rawBody.source).toBe('telegram')
    expect(h.hub.replies[0]!.rawBody.replyText).toBe('続きをお願い')
  })

  it('承認待ちがあっても平文では決して decide されない(ボタン経路のみ)', async () => {
    h = await createHarness()
    await h.startSse()
    h.hub.setRelay({ enabled: true, sources: ['g2', 'web', 'telegram'] })
    const { approval } = h.hub.createApproval()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    h.hub.pushStopNotification()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 2)

    for (const text of ['ok', 'OK。', 'はい', '承認', 'だめ', 'no']) {
      await h.dispatch(h.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text }))
    }

    expect(decideRequestCount(h)).toBe(0)
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending')
    // すべて通常テキストとしてセッションへ中継される
    expect(h.hub.replies).toHaveLength(6)
    expect(h.hub.replies.map((r) => r.rawBody.replyText)).toEqual([
      'ok',
      'OK。',
      'はい',
      '承認',
      'だめ',
      'no',
    ])
  })

  it('Stop 通知が TTL 超過なら案内メッセージにフォールバックする', async () => {
    h = await createHarness({ stopReplyTtlMs: 50 })
    await h.startSse()
    h.hub.setRelay({ enabled: true, sources: ['g2', 'web', 'telegram'] })
    h.hub.pushStopNotification()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 80))

    await h.dispatch(h.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text: '遅い平文' }))

    expect(h.hub.replies).toHaveLength(0)
    const feedback = h.stub.callsOf('sendMessage').at(-1)!
    expect(String(feedback.payload.text)).toContain('Phase 1 では')
  })

  it('Stop 通知が 1 件もなければ従来の案内を返す', async () => {
    h = await createHarness()
    await h.startSse()

    await h.dispatch(h.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text: 'こんにちは' }))

    const feedback = h.stub.callsOf('sendMessage').at(-1)!
    expect(String(feedback.payload.text)).toContain('Phase 1 では')
  })
})
