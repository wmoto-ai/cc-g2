import { afterEach, describe, expect, it } from 'vitest'
import { createSseParser, SseSubscriber, type SseEvent } from '../../src/hub/sse'
import { createBackoff } from '../../src/util/backoff'
import { startFixtureHub, type FixtureHub } from '../fixtures/hub-server'
import { silentLogger, waitFor } from '../fixtures/util'

describe('createSseParser', () => {
  it('event/data の組を分割チャンクでも正しく組み立てる', () => {
    const events: SseEvent[] = []
    const parser = createSseParser((e) => events.push(e))
    parser.push('event: notification-')
    parser.push('added\ndata: {"id":')
    parser.push('"n1"}\n\nevent: notification-updated\ndata: {"id":"n2"}\n\n')
    expect(events).toEqual([
      { event: 'notification-added', data: '{"id":"n1"}' },
      { event: 'notification-updated', data: '{"id":"n2"}' },
    ])
  })

  it('コメント行(ping)と retry 行はイベントにならない', () => {
    const events: SseEvent[] = []
    const parser = createSseParser((e) => events.push(e))
    parser.push('retry: 5000\n\n: ping\n\n')
    expect(events).toEqual([])
  })

  it('event 行のみで data がないブロックは無視する', () => {
    const events: SseEvent[] = []
    const parser = createSseParser((e) => events.push(e))
    parser.push('event: orphan\n\n')
    expect(events).toEqual([])
  })

  it('複数 data 行は改行で連結、event 省略時は message', () => {
    const events: SseEvent[] = []
    const parser = createSseParser((e) => events.push(e))
    parser.push('data: a\ndata: b\n\n')
    expect(events).toEqual([{ event: 'message', data: 'a\nb' }])
  })

  it('CRLF 行末も扱える', () => {
    const events: SseEvent[] = []
    const parser = createSseParser((e) => events.push(e))
    parser.push('event: x\r\ndata: y\r\n\r\n')
    expect(events).toEqual([{ event: 'x', data: 'y' }])
  })
})

describe('SseSubscriber', () => {
  let hub: FixtureHub
  let subscriber: SseSubscriber

  afterEach(async () => {
    subscriber?.stop()
    await hub?.close()
  })

  function createSubscriber(events: SseEvent[], onConnect: () => void): SseSubscriber {
    return new SseSubscriber({
      url: `${hub.url}/api/events`,
      onEvent: (e) => events.push(e),
      onConnect,
      logger: silentLogger,
      backoff: createBackoff({ baseMs: 20, maxMs: 50, jitter: 0 }),
      heartbeatTimeoutMs: 60_000,
    })
  }

  it('接続時に onConnect、イベント受信、切断後は自動再接続する', async () => {
    hub = await startFixtureHub()
    const events: SseEvent[] = []
    let connects = 0
    subscriber = createSubscriber(events, () => {
      connects += 1
    })
    subscriber.start()
    await hub.waitForSseClient()
    // サーバ側のクライアント登録とクライアント側の fetch 解決は非同期なので待つ
    await waitFor(() => connects === 1)

    hub.createApproval()
    await waitFor(() => events.length >= 1)
    expect(events[0]?.event).toBe('notification-added')
    const item = JSON.parse(events[0]!.data) as Record<string, unknown>
    expect((item.metadata as Record<string, unknown>).approvalId).toBeTruthy()
    // SSE の list item は fullText を含まない(実 Hub 仕様)
    expect(item.fullText).toBeUndefined()

    // 強制切断 → バックオフ後に再接続し onConnect が再度呼ばれる
    hub.dropSseClients()
    await waitFor(() => connects === 2)

    // 未知イベントもパーサはそのまま流す(無視はルータの責務)
    hub.pushRawEvent('session-activity', { sessions: [] })
    await waitFor(() => events.some((e) => e.event === 'session-activity'))
  })

  it('ハートビート途絶で強制再接続する', async () => {
    hub = await startFixtureHub()
    const events: SseEvent[] = []
    let connects = 0
    subscriber = new SseSubscriber({
      url: `${hub.url}/api/events`,
      onEvent: (e) => events.push(e),
      onConnect: () => {
        connects += 1
      },
      logger: silentLogger,
      backoff: createBackoff({ baseMs: 20, maxMs: 50, jitter: 0 }),
      heartbeatTimeoutMs: 100,
    })
    subscriber.start()
    await hub.waitForSseClient()
    // ping を一切送らない → heartbeatTimeoutMs 経過で abort → 再接続
    await waitFor(() => connects >= 2, 3_000)
  })

  it('stop() で再接続ループが止まる', async () => {
    hub = await startFixtureHub()
    let connects = 0
    subscriber = createSubscriber([], () => {
      connects += 1
    })
    subscriber.start()
    await hub.waitForSseClient()
    subscriber.stop()
    hub.dropSseClients()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(connects).toBe(1)
    expect(hub.sseClientCount()).toBe(0)
  })
})
