/**
 * Notification Hub 連携（SSE 接続・ハンドラ・コンテキストポーリング）
 *
 * リファクタ Phase 4 で main.ts から無編集移動（モジュールレベル let → ctx.* の
 * 機械的書き換えと ctx 引数の受け渡しのみ）。可変状態は持たない（AppContext に集約）。
 */
import { appConfig, createHubHeaders } from '../config'
import { log } from '../log'
import { errorMessage } from '../app/format'
import type { NotificationItem } from '../notifications'
import type { NotificationUIState } from '../glasses-ui'
import type { AppContext, ContextSession, SessionActivityEntry } from '../app/context'

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

/** 通知のmetadata.cwdに一致するセッションのコンテキスト占有率を返す */
export function getContextPctForNotification(ctx: AppContext, detail: { metadata?: Record<string, unknown> }): number | undefined {
  const cwd = detail.metadata?.cwd
  if (typeof cwd !== 'string' || ctx.contextSessions.length === 0) return ctx.latestContextPct
  const matches = ctx.contextSessions.filter((s) => s.cwd === cwd)
  if (matches.length === 0) return ctx.latestContextPct
  return Math.max(...matches.map((s) => s.usedPercentage))
}

function canAutoOpenForScreen(screen: NotificationUIState['screen']): boolean {
  // 録音/送信中・詳細閲覧中・画像表示中は割り込まない。idle/list では新着優先で一覧へ寄せる。
  return screen !== 'reply-recording' && screen !== 'reply-confirm' && screen !== 'reply-confirm-actions' && screen !== 'reply-sending'
    && screen !== 'ask-question' && screen !== 'ask-question-detail'
    && screen !== 'detail' && screen !== 'detail-actions' && screen !== 'image-detail'
}

// 切り分けメモ (2026-06-10): 一時導入していた「ユーザー操作後2秒の静穏窓
// (isUserInteractionActive)」と「フラッシュ時の一覧再取得 (notifClient.list)」は撤去し、
// main と同じ挙動に戻した（タイミング機構自体がクラッシュ要因になっている疑いの二分のため）。
// 一覧再取得の撤去により他通知のステータス鮮度は下がるが、表示は次の遷移で追いつく。
export async function flushPendingNotificationUi(ctx: AppContext, reason: string) {
  if (!ctx.connection || ctx.glassesUI.isRendering()) return

  if (ctx.pendingAutoOpenOnNew && appConfig.notificationAutoOpenOnNew && canAutoOpenForScreen(ctx.notifState.screen)) {
    ctx.notifState.screen = 'list'
    ctx.notifState.selectedIndex = 0
    await ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
    ctx.pendingAutoOpenOnNew = false
    log(`通知自動更新: ${ctx.notifState.items.length}件 (保留中の自動表示を再試行して成功 reason=${reason})`)
    return
  }

  if (ctx.pendingListRefresh && ctx.notifState.screen === 'list') {
    await ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
    ctx.pendingListRefresh = false
    log(`通知自動更新: ${ctx.notifState.items.length}件 (保留中のリスト更新を再試行して成功 reason=${reason})`)
  }
}

function schedulePendingFlush(ctx: AppContext) {
  if (ctx.pendingFlushTimer) return
  ctx.pendingFlushTimer = setTimeout(() => {
    ctx.pendingFlushTimer = null
    if (!ctx.connection) return
    if (ctx.glassesUI.isRendering() && (ctx.pendingAutoOpenOnNew || ctx.pendingListRefresh)) {
      schedulePendingFlush(ctx)
      return
    }
    void flushPendingNotificationUi(ctx, 'sse-retry')
  }, 500)
}

