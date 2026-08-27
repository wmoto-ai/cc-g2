// --- Session Activity Monitor (PTY-based) ---
// tmux の g2-* ペインを定期ポーリングして active/idle/error/dead を判定し SSE 配信する。
// sessionActivity は store が所有し、ここでは参照のみ。
import { statSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { deriveSessionLabel } from './notification-utils.mjs'
import { store } from './store.mjs'
import { sseBroadcast } from './sse.mjs'

/** @typedef {import('./store.mjs').SessionActivityState} SessionActivityState */

const { sessionActivity, approvals, notificationsById } = store

const SESSION_ACTIVITY_POLL_MS = 5000
const SESSION_IDLE_THRESHOLD_SEC = 10

// herdr(terminal workspace manager)で起動した agent も同じ周期で監視する。
// tmux ペインとは別経路のため、キーは reply-relay-herdr.sh と同じ `herdr:<pane_id>` 形式で
// 名前空間を分け、tmux 側の掃除ロジックが herdr エントリを消さないようにする。
const HERDR_BIN = process.env.HERDR_BIN || 'herdr'
const HERDR_KEY_PREFIX = 'herdr:'
let herdrUnavailableLogged = false

const PANE_LIST_FORMAT =
  '#{session_name}:#{window_index}.#{pane_index}|#{pane_id}|#{pane_tty}|#{pane_pid}|#{@cc_g2_agent_pane}|#{@cc_g2_qr_pane}'

// list-panes の行から監視対象ペインを選ぶ。
// - QR 常駐ペイン（@cc_g2_qr_pane）は表示専用なので除外する
// - @cc_g2_agent_pane が記録されたセッションは agent ペインのみを対象にする
//   （QR 以外にユーザーが split したペインで二重計上しないため）
function selectActivityPanes(lines) {
  const panes = lines
    .map((line) => {
      const [target, paneId, tty, pid, agentPane, qrPane] = line.split('|')
      return { target, paneId, tty, pid, agentPane: agentPane || '', qrPane: qrPane || '' }
    })
    .filter((p) => p.target && p.target.startsWith('g2-'))
    .filter((p) => !p.qrPane || p.paneId !== p.qrPane)

  const bySession = new Map()
  for (const p of panes) {
    const session = p.target.split(':')[0]
    if (!bySession.has(session)) bySession.set(session, [])
    bySession.get(session).push(p)
  }
  const selected = []
  for (const group of bySession.values()) {
    const agent = group.find((p) => p.agentPane && p.paneId === p.agentPane)
    if (agent) selected.push(agent)
    else selected.push(...group)
  }
  return selected
}

// 承認通知の metadata.tmuxTarget は pane_id（%N、新形式）と
// session:window.pane（旧形式・稼働中の旧セッション）が混在するため両方照合する
function approvalTargetsPane(metaTarget, pane) {
  if (!metaTarget) return false
  return metaTarget === pane.paneId || metaTarget === pane.target
}

// `herdr agent list` の JSON から監視エントリを取り出す。
// - キー: `herdr:<pane_id>`、label: cwd の basename
// - agent_status "working"→active、それ以外（idle など）→idle。error 判定は行わない
// pane_id を持たない/壊れた要素は無視する。
function parseHerdrAgents(raw) {
  let data
  try { data = JSON.parse(raw) } catch { return [] }
  const agents = data?.result?.agents
  if (!Array.isArray(agents)) return []
  const out = []
  for (const a of agents) {
    if (!a || typeof a.pane_id !== 'string' || !a.pane_id) continue
    const cwd = typeof a.cwd === 'string' ? a.cwd : ''
    const label = cwd.split('/').filter(Boolean).pop() || ''
    const state = /** @type {SessionActivityState} */ (a.agent_status === 'working' ? 'active' : 'idle')
    out.push({ key: `${HERDR_KEY_PREFIX}${a.pane_id}`, label, state })
  }
  return out
}

// herdr 経路のポーリング。sessionActivity（herdr: 名前空間）を更新し、変更有無を返す。
// exec は execFileSync 互換（file, args, options）。テストから注入できるよう引数化している。
// herdr が無い/失敗した場合は静かにスキップ（初回のみ log）し、既存 herdr エントリは触らない。
function pollHerdrActivity(exec = execFileSync) {
  let raw
  try {
    raw = exec(HERDR_BIN, ['agent', 'list'], { encoding: 'utf8', timeout: 3000 })
  } catch (err) {
    if (!herdrUnavailableLogged) {
      console.warn(`[session-activity] herdr source unavailable, skipping: ${err?.message || err}`)
      herdrUnavailableLogged = true
    }
    return false
  }

  let changed = false
  const agents = parseHerdrAgents(raw)
  const currentKeys = new Set(agents.map((a) => a.key))
  for (const { key, label, state } of agents) {
    const prev = sessionActivity.get(key)
    if (!prev || prev.state !== state || prev.label !== label) {
      sessionActivity.set(key, { tmuxTarget: key, label, state, updatedAt: new Date().toISOString() })
      changed = true
    }
  }

  // 前回いたペインが消えた場合: tmux の dead 処理と同じく、まず dead 表示 → 次回掃除の 2 段階。
  for (const key of sessionActivity.keys()) {
    if (!key.startsWith(HERDR_KEY_PREFIX) || currentKeys.has(key)) continue
    const prev = sessionActivity.get(key)
    if (prev.state !== 'dead') {
      sessionActivity.set(key, { ...prev, state: 'dead', updatedAt: new Date().toISOString() })
    } else {
      sessionActivity.delete(key)
    }
    changed = true
  }

  return changed
}

function pollSessionActivity() {
  let changed = false
  let tmuxPanes
  try {
    tmuxPanes = execSync(
      `tmux list-panes -a -F "${PANE_LIST_FORMAT}"`,
      { encoding: 'utf8', timeout: 3000 },
    ).trim().split('\n').filter(Boolean)
  } catch {
    // tmux 取得失敗時は tmux 由来エントリだけ掃除する（herdr 由来は独立経路で維持）。
    for (const key of sessionActivity.keys()) {
      if (key.startsWith(HERDR_KEY_PREFIX)) continue
      sessionActivity.delete(key)
      changed = true
    }
    if (pollHerdrActivity()) changed = true
    if (changed) {
      sseBroadcast('session-activity', [...sessionActivity.values()].map(
        ({ tmuxTarget, label, state }) => ({ tmuxTarget, label, state }),
      ))
    }
    return
  }

  const g2Panes = selectActivityPanes(tmuxPanes)

  for (const pane of g2Panes) {
    const { target, tty, pid } = pane
    let state = /** @type {SessionActivityState} */ ('dead')
    let pidAlive = false
    try { process.kill(Number(pid), 0); pidAlive = true } catch { /* not running */ }

    if (!pidAlive) {
      state = 'dead'
    } else if (approvals.some((a) => {
      if (a.status !== 'pending') return false
      const notif = notificationsById.get(a.notificationId)
      return approvalTargetsPane(notif?.metadata?.tmuxTarget, pane)
    })) {
      state = 'active'
    } else {
      try {
        const st = statSync(tty)
        const idleSec = (Date.now() - st.mtimeMs) / 1000
        if (idleSec < SESSION_IDLE_THRESHOLD_SEC) {
          state = 'active'
        } else {
          try {
            const raw = execFileSync('tmux', ['capture-pane', '-t', target, '-p'], { encoding: 'utf8', timeout: 2000 })
            const content = raw.split('\n').slice(-15).join('\n')
            const hasError = /[⚠✗]|error|overload|retry.*fail|429|500|timed?\s*out/i.test(content)
            state = hasError ? 'error' : 'idle'
          } catch { state = 'idle' }
        }
      } catch { state = 'dead' }
    }

    const prev = sessionActivity.get(target)
    const label = deriveSessionLabel(target)
    if (!prev || prev.state !== state) {
      sessionActivity.set(target, { tmuxTarget: target, label, state, updatedAt: new Date().toISOString() })
      changed = true
    }
  }

  // Remove stale entries（tmux 由来のみ。herdr 由来は pollHerdrActivity が管理する）
  const currentTargets = new Set(g2Panes.map((p) => p.target))
  for (const key of sessionActivity.keys()) {
    if (key.startsWith(HERDR_KEY_PREFIX)) continue
    if (!currentTargets.has(key)) {
      sessionActivity.delete(key)
      changed = true
    }
  }

  if (pollHerdrActivity()) changed = true

  if (changed) {
    sseBroadcast('session-activity', [...sessionActivity.values()].map(
      ({ tmuxTarget, label, state }) => ({ tmuxTarget, label, state }),
    ))
  }
}

// テスト（純関数の単体検証）から import してもポーリングが走らないようガードする
if (process.env.CC_G2_SESSION_ACTIVITY_DISABLED !== '1') {
  setInterval(pollSessionActivity, SESSION_ACTIVITY_POLL_MS)
}

export { selectActivityPanes, approvalTargetsPane, parseHerdrAgents, pollHerdrActivity }
