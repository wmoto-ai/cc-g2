/**
 * 返信録音・返信確認テキスト表示フロー
 *
 * リファクタ Phase 4 で main.ts から無編集移動（モジュールレベル let → ctx.* の
 * 機械的書き換えと ctx 引数の受け渡しのみ）。可変状態は持たない（AppContext に集約）。
 * 録音停止〜STT〜確認画面遷移の本体は reply-recording 画面ハンドラ
 * （src/g2/event-router.ts）側にある。
 */
import { appConfig, canUseOpenaiRealtimeStt, canUseSonioxStt, createHubHeaders } from '../config'
import { log } from '../log'
import { errorMessage } from '../app/format'
import { OpenAIRealtimeSTT } from '../stt/openai-realtime'
import { SonioxRealtimeSTT } from '../stt/soniox-realtime'
import type { NotificationDetail } from '../notifications'
import type { AppContext } from '../app/context'

/** 返信録音画面に遷移し、マイクを開始する */
export async function startReplyRecording(ctx: AppContext): Promise<void> {
  if (!ctx.connection) return
  ctx.notifState.screen = 'reply-recording'
  ctx.notifState.replyText = ''
  ctx.replyAudioChunks = []
  ctx.replyAudioTotalBytes = 0
  ctx.replyStopInFlight = false

  // Start realtime STT if configured
  if (canUseOpenaiRealtimeStt() || canUseSonioxStt()) {
    let realtimeCompleted = ''
    let realtimeDelta = ''
    try {
      ctx.realtimeSTT = canUseSonioxStt()
        ? new SonioxRealtimeSTT(appConfig.notificationHubUrl, createHubHeaders())
        : new OpenAIRealtimeSTT(appConfig.notificationHubUrl, createHubHeaders())
      await ctx.realtimeSTT.start((text, isFinal) => {
        if (isFinal) {
          realtimeCompleted += text
          realtimeDelta = ''
        } else {
          realtimeDelta += text
        }
        const display = realtimeCompleted + realtimeDelta
        if (display && ctx.connection) {
          ctx.glassesUI.updateReplyRecordingBody(ctx.connection, display)
        }
      })
      log(`返信録音: ${appConfig.sttProvider} Realtime STT開始`)
    } catch (err) {
      ctx.realtimeSTT = null
      log(`返信録音: Realtime STT開始失敗: ${errorMessage(err)}`)
    }
  }

  await ctx.glassesUI.showReplyRecording(ctx.connection)
  if (ctx.connection.mode === 'bridge' && !ctx.glassesUI.hasRenderedPage(ctx.connection)) {
    await ctx.glassesUI.ensureBasePage(ctx.connection, 'マイク録音中...')
  }
  await ctx.connection.startAudio()
  ctx.replyIsRecording = true
  ctx.ui.updateNotifInfo()
}

export async function showReplyConfirmTextPage(ctx: AppContext): Promise<void> {
  if (!ctx.connection || !ctx.notifState.detailItem || !ctx.notifState.replyText) return
  const confirmText = `${ctx.notifState.replyText}\n\n---\n送信・再録は最後までスクロール`
  const pageCount = ctx.glassesUI.getDetailPageCount(confirmText)
  ctx.notifState.detailPageIndex = Math.max(0, Math.min(ctx.notifState.detailPageIndex, pageCount - 1))
  ctx.notifState.detailPages = Array.from({ length: pageCount }, (_, i) => String(i))
  const syntheticDetail: NotificationDetail = {
    ...ctx.notifState.detailItem,
    title: '返信内容',
    fullText: confirmText,
    replyCapable: true,
  }
  await ctx.glassesUI.showNotificationDetail(ctx.connection, syntheticDetail, ctx.notifState.detailPageIndex, pageCount)
}
