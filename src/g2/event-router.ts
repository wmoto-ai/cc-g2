/**
 * G2 イベントルーティング（画面×イベントの状態機械）
 *
 * リファクタ Phase 4 で main.ts から無編集移動（モジュールレベル let → ctx.* の
 * 機械的書き換えと ctx 引数の受け渡しのみ）。
 *
 * 不変条件（docs/refactor-plan.md / docs/known-limitations.md 参照）:
 * - handleNotifEvent の try/finally による notifEventInFlight 解放は外側1箇所を維持する
 * - 画面分岐は notifState.screen の厳密一致 else-if 連鎖（排他的）。handler map への
 *   変換は禁止（条件の重なり・早期 return の意味が壊れる）
 * - idle 画面の分岐は isRendering() ガードより前にあることが仕様
 *   （描画中タップを idleTapDuringRender 保留フラグで拾うため）
 * - ガード窓定数群と保留イベント（pendingNotifEvent）の分岐順は数値・ロジックとも不変
 */
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from '../bridge'
import { log } from '../log'
import { transcribePcmChunks } from '../stt/groq'
import { errorMessage, getReplyResultMessage } from '../app/format'
import { extractAskQuestions, isAskUserQuestionNotification } from '../app/ask-question'
import { buildNotificationActions } from '../glasses-ui'
import { G2_EVENT, isDoubleTapEventType, normalizeHubEvent } from '../even-events'
import {
  DETAIL_SCROLL_COOLDOWN_MS,
  TAP_SCROLL_SUPPRESS_MS,
  IDLE_DOUBLE_TAP_WINDOW_MS,
  LIST_OPEN_CLOSE_GUARD_MS,
  REPLY_CONFIRM_EVENT_GUARD_MS,
  type AppContext,
} from '../app/context'
import { getContextPctForNotification } from '../hub/sse-client'
import {
  clearPendingNotifEvent,
  clearPendingScrollEvent,
  enterIdleScreen,
  navigateToAskQuestion,
  openImageDetail,
  returnToListFromResult,
  returnToListScreen,
  returnToReplyOriginScreen,
} from './flows'
import { showReplyConfirmTextPage, startReplyRecording } from './recording'

function queuePendingNotifEvent(ctx: AppContext, conn: BridgeConnection, event: EvenHubEvent) {
  ctx.pendingNotifEvent = event
  if (ctx.pendingNotifEventFlushTimer) return
  ctx.pendingNotifEventFlushTimer = setTimeout(() => {
    ctx.pendingNotifEventFlushTimer = null
    if (ctx.glassesUI.isRendering() || ctx.notifEventInFlight || !ctx.pendingNotifEvent) {
      if (ctx.pendingNotifEvent) queuePendingNotifEvent(ctx, conn, ctx.pendingNotifEvent)
      return
    }
    const nextEvent = ctx.pendingNotifEvent
    ctx.pendingNotifEvent = null
    void handleNotifEvent(ctx, conn, nextEvent)
  }, 120)
}

function shouldIgnoreDetailScroll(ctx: AppContext, eventType: number | undefined): boolean {
  if (eventType !== G2_EVENT.SCROLL_TOP && eventType !== G2_EVENT.SCROLL_BOTTOM) return false
  const now = Date.now()
  if ((now - ctx.lastTapEventAt) < TAP_SCROLL_SUPPRESS_MS) {
    log('[event] detail scroll suppressed: tap直後')
    return true
  }
  if ((now - ctx.lastDetailScrollAt) < DETAIL_SCROLL_COOLDOWN_MS) {
    log('[event] detail scroll suppressed: cooldown')
    return true
  }
  ctx.lastDetailScrollAt = now
  return false
}

// G2イベントリスナーを接続に登録（再接続時は新しい eventHandlers 配列になるため再登録が必要）
export function ensureNotifEventHandler(ctx: AppContext, conn: BridgeConnection) {
  if (ctx.notifEventRegisteredFor === conn) return
  conn.onEvent((event) => {
      void handleNotifEvent(ctx, conn, event)
  })
  ctx.notifEventRegisteredFor = conn
}

