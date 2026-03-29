import { createHubHeaders } from './config'

/**
 * 通知ハブ API クライアント
 *
 * GET /api/notifications でポーリングし、通知一覧/詳細を取得する。
 */

export type NotificationItem = {
  id: string
  source: string
  title: string
  summary: string
  createdAt: string
  replyCapable: boolean
  metadata?: Record<string, unknown>
  /** 返信/承認ステータス: 'delivered'|'decided'|'replied'|'pending' */
  replyStatus?: string
}

export type NotificationDetail = NotificationItem & {
  fullText: string
  raw?: unknown
}

export type NotificationListResponse = {
  ok: boolean
  items: NotificationItem[]
}

export type NotificationDetailResponse = {
  ok: boolean
  item: NotificationDetail
}

export type NotificationReplyResponse = {
  ok: boolean
  reply?: {
    id: string
    status: string
    action?: string
    resolvedAction?: string
    result?: 'resolved' | 'relayed' | 'ignored'
    ignoredReason?: 'approval-not-pending' | 'approval-link-not-found'
    error?: string
  }
}

export type NotificationReplyRequest = {
  action: 'approve' | 'deny' | 'comment' | 'answer'
  comment?: string
  source?: 'g2' | 'web'
  /** AskUserQuestion の回答データ: { "質問テキスト": "選択ラベル" } */
  answerData?: Record<string, string>
}

export function createNotificationClient(baseUrl: string) {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    return res.json() as Promise<T>
  }

  return {
    async list(limit = 20): Promise<NotificationItem[]> {
      const res = await fetchJson<NotificationListResponse>(
        `/api/notifications?limit=${limit}`,
        { headers: createHubHeaders() },
      )
      return res.items
    },

    async detail(id: string): Promise<NotificationDetail> {
      const res = await fetchJson<NotificationDetailResponse>(
        `/api/notifications/${encodeURIComponent(id)}`,
        { headers: createHubHeaders() },
      )
      return res.item
    },

    async reply(
      id: string,
      reply: string | NotificationReplyRequest,
    ): Promise<NotificationReplyResponse> {
      const body =
        typeof reply === 'string'
          ? { replyText: reply }
          : {
              action: reply.action,
              comment: reply.comment,
              source: reply.source,
              answerData: reply.answerData,
            }
      return fetchJson<NotificationReplyResponse>(
        `/api/notifications/${encodeURIComponent(id)}/reply`,
        {
          method: 'POST',
          headers: createHubHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        },
      )
    },
  }
}
