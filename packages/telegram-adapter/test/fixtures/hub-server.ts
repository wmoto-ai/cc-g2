// fixture Hub: Notification Hub の契約を再現した in-process HTTP サーバ。
// レスポンス形状は server/notification-hub/ の実出力に合わせる。
// 実仕様の再現ポイント:
//  - GET /api/approvals は pending のみ
//  - decide は 200 / 409(approval 同梱) / 404
//  - reply の relay source ゲートは「source 空文字はバイパスされて中継される」
//  - SSE は notification-added / notification-updated 以外のイベントも流れうる(pushRawEvent)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type {
  ApprovalDecision,
  ApprovalRecord,
  NotificationDetail,
  NotificationListItem,
} from '../../src/hub/types'

export interface CreateApprovalOptions {
  toolName?: string
  toolInput?: unknown
  cwd?: string
  agentName?: string
  createdAt?: string
  hookType?: 'permission-request' | 'ask-user-question'
  /** false にすると SSE を流さない(SSE 停止中の発生を再現) */
  broadcast?: boolean
}

export interface RecordedReply {
  notificationId: string
  rawBody: Record<string, unknown>
  status: 'stubbed' | 'forwarded'
}

export interface FixtureHub {
  url: string
  authToken: string
  approvals: Map<string, ApprovalRecord>
  notifications: Map<string, NotificationDetail>
  replies: RecordedReply[]
  requests: Array<{ method: string; path: string; token: string | undefined }>
  createApproval(options?: CreateApprovalOptions): {
    approval: ApprovalRecord
    notification: NotificationDetail
  }
  decideExternally(id: string, decision: ApprovalDecision, comment?: string, decidedBy?: string): void
  cleanupApproval(id: string, resolution: string, decidedBy?: string): void
  pushStopNotification(options?: {
    title?: string
    body?: string
    metadata?: Record<string, unknown>
  }): NotificationDetail
  pushImageNotification(image: Buffer, title?: string): { imageId: string; notification: NotificationDetail }
  removeImage(imageId: string): void
  pushRawEvent(event: string, data: unknown): void
  setRelay(options: { enabled: boolean; sources?: string[] }): void
  /** 次の decide リクエスト 1 回だけ 500 を返す(Hub 一時故障の再現) */
  failNextDecide(): void
  sseClientCount(): number
  waitForSseClient(timeoutMs?: number): Promise<void>
  dropSseClients(): void
  close(): Promise<void>
}

