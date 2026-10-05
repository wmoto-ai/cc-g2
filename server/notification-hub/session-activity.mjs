// --- Session Activity Monitor (PTY-based) ---
// tmux の g2-* ペインを定期ポーリングして active/idle/error/dead を判定し SSE 配信する。
// herdr 上の agent は herdr-events.mjs（events.subscribe 駆動）が同じ sessionActivity を更新する。
// tmux 側の掃除は `herdr:` 名前空間のエントリを触らない。
// sessionActivity は store が所有し、ここでは参照のみ。
import { statSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { deriveSessionLabel } from './notification-utils.mjs'
import { store } from './store.mjs'
import { HERDR_KEY_PREFIX, broadcastSessionActivity, startHerdrWatcher } from './herdr-events.mjs'

/** @typedef {import('./store.mjs').SessionActivityState} SessionActivityState */

const { sessionActivity, approvals, notificationsById } = store

const SESSION_ACTIVITY_POLL_MS = 5000
const SESSION_IDLE_THRESHOLD_SEC = 10

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
    if (changed) broadcastSessionActivity()
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

  // Remove stale entries（tmux 由来のみ。herdr 由来は herdr-events.mjs が管理する）
  const currentTargets = new Set(g2Panes.map((p) => p.target))
  for (const key of sessionActivity.keys()) {
    if (key.startsWith(HERDR_KEY_PREFIX)) continue
    if (!currentTargets.has(key)) {
      sessionActivity.delete(key)
      changed = true
    }
  }

  if (changed) broadcastSessionActivity()
}

// テスト（純関数の単体検証）から import してもポーリングが走らないようガードする
if (process.env.CC_G2_SESSION_ACTIVITY_DISABLED !== '1') {
  setInterval(pollSessionActivity, SESSION_ACTIVITY_POLL_MS)
  startHerdrWatcher()
}

export { selectActivityPanes, approvalTargetsPane }
