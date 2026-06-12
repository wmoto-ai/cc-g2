/**
 * 8bit グレースケール PNG エンコーダ
 *
 * G2 への画像送信用。updateImageRawData にはエンコード済み PNG バイト列を渡し、
 * Even App ホスト側が gray4（16階調）に変換して BLE 送信する。
 * canvas.toBlob('image/png') は RGBA PNG になりホスト変換の挙動が不確実なため、
 * colorType=0 (greyscale) の PNG を自前で組み立てる（Visionote 方式）。
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    crcTable[n] = c >>> 0
  }
  return crcTable
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + data.length + 4)
  writeU32BE(chunk, 0, data.length)
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(data, 8)
  const crcData = new Uint8Array(4 + data.length)
  for (let i = 0; i < 4; i++) crcData[i] = type.charCodeAt(i)
  crcData.set(data, 4)
  writeU32BE(chunk, 8 + data.length, crc32(crcData))
  return chunk
}

async function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  void writer.write(data as unknown as BufferSource)
  void writer.close()

  const reader = cs.readable.getReader()
  const chunks: Uint8Array[] = []
  let totalLen = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    totalLen += value.length
  }
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const c of chunks) {
    result.set(c, offset)
    offset += c.length
  }
  return result
}

/**
 * 8bit グレースケールピクセル列（width*height bytes, 行優先）を PNG にエンコードする。
 */
export async function encodeGrayscalePng(
  width: number,
  height: number,
  pixels: Uint8Array,
): Promise<Uint8Array> {
  if (pixels.length !== width * height) {
    throw new Error(`pixels length mismatch: expected ${width * height}, got ${pixels.length}`)
  }

  // IHDR: width(4) + height(4) + bitDepth(1) + colorType(1) + compression(1) + filter(1) + interlace(1)
  const ihdrData = new Uint8Array(13)
  writeU32BE(ihdrData, 0, width)
  writeU32BE(ihdrData, 4, height)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 0 // color type 0 = greyscale
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter method
  ihdrData[12] = 0 // interlace
  const ihdr = makePngChunk('IHDR', ihdrData)

  // IDAT: 各行の先頭にフィルタバイト 0 (None)
  const rawData = new Uint8Array(height * (1 + width))
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width)] = 0
    rawData.set(pixels.subarray(y * width, (y + 1) * width), y * (1 + width) + 1)
  }
  const idat = makePngChunk('IDAT', await zlibCompress(rawData))
  const iend = makePngChunk('IEND', new Uint8Array(0))

  const png = new Uint8Array(PNG_SIGNATURE.length + ihdr.length + idat.length + iend.length)
  let off = 0
  png.set(PNG_SIGNATURE, off)
  off += PNG_SIGNATURE.length
  png.set(ihdr, off)
  off += ihdr.length
  png.set(idat, off)
  off += idat.length
  png.set(iend, off)
  return png
}

/** RGBA ImageData から輝度ベースの 8bit グレースケールに変換する。 */
export function rgbaToGrayscale(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height)
  for (let i = 0; i < pixels.length; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    pixels[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  return pixels
}

/** G2 の 4bit（16階調）表示に合わせて量子化する（プレビュー一致用）。 */
export function quantizeGray16(pixels: Uint8Array): Uint8Array {
  const out = new Uint8Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    out[i] = Math.round(Math.round((pixels[i] / 255) * 15) * (255 / 15))
  }
  return out
}