async function handleNotifEvent(ctx: AppContext, conn: BridgeConnection, event: EvenHubEvent) {
  if (ctx.notifEventInFlight) {
    queuePendingNotifEvent(ctx, conn, event)
    return
  }
  ctx.notifEventInFlight = true
  try {
      if (!ctx.connection) return
      const normalized = normalizeHubEvent(event)
      if (normalized.kind === 'unknown') {
        log(
          `[event] ignored unknown screen=${ctx.notifState.screen} text=${JSON.stringify(event.textEvent)} list=${JSON.stringify(event.listEvent)} sys=${JSON.stringify(event.sysEvent)}`,
        )
        return
      }
      const eventType = normalized.eventType
      if (normalized.kind === 'tap' || normalized.kind === 'doubleTap') {
        ctx.lastTapEventAt = Date.now()
      }

      // idle画面のダブルタップ判定
      // G2実機は textEvent/listEvent なしの2連イベントを送る。
      // 描画中にタップが来た場合は保留フラグを立て、描画完了後の次イベントで即開く。
      if (ctx.notifState.screen === 'idle') {
        const now = Date.now()
        const isDoubleTapEvent = isDoubleTapEventType(eventType)
        const isTapLikeEvent = normalized.kind === 'tap' || normalized.kind === 'doubleTap'
        const isRapidTap = isTapLikeEvent && (now - ctx.lastIdleEventAt) < IDLE_DOUBLE_TAP_WINDOW_MS
        if (now < ctx.idleOpenBlockedUntil) {
          if (isTapLikeEvent) {
            log(`[event] idle open suppressed: cooldown remaining=${ctx.idleOpenBlockedUntil - now}ms`)
            ctx.lastIdleEventAt = now
          }
          return
        }
        if (isTapLikeEvent) ctx.lastIdleEventAt = now
        if (ctx.glassesUI.isRendering()) {
          if (!isTapLikeEvent) return
          ctx.idleTapDuringRender = true
          log(`[event] idle描画中 (保留フラグON)`)
          return
        }
        // 描画中保留タップ or 短時間連打 or SDK DOUBLE_CLICK のいずれかで発動
        const shouldOpen = ctx.idleTapDuringRender || isDoubleTapEvent || isRapidTap
        log(`[event] screen=idle eventType=${eventType} rapid=${isRapidTap} pending=${ctx.idleTapDuringRender} open=${shouldOpen}`)
        ctx.idleTapDuringRender = false
        if (!shouldOpen) return
        if (ctx.notifState.items.length === 0) {
          log('通知がありません。先に取得してください。')
          return
        }
        ctx.lastIdleEventAt = 0
        ctx.listOpenedFromIdleAt = Date.now()
        ctx.notifState.screen = 'list'
        ctx.notifState.selectedIndex = 0
        await ctx.glassesUI.showNotificationList(ctx.connection!, ctx.notifState.items)
        ctx.ui.updateNotifInfo()
        log('待機画面から通知一覧を表示')
        return
      }

      if (ctx.glassesUI.isRendering()) {
        // 画像転送中(image-detail描画中)のイベントは保留せず破棄する。
        // 転送完了直後にキューされたタップが発火して画面遷移すると、BLE転送直後の
        // ホストと競合してEven Appごとクラッシュする事象が実機で確認されたため。
        if (ctx.notifState.screen === 'image-detail') {
          log('[event] 画像転送中のため破棄 (操作は転送完了後に)')
          return
        }
        log('[event] 描画中のため保留')
        queuePendingNotifEvent(ctx, conn, event)
        return
      }

      log(
        `[event] screen=${ctx.notifState.screen} eventType=${eventType} text=${JSON.stringify(event.textEvent)} list=${JSON.stringify(event.listEvent)} sys=${JSON.stringify(event.sysEvent)}`,
      )

      if (ctx.notifState.screen === 'list') {
        if (isDoubleTapEventType(eventType)) {
          // idle→一覧を開いた直後の誤クローズ防止: 開いた瞬間のダブルタップは
          // 1発で一覧を開くため、同ジェスチャの残りイベントがここでクローズを
          // 踏むと「一瞬一覧が見えてすぐ消える」フラッシュになる。短時間は無視する。
          const sinceOpen = Date.now() - ctx.listOpenedFromIdleAt
          if (sinceOpen < LIST_OPEN_CLOSE_GUARD_MS) {
            log(`[event] 一覧クローズ抑制: open直後 ${sinceOpen}ms (オープン動作の残りイベント)`)
            return
          }
          await enterIdleScreen(ctx, '通知一覧を閉じて待機に戻る (double tap)')
          return
        }

        // SDK標準ListContainer: listEventからクリック選択を取得
        // ※実機ではスクロール方向が物理操作と逆（ファームウェア仕様、許容）
        if (normalized.source === 'list') {
          if (normalized.containerName !== 'notif-list') return
          const maybeIndex = typeof normalized.index === 'number'
            ? normalized.index
            : ctx.notifState.selectedIndex
          if (typeof maybeIndex !== 'number') {
            log('通知一覧: index未同梱イベントのため無視')
            return
          }
          const index = maybeIndex
          ctx.notifState.selectedIndex = index
          const item = ctx.notifState.items[index]
          if (!item) return
          log(`通知選択: "${item.title}" (index=${ctx.notifState.selectedIndex})`)
          try {
            const detail = await ctx.notifClient.detail(item.id)
            ctx.notifState.detailItem = detail

            // AskUserQuestion: 短い質問は選択肢画面へ直接、長い質問は詳細画面を先に表示
            if (isAskUserQuestionNotification(detail)) {
              const questions = extractAskQuestions(detail)
              if (questions.length > 0) {
                ctx.notifState.askQuestions = questions
                ctx.notifState.askQuestionIndex = 0
                ctx.notifState.askAnswers = {}
                await navigateToAskQuestion(ctx, questions[0], 0, questions.length)
                return
              }
            }

            const pageCount = ctx.glassesUI.getDetailPageCount(detail.fullText)
            ctx.notifState.detailPages = Array.from({ length: pageCount }, (_, i) => String(i))
            ctx.notifState.detailPageIndex = 0
            ctx.notifState.screen = 'detail'
            await ctx.glassesUI.showNotificationDetail(ctx.connection!, detail, 0, pageCount, getContextPctForNotification(ctx, detail))
            // 描画中（createStartUpフォールバックで数秒かかる）にキューされたスクロールイベントを破棄
            // tap/doubleTap等の非スクロールイベントは保持する
            clearPendingScrollEvent(ctx)
            ctx.lastDetailScrollAt = Date.now()
            ctx.ui.updateNotifInfo()
          } catch (err) {
            log(`通知詳細取得失敗: ${errorMessage(err)}`)
          }
        }
      } else if (ctx.notifState.screen === 'detail') {
        // 詳細画面: スクロールでページ送り＋画面遷移
        if (!ctx.notifState.detailItem) return
        // ghostリストコンテナからのイベントを無視（detail画面ではtextEventとsysEventのみ有効）
        if (normalized.source === 'list') return
        // detailPages は showNotificationDetail() で都度算出される（ここでは長さのみ参照）
        const pageCount = ctx.notifState.detailPages.length
        if (isDoubleTapEventType(eventType)) {
          log('通知詳細: double tap → リストに戻る')
          await returnToListScreen(ctx)
          return
        }
        if (shouldIgnoreDetailScroll(ctx, eventType)) return

        // 一覧画面と同じく、実機の逆方向スクロール挙動をそのまま許容する。
        // eventType=1 (物理下) → 前ページ / 最初のページで更に戻る → リストに戻る
        // eventType=2 (物理上) → 次ページ / 最終ページで更に進む → アクションメニュー
        if (eventType === G2_EVENT.SCROLL_TOP) {
          if (ctx.notifState.detailPageIndex > 0) {
            ctx.notifState.detailPageIndex--
            await ctx.glassesUI.showNotificationDetail(
              ctx.connection!, ctx.notifState.detailItem, ctx.notifState.detailPageIndex, pageCount, getContextPctForNotification(ctx, ctx.notifState.detailItem),
            )
            // 描画完了後にスクロールイベントのみクリア＋クールダウン更新（誤発火を防止）
            clearPendingScrollEvent(ctx)
            ctx.lastDetailScrollAt = Date.now()
            ctx.ui.updateNotifInfo()
          } else {
            log('通知詳細: 最初のページ → リストに戻る')
            await returnToListScreen(ctx)
          }
          return
        }

        // eventType=2 → 次ページ / 最終ページで更に進む → アクションメニュー
        if (eventType === G2_EVENT.SCROLL_BOTTOM) {
          if (ctx.notifState.detailPageIndex < pageCount - 1) {
            ctx.notifState.detailPageIndex++
            await ctx.glassesUI.showNotificationDetail(
              ctx.connection!, ctx.notifState.detailItem, ctx.notifState.detailPageIndex, pageCount, getContextPctForNotification(ctx, ctx.notifState.detailItem),
            )
            // 描画完了後にスクロールイベントのみクリア＋クールダウン更新（誤発火を防止）
            clearPendingScrollEvent(ctx)
            ctx.lastDetailScrollAt = Date.now()
          } else if (ctx.notifState.detailItem.replyCapable) {
            log('通知詳細: 最終ページ → アクションメニュー')
            ctx.notifState.screen = 'detail-actions'
            ctx.notifState.detailActions = buildNotificationActions(ctx.notifState.detailItem)
            await ctx.glassesUI.showNotificationActions(ctx.connection!, ctx.notifState.detailItem, ctx.notifState.detailActions)
          }
          ctx.ui.updateNotifInfo()
          return
        }
      } else if (ctx.notifState.screen === 'detail-actions') {
        if (!ctx.notifState.detailItem) return

        // SDK標準ListContainer: listEventからクリック選択を取得
        // メニュー項目は notifState.detailActions（typed 配列）の id でディスパッチする
        if (normalized.source === 'list') {
          const index = normalized.index ?? 0
          const action = ctx.notifState.detailActions[index]
          if (!action) {
            log(`通知アクション: 不明な index=${index} (actions=${ctx.notifState.detailActions.length})`)
            return
          }

          if (action.id === 'back') {
            log('通知アクション: 一覧に戻る')
            await returnToListScreen(ctx)
            return
          }

          if (action.id === 'approve' || action.id === 'deny') {
            const replyAction = action.id
            log(`通知アクション送信: ${replyAction} notificationId=${ctx.notifState.detailItem.id}`)
            ctx.notifState.screen = 'reply-sending'
            ctx.ui.updateNotifInfo()
            try {
              const res = await ctx.notifClient.reply(ctx.notifState.detailItem.id, {
                action: replyAction,
                source: 'g2',
              })
              const status = res.reply?.status || 'ok'
              const result = getReplyResultMessage(res)
              log(`通知アクション送信完了: action=${replyAction} status=${status}`)
              // await 中にユーザー操作でリストに戻っていたら結果画面をスキップ
              if (ctx.notifState.screen === 'reply-sending') {
                if (result.ok) {
                  await ctx.glassesUI.showReplyResult(ctx.connection!, true, replyAction === 'approve' ? 'Approve' : 'Deny')
                } else {
                  await ctx.glassesUI.showReplyResult(ctx.connection!, false, result.message || status)
                }
              }
            } catch (err) {
              const msg = errorMessage(err)
              log(`通知アクション送信失敗: action=${replyAction} ${msg}`)
              if (ctx.notifState.screen === 'reply-sending') {
                await ctx.glassesUI.showReplyResult(ctx.connection!, false, msg)
              }
            }
            setTimeout(() => returnToListFromResult(ctx), 3000)
            return
          }

          if (action.id === 'comment') {
            log('通知アクション: コメント（録音開始）')
            await startReplyRecording(ctx)
            return
          }

          if (action.id === 'view-image') {
            await openImageDetail(ctx)
            return
          }
        }
      } else if (ctx.notifState.screen === 'image-detail') {
        // 画像表示中: タップ/ダブルタップでアクションメニューに戻る。
        // 画像画面には他のタップ操作がないため、シングルタップも「戻る」として扱う
        // （実機はダブルタップを高速2連CLICKとして送る場合があり DOUBLE_CLICK 判定が不安定なため）。
        // 直前のアクションリストコンテナからの ghost イベント（source=list）は無視する。
        if (normalized.source === 'list') return
        // 転送完了直後のホスト安定待ち: BLE転送直後の画面遷移はホストと競合し
        // Even App がクラッシュし得るため、クールダウン中の戻る操作は無視する
        if (Date.now() < ctx.imageBackBlockedUntil) {
          log('[event] 画像表示: 転送直後のためクールダウン中 (戻る操作は無視)')
          return
        }
        if (normalized.kind === 'tap' || normalized.kind === 'doubleTap') {
          log(`画像表示: ${normalized.kind} → アクションメニューに戻る`)
          if (!ctx.notifState.detailItem) {
            await returnToListScreen(ctx)
            return
          }
          ctx.notifState.screen = 'detail-actions'
          ctx.notifState.detailActions = buildNotificationActions(ctx.notifState.detailItem)
          await ctx.glassesUI.showNotificationActions(ctx.connection!, ctx.notifState.detailItem, ctx.notifState.detailActions)
          ctx.ui.updateNotifInfo()
        }
        return
      } else if (ctx.notifState.screen === 'ask-question-detail') {
        // AskUserQuestion 詳細画面（長い質問テキストのページネーション表示）
        if (!ctx.notifState.detailItem) return
        if (normalized.source === 'list') return
        const aqPageCount = ctx.notifState.detailPages.length
        if (isDoubleTapEventType(eventType)) {
          log('AskQuestion詳細: double tap → リストに戻る')
          await returnToListScreen(ctx)
          return
        }
        if (shouldIgnoreDetailScroll(ctx, eventType)) return

        // AskQuestion詳細のページ送り共通ヘルパー
        const showCurrentAqPage = async () => {
          const currentQ = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
          const fullText = ctx.glassesUI.buildAskQuestionFullText(currentQ, ctx.notifState.askQuestionIndex, ctx.notifState.askQuestions.length)
          const syntheticDetail = { ...ctx.notifState.detailItem!, title: 'AskUserQuestion', fullText }
          await ctx.glassesUI.showNotificationDetail(ctx.connection!, syntheticDetail, ctx.notifState.detailPageIndex, aqPageCount)
          clearPendingScrollEvent(ctx)
          ctx.lastDetailScrollAt = Date.now()
        }

        if (eventType === G2_EVENT.SCROLL_TOP) {
          if (ctx.notifState.detailPageIndex > 0) {
            ctx.notifState.detailPageIndex--
            await showCurrentAqPage()
            ctx.ui.updateNotifInfo()
          } else {
            log('AskQuestion詳細: 最初のページ → リストに戻る')
            await returnToListScreen(ctx)
          }
          return
        }

        if (eventType === G2_EVENT.SCROLL_BOTTOM) {
          if (ctx.notifState.detailPageIndex < aqPageCount - 1) {
            ctx.notifState.detailPageIndex++
            await showCurrentAqPage()
          } else {
            log('AskQuestion詳細: 最終ページ → 選択肢画面へ')
            const currentQ = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
            ctx.notifState.screen = 'ask-question'
            await ctx.glassesUI.showAskUserQuestion(ctx.connection!, currentQ, ctx.notifState.askQuestionIndex, ctx.notifState.askQuestions.length)
            clearPendingScrollEvent(ctx)
          }
          ctx.ui.updateNotifInfo()
          return
        }
      } else if (ctx.notifState.screen === 'ask-question') {
        // AskUserQuestion 選択肢画面
        if (!ctx.notifState.detailItem) return

        if (isDoubleTapEventType(eventType)) {
          log('AskUserQuestion: double tap → リストに戻る')
          await returnToListScreen(ctx)
          return
        }

        if (normalized.source === 'list') {
          if (normalized.containerName !== 'ask-q-lst') return
          const index = normalized.index ?? 0
          const currentQ = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
          if (!currentQ) return
          const optionCount = currentQ.options.length
          // optionCount+0: 「その他（音声）」, optionCount+1: 「◀ 戻る」

          if (index === optionCount + 1) {
            // ◀ 戻る: 長い質問は詳細画面に戻る、短い質問はリストに戻る
            if (!ctx.glassesUI.isAskQuestionShort(currentQ)) {
              log('AskUserQuestion: 戻る → 詳細画面')
              await navigateToAskQuestion(ctx, currentQ, ctx.notifState.askQuestionIndex, ctx.notifState.askQuestions.length)
            } else {
              log('AskUserQuestion: 戻る → リスト')
              await returnToListScreen(ctx)
            }
            return
          }

          if (index === optionCount) {
            // その他（音声入力）→ 録音画面へ
            log('AskUserQuestion: その他（音声入力）')
            await startReplyRecording(ctx)
            return
          }

          if (index < optionCount) {
            // 選択肢を選んだ
            const selectedLabel = currentQ.options[index].label
            ctx.notifState.askAnswers[currentQ.question] = selectedLabel
            log(`AskUserQuestion: 選択 "${selectedLabel}" for "${currentQ.question}"`)

            // 次の質問があるか？
            if (ctx.notifState.askQuestionIndex < ctx.notifState.askQuestions.length - 1) {
              ctx.notifState.askQuestionIndex++
              const nextQ = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
              await navigateToAskQuestion(ctx, nextQ, ctx.notifState.askQuestionIndex, ctx.notifState.askQuestions.length)
              return
            }

            // 全質問に回答完了 → Hub に送信
            log(`AskUserQuestion: 全質問回答完了 answers=${JSON.stringify(ctx.notifState.askAnswers)}`)
            ctx.notifState.screen = 'reply-sending'
            ctx.ui.updateNotifInfo()
            try {
              const res = await ctx.notifClient.reply(ctx.notifState.detailItem.id, {
                action: 'answer',
                answerData: ctx.notifState.askAnswers,
                source: 'g2',
              })
              const result = getReplyResultMessage(res)
              log(`AskUserQuestion: 送信完了 status=${res.reply?.status || 'ok'}`)
              if (ctx.notifState.screen === 'reply-sending') {
                if (result.ok) {
                  await ctx.glassesUI.showReplyResult(ctx.connection!, true, `回答: ${selectedLabel}`)
                } else {
                  await ctx.glassesUI.showReplyResult(ctx.connection!, false, result.message || 'error')
                }
              }
            } catch (err) {
              const msg = errorMessage(err)
              log(`AskUserQuestion: 送信失敗 ${msg}`)
              if (ctx.notifState.screen === 'reply-sending') {
                await ctx.glassesUI.showReplyResult(ctx.connection!, false, msg)
              }
            }
            setTimeout(() => returnToListFromResult(ctx), 3000)
            return
          }
        }
      } else if (ctx.notifState.screen === 'reply-recording') {
        // 録音中画面:
        // - 単タップ相当は sysEvent {} とノイズが区別できないため使わない
        // - DOUBLE_CLICK を確実な停止入力として扱う
        if (isDoubleTapEventType(eventType)) {
          if (!ctx.replyIsRecording || ctx.replyStopInFlight) {
            log('返信録音: 重複停止イベントを無視')
            return
          }
          ctx.replyStopInFlight = true
          log('返信録音: 停止 → STT処理開始')
          ctx.replyIsRecording = false
          await ctx.connection!.stopAudio()

          await ctx.glassesUI.showReplySttProcessing(ctx.connection!)

          if (ctx.replyAudioTotalBytes === 0) {
            log('返信録音: 音声データなし → 前画面に戻る')
            if (ctx.realtimeSTT) { ctx.realtimeSTT.abort(); ctx.realtimeSTT = null }
            await returnToReplyOriginScreen(ctx)
            ctx.replyStopInFlight = false
            return
          }

          try {
            const stt = ctx.realtimeSTT
              ? await (async () => { const r = await ctx.realtimeSTT!.stop(); ctx.realtimeSTT = null; return r })()
              : await transcribePcmChunks(ctx.replyAudioChunks)
            const text = stt.text || ''
            log(`返信STT完了: provider=${stt.provider} text="${text}"`)

            if (!text) {
              log('返信STT: テキスト空 → 前画面に戻る')
              await returnToReplyOriginScreen(ctx)
              ctx.replyStopInFlight = false
              return
            }

            ctx.notifState.replyText = text
            ctx.notifState.detailPageIndex = 0
            ctx.notifState.screen = 'reply-confirm'
            await showReplyConfirmTextPage(ctx)
            clearPendingNotifEvent(ctx)
            ctx.replyConfirmIgnoreUntil = Date.now() + REPLY_CONFIRM_EVENT_GUARD_MS
            ctx.lastDetailScrollAt = Date.now()
            ctx.ui.updateNotifInfo()
            ctx.replyStopInFlight = false
          } catch (err) {
            if (ctx.realtimeSTT) { ctx.realtimeSTT.abort(); ctx.realtimeSTT = null }
            const msg = errorMessage(err)
            log(`返信STT失敗: ${msg}`)
            await ctx.glassesUI.showReplyResult(ctx.connection!, false, msg)
            // 3秒後に前画面に戻る
            setTimeout(async () => {
              await returnToReplyOriginScreen(ctx)
              ctx.replyStopInFlight = false
            }, 3000)
          }
          return
        }

        // スクロール入力はキャンセル → 前画面に戻る
        if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
          log('返信録音: キャンセル → 前画面に戻る')
          ctx.replyIsRecording = false
          await ctx.connection!.stopAudio()
          if (ctx.realtimeSTT) { ctx.realtimeSTT.abort(); ctx.realtimeSTT = null }
          await returnToReplyOriginScreen(ctx)
          ctx.replyStopInFlight = false
          return
        }
      } else if (ctx.notifState.screen === 'reply-confirm') {
        if (Date.now() < ctx.replyConfirmIgnoreUntil) {
          log(`[event] reply-confirm ignored during guard: remaining=${ctx.replyConfirmIgnoreUntil - Date.now()}ms`)
          return
        }

        if (normalized.source === 'list') return
        const pageCount = ctx.notifState.detailPages.length

        if (isDoubleTapEventType(eventType)) {
          log('返信確認: double tap → 前画面に戻る')
          ctx.notifState.replyText = ''
          await returnToReplyOriginScreen(ctx)
          return
        }

        if (shouldIgnoreDetailScroll(ctx, eventType)) return

        if (eventType === G2_EVENT.SCROLL_TOP) {
          if (ctx.notifState.detailPageIndex > 0) {
            ctx.notifState.detailPageIndex--
            await showReplyConfirmTextPage(ctx)
            clearPendingScrollEvent(ctx)
            ctx.lastDetailScrollAt = Date.now()
            ctx.ui.updateNotifInfo()
          } else {
            log('返信確認: 最初のページ → 前画面に戻る')
            ctx.notifState.replyText = ''
            await returnToReplyOriginScreen(ctx)
          }
          return
        }

        if (eventType === G2_EVENT.SCROLL_BOTTOM) {
          if (ctx.notifState.detailPageIndex < pageCount - 1) {
            ctx.notifState.detailPageIndex++
            await showReplyConfirmTextPage(ctx)
            clearPendingScrollEvent(ctx)
            ctx.lastDetailScrollAt = Date.now()
          } else {
            log('返信確認: 最終ページ → 操作メニュー')
            ctx.notifState.screen = 'reply-confirm-actions'
            await ctx.glassesUI.showReplyConfirmActions(ctx.connection!)
            clearPendingScrollEvent(ctx)
          }
          ctx.ui.updateNotifInfo()
          return
        }
      } else if (ctx.notifState.screen === 'reply-confirm-actions') {
        if (isDoubleTapEventType(eventType)) {
          log('返信確認操作: double tap → 本文に戻る')
          ctx.notifState.screen = 'reply-confirm'
          await showReplyConfirmTextPage(ctx)
          ctx.ui.updateNotifInfo()
          return
        }

        if (normalized.source === 'list') {
          const index = normalized.index ?? 0

          if (index === 0) {
            // 送信
            if (!ctx.notifState.detailItem || !ctx.notifState.replyText) return
            log(`返信送信: notificationId=${ctx.notifState.detailItem.id}`)
            ctx.notifState.screen = 'reply-sending'
            try {
              // AskUserQuestion の「その他（音声）」経由の場合は answer として送信
              const isAskQ = isAskUserQuestionNotification(ctx.notifState.detailItem)
              const replyReq = isAskQ
                ? {
                    action: 'answer' as const,
                    answerData: {
                      ...ctx.notifState.askAnswers,
                      [ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]?.question ?? '']: ctx.notifState.replyText,
                    },
                    source: 'g2' as const,
                  }
                : {
                    action: 'comment' as const,
                    comment: ctx.notifState.replyText,
                    source: 'g2' as const,
                  }
              const res = await ctx.notifClient.reply(ctx.notifState.detailItem.id, replyReq)
              const status = res.reply?.status || 'ok'
              const result = getReplyResultMessage(res)
              log(`返信送信完了: status=${status}`)
              // await 中にユーザー操作でリストに戻っていたら結果画面をスキップ
              if (ctx.notifState.screen === 'reply-sending') {
                if (result.ok) {
                  await ctx.glassesUI.showReplyResult(ctx.connection!, true)
                } else {
                  await ctx.glassesUI.showReplyResult(ctx.connection!, false, result.message || status)
                }
              }
            } catch (err) {
              const msg = errorMessage(err)
              log(`返信送信失敗: ${msg}`)
              if (ctx.notifState.screen === 'reply-sending') {
                await ctx.glassesUI.showReplyResult(ctx.connection!, false, msg)
              }
            }
            // 3秒後に一覧に戻る（ユーザー操作で先に戻った場合はスキップ）
            setTimeout(() => returnToListFromResult(ctx), 3000)
            return
          }

          if (index === 1) {
            // 再録
            log('返信確認: 再録')
            await startReplyRecording(ctx)
            return
          }

          if (index === 2) {
            // キャンセル → 前画面に戻る
            log('返信確認: キャンセル → 前画面に戻る')
            ctx.notifState.replyText = ''
            await returnToReplyOriginScreen(ctx)
            return
          }

          if (index === 3) {
            // ◀ 本文
            log('返信確認: 本文に戻る')
            ctx.notifState.screen = 'reply-confirm'
            await showReplyConfirmTextPage(ctx)
            ctx.ui.updateNotifInfo()
            return
          }
        }
      } else if (ctx.notifState.screen === 'reply-sending') {
        // 送信結果画面: 任意の操作（タップ/スワイプ）で即座にリスト一覧に戻る
        log('結果画面: ユーザー操作で即座に復帰')
        await returnToListFromResult(ctx)
      }
  } finally {
    ctx.notifEventInFlight = false
    if (ctx.pendingNotifEvent && !ctx.glassesUI.isRendering()) {
      queuePendingNotifEvent(ctx, conn, ctx.pendingNotifEvent)
    }
  }
}
