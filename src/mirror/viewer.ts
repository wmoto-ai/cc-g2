/**
 * G2 ミラービューア（mirror.html、plan/g2-mirror.md M2/M3）
 *
 * Safari/PC から G2 表示のミラーを見る独立ページ。Hub へは同一 origin の
 * /api だけを叩く（Vite dev proxy 経由。HTTPS 化時の mixed content 対策）。
 *
 * カメラ重畳: getUserMedia（HTTPS 必須 → tailscale serve 経由で開く）で背面カメラを
 * 背景に出し、ミラー canvas を mix-blend-mode: screen で重畳する（黒が透過して
 * 緑の発光だけが乗る）。「合成して保存」でカメラフレーム + ミラーを 1 枚の PNG に
 * 合成しダウンロードする（SNS 共有用）。
 */
import { renderMirror } from './renderer'
import { fromWireState, type G2DisplayWire } from './wire'

const video = document.getElementById('camera') as HTMLVideoElement
const canvas = document.getElementById('mirror-canvas') as HTMLCanvasElement
const cameraBtn = document.getElementById('camera-btn') as HTMLButtonElement
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
const sizeRange = document.getElementById('size-range') as HTMLInputElement
const posRange = document.getElementById('pos-range') as HTMLInputElement
const statusEl = document.getElementById('status') as HTMLSpanElement

function setStatus(text: string) {
  statusEl.textContent = text
}

// --- 重畳の大きさ・位置（viewport 比%。保存合成でも同じ比率を使う） ---

function applyOverlayLayout() {
  canvas.style.width = `${sizeRange.value}%`
  canvas.style.top = `${posRange.value}%`
}
sizeRange.addEventListener('input', applyOverlayLayout)
posRange.addEventListener('input', applyOverlayLayout)
applyOverlayLayout()

// --- ミラー状態の取得・描画 ---

let lastSeq = -1
let refreshing = false
let refreshQueued = false

async function refresh(): Promise<void> {
  if (refreshing) {
    refreshQueued = true
    return
  }
  refreshing = true
  try {
    const res = await fetch('/api/g2-display')
    if (res.status === 404) {
      setStatus('表示待ち（G2 側でまだ描画がありません）')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { ok: boolean; display: G2DisplayWire }
    const state = fromWireState(body.display)
    if (state.seq === lastSeq) return
    lastSeq = state.seq
    await renderMirror(canvas, state)
    const at = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : '-'
    setStatus(`seq=${state.seq} (${at})`)
  } catch (err) {
    setStatus(`取得失敗: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    refreshing = false
    if (refreshQueued) {
      refreshQueued = false
      void refresh()
    }
  }
}

const events = new EventSource('/api/events')
events.addEventListener('open', () => void refresh())
events.addEventListener('g2-display', () => void refresh())
events.addEventListener('error', () => {
  setStatus('SSE 再接続中...')
  // Hub 再起動等でイベントを取りこぼした場合の保険（refresh は seq 重複を弾くので冪等）
  setTimeout(() => void refresh(), 3000)
})
void refresh()

// --- カメラ重畳 ---

let cameraStream: MediaStream | null = null

cameraBtn.addEventListener('click', async () => {
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop()
    cameraStream = null
    video.style.display = 'none'
    cameraBtn.textContent = 'カメラ開始'
    return
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('カメラ不可: HTTPS（tailscale serve 経由）で開いてください')
    return
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    })
    video.srcObject = cameraStream
    video.style.display = 'block'
    cameraBtn.textContent = 'カメラ停止'
  } catch (err) {
    setStatus(`カメラ失敗: ${err instanceof Error ? err.message : String(err)}`)
  }
})

// --- 合成して保存（カメラフレーム + ミラーを 1 枚に） ---

saveBtn.addEventListener('click', () => {
  const out = document.createElement('canvas')
  const octx = out.getContext('2d')
  if (!octx) return

  if (cameraStream && video.videoWidth > 0) {
    out.width = video.videoWidth
    out.height = video.videoHeight
    octx.drawImage(video, 0, 0, out.width, out.height)
  } else {
    out.width = canvas.width
    out.height = canvas.height
    octx.fillStyle = '#000'
    octx.fillRect(0, 0, out.width, out.height)
  }

  // 画面と同じ比率（幅%・上端%）でミラーを screen 合成
  octx.globalCompositeOperation = 'screen'
  const w = out.width * (Number(sizeRange.value) / 100)
  const h = w / 2 // G2 は 2:1
  const x = (out.width - w) / 2
  const y = out.height * (Number(posRange.value) / 100)
  octx.drawImage(canvas, x, y, w, h)

  out.toBlob((blob) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `g2-mirror-${Date.now()}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }, 'image/png')
})
