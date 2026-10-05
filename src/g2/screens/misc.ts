/**
 * G2 画面: 基本テキスト・待機画面
 *
 * リファクタ Phase 5 で src/glasses-ui.ts から無編集移動。
 * core（描画ロック・レイアウト状態を内包）は createGlassesUI() が1回だけ生成し、
 * ここへは関数引数で渡す（モジュールレベル import でロックを共有しない。
 * src/g2/render-core.ts の凍結ヘッダ参照）。
 */
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from '../../bridge'
import { log } from '../../log'
import { t } from '../../i18n'
import { upgradeText, type RenderCore } from '../render-core'

export function createMiscScreens(core: RenderCore) {
  const {
    startupRenderedBridges,
    layoutByBridge,
    bridgeKeyOf,
    renderStartupPage,
  } = core

  return {
    hasRenderedPage(conn: BridgeConnection): boolean {
      return !!conn.bridge && startupRenderedBridges.has(bridgeKeyOf(conn))
    },

    async ensureBasePage(conn: BridgeConnection, text = 'Ready'): Promise<void> {
      if (!conn.bridge || startupRenderedBridges.has(bridgeKeyOf(conn))) return

      const container = new TextContainerProperty({
        xPosition: 8,
        yPosition: 10,
        width: 560,
        height: 80,
        containerID: 1,
        containerName: 'boot-text',
        content: text,
        isEventCapture: 1,
      })
      await renderStartupPage(conn, { texts: [container] })
      layoutByBridge.set(bridgeKeyOf(conn), 'base')
    },

    /**
     * G2にテキストを表示する
     */
    async showText(conn: BridgeConnection, text: string): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2表示: "${text}"`)
        return
      }

      const bridgeKey = bridgeKeyOf(conn)
      const currentLayout = layoutByBridge.get(bridgeKey)
      if (startupRenderedBridges.has(bridgeKey) && currentLayout === 'text') {
        if (await upgradeText(conn, 1, 'main-text', text)) {
          layoutByBridge.set(bridgeKey, 'text')
          log(`G2にテキスト表示完了: "${text}"`)
          return
        }
        log('G2 textContainerUpgrade に失敗 → ページ再描画へフォールバック')
      }

      const container = new TextContainerProperty({
        xPosition: 8,
        yPosition: 10,
        width: 560,
        height: 260,
        containerID: 1,
        containerName: 'main-text',
        content: text,
        isEventCapture: 1,
      })

      await renderStartupPage(conn, { texts: [container] })
      layoutByBridge.set(bridgeKey, 'text')
      log(`G2にテキスト表示完了: "${text}"`)
    },

    async showIdleLauncher(
      conn: BridgeConnection,
      options?: { dimMode?: boolean },
    ): Promise<void> {
      if (!conn.bridge) return
      const dimMode = options?.dimMode === true

      const idleContainer = new TextContainerProperty({
        xPosition: 8,
        yPosition: 4,
        width: 560,
        height: 272,
        containerID: 1,
        containerName: 'idle-touch',
        content: dimMode ? ' ' : t('g2_idle'),
        isEventCapture: 1,
      })

      await renderStartupPage(conn, {
        texts: [idleContainer],
        targetLayout: 'idle-launcher',
      })
      layoutByBridge.set(bridgeKeyOf(conn), 'idle-launcher')
      log('G2待機画面表示（DblTapで通知一覧）')
    },
  }
}
