import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_ID, createHarness, USER_ID, type Harness } from '../fixtures/harness'
import { waitFor } from '../fixtures/util'

let h: Harness | undefined

afterEach(async () => {
  await h?.close()
  h = undefined
})

describe('コメント付き Deny', () => {
  it('ボタン → ForceReply プロンプト → 返信 → deny+comment', async () => {
    h = await createHarness()
    await h.startSse()
    const { approval } = h.hub.createApproval()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    const approvalMsgId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId: approvalMsgId,
        data: `cmt|${approval.id}`,
      }),
    )
    const promptCall = h.stub.callsOf('sendMessage')[1]!
    expect((promptCall.payload.reply_markup as { force_reply?: boolean }).force_reply).toBe(true)
    const promptMsgId = h.stub.lastMessageId()
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending') // まだ deny していない

    await h.dispatch(
      h.stub.makeTextUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        text: '危険なので別の方法で',
        replyTo: promptMsgId,
      }),
    )
    const record = h.hub.approvals.get(approval.id)
    expect(record?.decision).toBe('deny')
    expect(record?.comment).toBe('危険なので別の方法で')
    expect(record?.decidedBy).toBe('telegram')

    const edit = h.stub.callsOf('editMessageText')[0]!
    expect(edit.payload.message_id).toBe(approvalMsgId)
    expect(String(edit.payload.text)).toContain('危険なので別の方法で')
  })

  it('承認メッセージ本体への直接返信もコメント付き Deny になる', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    const approvalMsgId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeTextUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        text: 'まず plan を見せて',
        replyTo: approvalMsgId,
      }),
    )
    const record = h.hub.approvals.get(approval.id)
    expect(record?.decision).toBe('deny')
    expect(record?.comment).toBe('まず plan を見せて')
  })

  it('プロンプト消費後の再返信は「返信先不明」扱い(二重 deny しない)', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    const approvalMsgId = h.stub.lastMessageId()
    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId: approvalMsgId,
        data: `cmt|${approval.id}`,
      }),
    )
    const promptMsgId = h.stub.lastMessageId()
    const reply = (text: string) =>
      h!.dispatch(
        h!.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text, replyTo: promptMsgId }),
      )

    await reply('一回目')
    expect(h.hub.approvals.get(approval.id)?.comment).toBe('一回目')
    await reply('二回目')
    // プロンプトは消費済み → 返信先不明の案内(承認は一回目のまま)
    expect(h.hub.approvals.get(approval.id)?.comment).toBe('一回目')
    const lastSend = h.stub.callsOf('sendMessage').at(-1)!
    expect(String(lastSend.payload.text)).toContain('特定できません')
  })

  it('stale 承認へのコメント返信は decide せず期限切れ化する', async () => {
    h = await createHarness({ postCutoffMs: 10_000_000, staleMs: 600_000 })
    const { approval } = h.hub.createApproval({
      broadcast: false,
      createdAt: new Date(Date.now() - 601_000).toISOString(),
    })
    await h.reconciler.runOnce()
    const approvalMsgId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeTextUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        text: '遅すぎたコメント',
        replyTo: approvalMsgId,
      }),
    )
    // Hub 上は pending のまま(deny+comment を送らない)
    const record = h.hub.approvals.get(approval.id)
    expect(record?.status).toBe('pending')
    expect(record?.comment).toBeUndefined()
    // expired 編集 + ユーザーへ期限切れ案内
    expect(String(h.stub.callsOf('editMessageText')[0]!.payload.text)).toContain('期限切れ')
    expect(String(h.stub.callsOf('sendMessage').at(-1)!.payload.text)).toContain('期限切れ')
  })

  it('stale 承認のコメントボタンはプロンプトを出さず期限切れ化する', async () => {
    h = await createHarness({ postCutoffMs: 10_000_000, staleMs: 600_000 })
    const { approval } = h.hub.createApproval({
      broadcast: false,
      createdAt: new Date(Date.now() - 601_000).toISOString(),
    })
    await h.reconciler.runOnce()
    const approvalMsgId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId: approvalMsgId,
        data: `cmt|${approval.id}`,
      }),
    )
    // ForceReply プロンプトは送られない(承認投稿の 1 通のみ)
    expect(h.stub.callsOf('sendMessage')).toHaveLength(1)
    expect(String(h.stub.callsOf('answerCallbackQuery')[0]!.payload.text)).toContain('期限切れ')
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending')
  })

  it('返信先不明のテキストは案内のみで副作用なし', async () => {
    h = await createHarness()
    await h.dispatch(
      h.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text: 'x', replyTo: 55_555 }),
    )
    const sends = h.stub.callsOf('sendMessage')
    expect(sends).toHaveLength(1)
    expect(String(sends[0]!.payload.text)).toContain('特定できません')
  })

  it('非返信の自由テキストには Phase 1 の案内を返す', async () => {
    h = await createHarness()
    await h.dispatch(h.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text: 'こんにちは' }))
    const sends = h.stub.callsOf('sendMessage')
    expect(sends).toHaveLength(1)
    expect(String(sends[0]!.payload.text)).toContain('Phase 1')
  })
})
