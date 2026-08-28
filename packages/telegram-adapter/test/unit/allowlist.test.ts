import { describe, expect, it } from 'vitest'
import type { Context } from 'grammy'
import { accessControl } from '../../src/telegram/allowlist'
import { silentLogger } from '../fixtures/util'

function makeCtx(fromId: number | undefined, chatId: number | undefined): Context {
  return {
    from: fromId !== undefined ? { id: fromId } : undefined,
    chat: chatId !== undefined ? { id: chatId } : undefined,
    update: { update_id: 1 },
  } as unknown as Context
}

async function runMiddleware(ctx: Context): Promise<boolean> {
  const middleware = accessControl({
    allowedUserIds: new Set([111]),
    chatId: 111,
    logger: silentLogger,
  })
  let passed = false
  await middleware(ctx, async () => {
    passed = true
  })
  return passed
}

describe('accessControl', () => {
  it('allowlist ユーザー + 設定 chat のみ通す', async () => {
    expect(await runMiddleware(makeCtx(111, 111))).toBe(true)
  })

  it('allowlist 外ユーザーは拒否', async () => {
    expect(await runMiddleware(makeCtx(222, 111))).toBe(false)
  })

  it('from が無い update は拒否', async () => {
    expect(await runMiddleware(makeCtx(undefined, 111))).toBe(false)
  })

  it('allowlist ユーザーでも別 chat は拒否(fail-closed)', async () => {
    expect(await runMiddleware(makeCtx(111, -100999))).toBe(false)
  })

  it('chat が取れない update(inline 由来など)は拒否', async () => {
    expect(await runMiddleware(makeCtx(111, undefined))).toBe(false)
  })
})
