/**
 * G2 ミラーの canvas 描画（plan/g2-mirror.md）
 *
 * G2 ディスプレイ仕様（576x288・緑モノクロ）を canvas 上に近似再現する。
 * 実機ファームウェアのフォント・折返し・リストスクロールは SDK から観測できないため
 * 近似と割り切る（折返しは measureText による貪欲折返し、リスト選択ハイライトは非再現）。
 */
import type { G2DisplayState, MirrorContainer, MirrorStore } from './state'

export const G2_WIDTH = 576
export const G2_HEIGHT = 288

// 内部解像度の倍率（CSS 縮小表示でも文字が潰れないように 2x で描く）
const SCALE = 2
const GREEN = '#3ddc84'
const FONT = '22px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif'
const LINE_HEIGHT = 30
const LIST_ROW_HEIGHT = 34

// PNG タイルのデコード結果キャッシュ（state は png の Uint8Array 参照を使い回すため WeakMap が効く）
const bitmapCache = new WeakMap<Uint8Array, Promise<ImageBitmap>>()

function decodePng(png: Uint8Array): Promise<ImageBitmap> {
  let cached = bitmapCache.get(png)
  if (!cached) {
    cached = createImageBitmap(new Blob([png.slice().buffer], { type: 'image/png' }))
    bitmapCache.set(png, cached)
  }
  return cached
}

/** measureText による貪欲折返し（\n は尊重） */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') {
      lines.push('')
      continue
    }
    let current = ''
    for (const ch of Array.from(raw)) {
      const candidate = current + ch
      if (current !== '' && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current)
        current = ch
      } else {
        current = candidate
      }
    }
    lines.push(current)
  }
  return lines
}

function drawText(ctx: CanvasRenderingContext2D, c: Extract<MirrorContainer, { kind: 'text' }>) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(c.x, c.y, c.w, c.h)
  ctx.clip()
  ctx.fillStyle = GREEN
  ctx.font = FONT
  ctx.textBaseline = 'top'
  const lines = wrapLines(ctx, c.content, c.w)
  for (let i = 0; i < lines.length; i++) {
    const y = c.y + 2 + i * LINE_HEIGHT
    if (y > c.y + c.h) break
    ctx.fillText(lines[i], c.x, y)
  }
  ctx.restore()
}

function drawList(ctx: CanvasRenderingContext2D, c: Extract<MirrorContainer, { kind: 'list' }>) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(c.x, c.y, c.w, c.h)
  ctx.clip()
  ctx.font = FONT
  ctx.textBaseline = 'middle'
  for (let i = 0; i < c.items.length; i++) {
    const rowY = c.y + i * LIST_ROW_HEIGHT
    if (rowY > c.y + c.h) break
    if (c.selectBorder) {
      ctx.strokeStyle = 'rgba(61, 220, 132, 0.35)'
      ctx.lineWidth = 1
      ctx.strokeRect(c.x + 1, rowY + 2, c.w - 2, LIST_ROW_HEIGHT - 4)
    }
    ctx.fillStyle = GREEN
    ctx.fillText(c.items[i], c.x + 8, rowY + LIST_ROW_HEIGHT / 2)
  }
  ctx.restore()
}

function drawImage(
  ctx: CanvasRenderingContext2D,
  c: Extract<MirrorContainer, { kind: 'image' }>,
  bitmap: ImageBitmap | null,
) {
  if (!bitmap) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(c.x, c.y, c.w, c.h)
  ctx.clip()
  ctx.drawImage(bitmap, c.x, c.y, c.w, c.h)
  // グレースケール PNG を G2 の緑モノクロに寄せる（multiply で白→緑、黒は黒のまま）
  ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = GREEN
  ctx.fillRect(c.x, c.y, c.w, c.h)
  ctx.restore()
}

/** state を 576x288（内部 2x）の canvas に描く。PNG デコードがあるため async */
export async function renderMirror(canvas: HTMLCanvasElement, state: G2DisplayState): Promise<void> {
  const images = state.containers.filter(
    (c): c is Extract<MirrorContainer, { kind: 'image' }> => c.kind === 'image',
  )
  // 先に全 PNG をデコードしてから同期的に描く（描画途中のちらつき防止）
  const bitmaps = new Map<MirrorContainer, ImageBitmap | null>()
  for (const c of images) {
    bitmaps.set(c, c.png ? await decodePng(c.png).catch(() => null) : null)
  }

  canvas.width = G2_WIDTH * SCALE
  canvas.height = G2_HEIGHT * SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, G2_WIDTH, G2_HEIGHT)

  for (const c of state.containers) {
    if (c.kind === 'text') drawText(ctx, c)
    else if (c.kind === 'list') drawList(ctx, c)
    else drawImage(ctx, c, bitmaps.get(c) ?? null)
  }
}

/**
 * canvas を store に購読接続する。
 *
 * 静音化: isQuiet()（= ctx.imageTransferQuiet の配線）が true の間は描画せず、
 * 解除後に最新 state だけを trailing 描画する（画像 BLE 転送中の WebView 追加負荷で
 * ホストがクラッシュした実測への対策。SSE 繰り延べと同じ思想）。
 * 通常時も 200ms debounce で連続 rebuild の描画を 1 回にまとめる。
 */
export function attachMirrorCanvas(
  canvas: HTMLCanvasElement,
  store: MirrorStore,
  isQuiet: () => boolean,
): () => void {
  let dirty = false
  let scheduled = false

  const tick = () => {
    if (isQuiet()) {
      setTimeout(tick, 500)
      return
    }
    scheduled = false
    if (!dirty) return
    dirty = false
    void renderMirror(canvas, store.getState())
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(tick, 200)
  }

  const unsubscribe = store.subscribe(() => {
    dirty = true
    schedule()
  })
  // 初期描画（空でも黒背景を出す）
  dirty = true
  schedule()
  return unsubscribe
}
