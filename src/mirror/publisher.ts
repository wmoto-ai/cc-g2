/**
 * G2 ミラー状態の Hub 送信。
 *
 * MirrorStore の更新を debounce（300ms trailing）でまとめ、最新状態だけを
 * POST /api/g2-display へ送る。Hub は SSE `g2-display` で軽量通知（{seq} のみ）を
 * 配信し、ビューアが GET で取得する。
 *
 * 静音化: isQuiet()（= ctx.imageTransferQuiet の配線）が true の間は送信せず、
 * 解除後に最新状態だけを trailing 送信する。base64 変換も送信時に行うため
 * 転送ウィンドウ内では走らない（画像 BLE 転送中の WebView 追加負荷対策）。
 */
import { log } from '../log'
import type { MirrorStore } from './state'
import { toWireState } from './wire'

const DEBOUNCE_MS = 300
const QUIET_RETRY_MS = 500
// 送信失敗時の再送間隔（300ms 連射での Hub 叩きを避ける）
const FAILURE_RETRY_MS = 5000

export function attachMirrorPublisher(
  store: MirrorStore,
  opts: {
    hubUrl: string
    headers: () => HeadersInit
    isQuiet: () => boolean
  },
): () => void {
  let dirty = false
  let scheduled = false
  let inFlight = false
  let failureLogged = false
  let lastSendFailed = false

  async function send(): Promise<void> {
    inFlight = true
    try {
      const res = await fetch(`${opts.hubUrl}/api/g2-display`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(opts.headers()).entries()) },
        body: JSON.stringify(toWireState(store.getState())),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      failureLogged = false
      lastSendFailed = false
    } catch (err) {
      // 失敗時は dirty に戻し、新しい更新がなくても最新状態を再送する
      // （Hub 一時停止からの復帰でビューアが古い seq に取り残されるのを防ぐ）
      dirty = true
      lastSendFailed = true
      // 失敗の連発はログ1回に抑える（恒常負荷・ログ洪水防止）。次の成功でリセット
      if (!failureLogged) {
        failureLogged = true
        log(`G2ミラー送信失敗: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      inFlight = false
      if (dirty) schedule(lastSendFailed ? FAILURE_RETRY_MS : DEBOUNCE_MS)
    }
  }

  const tick = () => {
    if (opts.isQuiet()) {
      setTimeout(tick, QUIET_RETRY_MS)
      return
    }
    scheduled = false
    if (!dirty || inFlight) return
    dirty = false
    void send()
  }

  const schedule = (delayMs = DEBOUNCE_MS) => {
    if (scheduled) return
    scheduled = true
    setTimeout(tick, delayMs)
  }

  const unsubscribe = store.subscribe(() => {
    dirty = true
    schedule()
  })
  return unsubscribe
}
