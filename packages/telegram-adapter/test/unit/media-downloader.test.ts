import { describe, expect, it } from 'vitest'
import type { Api } from 'grammy'
import {
  createTelegramDownloader,
  detectBinaryFormat,
  formatByExtension,
  formatFromMime,
  isPlausibleText,
} from '../../src/telegram/media-downloader'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01])
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x01,
])
const PDF = new TextEncoder().encode('%PDF-1.7\n…')
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02])
const MP3_ID3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00])
const MP3_SYNC = new Uint8Array([0xff, 0xfb, 0x90, 0x00]) // MPEG1 Layer III, 128kbps, 44.1kHz
const WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
])

/** ftyp box を組み立てる(size + 'ftyp' + major + minor + compatible...) */
function ftypBox(major: string, compatible: string[] = []): Uint8Array {
  const brands = [major, '\x00\x00\x00\x00', ...compatible] // minor version 4 バイトを挟む
  const body = new TextEncoder().encode(`ftyp${brands.join('')}`)
  const size = 4 + body.length
  return new Uint8Array([size >>> 24, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, ...body])
}

const M4A = ftypBox('M4A ')
const FMT_JPG = formatByExtension('jpg')!
const FMT_PNG = formatByExtension('png')!

function fakeApi(file: { file_path?: string; file_size?: number } = { file_path: 'files/f.bin' }): {
  api: Api
  getFileCalls: string[]
} {
  const getFileCalls: string[] = []
  const api = {
    async getFile(fileId: string) {
      getFileCalls.push(fileId)
      return { file_id: fileId, file_unique_id: `${fileId}-uniq`, ...file }
    },
  } as unknown as Api
  return { api, getFileCalls }
}

function fetchBytes(bytes: Uint8Array): typeof fetch {
  return async () => new Response(new Uint8Array(bytes))
}

describe('detectBinaryFormat', () => {
  it('画像(JPEG / PNG / GIF / WebP)の magic bytes を判定する', () => {
    expect(detectBinaryFormat(JPEG)).toBe('jpg')
    expect(detectBinaryFormat(PNG)).toBe('png')
    expect(detectBinaryFormat(GIF)).toBe('gif')
    expect(detectBinaryFormat(WEBP)).toBe('webp')
  })

  it('PDF・音声(ogg / mp3 / m4a / wav)の magic bytes を判定する', () => {
    expect(detectBinaryFormat(PDF)).toBe('pdf')
    expect(detectBinaryFormat(OGG)).toBe('ogg')
    expect(detectBinaryFormat(MP3_ID3)).toBe('mp3')
    expect(detectBinaryFormat(MP3_SYNC)).toBe('mp3')
    expect(detectBinaryFormat(M4A)).toBe('m4a')
    expect(detectBinaryFormat(WAV)).toBe('wav')
  })

  it('RIFF コンテナは WebP と WAV を offset 8 で区別し、未知の RIFF は null', () => {
    const riffUnknown = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20,
    ])
    expect(detectBinaryFormat(riffUnknown)).toBeNull() // RIFF....AVI(対応外)
  })

  it('未知の先頭バイトは null(テキスト・空)', () => {
    expect(detectBinaryFormat(new TextEncoder().encode('hello world!'))).toBeNull()
    expect(detectBinaryFormat(new Uint8Array())).toBeNull()
  })
})

describe('isM4a(ftyp brand 検証)', () => {
  const detect = formatByExtension('m4a')!.detect

  it('major brand が M4A 系なら受理する', () => {
    expect(detect(ftypBox('M4A '))).toBe(true)
    expect(detect(ftypBox('M4B '))).toBe(true)
  })

  it('mp42 major でも compatible brands に M4A があれば受理する', () => {
    expect(detect(ftypBox('mp42', ['isom', 'M4A ']))).toBe(true)
  })

  it('MP4 動画 / AVIF / HEIC 等の非 M4A brand は拒否する(ftypisom / ftypmp42)', () => {
    expect(detect(ftypBox('isom', ['iso2', 'mp41']))).toBe(false)
    expect(detect(ftypBox('mp42', ['isom', 'iso2']))).toBe(false)
    expect(detect(ftypBox('avif', ['mif1']))).toBe(false)
    expect(detect(ftypBox('heic', ['mif1']))).toBe(false)
  })
})

