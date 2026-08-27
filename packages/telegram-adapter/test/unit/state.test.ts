// StateStore の stopMessages 永続化と旧形式(値が notificationId の string)からの移行。
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { StateStore } from '../../src/core/state'
import { silentLogger } from '../fixtures/util'

async function tmpStatePath(): Promise<string> {
  await mkdir(path.resolve('tmp'), { recursive: true })
  const dir = await mkdtemp(path.resolve('tmp', 'state-unit-'))
  return path.join(dir, 'state.json')
}

describe('StateStore stopMessages', () => {
  it('addStopMessage は postedAt 付きで永続化され、再ロードで復元される', async () => {
    const statePath = await tmpStatePath()
    const state = await StateStore.load(statePath, silentLogger)
    state.addStopMessage(111, 42, 'n-1')
    await state.flushNow()

    const reloaded = await StateStore.load(statePath, silentLogger)
    const entry = reloaded.getStopMessage(111, 42)
    expect(entry?.notificationId).toBe('n-1')
    expect(Number.isFinite(Date.parse(entry?.postedAt ?? ''))).toBe(true)
  })

  it('旧形式(値が string)の state.json は load 時刻起点の postedAt で移行される', async () => {
    const statePath = await tmpStatePath()
    await writeFile(
      statePath,
      JSON.stringify({
        postedApprovals: {},
        stopMessages: { '111:42': 'n-old', '111:43': { notificationId: 'n-new', postedAt: '2026-07-07T00:00:00.000Z' } },
        seenNotificationIds: [],
      }),
      'utf8',
    )

    const before = Date.now()
    const state = await StateStore.load(statePath, silentLogger)
    const migrated = state.getStopMessage(111, 42)
    expect(migrated?.notificationId).toBe('n-old')
    expect(Date.parse(migrated?.postedAt ?? '')).toBeGreaterThanOrEqual(before - 1_000)
    // 新形式はそのまま保持される
    expect(state.getStopMessage(111, 43)).toEqual({
      notificationId: 'n-new',
      postedAt: '2026-07-07T00:00:00.000Z',
    })
  })

  it('保存形式は新スキーマ(object)で書き出される', async () => {
    const statePath = await tmpStatePath()
    const state = await StateStore.load(statePath, silentLogger)
    state.addStopMessage(111, 42, 'n-1')
    await state.flushNow()
    const raw = JSON.parse(await readFile(statePath, 'utf8')) as {
      stopMessages: Record<string, unknown>
    }
    expect(raw.stopMessages['111:42']).toMatchObject({ notificationId: 'n-1' })
  })
})
