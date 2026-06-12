/**
 * G2 画面: 画像表示（image-detail レイアウト＋タイル直列転送）
 *
 * リファクタ Phase 5 で src/glasses-ui.ts から無編集移動。
 * core（描画ロック・レイアウト状態を内包）は createGlassesUI() が1回だけ生成し、
 * ここへは関数引数で渡す（モジュールレベル import でロックを共有しない。
 * src/g2/render-core.ts の凍結ヘッダ参照）。
 */
import {
  TextContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
} from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from '../../bridge'
import { IMAGE_TILES, IMAGE_TILE_DELAY_MS, IMAGE_SETTLE_DELAY_MS } from '../../image/image-pipeline'
import { log } from '../../log'
import { IMAGE_TILE_TIMEOUT_MS, upgradeText, type RenderCore } from '../render-core'

export function createImageScreens(core: RenderCore) {
  const {
    layoutByBridge,
    bridgeKeyOf,
    withTimeout,
    withRenderLock,
    _renderStartupPageInner,
  } = core

  return {
    /**
     * 画像を G2 に表示する（image-detail レイアウト）
     *
     * 全画面イベント捕捉 TextContainer 1枚 + ImageContainer 4枚（2x2）。
     * tiles は image-pipeline.buildImageTiles() の出力（IMAGE_TILES と同順の PNG 群）。
     * レイアウト構築と画像転送を同一の描画ロック内で行い、転送中の rebuild 競合を防ぐ。
     * 転送は直列必須（SDK仕様）。戻り値は全タイル成功なら true。
     */
    async showImage(conn: BridgeConnection, tiles: Uint8Array[]): Promise<boolean> {
      if (!conn.bridge) {
        log(`[Mock] G2画像表示: tiles=${tiles.length}`)
        return true
      }
      if (tiles.length !== IMAGE_TILES.length) {
        log(`G2画像表示: タイル数不一致 expected=${IMAGE_TILES.length} got=${tiles.length}`)
        return false
      }

      return withRenderLock(async () => {
        // 実機は createStartUp フォールバック(約3秒) + BLE転送(0.5〜2秒/枚 x4) かかるため
        // 転送中インジケータを出す（Visionote と同じ手法。完了後に upgradeText で消す）
        const evtContainer = new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          containerID: 1,
          containerName: 'img-dtl-evt',
          content: '\n\n\n\n　　　　　　　　画像を転送中...\n　　　　　　　　(完了まで操作しないでください)',
          isEventCapture: 1,
          paddingLength: 0,
        })
        const imageContainers = IMAGE_TILES.map(
          (t, i) =>
            new ImageContainerProperty({
              containerID: 2 + i,
              containerName: `img-dtl-${i}`,
              xPosition: t.x,
              yPosition: t.y,
              width: t.w,
              height: t.h,
            }),
        )

        await _renderStartupPageInner(conn, [evtContainer], [], 'image-detail', imageContainers)
        layoutByBridge.set(bridgeKeyOf(conn), 'image-detail')

        // 実機はページ描画完了までラグがある（構築応答 ≠ 描画完了、実測約3秒）。
        // 構築直後の即時BLE転送はホスト(Even App)クラッシュの引き金になるため settle を置く
        if (IMAGE_SETTLE_DELAY_MS > 0) {
          log(`G2画像: レイアウト settle 待ち ${IMAGE_SETTLE_DELAY_MS}ms`)
          await new Promise((resolve) => setTimeout(resolve, IMAGE_SETTLE_DELAY_MS))
        }

        let allOk = true
        const t0 = performance.now()
        for (let i = 0; i < tiles.length; i++) {
          const tileStart = performance.now()
          let resultText: string
          let timedOut = false
          try {
            const raw = await withTimeout(
              conn.bridge!.updateImageRawData(
                new ImageRawDataUpdate({
                  containerID: 2 + i,
                  containerName: `img-dtl-${i}`,
                  imageData: Array.from(tiles[i]),
                }),
              ),
              IMAGE_TILE_TIMEOUT_MS,
              null,
            )
            if (raw === null) {
              resultText = `timeout(${IMAGE_TILE_TIMEOUT_MS}ms)`
              timedOut = true
              allOk = false
            } else {
              const normalized = ImageRawDataUpdateResult.normalize(raw)
              resultText = String(normalized)
              if (!ImageRawDataUpdateResult.isSuccess(normalized)) allOk = false
            }
          } catch (err) {
            resultText = `throw: ${err instanceof Error ? err.message : String(err)}`
            allOk = false
          }
          log(`G2画像タイル${i}: ${resultText} (${Math.round(performance.now() - tileStart)}ms, png=${tiles[i].length}B)`)
          if (timedOut) {
            // ハング中のホストに追い打ちをかけず、ロックを解放して以降のUI操作を守る
            log('G2画像表示中断: タイル送信タイムアウトのため残りをスキップ')
            break
          }
          // BLE負荷の切り分け用ディレイ（?imgdelay=<ms> / VITE_IMG_TILE_DELAY_MS、デフォルト0）
          if (IMAGE_TILE_DELAY_MS > 0 && i < tiles.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, IMAGE_TILE_DELAY_MS))
          }
        }
        // 転送中インジケータを消す（失敗時はメッセージを残してユーザーに状態を知らせる）
        await upgradeText(conn, 1, 'img-dtl-evt', allOk ? ' ' : '画像転送に失敗しました\nダブルタップで戻る')
        log(`G2画像${allOk ? '表示完了' : '表示一部失敗'}: total=${Math.round(performance.now() - t0)}ms`)
        return allOk
      })
    },
  }
}