describe('video 判定(mp4 / mov / webm)と m4a との相互排他', () => {
  const isMp4 = formatByExtension('mp4')!.detect
  const isMov = formatByExtension('mov')!.detect
  const isWebm = formatByExtension('webm')!.detect
  const isM4a = formatByExtension('m4a')!.detect
  const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]) // EBML magic

  it('mp4: 動画系 brand(isom / mp42 / avc1 等)を受理する', () => {
    expect(isMp4(ftypBox('isom', ['iso2', 'avc1']))).toBe(true)
    expect(isMp4(ftypBox('mp42'))).toBe(true)
  })

  it('m4a ↔ mp4 は相互排他: M4A 系 brand を含む ftyp は m4a のみ、動画 brand のみは mp4 のみ', () => {
    const m4aMajor = ftypBox('M4A ')
    const m4aCompat = ftypBox('mp42', ['isom', 'M4A '])
    expect(isM4a(m4aMajor)).toBe(true)
    expect(isM4a(m4aCompat)).toBe(true)
    expect(isMp4(m4aMajor)).toBe(false)
    expect(isMp4(m4aCompat)).toBe(false)

    const videoOnly = ftypBox('isom', ['mp42'])
    expect(isMp4(videoOnly)).toBe(true)
    expect(isM4a(videoOnly)).toBe(false)
  })

  it('mov: qt brand を受理し、mp4 とは区別される', () => {
    const qt = ftypBox('qt  ')
    expect(isMov(qt)).toBe(true)
    expect(isMp4(qt)).toBe(false)
  })

  it('webm: EBML magic を受理する', () => {
    expect(isWebm(WEBM)).toBe(true)
    expect(isWebm(OGG)).toBe(false)
  })

  it('detectBinaryFormat は ftyp ファミリを m4a / mp4 / mov に振り分ける', () => {
    expect(detectBinaryFormat(ftypBox('M4A '))).toBe('m4a')
    expect(detectBinaryFormat(ftypBox('isom'))).toBe('mp4')
    expect(detectBinaryFormat(ftypBox('qt  '))).toBe('mov')
    expect(detectBinaryFormat(WEBM)).toBe('webm')
  })
})

describe('isMp3(frame header 検証)', () => {
  const detect = formatByExtension('mp3')!.detect

  it('sync だけ合っていても reserved 値のヘッダは拒否する', () => {
    expect(detect(new Uint8Array([0xff, 0xe0, 0x90, 0x00]))).toBe(false) // layer 00 = reserved
    expect(detect(new Uint8Array([0xff, 0xeb, 0x90, 0x00]))).toBe(false) // version 01 = reserved
    expect(detect(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]))).toBe(false) // bitrate 1111 = bad
    expect(detect(new Uint8Array([0xff, 0xfb, 0x9c, 0x00]))).toBe(false) // frequency 11 = reserved
  })

  it('妥当な frame header と ID3 は受理する', () => {
    expect(detect(MP3_SYNC)).toBe(true)
    expect(detect(MP3_ID3)).toBe(true)
  })
})

