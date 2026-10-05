/**
 * herdr ソース（herdr-events.mjs）の単体テスト
 *
 * 背景:
 * - herdr で起動した agent は tmux のペイン監視に載らないため、herdr の agent 状態を
 *   sessionActivity（`herdr:<pane_id>`）にマージして G2 の状態マークに使う。
 * - 5 秒ポーリングでは 5 秒未満のターンを取りこぼしたため、events.subscribe の
 *   pane.agent_status_changed で遷移を直接処理する。agent.list はラベル・ペイン集合の更新用。
 *
 * herdr socket には繋がない（HERDR_SOCKET_PATH を存在しないパスにし、pane.read は失敗扱い）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CC_G2_SESSION_ACTIVITY_DISABLED = '1'
process.env.HUB_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'hub-herdr-events-'))
process.env.HERDR_SOCKET_PATH = path.join(process.env.HUB_DATA_DIR, 'no-such.sock')
const { parseHerdrAgents, applyHerdrAgents, applyHerdrStatusEvent, classifyHerdrEvent } = await import(
  '../server/notification-hub/herdr-events.mjs'
)
const { store } = await import('../server/notification-hub/store.mjs')

const agent = (paneId, status, cwd, name = 'claude') => ({
  agent: name,
  agent_status: status,
  cwd,
  pane_id: paneId,
})

/** sessionActivity から herdr: 名前空間のエントリだけ取り出す。 */
const herdrEntries = () =>
  [...store.sessionActivity.keys()].filter((k) => k.startsWith('herdr:'))

// 遷移処理（通知作成）は非同期で走るので一拍待つ
const flush = () => new Promise((r) => setTimeout(r, 20))
const completions = (label) => store.notifications.filter((n) => n.title === `完了: ${label}`)

let seq = 0
// テスト間でペインの内部状態が混ざらないよう、毎回別の pane_id を使う
const nextPane = () => `w9:p${++seq}`

beforeEach(() => {
  // 前テストのペインは dead → 掃除の 2 段階で消しておく
  applyHerdrAgents([])
  applyHerdrAgents([])
  store.sessionActivity.clear()
  store.notifications.length = 0
  store.notificationsById.clear()
})

describe('parseHerdrAgents', () => {
  it('working→active / idle→idle にマッピングし、cwd basename を label にする', () => {
    expect(parseHerdrAgents([
      agent('w4:p2', 'working', '/work/cc-g2'),
      agent('w4:p1', 'idle', '/work/example-repo'),
    ])).toMatchObject([
      { key: 'herdr:w4:p2', label: 'cc-g2', state: 'active', paneId: 'w4:p2', agent: 'claude', status: 'working' },
      { key: 'herdr:w4:p1', label: 'example-repo', state: 'idle', paneId: 'w4:p1', agent: 'claude', status: 'idle' },
    ])
  })

  it('blocked→waiting / done→done、未知ステータスは idle', () => {
    expect(parseHerdrAgents([agent('a', 'blocked', '/x'), agent('b', 'done', '/y'), agent('c', 'starting', '/z')])
      .map((a) => a.state)).toEqual(['waiting', 'done', 'idle'])
  })

  it('pane_id 欠落・配列以外は無視する', () => {
    expect(parseHerdrAgents(undefined)).toEqual([])
    expect(parseHerdrAgents([{ cwd: '/a' }, null])).toEqual([])
  })
})

describe('applyHerdrAgents', () => {
  it('新規ペインを登録する（初回観測は通知しない）', async () => {
    const p = nextPane()
    expect(applyHerdrAgents([agent(p, 'working', '/a/b/repo', 'dsh-tui')])).toBe(true)
    expect(store.sessionActivity.get(`herdr:${p}`)).toMatchObject({ tmuxTarget: `herdr:${p}`, label: 'repo', state: 'active' })
    await flush()
    expect(store.notifications).toHaveLength(0)
  })

  it('前回いたペインが消えたら dead → 次回で掃除（2 段階）', () => {
    const p = nextPane()
    applyHerdrAgents([agent(p, 'idle', '/a/b/repo')])
    expect(applyHerdrAgents([])).toBe(true)
    expect(store.sessionActivity.get(`herdr:${p}`).state).toBe('dead')
    expect(applyHerdrAgents([])).toBe(true)
    expect(herdrEntries()).toHaveLength(0)
  })

  it('状態が変わらなければ changed=false', () => {
    const p = nextPane()
    applyHerdrAgents([agent(p, 'working', '/a/b/repo')])
    expect(applyHerdrAgents([agent(p, 'working', '/a/b/repo')])).toBe(false)
  })

  it('購読が無い間（transitions=true）は list の差分で遷移を処理する', async () => {
    const p = nextPane()
    applyHerdrAgents([agent(p, 'working', '/a/b/poll', 'dsh-tui')])
    applyHerdrAgents([agent(p, 'idle', '/a/b/poll', 'dsh-tui')])
    await flush()
    expect(completions('poll')).toHaveLength(1)
  })
})

describe('applyHerdrStatusEvent', () => {
  it('5 秒未満のターン（working→idle）もイベントで完了通知になる', async () => {
    const p = nextPane()
    applyHerdrAgents([agent(p, 'idle', '/a/b/quick', 'dsh-tui')])
    expect(applyHerdrStatusEvent({ pane_id: p, agent_status: 'working', agent: 'dsh-tui' })).toBe(true)
    expect(store.sessionActivity.get(`herdr:${p}`).state).toBe('active')
    applyHerdrStatusEvent({ pane_id: p, agent_status: 'idle', agent: 'dsh-tui' })
    await flush()
    expect(completions('quick')).toHaveLength(1)
    expect(completions('quick')[0].metadata).toMatchObject({ hookType: 'stop', tmuxTarget: `herdr:${p}` })
  })

  it('購読中は古い list で状態を巻き戻さず、完了通知を二重にしない', async () => {
    const p = nextPane()
    applyHerdrAgents([agent(p, 'idle', '/a/b/race', 'dsh-tui')])
    applyHerdrStatusEvent({ pane_id: p, agent_status: 'working' })
    applyHerdrStatusEvent({ pane_id: p, agent_status: 'idle' })
    // イベントより前に取った list（まだ working）が後から届く
    applyHerdrAgents([agent(p, 'working', '/a/b/race', 'dsh-tui')], { transitions: false })
    expect(store.sessionActivity.get(`herdr:${p}`).state).toBe('idle')
    // フォールバックの list（idle）でも重ねない
    applyHerdrAgents([agent(p, 'idle', '/a/b/race', 'dsh-tui')], { transitions: false })
    await flush()
    expect(completions('race')).toHaveLength(1)
  })

  it('同じ状態の再送・未知ペイン・壊れたデータは無視する', () => {
    const p = nextPane()
    applyHerdrAgents([agent(p, 'idle', '/a/b/x')])
    expect(applyHerdrStatusEvent({ pane_id: p, agent_status: 'idle' })).toBe(false)
    expect(applyHerdrStatusEvent({ pane_id: 'w0:unknown', agent_status: 'working' })).toBe(false)
    expect(applyHerdrStatusEvent(undefined)).toBe(false)
  })
})

describe('classifyHerdrEvent', () => {
  it('ドット区切り・スネークケースの両方を分類する', () => {
    expect(classifyHerdrEvent('pane.agent_status_changed')).toBe('status')
    expect(classifyHerdrEvent('pane_created')).toBe('lifecycle')
    expect(classifyHerdrEvent('pane.closed')).toBe('lifecycle')
    expect(classifyHerdrEvent('pane.scroll_changed')).toBe('ignore')
  })
})
