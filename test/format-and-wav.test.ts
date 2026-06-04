import { describe, expect, it } from 'vitest'

import { concatChunks, encodePcm16kMonoS16leToWav } from '../src/audio/wav'
import { formatForG2Display, formatForG2ScrollableText } from '../src/g2-format'

describe('formatForG2Display', () => {
  it('returns fallback text for empty input', () => {
    expect(formatForG2Display('   ')).toBe('（認識結果なし）')
  })

  it('wraps text into multiple lines without exceeding max lines', () => {
    expect(formatForG2Display('alpha beta gamma delta epsilon', 2, 12)).toBe('alpha beta\ngamma delta…')
  })
})

describe('formatForG2ScrollableText', () => {
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