describe('isPlausibleText', () => {
  it('UTF-8 テキスト(日本語含む)は許可される', () => {
    expect(isPlausibleText(new TextEncoder().encode('# メモ\nabc,def\n'))).toBe(true)
  })

  it('NUL バイトは位置を問わず拒否される(8KB 以降も全走査)', () => {
    expect(isPlausibleText(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false)
    const tail = new Uint8Array(9_000).fill(0x61) // 'a' × 9000
    tail[8_500] = 0x00
    expect(isPlausibleText(tail)).toBe(false)
  })

  it('既知バイナリの magic で始まるデータは text 申告でも拒否される(%PDF 等)', () => {
    expect(isPlausibleText(PDF)).toBe(false) // %PDF は UTF-8 として妥当でも拒否
    expect(isPlausibleText(OGG)).toBe(false)
  })

  it('UTF-8 として不正なバイト列は拒否される', () => {
    expect(isPlausibleText(new Uint8Array([0xc3, 0x28, 0xa0, 0xa1]))).toBe(false)
  })
})

describe('formatFromMime / formatByExtension', () => {
  it('charset 等のパラメータと大文字小文字を無視して引く', () => {
    expect(formatFromMime('text/plain; charset=utf-8')?.extension).toBe('txt')
    expect(formatFromMime('Audio/MPEG')?.extension).toBe('mp3')
    expect(formatFromMime('application/zip')).toBeUndefined()
  })

  it('拡張子でも引ける(registry の一貫性)', () => {
    expect(formatByExtension('md')?.category).toBe('text')
    expect(formatByExtension('exe')).toBeUndefined()
  })
})

describe('createTelegramDownloader', () => {
  it('実データが期待形式と一致すれば ok', async () => {
    const { api } = fakeApi()
    const dl = createTelegramDownloader(api, { token: 't', maxBytes: 100, fetchFn: fetchBytes(JPEG) })
    const result = await dl.downloadMedia({ fileId: 'f', expected: FMT_JPG })
    expect(result).toMatchObject({ ok: true, format: { extension: 'jpg' } })
  })

  it('申告 MIME と実データが不一致なら type-mismatch(PNG 申告で中身 JPEG)', async () => {
    const { api } = fakeApi()
    const dl = createTelegramDownloader(api, { token: 't', maxBytes: 100, fetchFn: fetchBytes(JPEG) })
    const result = await dl.downloadMedia({ fileId: 'f', expected: FMT_PNG })
    expect(result).toEqual({ ok: false, reason: 'type-mismatch', detected: 'jpg' })
  })

  it('申告サイズが上限超過なら getFile を呼ばずに too-large', async () => {
    const { api, getFileCalls } = fakeApi()
    const dl = createTelegramDownloader(api, { token: 't', maxBytes: 10, fetchFn: fetchBytes(JPEG) })
    const result = await dl.downloadMedia({ fileId: 'f', expected: FMT_JPG, declaredSize: 11 })
    expect(result).toEqual({ ok: false, reason: 'too-large', size: 11, limit: 10 })
    expect(getFileCalls).toHaveLength(0)
  })

  it('getFile の file_size が上限超過ならダウンロードせずに too-large', async () => {
    const { api } = fakeApi({ file_path: 'files/f.bin', file_size: 11 })
    let fetched = false
    const dl = createTelegramDownloader(api, {
      token: 't',
      maxBytes: 10,
      fetchFn: async () => {
        fetched = true
        return new Response(new Uint8Array(JPEG))
      },
    })
    const result = await dl.downloadMedia({ fileId: 'f', expected: FMT_JPG })
    expect(result).toMatchObject({ ok: false, reason: 'too-large', size: 11 })
    expect(fetched).toBe(false)
  })

  it('stream 読みで上限超過が確定した時点で中断する(全量を読まない)', async () => {
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 1_000) {
          controller.close()
          return
        }
        controller.enqueue(new Uint8Array(1_024))
      },
    })
    const { api } = fakeApi()
    const dl = createTelegramDownloader(api, {
      token: 't',
      maxBytes: 2_048,
      fetchFn: async () => new Response(stream),
    })
    const result = await dl.downloadMedia({ fileId: 'f', expected: FMT_JPG })
    expect(result).toMatchObject({ ok: false, reason: 'too-large' })
    expect(pulls).toBeLessThan(10) // 3 チャンク目(3072 bytes)で打ち切られる
  })

  it('ダウンロードが timeoutMs 以内に完了しなければ failed', async () => {
    const { api } = fakeApi()
    const neverResolves: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const dl = createTelegramDownloader(api, {
      token: 't',
      maxBytes: 100,
      fetchFn: neverResolves,
      timeoutMs: 20,
    })
    const result = await dl.downloadMedia({ fileId: 'f', expected: FMT_JPG })
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
  })

  it('HTTP エラーは failed(detail に URL や token を含めない)', async () => {
    const { api } = fakeApi()
    const dl = createTelegramDownloader(api, {
      token: 'SECRET',
      maxBytes: 100,
      fetchFn: async () => new Response('nope', { status: 404 }),
    })
    const result = await dl.downloadMedia({ fileId: 'f', expected: FMT_JPG })
    expect(result).toEqual({ ok: false, reason: 'failed', detail: 'download HTTP 404' })
  })
})
