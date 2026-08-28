import { errorMessage } from '../logger'
import type {
  ApprovalDecision,
  ApprovalRecord,
  ContextSessionRecord,
  DecideOutcome,
  NotificationDetail,
  ReplyRecord,
  SessionActivityRecord,
} from './types'

/**
 * reply / decide に載せる source。Hub の relay allowlist(HUB_REPLY_RELAY_SOURCES)の判定材料であり、
 * relay.mjs は source が空文字だとチェックをバイパスして中継してしまうため、省略という状態を作らない。
 */
export const ADAPTER_SOURCE = 'telegram'

export class HubRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'HubRequestError'
  }
}

export interface HubClientOptions {
  baseUrl: string
  authToken?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

export class HubClient {
  private readonly baseUrl: string
  private readonly authToken: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(options: HubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.authToken = options.authToken ?? ''
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchFn = options.fetchFn ?? fetch
  }

  private headers(withJson = false): Record<string, string> {
    const headers: Record<string, string> = {}
    if (withJson) headers['content-type'] = 'application/json'
    // 公開エンドポイントにも付けて無害。要 token エンドポイントの分岐を持たない
    if (this.authToken) headers['x-cc-g2-token'] = this.authToken
    return headers
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      throw new HubRequestError(
        `hub request failed: ${init.method ?? 'GET'} ${path}: ${errorMessage(err)}`,
      )
    }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: T }> {
    const res = await this.request(path, init)
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new HubRequestError(`hub returned non-JSON (HTTP ${res.status}) for ${path}`, res.status)
    }
    return { status: res.status, body: body as T }
  }

  /** GET /api/approvals — Hub 仕様により pending のみが返る */
  async listPendingApprovals(): Promise<ApprovalRecord[]> {
    const { status, body } = await this.requestJson<{ ok?: boolean; items?: ApprovalRecord[] }>(
      '/api/approvals',
      { headers: this.headers() },
    )
    if (status !== 200 || !body.ok || !Array.isArray(body.items)) {
      throw new HubRequestError(`GET /api/approvals failed (HTTP ${status})`, status)
    }
    return body.items
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const { status, body } = await this.requestJson<{ ok?: boolean; approval?: ApprovalRecord }>(
      `/api/approvals/${encodeURIComponent(id)}`,
      { headers: this.headers() },
    )
    if (status === 404) return null
    if (status !== 200 || !body.ok || !body.approval) {
      throw new HubRequestError(`GET /api/approvals/:id failed (HTTP ${status})`, status)
    }
    return body.approval
  }

  /**
   * POST /api/approvals/:id/decide。409(既決)は正常系の分岐として返す。
   * ネットワーク失敗は HubRequestError を投げる — 呼び出し側は自動リトライせず
   * ユーザーに再タップさせる方針(plan §6)。
   */
  async decide(id: string, decision: ApprovalDecision, comment?: string): Promise<DecideOutcome> {
    const { status, body } = await this.requestJson<{
      ok?: boolean
      approval?: ApprovalRecord
      error?: string
    }>(`/api/approvals/${encodeURIComponent(id)}/decide`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        decision,
        comment: comment || undefined,
        source: ADAPTER_SOURCE,
      }),
    })
    if (status === 200 && body.approval) return { outcome: 'decided', approval: body.approval }
    if (status === 409 && body.approval) return { outcome: 'already-decided', approval: body.approval }
    if (status === 404) return { outcome: 'not-found' }
    throw new HubRequestError(`decide failed (HTTP ${status}): ${body.error ?? 'unknown'}`, status)
  }

  async getNotification(id: string): Promise<NotificationDetail | null> {
    const { status, body } = await this.requestJson<{ ok?: boolean; item?: NotificationDetail }>(
      `/api/notifications/${encodeURIComponent(id)}`,
      { headers: this.headers() },
    )
    if (status === 404) return null
    if (status !== 200 || !body.ok || !body.item) {
      throw new HubRequestError(`GET /api/notifications/:id failed (HTTP ${status})`, status)
    }
    return body.item
  }

  /** POST /api/notifications/:id/reply。source は常に telegram(型レベルで省略不能) */
  async reply(notificationId: string, replyText: string): Promise<ReplyRecord> {
    const { status, body } = await this.requestJson<{
      ok?: boolean
      reply?: ReplyRecord
      error?: string
    }>(`/api/notifications/${encodeURIComponent(notificationId)}/reply`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ replyText, source: ADAPTER_SOURCE }),
    })
    if (status !== 200 || !body.ok || !body.reply) {
      throw new HubRequestError(`reply failed (HTTP ${status}): ${body.error ?? 'unknown'}`, status)
    }
    return body.reply
  }

  /** GET /api/context-status — エージェント各セッションのコンテキスト使用率 */
  async getContextStatus(): Promise<ContextSessionRecord[]> {
    const { status, body } = await this.requestJson<{ ok?: boolean; sessions?: ContextSessionRecord[] }>(
      '/api/context-status',
      { headers: this.headers() },
    )
    if (status !== 200 || !body.ok || !Array.isArray(body.sessions)) {
      throw new HubRequestError(`GET /api/context-status failed (HTTP ${status})`, status)
    }
    return body.sessions
  }

  /** GET /api/session-activity — tmux セッションの活動状態 */
  async getSessionActivity(): Promise<SessionActivityRecord[]> {
    const { status, body } = await this.requestJson<{ ok?: boolean; sessions?: SessionActivityRecord[] }>(
      '/api/session-activity',
      { headers: this.headers() },
    )
    if (status !== 200 || !body.ok || !Array.isArray(body.sessions)) {
      throw new HubRequestError(`GET /api/session-activity failed (HTTP ${status})`, status)
    }
    return body.sessions
  }

  /** GET /api/images/:id。prune 済み(404)は null */
  async fetchImage(imageId: string): Promise<{ data: Buffer; contentType: string } | null> {
    const res = await this.request(`/api/images/${encodeURIComponent(imageId)}`, {
      headers: this.headers(),
    })
    if (res.status === 404) return null
    if (!res.ok) throw new HubRequestError(`GET /api/images/:id failed (HTTP ${res.status})`, res.status)
    const buf = Buffer.from(await res.arrayBuffer())
    return { data: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
  }
}
