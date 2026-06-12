/**
 * G2 画面遷移フロー（一覧復帰・待機復帰・画像表示・AskUserQuestion 遷移）
 *
 * リファクタ Phase 4 で main.ts から無編集移動（モジュールレベル let → ctx.* の
 * 機械的書き換えと ctx 引数の受け渡しのみ）。可変状態は持たない（AppContext に集約）。
 */
import { appConfig, createHubHeaders } from '../config'
import { log } from '../log'
import { errorMessage } from '../app/format'
import { isAskUserQuestionNotification } from '../app/ask-question'
import { buildNotificationActions, type AskQuestionData } from '../glasses-ui'
import { buildImageTiles } from '../image/image-pipeline'
import { G2_EVENT, getNormalizedEventType } from '../even-events'
import { IDLE_REOPEN_COOLDOWN_MS, IMAGE_BACK_COOLDOWN_MS, type AppContext } from '../app/context'
import { applySseEvent, flushPendingNotificationUi } from '../hub/sse-client'

// 送信結果画面からリスト一覧に復帰する共通処理
export async function returnToListFromResult(ctx: AppContext) {
  if (ctx.notifState.screen === 'list') return // 既に復帰済み
  // ユーザーが自力で待機画面に戻った場合は割り込まない
  if (ctx.notifState.screen === 'idle') return
  log('結果画面 → 通知一覧に復帰')
  ctx.notifState.replyText = ''
  if (ctx.connection) {
    try {
      ctx.notifState.items = await ctx.notifClient.list(20)
    } catch { /* fallback to cached */ }
  }
  await returnToListScreen(ctx)
  await flushPendingNotificationUi(ctx, 'result-return')
}

/** 返信/録音画面から元の操作画面（ask-question or detail-actions）に戻る */
export async function returnToReplyOriginScreen(ctx: AppContext): Promise<void> {
  if (ctx.notifState.detailItem && isAskUserQuestionNotification(ctx.notifState.detailItem) && ctx.notifState.askQuestions.length > 0) {
    ctx.notifState.screen = 'ask-question'
    const q = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
    if (ctx.connection) {
      await ctx.glassesUI.showAskUserQuestion(ctx.connection, q, ctx.notifState.askQuestionIndex, ctx.notifState.askQuestions.length)
    }
  } else {
    ctx.notifState.screen = 'detail-actions'
    if (ctx.notifState.detailItem && ctx.connection) {
      ctx.notifState.detailActions = buildNotificationActions(ctx.notifState.detailItem)
      await ctx.glassesUI.showNotificationActions(ctx.connection, ctx.notifState.detailItem, ctx.notifState.detailActions)
    }
  }
  ctx.ui.updateNotifInfo()
}

/**
 * 通知に添付された画像を G2 に表示する（detail-actions → image-detail）
 *
 * Hub から画像を取得 → canvas でタイル分割 → showImage で転送。
 * 失敗時はアクションメニューに戻す。
 */
