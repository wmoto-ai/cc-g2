import { afterEach, describe, expect, it } from 'vitest'
import {
  CHAT_ID,
  createHarness,
  OTHER_CHAT_ID,
  OTHER_USER_ID,
  USER_ID,
  type Harness,
} from '../fixtures/harness'
import { waitFor } from '../fixtures/util'

let h: Harness | undefined

afterEach(async () => {
  await h?.close()
  h = undefined
})

describe('アクセス制御(fail-closed)', () => {
  it('allowlist 外ユーザーの callback は一切の副作用を生まない(無応答)', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    const messageId = h.stub.lastMessageId()
    const callsBefore = h.stub.calls.length

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: OTHER_USER_ID,
        chatId: CHAT_ID,
        messageId,
        data: `apr|${approval.id}`,
      }),
    )
    expect(h.stub.calls.length).toBe(callsBefore) // answer さえ返さない
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending')
  })

  it('allowlist ユーザーでも別 chat からの callback は副作用ゼロ', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    const messageId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: OTHER_CHAT_ID,
        messageId,
        data: `apr|${approval.id}`,
      }),
    )
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending')
  })

  it('別 chat からの Stop 返信・コメント deny は注入されない', async () => {
    h = await createHarness()
    await h.startSse()
    h.hub.setRelay({ enabled: true, sources: ['g2', 'web', 'telegram'] })

    const { approval } = h.hub.createApproval()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    const approvalMsgId = h.stub.lastMessageId()
    h.hub.pushStopNotification()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 2)
    const stopMsgId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeTextUpdate({
        fromId: USER_ID,
        chatId: OTHER_CHAT_ID,
        text: '注入テキスト',
        replyTo: stopMsgId,
      }),
    )
    await h.dispatch(
      h.stub.makeTextUpdate({
        fromId: USER_ID,
        chatId: OTHER_CHAT_ID,
        text: '注入コメント',
        replyTo: approvalMsgId,
      }),
    )
    expect(h.hub.replies).toHaveLength(0)
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending')
  })

  it('不正な callback_data は decide されず「不明な操作」', async () => {
    h = await createHarness()
    await h.dispatch(
      h.stub.makeCallbackUpdate({ fromId: USER_ID, chatId: CHAT_ID, messageId: 1, data: 'garbage' }),
    )
    const answer = h.stub.callsOf('answerCallbackQuery')[0]!
    expect(String(answer.payload.text)).toContain('不明')
    expect(
      h.hub.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/decide')),
    ).toHaveLength(0)
  })

  it('未知 SSE イベント(session-activity 等)が混ざっても処理は継続する', async () => {
    h = await createHarness()
    await h.startSse()
    h.hub.pushRawEvent('session-activity', { sessions: [] })
    h.hub.pushRawEvent('g2-display', { tiles: [] })
    h.hub.createApproval()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
  })
})
