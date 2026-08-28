/**
 * 通知イベントの UI 反映(輸送路非依存)
 *
 * hub/sse-client.ts から Phase A リファクタで無編集移動(輸送路の分離のみ)。
 * EventSource(hub)/ MTProto updates(telegram)のどちらから来たイベントも、
 * `{ type, data }` の TransportEventMessage に正規化してここで UI に反映する。
 * 関数名の Sse は歴史的経緯(挙動不変を優先し改名しない)。
 */
import { appConfig } from '../config'
import { log } from '../log'
import { t } from '../i18n'
import type { NotificationItem } from '../notifications'
import type { NotificationUIState } from '../glasses-ui'
import { ALL_FILTER } from '../g2/session-groups'
import type { AppContext, SessionActivityEntry } from './context'

/** EventSource の MessageEvent と構造互換の最小イベント型 */
export type TransportEventMessage = { type: string; data: string }

/**
 * 一覧を全件表示に戻す（絞り込みを解除する）。新着自動表示などで使う。
 * ctx 側の状態と、引数省略の再描画が参照する glassesUI 側フィルタの両方を同期する。
 */
export function resetListFilter(ctx: AppContext): void {
  ctx.notifState.sessionFilter = null
  ctx.notifState.sessionFilterLabel = ''
  ctx.glassesUI.setListFilter(ALL_FILTER)
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
    && screen !== 'session-list'
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
    resetListFilter(ctx)
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

export function schedulePendingFlush(ctx: AppContext) {
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
export function deferSseDuringImageTransfer(ctx: AppContext, e: TransportEventMessage): boolean {
  if (!ctx.imageTransferQuiet) return false
  if (ctx.quietDeferredSse.length < 200) ctx.quietDeferredSse.push(e)
  return true
}

export function applySseEvent(ctx: AppContext, e: TransportEventMessage) {
  if (e.type === 'notification-added') void handleSseNotificationAdded(ctx, e)
  else if (e.type === 'notification-updated') void handleSseNotificationUpdated(ctx, e)
  else if (e.type === 'session-activity') handleSseSessionActivity(ctx, e)
}

export function handleSseSessionActivity(ctx: AppContext, e: TransportEventMessage) {
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

export async function handleSseNotificationAdded(ctx: AppContext, e: TransportEventMessage) {
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
    resetListFilter(ctx)
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
    const badgeHeader = `${t('badge_new')} ${detail.title}${pageInfo}`
    await ctx.glassesUI.updateDetailHeaderBadge(ctx.connection, badgeHeader)
  }

  ctx.ui.updateDashboard()
}

export async function handleSseNotificationUpdated(ctx: AppContext, e: TransportEventMessage) {
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
