import { afterEach, describe, expect, it } from 'vitest'
import { ADAPTER_SOURCE, HubClient, HubRequestError } from '../../src/hub/client'
import { startFixtureHub, type FixtureHub } from '../fixtures/hub-server'

let hub: FixtureHub | undefined

afterEach(async () => {
  await hub?.close()
  hub = undefined
})

describe('HubClient', () => {
  it('listPendingApprovals は pending のみ返し、token ヘッダを送る', async () => {
    hub = await startFixtureHub({ authToken: 'tok' })
    const client = new HubClient({ baseUrl: hub.url, authToken: 'tok' })
    const { approval: pending } = hub.createApproval({ broadcast: false })
    const { approval: decided } = hub.createApproval({ broadcast: false })
    hub.decideExternally(decided.id, 'approve')

    const items = await client.listPendingApprovals()
    expect(items.map((a) => a.id)).toEqual([pending.id])
    expect(hub.requests.at(-1)?.token).toBe('tok')
  })

  it('token 不一致は HubRequestError(401)', async () => {
    hub = await startFixtureHub({ authToken: 'tok' })
    const client = new HubClient({ baseUrl: hub.url, authToken: 'wrong' })
    await expect(client.listPendingApprovals()).rejects.toThrow(HubRequestError)
  })

  it('getApproval: 存在しない id は null', async () => {
    hub = await startFixtureHub()
    const client = new HubClient({ baseUrl: hub.url })
    expect(await client.getApproval('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('decide: 200 → decided、source=telegram が decidedBy に記録される', async () => {
    hub = await startFixtureHub()
    const client = new HubClient({ baseUrl: hub.url })
    const { approval } = hub.createApproval({ broadcast: false })

    const outcome = await client.decide(approval.id, 'approve')
    expect(outcome.outcome).toBe('decided')
    expect(hub.approvals.get(approval.id)?.status).toBe('decided')
    expect(hub.approvals.get(approval.id)?.decidedBy).toBe(ADAPTER_SOURCE)
  })

  it('decide: deny + comment がレコードに載る', async () => {
    hub = await startFixtureHub()
    const client = new HubClient({ baseUrl: hub.url })
    const { approval } = hub.createApproval({ broadcast: false })

    const outcome = await client.decide(approval.id, 'deny', 'やめて')
    expect(outcome.outcome).toBe('decided')
    expect(hub.approvals.get(approval.id)?.comment).toBe('やめて')
  })

  it('decide: 既決は already-decided(approval 同梱)', async () => {
    hub = await startFixtureHub()
    const client = new HubClient({ baseUrl: hub.url })
    const { approval } = hub.createApproval({ broadcast: false })
    hub.decideExternally(approval.id, 'deny', undefined, 'g2')

    const outcome = await client.decide(approval.id, 'approve')
    expect(outcome.outcome).toBe('already-decided')
    if (outcome.outcome === 'already-decided') {
      expect(outcome.approval.decision).toBe('deny')
      expect(outcome.approval.decidedBy).toBe('g2')
    }
  })

  it('decide: 未知 id は not-found', async () => {
    hub = await startFixtureHub()
    const client = new HubClient({ baseUrl: hub.url })
    const outcome = await client.decide('00000000-0000-0000-0000-000000000000', 'approve')
    expect(outcome.outcome).toBe('not-found')
  })

  it('getNotification: fullText を含む詳細が取れる', async () => {
    hub = await startFixtureHub()
    const client = new HubClient({ baseUrl: hub.url })
    const { notification } = hub.createApproval({
      toolInput: { command: 'pnpm test' },
      broadcast: false,
    })
    const detail = await client.getNotification(notification.id)
    expect(detail?.fullText).toBe('$ pnpm test')
  })

  it('reply は常に source=telegram を送る(省略という状態がない)', async () => {
    hub = await startFixtureHub()
    hub.setRelay({ enabled: true, sources: ['g2', 'web', 'telegram'] })
    const client = new HubClient({ baseUrl: hub.url })
    const notification = hub.pushStopNotification()

    const reply = await client.reply(notification.id, 'こんにちは')
    expect(reply.status).toBe('forwarded')
    expect(hub.replies[0]?.rawBody.source).toBe('telegram')
  })

  it('relay sources に telegram がないと stubbed(実 Hub の allowlist 仕様)', async () => {
    hub = await startFixtureHub()
    hub.setRelay({ enabled: true, sources: ['g2', 'web'] })
    const client = new HubClient({ baseUrl: hub.url })
    const notification = hub.pushStopNotification()

    const reply = await client.reply(notification.id, 'こんにちは')
    expect(reply.status).toBe('stubbed')
  })

  it('fetchImage: 取得できる / 404 は null', async () => {
    hub = await startFixtureHub()
    const client = new HubClient({ baseUrl: hub.url })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { imageId } = hub.pushImageNotification(png)

    const image = await client.fetchImage(imageId)
    expect(image?.data.equals(png)).toBe(true)
    expect(image?.contentType).toBe('image/png')

    hub.removeImage(imageId)
    expect(await client.fetchImage(imageId)).toBeNull()
  })

  it('接続不能は HubRequestError', async () => {
    const client = new HubClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 })
    await expect(client.listPendingApprovals()).rejects.toThrow(HubRequestError)
  })
})
