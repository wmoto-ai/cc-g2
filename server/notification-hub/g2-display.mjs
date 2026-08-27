// G2 ミラー表示状態の受信・配信。
// 最新 1 状態のみメモリ保持（揮発フレームのため JSONL 永続化しない）。
// 再代入されるため store.g2Display 経由で読み書きする（lastLocation と同じ流儀）。
// SSE は軽量な {seq} のみ配信し、フル状態はビューアが GET で取得する
// （WebView 自身への大 payload 反射を避ける）。
import { store, log } from './store.mjs'
import { hubMaxG2DisplayBodyBytes } from './config.mjs'
import { sendJson, parseJsonBody } from './http-util.mjs'
import { sseBroadcast } from './sse.mjs'

const VALID_KINDS = new Set(['text', 'list', 'image'])

function isValidContainer(c) {
  return (
    c !== null &&
    typeof c === 'object' &&
    VALID_KINDS.has(c.kind) &&
    typeof c.id === 'number' &&
    typeof c.name === 'string' &&
    [c.x, c.y, c.w, c.h].every((v) => typeof v === 'number')
  )
}

/** POST /api/g2-display */
async function handleG2DisplayPost(req, res) {
  // 画像タイルの base64 を含むため既定の body 上限と別枠（config 参照）
  const p = await parseJsonBody(req, res, hubMaxG2DisplayBodyBytes)
  if (!p) return
  if (!Array.isArray(p.containers) || !p.containers.every(isValidContainer)) {
    return sendJson(res, 400, { ok: false, error: 'containers (array of valid containers) is required' })
  }
  store.g2Display = {
    seq: typeof p.seq === 'number' ? p.seq : 0,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
    containers: p.containers,
    receivedAt: new Date().toISOString(),
  }
  sseBroadcast('g2-display', { seq: store.g2Display.seq })
  log(`g2-display updated: seq=${store.g2Display.seq} containers=${p.containers.length}`)
  return sendJson(res, 200, { ok: true })
}

/** GET /api/g2-display */
function handleG2DisplayGet(req, res) {
  if (!store.g2Display) {
    return sendJson(res, 404, { ok: false, error: 'No display state yet' })
  }
  return sendJson(res, 200, { ok: true, display: store.g2Display })
}

export { handleG2DisplayPost, handleG2DisplayGet }
