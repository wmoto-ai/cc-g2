import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'
import { encodeGrayscalePng, crc32, rgbaToGrayscale, quantizeGray16 } from '../src/image/grayscale-png'

function readU32BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
}

/** PNG バイト列からチャンクを取り出す */
function findChunk(png: Uint8Array, type: string): { data: Uint8Array; crc: number } {
  let off = 8 // signature
  while (off < png.length) {
    const len = readU32BE(png, off)
    const t = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7])
    if (t === type) {
      return { data: png.slice(off + 8, off + 8 + len), crc: readU32BE(png, off + 8 + len) }
    }
    off += 12 + len
  }
  throw new Error(`chunk not found: ${type}`)
}

describe('encodeGrayscalePng', () => {
  it('PNG signature と IHDR が正しい', async () => {
    const png = await encodeGrayscalePng(4, 2, new Uint8Array([0, 32, 64, 96, 128, 160, 192, 255]))
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

    const ihdr = findChunk(png, 'IHDR')
    expect(readU32BE(ihdr.data, 0)).toBe(4) // width
    expect(readU32BE(ihdr.data, 4)).toBe(2) // height
    expect(ihdr.data[8]).toBe(8) // bit depth
    expect(ihdr.data[9]).toBe(0) // color type: greyscale
    expect(ihdr.data[12]).toBe(0) // interlace: none
  })

  it('IDAT を inflate するとフィルタバイト付きのピクセルが復元できる', async () => {
    const pixels = new Uint8Array([10, 20, 30, 40, 50, 60])
    const png = await encodeGrayscalePng(3, 2, pixels)
    const idat = findChunk(png, 'IDAT')
    const raw = inflateSync(idat.data)

    // 各行: filter byte (0) + width bytes
    expect(raw.length).toBe(2 * (1 + 3))
    expect(raw[0]).toBe(0)
    expect(Array.from(raw.subarray(1, 4))).toEqual([10, 20, 30])
    expect(raw[4]).toBe(0)
    expect(Array.from(raw.subarray(5, 8))).toEqual([40, 50, 60])
  })

  it('チャンク CRC が正しい', async () => {
    const png = await encodeGrayscalePng(2, 2, new Uint8Array([0, 85, 170, 255]))
    for (const type of ['IHDR', 'IDAT', 'IEND']) {
      const chunk = findChunk(png, type)
      const crcInput = new Uint8Array(4 + chunk.data.length)
      for (let i = 0; i < 4; i++) crcInput[i] = type.charCodeAt(i)
      crcInput.set(chunk.data, 4)
      expect(chunk.crc).toBe(crc32(crcInput))
    }
  })

  it('ピクセル数が合わないと throw する', async () => {
    await expect(encodeGrayscalePng(2, 2, new Uint8Array(3))).rejects.toThrow(/length mismatch/)
  })
})

describe('rgbaToGrayscale', () => {
  it('輝度変換 (0.299R + 0.587G + 0.114B)', () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, // red → 76
      0, 255, 0, 255, // green → 150
      0, 0, 255, 255, // blue → 29
      255, 255, 255, 255, // white → 255
    ])
    expect(Array.from(rgbaToGrayscale(rgba, 4, 1))).toEqual([76, 150, 29, 255])
  })
})

describe('quantizeGray16', () => {
  it('16階調に量子化される', () => {
    const out = quantizeGray16(new Uint8Array([0, 8, 17, 128, 255]))
    expect(out[0]).toBe(0)
    expect(out[4]).toBe(255)
    const distinct = new Set(quantizeGray16(Uint8Array.from({ length: 256 }, (_, i) => i)))
    expect(distinct.size).toBe(16)
  })
})
