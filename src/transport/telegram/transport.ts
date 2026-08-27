/**
 * TelegramTransport — Telegram(GramJS userbot)経由で Transport 抽象を実装する。
 * Tailscale / Hub 到達性なしで G2 体験を成立させる。
 *
 * 真実の源は cc-tg bot とのチャット:
 * - 一覧/詳細: チャット履歴のマーカー付きメッセージ(model.ts で変換)
 * - Approve/Deny: 実 inline ボタンの押下(アダプタのガードがそのまま効く)
 * - コメント: reply_to 付き送信(アダプタの既存中継経路)
 * - 決着反映: editMessage 更新の購読(アダプタの editMessageText がそのまま来る)
 */
import { log } from '../../log'
import { errorMessage } from '../../app/format'
import type { NotificationItem, NotificationReplyRequest, NotificationReplyResponse } from '../../notifications'
import type { AppContext } from '../../app/context'
import {
  deferSseDuringImageTransfer,
  handleSseNotificationAdded,
  handleSseNotificationUpdated,
  schedulePendingFlush,
  type TransportEventMessage,
} from '../../app/notification-events'
import { SonioxRealtimeSTT } from '../../stt/soniox-realtime'
import type { Transport } from '../types'
import { TgClient } from './client'
import {
  classifyTgMessage,
  parseStatusPayload,
  toNotificationDetail,
  toNotificationItem,
  type TgMessageKind,
  type TgMessageLike,
  type TgStatusPayload,
} from './model'
import type { TelegramSettings } from './settings'

const LIST_FETCH_LIMIT = 50 // マーカー無し(other)を除外しても 20 件残るよう多めに取る
// ピン留めステータスの鮮度上限。アダプタ停止中の古い ctx% を G2 に出さない
// (アダプタの更新間隔 30 秒 × 余裕 10 倍)
const STATUS_STALE_SEC = 300

interface CachedEntry {
  msg: TgMessageLike
  kind: TgMessageKind
}

