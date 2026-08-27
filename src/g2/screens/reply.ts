/**
 * G2 画面: 音声返信フロー（録音中・STT処理中・確認アクション・送信結果）
 *
 * リファクタ Phase 5 で src/glasses-ui.ts から無編集移動。
 * core（描画ロック・レイアウト状態を内包）は createGlassesUI() が1回だけ生成し、
 * ここへは関数引数で渡す（モジュールレベル import でロックを共有しない。
 * src/g2/render-core.ts の凍結ヘッダ参照）。
 */
import type { BridgeConnection } from '../../bridge'
import { log } from '../../log'
import { t } from '../../i18n'
import { upgradeText, type RenderCore } from '../render-core'

export function createReplyScreens(core: RenderCore) {
  const {
    startupRenderedBridges,
    layoutByBridge,
    bridgeKeyOf,
    renderHeaderListPage,
    renderHeaderBodyPage,
  } = core

  return {
    /**
     * G2に録音中画面を表示する
     * Click: 録音停止
     */
    async showReplyRecording(conn: BridgeConnection): Promise<void> {
      if (!conn.bridge) {
        log('[Mock] G2返信録音中')
        return
      }

      await renderHeaderBodyPage(conn, {
        headerContainerName: 'reply-header',
        headerContent: t('reply_header'),
        bodyContainerName: 'reply-body',
        bodyContent: t('reply_recording_body'),
        targetLayout: 'reply-recording',
        layoutSet: 'reply-recording',
      })
      log('G2に録音中画面表示')
    },

    /**
     * 録音中画面のbodyテキストをリアルタイム更新する（ストリーミングSTT表示用）
     */
    async updateReplyRecordingBody(conn: BridgeConnection, text: string): Promise<void> {
      if (!conn.bridge) return
      const bridgeKey = bridgeKeyOf(conn)
      if (layoutByBridge.get(bridgeKey) !== 'reply-recording') return
      await upgradeText(conn, 2, 'reply-body', text)
    },

    /**
     * G2にSTT処理中画面を表示する
     */
    async showReplySttProcessing(conn: BridgeConnection): Promise<void> {
      if (!conn.bridge) {
        log('[Mock] G2 STT処理中')
        return
      }

      // reply-recording レイアウト時は textContainerUpgrade で body だけ差し替え（特殊最適化パス）
      const bridgeKey = bridgeKeyOf(conn)
      if (startupRenderedBridges.has(bridgeKey) && layoutByBridge.get(bridgeKey) === 'reply-recording') {
        if (await upgradeText(conn, 2, 'reply-body', t('stt_processing'))) {
          log('G2にSTT処理中表示')
          return
        }
      }

      await renderHeaderBodyPage(conn, {
        headerContainerName: 'reply-header',
        headerContent: t('reply_header'),
        bodyContainerName: 'reply-body',
        bodyContent: t('stt_processing'),
        targetLayout: 'reply-recording',
        layoutSet: 'reply-recording',
      })
      log('G2にSTT処理中表示')
    },

    /**
     * G2に返信確認後の操作メニューを表示する（SDK標準ListContainer）
     */
    async showReplyConfirmActions(conn: BridgeConnection): Promise<void> {
      if (!conn.bridge) {
        log('[Mock] G2返信確認アクション')
        return
      }

      await renderHeaderListPage(conn, {
        headerContainerName: 'rply-act-hdr',
        headerYPosition: 4,
        headerHeight: 52,
        headerContent: t('reply_confirm_header'),
        listContainerName: 'rply-act-lst',
        listYPosition: 58,
        listHeight: 210,
        listItems: [t('reply_send'), t('reply_rerecord'), t('reply_cancel'), t('reply_body')],
        targetLayout: 'reply-confirm-actions',
        layoutSet: 'reply-confirm-actions',
      })
      log('G2に返信確認アクション表示')
    },

    /**
     * G2に送信結果を表示する
     */
    async showReplyResult(conn: BridgeConnection, success: boolean, message?: string): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2返信結果: ${success ? '成功' : '失敗'}`)
        return
      }

      const statusLabel = success ? t('reply_done') : t('reply_failed')
      const statusPrefix = success ? t('send_done') : t('send_failed')

      await renderHeaderBodyPage(conn, {
        headerContainerName: 'rply-rst-hdr',
        headerContent: statusLabel,
        bodyContainerName: 'rply-rst-body',
        bodyContent: `${statusPrefix}\n${message || ''}`,
        targetLayout: 'reply-result',
        layoutSet: 'reply-result',
      })
      log(`G2に返信結果表示: ${statusLabel}`)
    },
  }
}
