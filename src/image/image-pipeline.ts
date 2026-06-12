/**
 * G2 画像表示パイプライン
 *
 * Hub から取得した画像 (png/jpeg) を G2 表示用のタイル PNG 群に変換する。
 * 流れ: decode → アスペクト維持で全体領域にレターボックス描画 →
 *       グレースケール化 → 16階調量子化 → タイルごとに 8bit グレースケール PNG 化
 *
 * タイル寸法はデフォルト 288x144（2x2 = 576x288 フルレンズ）。
 * 一時期 200x100 を安全圏デフォルトにしていたが、実測されたクラッシュ原因は
 * すべてタイミング/コンテンツ起因（SSEバースト・リストアイテムのバイト超過・
 * 描画衝突）でサイズとの相関は観測されなかった（2026-06-10）。転送時間が伸びる分の
 * 危険窓は転送中SSE繰り延べ・イベント破棄・BLE静穏ギャップで保護済み。
 * 不安定になった場合は ?imgtile=200 等で従来の安全圏に戻せる。
 */
import { encodeGrayscalePng, rgbaToGrayscale, quantizeGray16 } from './grayscale-png'

export type ImageTileSpec = {
  /** コンテナ配置座標（ディスプレイ 576x288 基準） */
  x: number
  y: number
  w: number
  h: number
}

// タイルサイズの切替（公式仕様: 幅20〜288 / 高さ20〜144、2x2タイルで表示）:
//   '288' = 288x144 (デフォルト, フルレンズ 576x288, 転送約8秒)
//   '256' = 256x128 (512x256表示 = フルレンズの約89%, 転送約6.5秒)
//   '200' = 200x100 (400x200表示, 転送約4秒, コミュニティ実証の安全圏)
//   'WxH' = 任意サイズ（例 240x120。範囲外は自動クランプ）
// URL ?imgtile=... または .env.local の VITE_IMG_TILE=... で切替。
// タイル間ディレイ: ?imgdelay=<ms> または VITE_IMG_TILE_DELAY_MS（BLE負荷の切り分け用）
// 転送時間の実測 (2026-06-10): タイルデータ量にほぼ比例、288x144x4 で約8秒
const TILE_PRESETS: Record<string, { w: number; h: number }> = {
  '288': { w: 288, h: 144 },
  '256': { w: 256, h: 128 },
  '200': { w: 200, h: 100 },
}

function parseTileKey(key: string): { w: number; h: number } | null {
  if (TILE_PRESETS[key]) return TILE_PRESETS[key]
  const m = key.match(/^(\d{2,3})x(\d{2,3})$/)
  if (!m) return null
  return {
    w: Math.min(288, Math.max(20, Number(m[1]))),
    h: Math.min(144, Math.max(20, Number(m[2]))),
  }
}

const uiParams = new URLSearchParams(globalThis.location?.search || '')
const tileKey = uiParams.get('imgtile') || (import.meta.env.VITE_IMG_TILE as string | undefined)?.trim() || '288'
const TILE = parseTileKey(tileKey) ?? TILE_PRESETS['288']
const TILE_W = TILE.w
const TILE_H = TILE.h
const ORIGIN_X = Math.floor((576 - TILE_W * 2) / 2)
const ORIGIN_Y = Math.floor((288 - TILE_H * 2) / 2)

// タイル間ディレイ。BLE飽和の緩和（ホストのハートビート/ジェスチャー処理に隙間を与える）。
// G2ファームの実効BLE上限(~8.8KB/s)とハートビート間隔(5秒)からの推定適正は50〜150ms。
// デフォルト100ms。
export const IMAGE_TILE_DELAY_MS = Math.max(
  0,
  Number(uiParams.get('imgdelay') ?? (import.meta.env.VITE_IMG_TILE_DELAY_MS as string | undefined) ?? '100') || 0,
)

// レイアウト構築（rebuild/createStartUp）後、最初のタイル送信までの待ち時間。
// 公式テンプレ/Visionoteはsettle 0だが、構築直後のBLE連続書き込みを避ける保険として
// 300msを置く。?imgsettle=<ms> / VITE_IMG_SETTLE_MS で調整可。
export const IMAGE_SETTLE_DELAY_MS = Math.max(
  0,
  Number(uiParams.get('imgsettle') ?? (import.meta.env.VITE_IMG_SETTLE_MS as string | undefined) ?? '300') || 0,
)

/** 2x2 タイル構成（左上→右上→左下→右下）。x/y はディスプレイ座標、タイル切り出しは origin 差し引き */
export const IMAGE_TILES: readonly ImageTileSpec[] = [
  { x: ORIGIN_X, y: ORIGIN_Y, w: TILE_W, h: TILE_H },
  { x: ORIGIN_X + TILE_W, y: ORIGIN_Y, w: TILE_W, h: TILE_H },
  { x: ORIGIN_X, y: ORIGIN_Y + TILE_H, w: TILE_W, h: TILE_H },
  { x: ORIGIN_X + TILE_W, y: ORIGIN_Y + TILE_H, w: TILE_W, h: TILE_H },
]

export const IMAGE_FULL_W = TILE_W * 2
export const IMAGE_FULL_H = TILE_H * 2

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = url
  })
}

/**
 * 画像 Blob を G2 タイル PNG 群（IMAGE_TILES と同順）に変換する。
 */
export async function buildImageTiles(blob: Blob): Promise<Uint8Array[]> {
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)

    const canvas = document.createElement('canvas')
    canvas.width = IMAGE_FULL_W
    canvas.height = IMAGE_FULL_H
    const ctx = canvas.getContext('2d')!

    // 黒背景（G2 では黒 = 非発光 = 透明）
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, IMAGE_FULL_W, IMAGE_FULL_H)

    // アスペクト維持レターボックス
    const scale = Math.min(IMAGE_FULL_W / img.width, IMAGE_FULL_H / img.height)
    const drawW = Math.max(1, Math.round(img.width * scale))
    const drawH = Math.max(1, Math.round(img.height * scale))
    const drawX = Math.floor((IMAGE_FULL_W - drawW) / 2)
    const drawY = Math.floor((IMAGE_FULL_H - drawH) / 2)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, drawX, drawY, drawW, drawH)

    const tiles: Uint8Array[] = []
    for (const tile of IMAGE_TILES) {
      // tile.x/y はディスプレイ座標（コンテナ配置用）なので canvas 座標に変換して切り出す
      const tileData = ctx.getImageData(tile.x - ORIGIN_X, tile.y - ORIGIN_Y, tile.w, tile.h)
      const gray = quantizeGray16(rgbaToGrayscale(tileData.data, tile.w, tile.h))
      tiles.push(await encodeGrayscalePng(tile.w, tile.h, gray))
    }
    return tiles
  } finally {
    URL.revokeObjectURL(url)
  }
}
