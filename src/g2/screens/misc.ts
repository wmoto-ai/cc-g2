/**
 * G2 画面: 基本テキスト・待機画面・承認UI
 *
 * リファクタ Phase 5 で src/glasses-ui.ts から無編集移動。
 * core（描画ロック・レイアウト状態を内包）は createGlassesUI() が1回だけ生成し、
 * ここへは関数引数で渡す（モジュールレベル import でロックを共有しない。
 * src/g2/render-core.ts の凍結ヘッダ参照）。
 */
import { TextContainerProperty, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from '../../bridge'
import { log } from '../../log'
import { upgradeText, type RenderCore } from '../render-core'

export type ApprovalRequest = {
  title: string
  detail: string
  options: string[]
}

export function createMiscScreens(core: RenderCore) {
  const {
    startupRenderedBridges,
    layoutByBridge,
    bridgeKeyOf,
    renderStartupPage,
    renderHeaderListPage,
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
        content: dimMode ? ' ' : '待機中\n\nDblTap = 通知一覧',
        isEventCapture: 1,
      })

      await renderStartupPage(conn, {
        texts: [idleContainer],
        targetLayout: 'idle-launcher',
      })
      layoutByBridge.set(bridgeKeyOf(conn), 'idle-launcher')
      log('G2待機画面表示（DblTapで通知一覧）')
    },

    /**
     * G2に承認UIを表示し、ユーザーの選択を待つ
     */
    async requestApproval(
      conn: BridgeConnection,
      request: ApprovalRequest,
    ): Promise<string> {
      if (!conn.bridge) {
        log(`[Mock] 承認リクエスト: ${request.title}`)
        // Mockモードでは2秒後に自動承認
        return new Promise((resolve) => {
          setTimeout(() => {
            log('[Mock] 自動承認')
            resolve(request.options[0])
          }, 2000)
        })
      }

      // Use a compact layout that fits both 576x288 and 640x200 displays/simulators.
      await renderHeaderListPage(conn, {
        headerContainerName: 'approval-title',
        headerYPosition: 10,
        headerHeight: 48,
        headerContent: `${request.title}\n${request.detail}`,
        listContainerName: 'approval-list',
        listYPosition: 64,
        listHeight: 120,
        listItems: request.options,
        targetLayout: undefined,
        layoutSet: 'approval',
      })
      log('G2に承認UIを表示')

      // イベント待ち
      return new Promise<string>((resolve) => {
        const timeoutId = setTimeout(() => {
          log('承認タイムアウト（60秒）→ 自動拒否')
          resolve(request.options[request.options.length - 1]) // 最後の選択肢（拒否）
        }, 60_000)

        conn.onEvent((event: EvenHubEvent) => {
          if (event.listEvent) {
            const index = event.listEvent.currentSelectItemIndex ?? 0
            const selected = request.options[index] ?? request.options[0]
            clearTimeout(timeoutId)
            log(`G2で選択: "${selected}" (index=${index})`)
            resolve(selected)
          }
        })
      })
    },
  }
}
