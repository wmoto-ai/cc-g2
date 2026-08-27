// StatusFlow: ピン留めステータスメッセージの投稿・編集・フォールバック。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STATUS_HEARTBEAT_MS, StatusFlow, type StatusFlowDeps } from '../../src/core/status-flow'
import type { StatusMessageRef } from '../../src/core/state'
import { G2_MARKER } from '../../src/telegram/format'
import type { ContextSessionRecord, SessionActivityRecord } from '../../src/hub/types'
import { silentLogger } from '../fixtures/util'

interface Harness {
  flow: StatusFlow
  sent: { chatId: number; html: string; disableNotification?: boolean }[]
  edited: { chatId: number; messageId: number; html: string }[]
  pinned: number[]
  statusRef: () => StatusMessageRef | undefined
  setCtx: (sessions: ContextSessionRecord[]) => void
  setActivity: (sessions: SessionActivityRecord[]) => void
  failHub: (fail: boolean) => void
  failCtxOnly: (fail: boolean) => void
  failEdit: (message: string | null) => void
}

function harness(initialRef?: StatusMessageRef): Harness {
  let ctxSessions: ContextSessionRecord[] = []
  let activities: SessionActivityRecord[] = []
  let hubFail = false
  let ctxFail = false
  let editFailMessage: string | null = null
  let ref = initialRef
  const sent: Harness['sent'] = []
  const edited: Harness['edited'] = []
  const pinned: number[] = []

  const deps: StatusFlowDeps = {
    hub: {
      async getContextStatus() {
        if (hubFail || ctxFail) throw new Error('hub down')
        return ctxSessions
      },
      async getSessionActivity() {
        if (hubFail) throw new Error('hub down')
        return activities
      },
    },
    sender: {
      async sendMessage(chatId, html, options = {}) {
        sent.push({ chatId, html, disableNotification: options.disableNotification })
        return { messageId: 100 + sent.length }
      },
      async editMessageText(chatId, messageId, html) {
        if (editFailMessage) throw new Error(editFailMessage)
        edited.push({ chatId, messageId, html })
      },
      async pinChatMessage(_chatId, messageId) {
        pinned.push(messageId)
      },
    },
    state: {
      getStatusMessage: () => ref,
      setStatusMessage: (next) => {
        ref = next
      },
    },
    chatId: 999,
    intervalMs: 30_000,
    logger: silentLogger,
  }
  return {
    flow: new StatusFlow(deps),
    sent,
    edited,
    pinned,
    statusRef: () => ref,
    setCtx: (s) => (ctxSessions = s),
    setActivity: (s) => (activities = s),
    failHub: (f) => (hubFail = f),
    failCtxOnly: (f) => (ctxFail = f),
    failEdit: (m) => (editFailMessage = m),
  }
}

const CTX: ContextSessionRecord[] = [
  { sessionId: 's1', cwd: '/repo', usedPercentage: 42, model: 'claude-sonnet-5' },
]
const ACT: SessionActivityRecord[] = [{ tmuxTarget: 'cc:1.0', label: 'repo', state: 'active' }]

describe('StatusFlow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('初回は通知なしで投稿し、pin して messageId を保存する', async () => {
    const h = harness()
    h.setCtx(CTX)
    h.setActivity(ACT)
    await h.flow.runOnce()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.disableNotification).toBe(true)
    expect(h.sent[0]!.html).toContain(G2_MARKER.status)
    expect(h.pinned).toEqual([101])
    expect(h.statusRef()).toEqual({ chatId: 999, messageId: 101 })
  })

  it('2 回目以降は edit で更新し、内容が同じ(ts 以外)なら edit しない', async () => {
    const h = harness()
    h.setCtx(CTX)
    h.setActivity(ACT)
    await h.flow.runOnce()
    await h.flow.runOnce() // 変化なし → skip
    expect(h.edited).toHaveLength(0)
    h.setCtx([{ ...CTX[0]!, usedPercentage: 55 }])
    await h.flow.runOnce()
    expect(h.edited).toHaveLength(1)
    expect(h.edited[0]!.messageId).toBe(101)
    expect(h.sent).toHaveLength(1) // 再投稿はしない
  })

  it('内容不変でも STATUS_HEARTBEAT_MS 経過後は ts 更新の edit を行う(ミニアプリの stale 判定対策)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = harness()
    h.setCtx(CTX)
    await h.flow.runOnce() // 初回投稿
    await h.flow.runOnce() // 直後: 内容不変 → skip
    expect(h.edited).toHaveLength(0)
    vi.setSystemTime(1_800_000_000_000 + STATUS_HEARTBEAT_MS + 1)
    await h.flow.runOnce() // 内容不変でも heartbeat で ts を更新する
    expect(h.edited).toHaveLength(1)
  })

  it('hub 両方失敗はスキップ(投稿も編集もしない)', async () => {
    const h = harness()
    h.failHub(true)
    await h.flow.runOnce()
    expect(h.sent).toHaveLength(0)
    expect(h.edited).toHaveLength(0)
  })

  it('edit が message not found 系で失敗したら再投稿して pin し直す', async () => {
    const h = harness({ chatId: 999, messageId: 50 })
    h.setCtx(CTX)
    h.failEdit('Bad Request: message to edit not found')
    await h.flow.runOnce()
    expect(h.sent).toHaveLength(1)
    expect(h.statusRef()).toEqual({ chatId: 999, messageId: 101 })
    expect(h.pinned).toEqual([101])
  })

  it('一過性の edit 失敗(429 等)では再投稿せず次周期に任せる', async () => {
    const h = harness({ chatId: 999, messageId: 50 })
    h.setCtx(CTX)
    h.failEdit('429: Too Many Requests: retry after 5')
    await h.flow.runOnce()
    expect(h.sent).toHaveLength(0) // 重複ステータスを作らない
    expect(h.statusRef()).toEqual({ chatId: 999, messageId: 50 }) // ref は保持
    h.failEdit(null)
    await h.flow.runOnce() // 次周期: 同じメッセージへの edit が成功する
    expect(h.edited).toHaveLength(1)
    expect(h.edited[0]!.messageId).toBe(50)
  })

  it('hub 片側失敗はフィールド欠落として配信し、空配列(0 件)と区別する', async () => {
    const h = harness()
    h.setCtx(CTX) // ctx 側は失敗させる
    h.setActivity([]) // activity 側は「取得できて 0 件」
    h.failCtxOnly(true)
    await h.flow.runOnce()
    const json = h.sent[0]!.html.split('\n').find((l) => l.includes('{'))!
    const payload = JSON.parse(json.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"'))
    expect(payload.ctx).toBeUndefined() // 取得失敗 → フィールド欠落(前回値維持の指示)
    expect(payload.activity).toEqual([]) // 0 件 → 空配列(クリアの指示)
  })

  it('edit の "message is not modified" は成功扱い(再投稿しない)', async () => {
    const h = harness({ chatId: 999, messageId: 50 })
    h.setCtx(CTX)
    h.failEdit('Bad Request: message is not modified')
    await h.flow.runOnce()
    expect(h.sent).toHaveLength(0)
    expect(h.statusRef()).toEqual({ chatId: 999, messageId: 50 })
  })
})
