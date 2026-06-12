import { describe, expect, it } from 'vitest'

import { concatChunks, encodePcm16kMonoS16leToWav } from '../src/audio/wav'
import { formatForG2ScrollableText } from '../src/g2/text-format'

describe('formatForG2ScrollableText', () => {
  it('returns fallback text for empty input', () => {
    expect(formatForG2ScrollableText('   ')).toBe('（認識結果なし）')
  })

  it('keeps long STT text scrollable instead of truncating it to a few lines', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const formatted = formatForG2ScrollableText(text)
    expect(formatted).toBe(text)
    expect(formatted).not.toContain('\n')
  })

  it('caps scrollable STT text by UTF-8 bytes with an ellipsis', () => {
    const formatted = formatForG2ScrollableText('あ'.repeat(400), 30)
    expect(new TextEncoder().encode(formatted).length).toBeLessThanOrEqual(30)
    expect(formatted.endsWith('…')).toBe(true)
  })

  it('ちょうど maxBytes に収まるテキストは切り詰めない（truncateByBytes 一本化の境界確認）', () => {
    const text = 'あ'.repeat(10) // 30 bytes
    expect(formatForG2ScrollableText(text, 30)).toBe(text)
  })
})

describe('wav helpers', () => {
  it('concatenates chunks in order', () => {
    const out = concatChunks([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])])
    expect([...out]).toEqual([1, 2, 3, 4, 5])
  })

  it('encodes PCM to a 16k mono WAV header', () => {
    const pcm = new Uint8Array([1, 0, 255, 127])
    const wav = encodePcm16kMonoS16leToWav(pcm)
    const ascii = (start: number, end: number) =>
      String.fromCharCode(...Array.from(wav.slice(start, end)))
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)

    expect(wav.byteLength).toBe(48)
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 12)).toBe('WAVE')
    expect(ascii(12, 16)).toBe('fmt ')
    expect(ascii(36, 40)).toBe('data')
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    expect([...wav.slice(44)]).toEqual([1, 0, 255, 127])
  })
})