// 画像転送中はSSEイベント処理を後回しにして転送ウィンドウを静かに保つ
// （経緯と実測は src/app/context.ts の imageTransferQuiet コメント参照）。
function deferSseDuringImageTransfer(ctx: AppContext, e: MessageEvent): boolean {
  if (!ctx.imageTransferQuiet) return false
  if (ctx.quietDeferredSse.length < 200) ctx.quietDeferredSse.push(e)
  return true
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

export function applySseEvent(ctx: AppContext, e: MessageEvent) {
  if (e.type === 'notification-added') void handleSseNotificationAdded(ctx, e)
  else if (e.type === 'notification-updated') void handleSseNotificationUpdated(ctx, e)
  else if (e.type === 'session-activity') handleSseSessionActivity(ctx, e)
}

function handleSseSessionActivity(ctx: AppContext, e: MessageEvent) {
  ctx.sessionActivities = JSON.parse(e.data) as SessionActivityEntry[]
  ctx.glassesUI.setSessionActivities(ctx.sessionActivities)
  if (ctx.notifState.screen === 'list' && ctx.connection) {
    if (!ctx.glassesUI.isRendering()) {
      void ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
    } else {
      ctx.pendingListRefresh = true
      schedulePendingFlush(ctx)
    }
  }
  ctx.ui.updateDashboard()
}

async function handleSseNotificationAdded(ctx: AppContext, e: MessageEvent) {
  const item: NotificationItem = JSON.parse(e.data)
  ctx.lastNotifRefreshAt = Date.now()

  const existingIdx = ctx.notifState.items.findIndex(n => n.id === item.id)
  if (existingIdx >= 0) {
    ctx.notifState.items[existingIdx] = item
  } else {
    ctx.notifState.items.unshift(item)
    if (ctx.notifState.items.length > 20) ctx.notifState.items.pop()
  }

  // auto-open ロジック（main と同じ即時描画。Hub 側の fan-out 撤去でバーストは解消済み）
  const wantsAutoOpen = appConfig.notificationAutoOpenOnNew
  const canAutoOpenNow = wantsAutoOpen && canAutoOpenForScreen(ctx.notifState.screen) && ctx.connection && !ctx.glassesUI.isRendering()

  if (canAutoOpenNow) {
    ctx.notifState.screen = 'list'
    ctx.notifState.selectedIndex = 0
    await ctx.glassesUI.showNotificationList(ctx.connection!, ctx.notifState.items)
    ctx.pendingAutoOpenOnNew = false
    log(`SSE新着通知: "${item.title}" (自動表示)`)
  } else if (wantsAutoOpen) {
    ctx.pendingAutoOpenOnNew = true
    schedulePendingFlush(ctx)
    log(`SSE新着通知: "${item.title}" (自動表示保留 screen=${ctx.notifState.screen})`)
  } else if (ctx.notifState.screen === 'list' && ctx.connection && !ctx.glassesUI.isRendering()) {
    await ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
    log(`SSE新着通知: "${item.title}" (リスト更新)`)
  } else {
    if (ctx.notifState.screen === 'list') {
      ctx.pendingListRefresh = true
      schedulePendingFlush(ctx)
    }
    log(`SSE新着通知: "${item.title}"`)
  }

  // 詳細画面のバッジ表示
  if ((ctx.notifState.screen === 'detail' || ctx.notifState.screen === 'detail-actions') && ctx.notifState.detailItem && ctx.connection) {
    const detail = ctx.notifState.detailItem
    const pages = ctx.glassesUI.getDetailPageCount(detail.fullText)
    const ctxSuffix = ctx.latestContextPct != null ? ` ctx:${Math.round(ctx.latestContextPct)}%` : ''
    const pageInfo = pages > 1 ? ` [${ctx.notifState.detailPageIndex + 1}/${pages}]${ctxSuffix}` : ctxSuffix
    const badgeHeader = `[●新着] ${detail.title}${pageInfo}`
    await ctx.glassesUI.updateDetailHeaderBadge(ctx.connection, badgeHeader)
  }

  ctx.ui.updateDashboard()
}

async function handleSseNotificationUpdated(ctx: AppContext, e: MessageEvent) {
  const item: NotificationItem = JSON.parse(e.data)
  ctx.lastNotifRefreshAt = Date.now()
  const idx = ctx.notifState.items.findIndex(n => n.id === item.id)
  if (idx >= 0) {
    ctx.notifState.items[idx] = item
  }
  if (ctx.notifState.screen === 'list' && ctx.connection) {
    if (!ctx.glassesUI.isRendering()) {
      await ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
    } else {
      ctx.pendingListRefresh = true
      schedulePendingFlush(ctx)
    }
  }
  ctx.ui.updateDashboard()
  log(`SSE通知更新: "${item.title}" status=${item.replyStatus ?? 'none'}`)
}
