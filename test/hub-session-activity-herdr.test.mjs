/**
 * session-activity の herdr ソース対応の単体テスト
 *
 * 背景（タスク #9）:
 * - herdr（terminal workspace manager）で起動した Claude Code は tmux 経由の
 *   ペイン監視に載らず、G2 ヘッダの状態マークが出なかった。
 * - 同じポーリング周期で `herdr agent list` をマージし、agent_status を
 *   active/idle に、消えたペインを dead にマッピングする。
 *
 * exec を注入して純粋にステート遷移だけを検証する（herdr CLI 非依存）。
 */
import { describe, it, expect, beforeEach } from 'vitest'

// 静的 import は hoist され env 設定より先に走るため、動的 import で
// ポーリング開始ガード（CC_G2_SESSION_ACTIVITY_DISABLED）を確実に効かせる
process.env.CC_G2_SESSION_ACTIVITY_DISABLED = '1'
const { parseHerdrAgents, pollHerdrActivity } = await import(
  '../server/notification-hub/session-activity.mjs'
)
const { store } = await import('../server/notification-hub/store.mjs')

/** `herdr agent list` の JSON を返す fake exec を作る（引数は無視）。 */
const execWith = (agents) => () =>
  JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents } })

const agent = (paneId, status, cwd) => ({
  agent: 'claude',
  agent_status: status,
  cwd,
  pane_id: paneId,
})

/** sessionActivity から herdr: 名前空間のエントリだけ取り出す。 */
const herdrEntries = () =>
  [...store.sessionActivity.keys()].filter((k) => k.startsWith('herdr:'))

beforeEach(() => {
  store.sessionActivity.clear()
})

describe('parseHerdrAgents', () => {
  it('working→active / idle→idle にマッピングし、cwd basename を label にする', () => {
    const raw = execWith([
      agent('w4:p2', 'working', '/work/cc-g2'),
      agent('w4:p1', 'idle', '/work/example-repo'),
    ])()
    expect(parseHerdrAgents(raw)).toEqual([
      { key: 'herdr:w4:p2', label: 'cc-g2', state: 'active' },
      { key: 'herdr:w4:p1', label: 'example-repo', state: 'idle' },
    ])
  })

  it('working 以外の未知ステータスは idle 扱い（error 判定はしない）', () => {
    const raw = execWith([agent('w4:p9', 'starting', '/tmp/foo')])()
    expect(parseHerdrAgents(raw)[0].state).toBe('idle')
  })

  it('pane_id 欠落・壊れた JSON は無視する', () => {
    expect(parseHerdrAgents('not json')).toEqual([])
    expect(parseHerdrAgents(JSON.stringify({ result: { agents: [{ cwd: '/a' }] } }))).toEqual([])
    expect(parseHerdrAgents(JSON.stringify({ result: {} }))).toEqual([])
  })
})

describe('pollHerdrActivity', () => {
  it('working は active として登録される', () => {
    const changed = pollHerdrActivity(execWith([agent('w4:p2', 'working', '/work/cc-g2')]))
    expect(changed).toBe(true)
    expect(store.sessionActivity.get('herdr:w4:p2')).toMatchObject({
      tmuxTarget: 'herdr:w4:p2',
      label: 'cc-g2',
      state: 'active',
    })
  })

  it('idle は idle として登録される', () => {
    pollHerdrActivity(execWith([agent('w4:p1', 'idle', '/a/b/MinimalMem')]))
    expect(store.sessionActivity.get('herdr:w4:p1')).toMatchObject({
      label: 'MinimalMem',
      state: 'idle',
    })
  })

  it('前回いたペインが消えたら dead → 次回ポーリングで掃除（2 段階）', () => {
    pollHerdrActivity(execWith([agent('w4:p2', 'idle', '/a/b/repo')]))
    expect(store.sessionActivity.get('herdr:w4:p2').state).toBe('idle')

    // ペイン close: agent list から消えた最初のポーリングで dead 表示
    const changed1 = pollHerdrActivity(execWith([]))
    expect(changed1).toBe(true)
    expect(store.sessionActivity.get('herdr:w4:p2').state).toBe('dead')

    // 次のポーリングでも不在なら map から掃除
    const changed2 = pollHerdrActivity(execWith([]))
    expect(changed2).toBe(true)
    expect(store.sessionActivity.has('herdr:w4:p2')).toBe(false)
  })

  it('状態が変わらなければ changed=false（無駄な SSE 配信を避ける）', () => {
    pollHerdrActivity(execWith([agent('w4:p2', 'working', '/a/b/repo')]))
    const changed = pollHerdrActivity(execWith([agent('w4:p2', 'working', '/a/b/repo')]))
    expect(changed).toBe(false)
  })

  it('herdr 不在/失敗時は静かにスキップし、herdr エントリを触らない', () => {
    // 既存の herdr エントリを用意
    pollHerdrActivity(execWith([agent('w4:p2', 'working', '/a/b/repo')]))
    expect(herdrEntries()).toEqual(['herdr:w4:p2'])

    const throwExec = () => { throw Object.assign(new Error('spawn herdr ENOENT'), { code: 'ENOENT' }) }
    const changed = pollHerdrActivity(throwExec)
    expect(changed).toBe(false)
    // 失敗時は既存エントリを保持（誤って dead/削除しない）
    expect(store.sessionActivity.get('herdr:w4:p2').state).toBe('active')
  })

  it('herdr 不在から始めても例外を投げず、エントリを作らない', () => {
    store.sessionActivity.clear()
    const throwExec = () => { throw new Error('command not found') }
    expect(() => pollHerdrActivity(throwExec)).not.toThrow()
    expect(herdrEntries()).toHaveLength(0)
  })
})
