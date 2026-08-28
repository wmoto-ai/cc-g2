/**
 * G2 接続フロー（Connect ボタン・自動接続の共通処理）
 *
 * リファクタ Phase 4 で main.ts から無編集移動（モジュールレベル let → ctx.* の
 * 機械的書き換えと ctx 引数の受け渡しのみ）。可変状態は持たない（AppContext に集約）。
 */
import { initBridge } from '../bridge'
import { log } from '../log'
import { appConfig, canUseGroqStt, canUseOpenaiRealtimeStt, canUseSonioxStt } from '../config'
import { getWebSpeechSupport } from '../stt/webspeech'
import { errorMessage } from '../app/format'
import { t } from '../i18n'
import type { AppContext } from './context'
import { ensureNotifEventHandler } from '../g2/event-router'
import { wrapBridgeForMirror } from '../mirror/bridge-tap'

// --- Connect ---
// 二重接続防止: initBridge() を複数回呼ぶと SDK bridge への onEvenHubEvent 登録が
// 重複し、全イベントが二重処理→描画が二重実行されて実機ホストが不安定になる。
// 手動 Connect ボタンと自動接続の両方からこのハンドラを通るため、ここで冪等化する。
export async function connectGlasses(ctx: AppContext): Promise<void> {
  if (ctx.connectInFlight) {
    log('Bridge接続: 既に接続処理中のためスキップ')
    return
  }
  if (ctx.connection) {
    log(`Bridge接続: 既に接続済み (${ctx.connection.mode}) のためスキップ`)
    return
  }
  ctx.connectInFlight = true
  ctx.ui.setPill('connection-status', t('status_connecting'), 'warn')
  log('Bridge接続を開始...')

  try {
    ctx.connection = await initBridge()
    // G2 ミラー: bridge を観測タップでラップする（描画前のここで1回だけ。
    // render-core の WeakMap キーは conn.bridge 参照のため途中差し替え禁止。
    // 詳細は src/mirror/bridge-tap.ts を参照。
    if (ctx.mirror && ctx.connection.bridge) {
      ctx.connection.bridge = wrapBridgeForMirror(ctx.connection.bridge, ctx.mirror)
      log('G2ミラー: bridge 観測タップを有効化')
    }
    ctx.ui.updateDashboard()
    log(`接続成功: ${ctx.connection.mode} モード`)

    if (ctx.connection.bridge) {
      try {
        const info = await ctx.connection.bridge.getDeviceInfo()
        if (info) {
          log(
            `DeviceInfo: model=${info.model}, sn=${info.sn || '-'}, connectType=${info.status?.connectType || '-'}, battery=${info.status?.batteryLevel ?? '-'}%`,
          )
        } else {
          log('DeviceInfo: 取得結果なし')
        }
      } catch (err) {
        log(`DeviceInfo取得失敗: ${errorMessage(err)}`)
      }

      if (!ctx.deviceStatusListenerAttached) {
        try {
          ctx.connection.bridge.onDeviceStatusChanged((status) => {
            if (typeof status.isWearing === 'boolean') ctx.deviceWearing = status.isWearing
            log(
              `DeviceStatus: connectType=${status.connectType}, wearing=${status.isWearing}, battery=${status.batteryLevel}%`,
            )
          })
          ctx.deviceStatusListenerAttached = true
        } catch (err) {
          log(`DeviceStatus購読失敗: ${errorMessage(err)}`)
        }
      }
    }

    if (!ctx.speechCapabilityLogged) {
      log(
        `STT設定: enabled=${appConfig.sttEnabled ? 'yes' : 'no'}, forceError=${appConfig.sttForceError ? 'yes' : 'no'}, provider=${appConfig.sttProvider}, mode=${canUseOpenaiRealtimeStt() || canUseSonioxStt() ? 'realtime' : canUseGroqStt() ? 'hub' : 'mock'}`,
      )
      if (appConfig.webSpeechCompare) {
        const cap = getWebSpeechSupport()
        log(
          `Web Speech API可否: SpeechRecognition=${cap.speechRecognition ? 'yes' : 'no'}, webkitSpeechRecognition=${cap.webkitSpeechRecognition ? 'yes' : 'no'}`,
        )
      }
      ctx.speechCapabilityLogged = true
    }

    if (!ctx.audioListenerAttached) {
      const audioInfo = document.getElementById('audio-info')!
      ctx.connection.onAudio((pcm: Uint8Array) => {
        // 返信録音中 (realtime mode)
        if (ctx.replyIsRecording && ctx.realtimeSTT) {
          ctx.realtimeSTT.sendAudio(pcm)
          ctx.replyAudioTotalBytes += pcm.length
          return
        }
        // 返信録音中 (batch mode - existing)
        if (ctx.replyIsRecording) {
          ctx.replyAudioChunks.push(pcm)
          ctx.replyAudioTotalBytes += pcm.length
          return
        }

        // Dev mic test (realtime mode)
        if (ctx.isRecording && ctx.realtimeSTT) {
          ctx.realtimeSTT.sendAudio(pcm)
          ctx.audioTotalBytes += pcm.length
          const durationMs = (ctx.audioTotalBytes / 2) / 16
          audioInfo.textContent = [
            `[realtime] 合計バイト: ${ctx.audioTotalBytes}`,
            `推定時間: ${(durationMs / 1000).toFixed(1)}秒`,
            `最新チャンク: ${pcm.length} bytes`,
          ].join('\n')
          return
        }

        // Dev mic test (batch mode - existing)
        if (!ctx.isRecording) return

        ctx.audioChunks.push(pcm)
        ctx.audioTotalBytes += pcm.length
        const durationMs = (ctx.audioTotalBytes / 2) / 16 // 16kHz, 16bit = 2 bytes/sample
        audioInfo.textContent = [
          `チャンク数: ${ctx.audioChunks.length}`,
          `合計バイト: ${ctx.audioTotalBytes}`,
          `推定時間: ${(durationMs / 1000).toFixed(1)}秒`,
          `最新チャンク: ${pcm.length} bytes`,
        ].join('\n')
      })
      ctx.audioListenerAttached = true
    }
    ensureNotifEventHandler(ctx, ctx.connection)
    ctx.transport.connectEvents(ctx)
  } catch (err) {
    ctx.ui.setPill('connection-status', t('status_connect_failed'), 'error')
    log(`接続失敗: ${err}`)
  } finally {
    ctx.connectInFlight = false
  }
}