function toListItem(n: NotificationDetail): NotificationListItem {
  const { fullText: _fullText, ...rest } = n
  return rest
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function startFixtureHub(options: { authToken?: string } = {}): Promise<FixtureHub> {
  const authToken = options.authToken ?? ''
  const approvals = new Map<string, ApprovalRecord>()
  const notifications = new Map<string, NotificationDetail>()
  const images = new Map<string, Buffer>()
  const replies: RecordedReply[] = []
  const requests: FixtureHub['requests'] = []
  const sseClients = new Set<ServerResponse>()
  let relay: { enabled: boolean; sources: Set<string> } = {
    enabled: false,
    sources: new Set(['g2', 'web']),
  }
  let decideFailuresLeft = 0

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of sseClients) client.write(payload)
  }

  function finalize(
    approval: ApprovalRecord,
    fields: Partial<ApprovalRecord>,
    broadcastUpdate = true,
  ): void {
    approval.status = 'decided'
    approval.decidedAt = new Date().toISOString()
    Object.assign(approval, fields)
    const notification = notifications.get(approval.notificationId)
    if (notification && broadcastUpdate) {
      broadcast('notification-updated', { ...toListItem(notification), replyStatus: 'decided' })
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const token = req.headers['x-cc-g2-token']
    requests.push({ method, path, token: typeof token === 'string' ? token : undefined })

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const requireAuth = (): boolean => {
      if (!authToken || token === authToken) return true
      json(401, { ok: false, error: 'Unauthorized' })
      return false
    }

    if (method === 'GET' && path === '/api/health') {
      return json(200, { ok: true, service: 'fixture-hub' })
    }

    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.write('retry: 5000\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    if (method === 'GET' && path === '/api/approvals') {
      if (!requireAuth()) return
      const items = [...approvals.values()].filter((a) => a.status === 'pending')
      return json(200, { ok: true, items })
    }

    const decideMatch = path.match(/^\/api\/approvals\/([^/]+)\/decide$/)
    if (method === 'POST' && decideMatch) {
      if (!requireAuth()) return
      if (decideFailuresLeft > 0) {
        decideFailuresLeft -= 1
        return json(500, { ok: false, error: 'Internal error (injected)' })
      }
      const approval = approvals.get(decideMatch[1]!)
      if (!approval) return json(404, { ok: false, error: 'Approval not found' })
      if (approval.status !== 'pending') {
        return json(409, { ok: false, error: 'Approval already decided', approval })
      }
      const body = await readJson(req)
      const decision = body.decision
      if (decision !== 'approve' && decision !== 'deny') {
        return json(400, { ok: false, error: '`decision` must be "approve" or "deny"' })
      }
      finalize(approval, {
        decision,
        comment: typeof body.comment === 'string' && body.comment ? body.comment : undefined,
        decidedBy: typeof body.source === 'string' && body.source ? body.source : undefined,
      })
      return json(200, { ok: true, approval })
    }

    const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
    if (method === 'GET' && approvalMatch) {
      if (!requireAuth()) return
      const approval = approvals.get(approvalMatch[1]!)
      if (!approval) return json(404, { ok: false, error: 'Approval not found' })
      return json(200, { ok: true, approval })
    }

    const replyMatch = path.match(/^\/api\/notifications\/([^/]+)\/reply$/)
    if (method === 'POST' && replyMatch) {
      if (!requireAuth()) return
      const notification = notifications.get(replyMatch[1]!)
      if (!notification) return json(404, { ok: false, error: 'Notification not found' })
      const body = await readJson(req)
      const source = typeof body.source === 'string' ? body.source : ''
      // 実 Hub 仕様の再現: relay 有効時、source 空文字は allowlist チェックをバイパスして中継される
      let status: 'stubbed' | 'forwarded' = 'stubbed'
      if (relay.enabled) {
        const blocked = relay.sources.size > 0 && source !== '' && !relay.sources.has(source)
        status = blocked ? 'stubbed' : 'forwarded'
      }
      replies.push({ notificationId: notification.id, rawBody: body, status })
      const record = {
        id: randomUUID(),
        notificationId: notification.id,
        replyText: typeof body.replyText === 'string' ? body.replyText : '',
        createdAt: new Date().toISOString(),
        status,
        source: source || undefined,
      }
      return json(200, { ok: true, reply: record })
    }

    const notifMatch = path.match(/^\/api\/notifications\/([^/]+)$/)
    if (method === 'GET' && notifMatch) {
      const notification = notifications.get(notifMatch[1]!)
      if (!notification) return json(404, { ok: false, error: 'Notification not found' })
      return json(200, { ok: true, item: notification })
    }

    const imageMatch = path.match(/^\/api\/images\/([^/]+)$/)
    if (method === 'GET' && imageMatch) {
      const image = images.get(imageMatch[1]!)
      if (!image) return json(404, { ok: false, error: 'Image not found' })
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length })
      res.end(image)
      return
    }

    return json(404, { ok: false, error: 'Not found' })
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    authToken,
    approvals,
    notifications,
    replies,
    requests,

    createApproval(opts: CreateApprovalOptions = {}) {
      const approvalId = randomUUID()
      const toolName = opts.toolName ?? 'Bash'
      const toolInput = opts.toolInput ?? { command: 'echo hello' }
      const command = (toolInput as { command?: unknown } | null)?.command
      const preview = typeof command === 'string' ? `$ ${command}` : JSON.stringify(toolInput)
      const createdAt = opts.createdAt ?? new Date().toISOString()
      const agentName = opts.agentName ?? 'claude-code'
      const notification: NotificationDetail = {
        id: randomUUID(),
        source: 'claude-code',
        title: toolName,
        summary: preview.slice(0, 64),
        fullText: preview,
        createdAt,
        replyCapable: true,
        metadata: {
          hookType: opts.hookType ?? 'permission-request',
          approvalId,
          externalId: `approval:${approvalId}`,
          toolName,
          cwd: opts.cwd ?? '/tmp/demo',
          agentName,
          sessionId: 'sess-1',
          tmuxTarget: 'demo:0.0',
          sessionLabel: '#1',
        },
      }
      const approval: ApprovalRecord = {
        id: approvalId,
        notificationId: notification.id,
        source: `${agentName}-hook`,
        toolName,
        toolInput,
        toolId: '',
        cwd: opts.cwd ?? '/tmp/demo',
        reason: '',
        agentName,
        status: 'pending',
        createdAt,
      }
      approvals.set(approvalId, approval)
      notifications.set(notification.id, notification)
      if (opts.broadcast !== false) broadcast('notification-added', toListItem(notification))
      return { approval, notification }
    },

    decideExternally(id, decision, comment, decidedBy = 'g2') {
      const approval = approvals.get(id)
      if (!approval || approval.status !== 'pending') throw new Error(`not pending: ${id}`)
      finalize(approval, { decision, comment: comment || undefined, decidedBy })
    },

    cleanupApproval(id, resolution, decidedBy = 'terminal') {
      const approval = approvals.get(id)
      if (!approval || approval.status !== 'pending') throw new Error(`not pending: ${id}`)
      finalize(approval, { decision: undefined, resolution, decidedBy })
    },

    pushStopNotification(opts = {}) {
      const notification: NotificationDetail = {
        id: randomUUID(),
        source: 'claude-code',
        title: opts.title ?? 'Session finished',
        summary: (opts.body ?? '作業が完了しました').slice(0, 64),
        fullText: opts.body ?? '作業が完了しました',
        createdAt: new Date().toISOString(),
        replyCapable: true,
        metadata: {
          hookType: 'stop',
          sessionId: 'sess-1',
          tmuxTarget: 'demo:0.0',
          sessionLabel: '#1',
          cwd: '/tmp/demo',
          ...opts.metadata,
        },
      }
      notifications.set(notification.id, notification)
      broadcast('notification-added', toListItem(notification))
      return notification
    },

    pushImageNotification(image, title = 'Screenshot') {
      const imageId = randomUUID()
      images.set(imageId, image)
      const notification: NotificationDetail = {
        id: randomUUID(),
        source: 'moshi',
        title,
        summary: `画像が届きました (png, ${Math.round(image.length / 1024)}KB)`,
        fullText: `画像が届きました (png, ${Math.round(image.length / 1024)}KB)`,
        createdAt: new Date().toISOString(),
        replyCapable: true,
        metadata: { imageId },
      }
      notifications.set(notification.id, notification)
      broadcast('notification-added', toListItem(notification))
      return { imageId, notification }
    },

    removeImage(imageId) {
      images.delete(imageId)
    },

    pushRawEvent(event, data) {
      broadcast(event, data)
    },

    setRelay(opts) {
      relay = { enabled: opts.enabled, sources: new Set(opts.sources ?? ['g2', 'web']) }
    },

    failNextDecide() {
      decideFailuresLeft += 1
    },

    sseClientCount() {
      return sseClients.size
    },

    async waitForSseClient(timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs
      while (sseClients.size === 0) {
        if (Date.now() > deadline) throw new Error('no SSE client connected in time')
        await new Promise((r) => setTimeout(r, 10))
      }
    },

    dropSseClients() {
      for (const client of sseClients) client.destroy()
      sseClients.clear()
    },

    async close() {
      for (const client of sseClients) client.destroy()
      sseClients.clear()
      // undici の keep-alive ソケットが残ると server.close が数秒待つため強制切断
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}
