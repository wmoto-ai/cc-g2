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

describe('承認ライフサイクル', () => {
  it('SSE 承認 → 投稿 → Approve タップ → decide → ボタン無効化', async () => {
    h = await createHarness()
    await h.startSse()
    const { approval } = h.hub.createApproval({ toolInput: { command: 'pnpm test' } })
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)

    const posted = h.stub.callsOf('sendMessage')[0]!
    expect(posted.payload.chat_id).toBe(CHAT_ID)
    expect(String(posted.payload.text)).toContain('$ pnpm test')
    expect(String(posted.payload.text)).toContain('Bash')
    const markup = posted.payload.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    expect(markup.inline_keyboard[0]![0]!.callback_data).toBe(`apr|${approval.id}`)

    const messageId = h.stub.lastMessageId()
    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId,
        data: `apr|${approval.id}`,
      }),
    )

    const record = h.hub.approvals.get(approval.id)
    expect(record?.status).toBe('decided')
    expect(record?.decision).toBe('approve')
    expect(record?.decidedBy).toBe('telegram')

    const edit = h.stub.callsOf('editMessageText')[0]!
    expect(edit.payload.message_id).toBe(messageId)
    expect(String(edit.payload.text)).toContain('Approved')
    expect(edit.payload.reply_markup).toBeUndefined() // キーボード除去
    expect(h.stub.callsOf('answerCallbackQuery')).toHaveLength(1)
  })

  it('Deny タップ → decide deny', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    const messageId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId,
        data: `dny|${approval.id}`,
      }),
    )
    expect(h.hub.approvals.get(approval.id)?.decision).toBe('deny')
    expect(String(h.stub.callsOf('editMessageText')[0]!.payload.text)).toContain('Denied')
  })

  it('二重タップ: 2 回目は decide されず「クローズ済み」応答', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    const messageId = h.stub.lastMessageId()
    const tap = () =>
      h!.dispatch(
        h!.stub.makeCallbackUpdate({
          fromId: USER_ID,
          chatId: CHAT_ID,
          messageId,
          data: `apr|${approval.id}`,
        }),
      )

    await tap()
    await tap()
    expect(decideRequestCount(h)).toBe(1)
    const answers = h.stub.callsOf('answerCallbackQuery')
    expect(answers).toHaveLength(2)
    expect(String(answers[1]!.payload.text)).toContain('クローズ済み')
  })

  it('別経路で決着済みの承認をタップ → 409 → 別経路フッタで無効化', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    const messageId = h.stub.lastMessageId()
    // SSE を張っていないので notification-updated は届かず、タップ時の 409 で気づく経路になる
    h.hub.decideExternally(approval.id, 'deny', 'PC で対応', 'g2')

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId,
        data: `apr|${approval.id}`,
      }),
    )
    const edit = h.stub.callsOf('editMessageText')[0]!
    expect(String(edit.payload.text)).toContain('別経路 (g2) で対応済み')
    expect(String(edit.payload.text)).toContain('PC で対応')
    const answer = h.stub.callsOf('answerCallbackQuery')[0]!
    expect(String(answer.payload.text)).toContain('別経路で対応済み')
    expect(answer.payload.show_alert).toBe(true)
  })

  it('notification-updated で PC 側決着が即時反映される', async () => {
    h = await createHarness()
    await h.startSse()
    const { approval } = h.hub.createApproval()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)

    h.hub.cleanupApproval(approval.id, 'terminal-disconnect', 'terminal')
    await waitFor(() => h!.stub.callsOf('editMessageText').length >= 1)
    expect(String(h.stub.callsOf('editMessageText')[0]!.payload.text)).toContain('PC 側で対応済み')
  })

  it('stale 承認へのタップは decide せず期限切れ化する(再起動直後の queued callback 再現)', async () => {
    // postCutoff を広げて「hook タイムアウト済み(stale)の承認が投稿済み」の状態を作り、
    // reconciliation の expire が反映される前にユーザーがタップするケースを再現する
    h = await createHarness({ postCutoffMs: 10_000_000, staleMs: 600_000 })
    const { approval } = h.hub.createApproval({
      broadcast: false,
      createdAt: new Date(Date.now() - 601_000).toISOString(),
    })
    await h.reconciler.runOnce() // 投稿のみ(expire は次周期のため未反映)
    const messageId = h.stub.lastMessageId()
    const tap = () =>
      h!.dispatch(
        h!.stub.makeCallbackUpdate({
          fromId: USER_ID,
          chatId: CHAT_ID,
          messageId,
          data: `apr|${approval.id}`,
        }),
      )

    await tap()
    // decide が Hub に飛ばない = 「CC に届かないのに Hub 上だけ decided」を防止
    expect(decideRequestCount(h)).toBe(0)
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending')
    // ボタン無効化(expired 編集)+ ユーザーへ期限切れを alert 通知
    const edit = h.stub.callsOf('editMessageText')[0]!
    expect(edit.payload.message_id).toBe(messageId)
    expect(String(edit.payload.text)).toContain('期限切れ')
    const answer = h.stub.callsOf('answerCallbackQuery')[0]!
    expect(String(answer.payload.text)).toContain('期限切れ')
    expect(answer.payload.show_alert).toBe(true)

    // クローズ後の再タップもローカルで弾かれ decide されない
    await tap()
    expect(decideRequestCount(h)).toBe(0)
  })

  it('境界レース対策: stale 手前(585s)のタップも decide せず期限切れ化する(600s − マージン 30s)', async () => {
    // 585s は staleMs(600s)未満だが decide cutoff(600s − 30s = 570s)超過。
    // ここで decide を通すと hook(2 秒間隔ポーリング)が観測する前に 600s タイムアウトに
    // 食われうるため、ガードで遮断されることを確認する
    h = await createHarness({ postCutoffMs: 10_000_000, staleMs: 600_000 })
    const { approval } = h.hub.createApproval({
      broadcast: false,
      createdAt: new Date(Date.now() - 585_000).toISOString(),
    })
    await h.reconciler.runOnce()
    const messageId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId,
        data: `apr|${approval.id}`,
      }),
    )
    expect(decideRequestCount(h)).toBe(0)
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending')
    expect(String(h.stub.callsOf('editMessageText')[0]!.payload.text)).toContain('期限切れ')
    expect(String(h.stub.callsOf('answerCallbackQuery')[0]!.payload.text)).toContain('期限切れ')
  })

  it('境界レース対策: cutoff 未満(500s)のタップは通常どおり decide される', async () => {
    h = await createHarness({ postCutoffMs: 10_000_000, staleMs: 600_000 })
    const { approval } = h.hub.createApproval({
      broadcast: false,
      createdAt: new Date(Date.now() - 500_000).toISOString(),
    })
    await h.reconciler.runOnce()
    const messageId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeCallbackUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        messageId,
        data: `apr|${approval.id}`,
      }),
    )
    expect(decideRequestCount(h)).toBe(1)
    expect(h.hub.approvals.get(approval.id)?.status).toBe('decided')
    expect(h.hub.approvals.get(approval.id)?.decision).toBe('approve')
  })

  it('decide 一時失敗 → alert 提示・ボタン残置 → 再タップで成功(自動リトライしない)', async () => {
    h = await createHarness()
    const { approval } = h.hub.createApproval({ broadcast: false })
    await h.reconciler.runOnce()
    const messageId = h.stub.lastMessageId()
    const tap = () =>
      h!.dispatch(
        h!.stub.makeCallbackUpdate({
          fromId: USER_ID,
          chatId: CHAT_ID,
          messageId,
          data: `apr|${approval.id}`,
        }),
      )

    h.hub.failNextDecide()
    await tap()
    // 失敗時: alert、メッセージ編集なし、Hub 側は pending のまま
    const answer = h.stub.callsOf('answerCallbackQuery')[0]!
    expect(String(answer.payload.text)).toContain('失敗')
    expect(answer.payload.show_alert).toBe(true)
    expect(h.stub.callsOf('editMessageText')).toHaveLength(0)
    expect(h.hub.approvals.get(approval.id)?.status).toBe('pending')

    // 再タップで成功
    await tap()
    expect(h.hub.approvals.get(approval.id)?.status).toBe('decided')
    expect(h.stub.callsOf('editMessageText')).toHaveLength(1)
  })
})