export async function openImageDetail(ctx: AppContext): Promise<void> {
  if (!ctx.connection || !ctx.notifState.detailItem) return
  const imageId = typeof ctx.notifState.detailItem.metadata?.imageId === 'string'
    ? ctx.notifState.detailItem.metadata.imageId
    : ''
  if (!imageId) {
    log('画像表示: imageId がありません')
    return
  }

  log(`画像表示開始: imageId=${imageId}`)
  ctx.notifState.screen = 'image-detail'
  ctx.ui.updateNotifInfo()
  // 転送ウィンドウの静音化: レイアウト構築〜タイル転送の間に届いたSSEは後回しにする
  // （deferSseDuringImageTransfer 参照。転送0.4秒後のSSE到着でクラッシュした実測あり）
  ctx.imageTransferQuiet = true
  try {
    const res = await fetch(`${appConfig.notificationHubUrl}/api/images/${encodeURIComponent(imageId)}`, {
      headers: createHubHeaders(),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const tiles = await buildImageTiles(blob)
    const ok = await ctx.glassesUI.showImage(ctx.connection, tiles)
    // BLE転送直後の画面遷移はホスト競合でクラッシュし得るため、戻る操作を短時間ブロック
    ctx.imageBackBlockedUntil = Date.now() + IMAGE_BACK_COOLDOWN_MS
    if (!ok) log('画像表示: 一部タイルの送信に失敗（画面は表示継続）')
  } catch (err) {
    log(`画像表示失敗: ${errorMessage(err)}`)
    if (ctx.notifState.screen === 'image-detail' && ctx.notifState.detailItem) {
      ctx.notifState.screen = 'detail-actions'
      ctx.notifState.detailActions = buildNotificationActions(ctx.notifState.detailItem)
      await ctx.glassesUI.showNotificationActions(ctx.connection, ctx.notifState.detailItem, ctx.notifState.detailActions)
    }
  } finally {
    ctx.imageTransferQuiet = false
    const deferred = ctx.quietDeferredSse
    ctx.quietDeferredSse = []
    if (deferred.length > 0) log(`画像表示: 繰り延べたSSEイベント ${deferred.length}件を処理`)
    for (const e of deferred) applySseEvent(ctx, e)
  }
  ctx.ui.updateNotifInfo()
}

/** AskUserQuestion の質問画面に遷移する（短い質問は選択肢直接、長い質問は詳細ページ経由） */
export async function navigateToAskQuestion(ctx: AppContext, question: AskQuestionData, questionIndex: number, totalQuestions: number): Promise<void> {
  if (!ctx.connection || !ctx.notifState.detailItem) return
  if (ctx.glassesUI.isAskQuestionShort(question)) {
    ctx.notifState.screen = 'ask-question'
    await ctx.glassesUI.showAskUserQuestion(ctx.connection, question, questionIndex, totalQuestions)
  } else {
    const fullText = ctx.glassesUI.buildAskQuestionFullText(question, questionIndex, totalQuestions)
    const pageCount = ctx.glassesUI.getDetailPageCount(fullText)
    ctx.notifState.detailPages = Array.from({ length: pageCount }, (_, i) => String(i))
    ctx.notifState.detailPageIndex = 0
    ctx.notifState.screen = 'ask-question-detail'
    const syntheticDetail = { ...ctx.notifState.detailItem, title: 'AskUserQuestion', fullText }
    await ctx.glassesUI.showNotificationDetail(ctx.connection, syntheticDetail, 0, pageCount)
    ctx.lastDetailScrollAt = Date.now()
  }
  clearPendingScrollEvent(ctx)
  ctx.ui.updateNotifInfo()
}

/** 通知一覧画面に遷移し、状態をリセットして描画する */
export async function returnToListScreen(ctx: AppContext): Promise<void> {
  ctx.notifState.screen = 'list'
  ctx.notifState.detailItem = null
  ctx.notifState.selectedIndex = 0
  ctx.notifState.askQuestions = []
  ctx.notifState.askQuestionIndex = 0
  ctx.notifState.askAnswers = {}
  if (ctx.connection) {
    await ctx.glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
  }
  ctx.ui.updateNotifInfo()
}

export function clearPendingNotifEvent(ctx: AppContext) {
  ctx.pendingNotifEvent = null
  if (ctx.pendingNotifEventFlushTimer) {
    clearTimeout(ctx.pendingNotifEventFlushTimer)
    ctx.pendingNotifEventFlushTimer = null
  }
}

/** キュー中のイベントがスクロールの場合のみクリアする（tap/doubleTap等は保持） */
export function clearPendingScrollEvent(ctx: AppContext) {
  if (!ctx.pendingNotifEvent) return
  const eventType = getNormalizedEventType(ctx.pendingNotifEvent)
  if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
    clearPendingNotifEvent(ctx)
  }
}

export async function enterIdleScreen(ctx: AppContext, reason: string) {
  ctx.notifState.screen = 'idle'
  ctx.notifState.detailItem = null
  ctx.notifState.replyText = ''
  ctx.idleTapDuringRender = false
  ctx.lastIdleEventAt = 0
  ctx.idleOpenBlockedUntil = Date.now() + IDLE_REOPEN_COOLDOWN_MS
  // ユーザーが明示的に待機画面に戻ったので、保留中の自動復帰を取り消す
  ctx.pendingAutoOpenOnNew = false
  ctx.pendingListRefresh = false
  clearPendingNotifEvent(ctx)
  if (ctx.connection) {
    await ctx.glassesUI.showIdleLauncher(ctx.connection, { dimMode: appConfig.notificationIdleDimMode })
  }
  ctx.ui.updateNotifInfo()
  log(`${reason} (idle reopen blocked ${IDLE_REOPEN_COOLDOWN_MS}ms)`)
}
