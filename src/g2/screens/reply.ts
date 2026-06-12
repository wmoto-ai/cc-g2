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
        headerContent: '音声返信',
        bodyContainerName: 'reply-body',
        bodyContent: '録音中...\n\nDblClick = 停止\nSwipe = キャンセル',
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
        if (await upgradeText(conn, 2, 'reply-body', 'STT処理中...')) {
          log('G2にSTT処理中表示')
          return
        }
      }

      await renderHeaderBodyPage(conn, {
        headerContainerName: 'reply-header',
        headerContent: '音声返信',
        bodyContainerName: 'reply-body',
        bodyContent: 'STT処理中...',
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
        headerContent: '返信内容 OK?',
        listContainerName: 'rply-act-lst',
        listYPosition: 58,
        listHeight: 210,
        listItems: ['送信', '再録', 'キャンセル', '◀ 本文'],
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

      const statusLabel = success ? '返信完了' : '返信失敗'
      const statusPrefix = success ? '送信完了' : '送信失敗'

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
