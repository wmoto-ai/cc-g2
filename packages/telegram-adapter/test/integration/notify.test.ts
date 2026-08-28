import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_ID, createHarness, USER_ID, type Harness } from '../fixtures/harness'
import { waitFor } from '../fixtures/util'

let h: Harness | undefined

afterEach(async () => {
  await h?.close()
  h = undefined
})

describe('Stop 通知・画像', () => {
  it('Stop 通知が投稿され、返信が 1 行正規化 + source=telegram で中継される', async () => {
    h = await createHarness()
    await h.startSse()
    h.hub.setRelay({ enabled: true, sources: ['g2', 'web', 'telegram'] })
    h.hub.pushStopNotification({ title: 'Session finished', body: '完了しました\n詳細は後で' })
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    const stopCall = h.stub.callsOf('sendMessage')[0]!
    expect(String(stopCall.payload.text)).toContain('Session finished')
    expect(String(stopCall.payload.text)).toContain('返信するとセッションへ送信されます')
    const stopMsgId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeTextUpdate({
        fromId: USER_ID,
        chatId: CHAT_ID,
        text: '続けて\nお願い',
        replyTo: stopMsgId,
      }),
    )
    expect(h.hub.replies).toHaveLength(1)
    expect(h.hub.replies[0]!.rawBody.source).toBe('telegram')
    expect(h.hub.replies[0]!.rawBody.replyText).toBe('続けて お願い') // 改行の 1 行正規化
    const feedback = h.stub.callsOf('sendMessage').at(-1)!
    expect(String(feedback.payload.text)).toContain('送信しました')
  })

  it('TTL 超過した Stop 通知へのテキスト返信は追跡外として扱う', async () => {
    h = await createHarness({ stopReplyTtlMs: 50 })
    await h.startSse()
    h.hub.setRelay({ enabled: true, sources: ['g2', 'web', 'telegram'] })
    h.hub.pushStopNotification()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    const stopMsgId = h.stub.lastMessageId()
    await new Promise((resolve) => setTimeout(resolve, 80))

    await h.dispatch(
      h.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text: '遅い返信', replyTo: stopMsgId }),
    )
    expect(h.hub.replies).toHaveLength(0)
    const feedback = h.stub.callsOf('sendMessage').at(-1)!
    expect(String(feedback.payload.text)).toContain('返信先を特定できませんでした')
  })

  it('relay allowlist に telegram がないと stubbed の案内を返す', async () => {
    h = await createHarness()
    await h.startSse()
    h.hub.setRelay({ enabled: true, sources: ['g2', 'web'] })
    h.hub.pushStopNotification()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)
    const stopMsgId = h.stub.lastMessageId()

    await h.dispatch(
      h.stub.makeTextUpdate({ fromId: USER_ID, chatId: CHAT_ID, text: 'テスト', replyTo: stopMsgId }),
    )
    const feedback = h.stub.callsOf('sendMessage').at(-1)!
    expect(String(feedback.payload.text)).toContain('HUB_REPLY_RELAY_SOURCES')
  })

  it('画像通知は sendPhoto、取得できない画像はテキストにフォールバック', async () => {
    h = await createHarness()
    await h.startSse()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    h.hub.pushImageNotification(png, 'スクショ')
    await waitFor(() => h!.stub.callsOf('sendPhoto').length >= 1)
    expect(h.stub.callsOf('sendPhoto')[0]!.payload.caption).toBe('スクショ\n· cc-g2:image')

    // 存在しない imageId の通知 → テキストフォールバック
    h.hub.pushRawEvent('notification-added', {
      id: `n-${randomUUID()}`,
      source: 'moshi',
      title: '消えた画像',
      summary: '',
      createdAt: new Date().toISOString(),
      replyCapable: true,
      metadata: { imageId: randomUUID() },
    })
    await waitFor(() =>
      h!.stub.callsOf('sendMessage').some((c) => String(c.payload.text).includes('取得に失敗')),
    )
  })

  it('同一通知の SSE 重複配信は 1 回だけ処理される', async () => {
    h = await createHarness()
    await h.startSse()
    const notification = h.hub.pushStopNotification()
    await waitFor(() => h!.stub.callsOf('sendMessage').length >= 1)

    const { fullText: _omit, ...listItem } = notification
    h.hub.pushRawEvent('notification-added', listItem)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.stub.callsOf('sendMessage')).toHaveLength(1)
  })
})
