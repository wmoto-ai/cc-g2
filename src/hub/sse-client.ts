/**
 * Notification Hub 連携（SSE 接続・コンテキストポーリング）— hub トランスポート専用
 *
 * Phase A リファクタで UI 反映ロジックを src/app/notification-events.ts へ分離した。
 * このモジュールに残るのは EventSource の配線と Hub 固有のポーリングのみ。
 */
import { appConfig, createHubHeaders } from '../config'
import { log } from '../log'
import { errorMessage } from '../app/format'
import type { AppContext, ContextSession, SessionActivityEntry } from '../app/context'
import {
  applySseEvent,
  deferSseDuringImageTransfer,
  handleSseNotificationAdded,
  handleSseNotificationUpdated,
  handleSseSessionActivity,
} from '../app/notification-events'

// --- Context status polling ---
async function fetchContextStatus(ctx: AppContext) {
  try {
    const res = await fetch(`${appConfig.notificationHubUrl}/api/context-status`, {
      headers: createHubHeaders(),
    })
    if (res.ok) {
      const data = await res.json() as { ok: boolean; sessions: ContextSession[] }
      if (data.sessions && data.sessions.length > 0) {
        ctx.contextSessions = data.sessions
        ctx.latestContextPct = Math.max(...data.sessions.map((s) => s.usedPercentage))
      }
    }
  } catch { /* ignore */ }
  try {
    const res = await fetch(`${appConfig.notificationHubUrl}/api/session-activity`, {
      headers: createHubHeaders(),
    })
    if (res.ok) {
      const data = await res.json() as { ok: boolean; sessions: SessionActivityEntry[] }
      if (data.sessions) {
        ctx.sessionActivities = data.sessions
        ctx.glassesUI.setSessionActivities(ctx.sessionActivities)
      }
    }
  } catch { /* ignore */ }
}

export function connectNotificationSSE(ctx: AppContext) {
  if (ctx.sseSource) return

  const sseUrl = `${appConfig.notificationHubUrl}/api/events`
  log(`SSE接続開始: ${sseUrl}`)
  ctx.sseSource = new EventSource(sseUrl)

  let sseSynced = false
  let sseQueue: MessageEvent[] = []

  ctx.sseSource.addEventListener('open', async () => {
    ctx.hubReachable = true
    ctx.ui.updateDashboard()
    log('SSE接続成功')
    try {
      const items = await ctx.notifClient.list(20)
      ctx.notifState.items = items
      ctx.lastNotifRefreshAt = Date.now()
      ctx.ui.updateDashboard()
      if (ctx.notifState.screen === 'list' && ctx.connection && !ctx.glassesUI.isRendering()) {
        await ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
      }
    } catch (err) {
      log(`SSE初期リスト取得失敗: ${errorMessage(err)}`)
    } finally {
      // list取得の成否を問わず、キューに溜まったSSEイベントをマージ
      sseSynced = true
      for (const e of sseQueue) {
        applySseEvent(ctx, e)
      }
      sseQueue = []
    }
  })

  ctx.sseSource.addEventListener('error', () => {
    ctx.hubReachable = false
    sseSynced = false
    sseQueue = []
    ctx.ui.updateDashboard()
  })

  ctx.sseSource.addEventListener('notification-added', (e: MessageEvent) => {
    if (!sseSynced) { sseQueue.push(e); return }
    if (deferSseDuringImageTransfer(ctx, e)) return
    void handleSseNotificationAdded(ctx, e)
  })

  ctx.sseSource.addEventListener('notification-updated', (e: MessageEvent) => {
    if (!sseSynced) { sseQueue.push(e); return }
    if (deferSseDuringImageTransfer(ctx, e)) return
    void handleSseNotificationUpdated(ctx, e)
  })

  ctx.sseSource.addEventListener('session-activity', (e: MessageEvent) => {
    if (deferSseDuringImageTransfer(ctx, e)) return
    handleSseSessionActivity(ctx, e)
  })

  // context-status は SSE と無関係、別タイマーで低頻度ポーリング
  if (!ctx.contextPollTimer) {
    fetchContextStatus(ctx)
    ctx.contextPollTimer = setInterval(() => {
      if (ctx.connection) fetchContextStatus(ctx)
    }, 30_000)
  }
}