export function createTelegramTransport(client: TgClient, settings: TelegramSettings): Transport {
  const chat = settings.chat
  const cache = new Map<number, CachedEntry>()
  let subscribed = false
  let boundCtx: AppContext | null = null
  let latestStatus: TgStatusPayload | null = null

  /**
   * ステータスペイロードを hub モードと同じ ctx 面に反映する。
   * null = アダプタ側の取得失敗 → 前回値を維持。[] = 0 件 → 表示をクリア。
   * 反映後の再描画は hub モードの handleSseSessionActivity と同じ扱い
   * (一覧表示中ならヘッダ再描画 + ダッシュボード更新)。
   */
  function applyStatus(payload: TgStatusPayload): void {
    if (payload.ts * 1000 < Date.now() - STATUS_STALE_SEC * 1000) return
    if (latestStatus && payload.ts < latestStatus.ts) return
    latestStatus = payload
    const ctx = boundCtx
    if (!ctx) return
    if (payload.contextSessions != null) {
      ctx.contextSessions = payload.contextSessions
      ctx.latestContextPct = payload.contextSessions.length > 0
        ? Math.max(...payload.contextSessions.map((s) => s.usedPercentage))
        : undefined
    }
    if (payload.sessionActivities != null) {
      ctx.sessionActivities = payload.sessionActivities
      ctx.glassesUI.setSessionActivities(ctx.sessionActivities)
      if (ctx.notifState.screen === 'list' && ctx.connection) {
        if (!ctx.glassesUI.isRendering()) {
          void ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
        } else {
          ctx.pendingListRefresh = true
          schedulePendingFlush(ctx)
        }
      }
    }
    ctx.ui.updateDashboard()
  }

  function upsert(m: TgMessageLike): CachedEntry | null {
    const kind = classifyTgMessage(m)
    if (kind === 'status') {
      const payload = parseStatusPayload(m.text)
      if (payload) applyStatus(payload)
      return null // 通知一覧には出さない
    }
    if (kind === 'other') return null
    const entry = { msg: m, kind }
    cache.set(m.id, entry)
    return entry
  }

  function cachedItems(limit: number): NotificationItem[] {
    return [...cache.values()]
      .sort((a, b) => b.msg.id - a.msg.id)
      .slice(0, limit)
      .map((e) => toNotificationItem(e.msg, e.kind))
  }

  const notifications = {
    async list(limit = 20): Promise<NotificationItem[]> {
      const messages = await client.getRecentMessages(chat, LIST_FETCH_LIMIT)
      for (const m of messages) upsert(m)
      return cachedItems(limit)
    },

    async detail(id: string) {
      const entry = cache.get(Number(id))
      if (!entry) throw new Error(`notification ${id} not found`)
      return toNotificationDetail(entry.msg, entry.kind)
    },

    async reply(id: string, reply: NotificationReplyRequest): Promise<NotificationReplyResponse> {
      const messageId = Number(id)
      const entry = cache.get(messageId)
      if (!entry) return { ok: false, reply: { id, status: 'failed', error: 'メッセージが見つかりません' } }

      if (reply.action === 'approve' || reply.action === 'deny') {
        if (entry.kind !== 'approval') {
          return {
            ok: false,
            reply: { id, status: 'failed', result: 'ignored', ignoredReason: 'approval-link-not-found' },
          }
        }
        const prefix = reply.action === 'approve' ? 'apr|' : 'dny|'
        try {
          const answer = await client.clickButton(chat, messageId, prefix)
          // アダプタは無効な承認にも answerCallbackQuery で応答する(「期限切れ」等)。
          // 成功系文言(承認しました/拒否しました)以外は失敗として G2 に見せる
          const okAnswer = answer == null || answer.includes('承認しました') || answer.includes('拒否しました')
          if (!okAnswer) {
            return { ok: false, reply: { id, status: 'failed', error: answer ?? 'unknown' } }
          }
          return { ok: true, reply: { id, status: 'decided', action: reply.action, result: 'resolved' } }
        } catch (err) {
          return { ok: false, reply: { id, status: 'failed', error: errorMessage(err) } }
        }
      }

      if (reply.action === 'comment') {
        const comment = (reply.comment ?? '').trim()
        if (!comment) return { ok: true }
        try {
          await client.sendReply(chat, comment, messageId)
          return { ok: true, reply: { id, status: 'replied', action: 'comment', result: 'relayed' } }
        } catch (err) {
          return { ok: false, reply: { id, status: 'failed', error: errorMessage(err) } }
        }
      }

      // answer(AskUserQuestion)は Phase B(アダプタ側の選択肢ボタン対応とセット)
      return { ok: false, reply: { id, status: 'failed', error: 'telegram モードでは未対応の操作です' } }
    },
  }

  return {
    mode: 'telegram',
    notifications,

    async fetchImageBlob(imageId: string): Promise<Blob> {
      const messageId = Number(imageId.replace(/^tg:/, ''))
      if (!Number.isFinite(messageId)) throw new Error(`invalid image ref: ${imageId}`)
      return client.downloadPhoto(messageId)
    },

    connectEvents(ctx: AppContext) {
      if (subscribed) return
      subscribed = true
      boundCtx = ctx
      log(`telegram events: 購読開始 (chat=${chat})`)
      client.subscribe(chat, (m, edited) => {
        const before = cache.has(m.id)
        const entry = upsert(m)
        if (!entry) return
        const item = toNotificationItem(entry.msg, entry.kind)
        const type = edited || before ? 'notification-updated' : 'notification-added'
        const event: TransportEventMessage = { type, data: JSON.stringify(item) }
        if (deferSseDuringImageTransfer(ctx, event)) return
        if (type === 'notification-added') void handleSseNotificationAdded(ctx, event)
        else void handleSseNotificationUpdated(ctx, event)
      })

      const refreshList = async (reason: string): Promise<void> => {
        try {
          const items = await notifications.list(20)
          ctx.notifState.items = items
          ctx.lastNotifRefreshAt = Date.now()
          ctx.hubReachable = true
          ctx.ui.updateDashboard()
          if (ctx.notifState.screen === 'list' && ctx.connection && !ctx.glassesUI.isRendering()) {
            await ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
          }
        } catch (err) {
          ctx.hubReachable = false
          ctx.ui.updateDashboard()
          log(`telegram events: リスト取得失敗 (${reason}): ${errorMessage(err)}`)
        }
      }

      // 初期リスト取得(hub モードの SSE open 相当)
      void refreshList('initial')

      // ピン留めステータスの初期取得。edit は id が古いまま進むため履歴 LIST_FETCH_LIMIT 件の
      // 圏外に脱落しうる — ピンから直接拾う(以後の更新は EditedMessage 購読で届く)。
      // ユーザーが別メッセージをピンしていてもよいよう複数件を走査する(分類は upsert 任せ)
      void client
        .getPinnedMessages(chat)
        .then((messages) => {
          for (const m of messages) upsert(m)
        })
        .catch((err) => {
          log(`telegram events: ピン留めステータス取得失敗(継続): ${errorMessage(err)}`)
        })

      // Wi-Fi ⇔ LTE 切替で WSS が黙って死ぬため、watchdog で切断検知 → 再接続 →
      // 切断中の取りこぼしを履歴再取得で回収する(GramJS の connectionRetries 任せに
      // しない。ERGram 由来の弱点への対策)
      let reconnecting = false
      const attemptReconnect = async (trigger: string): Promise<void> => {
        if (reconnecting) return
        if (client.isConnected()) return
        reconnecting = true
        ctx.hubReachable = false
        ctx.ui.updateDashboard()
        log(`telegram events: 切断検知 (${trigger}) — 再接続します`)
        try {
          await client.reconnect()
          log('telegram events: 再接続成功 — 履歴を再同期')
          await refreshList('reconnect')
        } catch (err) {
          log(`telegram events: 再接続失敗 (${trigger}): ${errorMessage(err)}`)
        } finally {
          reconnecting = false
        }
      }
      setInterval(() => {
        void attemptReconnect('watchdog')
      }, 15_000)
      globalThis.addEventListener?.('online', () => {
        void attemptReconnect('online-event')
      })
    },

    createRealtimeStt() {
      const key = settings.sonioxKey.trim()
      if (!key) return null
      return new SonioxRealtimeSTT(async () => key)
    },

    async transcribeBatch(chunks) {
      // telegram モードのバッチ STT は無し(Hub 非到達)。Soniox キー未設定時のみ通る
      void chunks
      return {
        text: '',
        provider: 'mock' as const,
      }
    },
  }
}
