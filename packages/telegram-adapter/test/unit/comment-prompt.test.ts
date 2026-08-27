import { describe, expect, it } from 'vitest'
import { CommentPromptStore } from '../../src/telegram/comment-prompt'

describe('CommentPromptStore', () => {
  it('登録 → take で消費、二度目は null', () => {
    const store = new CommentPromptStore(1000, () => 0)
    store.register(1, 10, 'apv-1')
    expect(store.take(1, 10)).toBe('apv-1')
    expect(store.take(1, 10)).toBeNull()
  })

  it('chatId:messageId の複合キーで突合する(別 chat の同 messageId は別物)', () => {
    const store = new CommentPromptStore(1000, () => 0)
    store.register(1, 10, 'apv-1')
    expect(store.take(2, 10)).toBeNull()
    expect(store.take(1, 10)).toBe('apv-1')
  })

  it('TTL 失効後は null', () => {
    let now = 0
    const store = new CommentPromptStore(1000, () => now)
    store.register(1, 10, 'apv-1')
    now = 1001
    expect(store.take(1, 10)).toBeNull()
  })

  it('prune で失効分が消える', () => {
    let now = 0
    const store = new CommentPromptStore(1000, () => now)
    store.register(1, 10, 'a')
    store.register(1, 11, 'b')
    now = 1001
    store.prune()
    expect(store.size()).toBe(0)
  })
})
