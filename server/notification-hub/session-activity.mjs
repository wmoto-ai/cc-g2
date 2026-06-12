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

function pollSessionActivity() {
  let changed = false
  let tmuxPanes
  try {
    tmuxPanes = execSync(
      'tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index} #{pane_tty} #{pane_pid}"',
      { encoding: 'utf8', timeout: 3000 },
    ).trim().split('\n').filter(Boolean)
  } catch {
    if (sessionActivity.size > 0) {
      sessionActivity.clear()
      changed = true
    }
    if (changed) sseBroadcast('session-activity', [])
    return
  }

  const g2Panes = tmuxPanes
    .map((line) => { const [target, tty, pid] = line.split(' '); return { target, tty, pid } })
    .filter((p) => p.target && p.target.startsWith('g2-'))

  for (const { target, tty, pid } of g2Panes) {
    let state = /** @type {SessionActivityState} */ ('dead')
    let pidAlive = false
    try { process.kill(Number(pid), 0); pidAlive = true } catch { /* not running */ }

    if (!pidAlive) {
      state = 'dead'
    } else if (approvals.some((a) => {
      if (a.status !== 'pending') return false
      const notif = notificationsById.get(a.notificationId)
      return notif?.metadata?.tmuxTarget === target
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

  // Remove stale entries
  const currentTargets = new Set(g2Panes.map((p) => p.target))
  for (const key of sessionActivity.keys()) {
    if (!currentTargets.has(key)) {
      sessionActivity.delete(key)
      changed = true
    }
  }

  if (changed) {
    sseBroadcast('session-activity', [...sessionActivity.values()].map(
      ({ tmuxTarget, label, state }) => ({ tmuxTarget, label, state }),
    ))
  }
}

setInterval(pollSessionActivity, SESSION_ACTIVITY_POLL_MS)
