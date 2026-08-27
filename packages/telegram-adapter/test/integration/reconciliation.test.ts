import { afterEach, describe, expect, it } from 'vitest'
import { startFixtureHub } from '../fixtures/hub-server'
import { CHAT_ID, createHarness, USER_ID, type Harness } from '../fixtures/harness'

let h: Harness | undefined

afterEach(async () => {
  await h?.close()
  h = undefined
})

describe('reconciliation', () => {
  it('SSE 停止中に発生した承認を runOnce が投稿し、再実行しても重複しない', async () => {
    h = await createHarness()
    h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    expect(h.stub.callsOf('sendMessage')).toHaveLength(1)

    await h.reconciler.runOnce()
    expect(h.stub.callsOf('sendMessage')).toHaveLength(1)
  })

  it('再起動(state 保持)で重複投稿しない', async () => {
    const hub = await startFixtureHub()
    try {
      const h1 = await createHarness({ hub })
      hub.createApproval({ broadcast: false })
      await h1.reconciler.runOnce()
      expect(h1.stub.callsOf('sendMessage')).toHaveLength(1)
      await h1.close()

      const h2 = await createHarness({ hub, statePath: h1.statePath })
      await h2.reconciler.runOnce()
      expect(h2.stub.callsOf('sendMessage')).toHaveLength(0)
      await h2.close()
    } finally {
      await hub.close()
    }
  })

  it('state 消失時は重複投稿されるが機能は回復する(decide 可能)', async () => {
    const hub = await startFixtureHub()
    try {
      const h1 = await createHarness({ hub })
      const { approval } = hub.createApproval({ broadcast: false })
      await h1.reconciler.runOnce()
      await h1.close()

      const h2 = await createHarness({ hub }) // state は新規 = 消失を再現
      await h2.reconciler.runOnce()
      expect(h2.stub.callsOf('sendMessage')).toHaveLength(1) // 重複投稿(許容)
      const messageId = h2.stub.lastMessageId()
      await h2.dispatch(
        h2.stub.makeCallbackUpdate({
          fromId: USER_ID,
          chatId: CHAT_ID,
          messageId,
          data: `apr|${approval.id}`,
        }),
      )
      expect(hub.approvals.get(approval.id)?.status).toBe('decided')
      await h2.close()
    } finally {
      await hub.close()
    }
  })

  it('post cutoff 超過の pending は投稿されない(死んだ承認)', async () => {
    h = await createHarness() // postCutoffMs = 540s
    h.hub.createApproval({
      broadcast: false,
      createdAt: new Date(Date.now() - 600_000).toISOString(),
    })
    await h.reconciler.runOnce()
    expect(h.stub.callsOf('sendMessage')).toHaveLength(0)
  })

  it('境界レース対策: cutoff(540s)〜stale(600s) の間の pending も投稿されない', async () => {
    h = await createHarness()
    h.hub.createApproval({
      broadcast: false,
      createdAt: new Date(Date.now() - 560_000).toISOString(),
    })
    await h.reconciler.runOnce()
    expect(h.stub.callsOf('sendMessage')).toHaveLength(0)
  })

  it('投稿済みが stale 閾値を超えたら expired 編集され、以後タップも効かない', async () => {
    // postCutoff を大きくして「古い承認を投稿済み」の状態を作る
    h = await createHarness({ postCutoffMs: 10_000_000, staleMs: 600_000 })
    const { approval } = h.hub.createApproval({
      broadcast: false,
      createdAt: new Date(Date.now() - 601_000).toISOString(),
    })
    await h.reconciler.runOnce()
    expect(h.stub.callsOf('sendMessage')).toHaveLength(1)
    const messageId = h.stub.lastMessageId()

    await h.reconciler.runOnce() // 2 周期目で expire
    const edit = h.stub.callsOf('editMessageText')[0]!
    expect(String(edit.payload.text)).toContain('期限切れ')

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId,
        data: `apr|${approval.id}`,
      }),
    )
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending') // decide されない
    expect(String(h.stub.callsOf('answerCallbackQuery')[0]!.payload.text)).toContain('クローズ済み')
  })

  it('投稿済みが pending から消えたら(自動クリーンアップ)終状態を反映する', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()

    h.hub.cleanupApproval(approval.id, 'session-ended', 'auto-session-end')
    await h.reconciler.runOnce()
    const edit = h.stub.callsOf('editMessageText')[0]!
    expect(String(edit.payload.text)).toContain('セッション終了')
  })
})
