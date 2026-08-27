import { describe, expect, it } from 'vitest'
import { createBackoff } from '../../src/util/backoff'

describe('createBackoff', () => {
  it('ジッタなしで指数的に増え上限で頭打ちになる', () => {
    const backoff = createBackoff({ baseMs: 1000, maxMs: 30_000, factor: 2, jitter: 0 })
    expect(backoff.next()).toBe(1000)
    expect(backoff.next()).toBe(2000)
    expect(backoff.next()).toBe(4000)
    expect(backoff.next()).toBe(8000)
    expect(backoff.next()).toBe(16_000)
    expect(backoff.next()).toBe(30_000)
    expect(backoff.next()).toBe(30_000)
  })

  it('reset で初期値に戻る', () => {
    const backoff = createBackoff({ baseMs: 1000, jitter: 0 })
    backoff.next()
    backoff.next()
    backoff.reset()
    expect(backoff.next()).toBe(1000)
  })

  it('ジッタは raw*(1±jitter) の範囲に収まる', () => {
    const low = createBackoff({ baseMs: 1000, jitter: 0.3, random: () => 0 })
    const high = createBackoff({ baseMs: 1000, jitter: 0.3, random: () => 1 })
    expect(low.next()).toBe(700)
    expect(high.next()).toBe(1300)
  })
})
