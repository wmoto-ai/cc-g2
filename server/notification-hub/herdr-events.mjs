// herdr 上の agent ペインの監視（events.subscribe 駆動）。
// - 状態遷移は pane.agent_status_changed イベントの agent_status で直接処理する（5 秒未満のターンも拾う）
// - agent.list は起動時・ペイン増減イベント時・フォールバック周期で取り、ラベル/cwd/ペイン集合を更新する
// - 購読が生きている間は list で遷移を起こさない（イベントと list の追い越しで完了通知が二重になるのを防ぐ）。
//   購読の (再)開始直後と、購読できない間だけ list の差分を遷移として扱う
// キーは reply-relay-herdr.sh と同じ `herdr:<pane_id>`。sessionActivity は store が所有する。
import { store, log } from './store.mjs'
import { sseBroadcast } from './sse.mjs'
import { handleHerdrTransition } from './herdr-screen.mjs'
import { herdrAgentList, herdrSubscribe } from './herdr-client.mjs'

/** @typedef {import('./store.mjs').SessionActivityState} SessionActivityState */

const { sessionActivity } = store

const HERDR_KEY_PREFIX = 'herdr:'
// herdr agent_status → G2 表示状態
const HERDR_STATE_MAP = { working: 'active', blocked: 'waiting', done: 'done' }
const LIFECYCLE_SUBSCRIPTIONS = ['pane.created', 'pane.closed', 'pane.exited', 'pane.agent_detected']
const LIFECYCLE_EVENTS = new Set(LIFECYCLE_SUBSCRIPTIONS.map((t) => t.replace(/\./g, '_')))
const FALLBACK_POLL_MS = Number(process.env.CC_G2_HERDR_POLL_MS || 30000)
const RETRY_MS = 5000
const LIST_DEBOUNCE_MS = 150

// key → { paneId, agent, cwd, label, status }。status は herdr の生ステータス（遷移検知用）
const herdrPanes = new Map()

function toState(status) {
  return /** @type {SessionActivityState} */ (HERDR_STATE_MAP[status] || 'idle')
}

// agent.list の agents 配列から監視エントリを取り出す。pane_id の無い要素は無視する。
function parseHerdrAgents(agents) {
  if (!Array.isArray(agents)) return []
  const out = []
  for (const a of agents) {
    if (!a || typeof a.pane_id !== 'string' || !a.pane_id) continue
    const cwd = typeof a.cwd === 'string' ? a.cwd : ''
    const label = cwd.split('/').filter(Boolean).pop() || ''
    const status = typeof a.agent_status === 'string' ? a.agent_status : ''
    const agent = typeof a.agent === 'string' ? a.agent : ''
    out.push({ key: `${HERDR_KEY_PREFIX}${a.pane_id}`, label, state: toState(status), paneId: a.pane_id, agent, cwd, status })
  }
  return out
}

function broadcastSessionActivity() {
  sseBroadcast('session-activity', [...sessionActivity.values()].map(
    ({ tmuxTarget, label, state }) => ({ tmuxTarget, label, state }),
  ))
}

function setActivity(key, label, state) {
  const prev = sessionActivity.get(key)
  if (prev && prev.state === state && prev.label === label) return false
  sessionActivity.set(key, { tmuxTarget: key, label, state, updatedAt: new Date().toISOString() })
  return true
}

function applyStatus(key, pane, status) {
  const prevStatus = pane.status
  pane.status = status
  const changed = setActivity(key, pane.label, toState(status))
  if (prevStatus !== undefined && prevStatus !== status) {
    handleHerdrTransition({ ...pane, key, status, prevStatus })
      .catch((err) => log(`herdr transition failed ${key}: ${err?.message || err}`))
  }
  return changed
}

/**
 * agent.list のスナップショットを反映し、変更有無を返す。
 * transitions=false のときは既知ペインの状態を変えない（イベントが正）。新規ペインは初回観測として通知しない。
 * 消えたペインは dead 表示 → 次回掃除の 2 段階。
 */
function applyHerdrAgents(agents, { transitions = true } = {}) {
  let changed = false
  const entries = parseHerdrAgents(agents)
  const currentKeys = new Set(entries.map((e) => e.key))
  for (const e of entries) {
    const pane = herdrPanes.get(e.key)
    if (!pane) {
      herdrPanes.set(e.key, { paneId: e.paneId, agent: e.agent, cwd: e.cwd, label: e.label, status: e.status })
      if (setActivity(e.key, e.label, e.state)) changed = true
      continue
    }
    Object.assign(pane, { paneId: e.paneId, agent: e.agent, cwd: e.cwd, label: e.label })
    if (transitions && pane.status !== e.status) {
      if (applyStatus(e.key, pane, e.status)) changed = true
    } else if (setActivity(e.key, e.label, toState(pane.status))) {
      changed = true
    }
  }
  for (const key of sessionActivity.keys()) {
    if (!key.startsWith(HERDR_KEY_PREFIX) || currentKeys.has(key)) continue
    const prev = sessionActivity.get(key)
    if (prev.state !== 'dead') {
      sessionActivity.set(key, { ...prev, state: 'dead', updatedAt: new Date().toISOString() })
    } else {
      sessionActivity.delete(key)
      herdrPanes.delete(key)
    }
    changed = true
  }
  return changed
}

/** pane.agent_status_changed の data を反映し、変更有無を返す。未知ペインは false（list 側で拾う）。 */
function applyHerdrStatusEvent(data) {
  if (!data || typeof data.pane_id !== 'string' || typeof data.agent_status !== 'string') return false
  const key = `${HERDR_KEY_PREFIX}${data.pane_id}`
  const pane = herdrPanes.get(key)
  if (!pane) return false
  if (typeof data.agent === 'string' && data.agent) pane.agent = data.agent
  if (pane.status === data.agent_status) return false
  return applyStatus(key, pane, data.agent_status)
}

function classifyHerdrEvent(name) {
  const kind = String(name || '').replace(/\./g, '_')
  if (kind === 'pane_agent_status_changed') return 'status'
  if (LIFECYCLE_EVENTS.has(kind)) return 'lifecycle'
  return 'ignore'
}

// --- watcher ---

let unsubscribe = null
let subscribedIds = new Set()
let live = false
let listTimer = null
let retryTimer = null
let refreshing = null
let refreshAgain = null
let unavailableLogged = false

function setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function scheduleList() {
  if (listTimer) return
  listTimer = setTimeout(() => {
    listTimer = null
    void refresh()
  }, LIST_DEBOUNCE_MS)
}

function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void refresh()
  }, RETRY_MS)
}

function subscribe(ids) {
  unsubscribe?.()
  live = false
  subscribedIds = ids
  const subscriptions = [
    ...LIFECYCLE_SUBSCRIPTIONS.map((type) => ({ type })),
    ...[...ids].map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId })),
  ]
  const stop = herdrSubscribe(subscriptions, {
    onReady: () => {
      live = true
      // 購読開始までの隙間に起きた遷移を list の差分で埋める
      void refresh({ transitions: true })
    },
    onEvent: (ev) => {
      const kind = classifyHerdrEvent(ev.event)
      if (kind === 'status') {
        if (applyHerdrStatusEvent(ev.data)) broadcastSessionActivity()
      } else if (kind === 'lifecycle') {
        scheduleList()
      }
    },
    onClose: () => {
      if (unsubscribe !== stop) return
      unsubscribe = null
      live = false
      log('herdr events subscription closed; retrying')
      scheduleRetry()
    },
  })
  unsubscribe = stop
}

/** agent.list を取り直して反映し、ペイン集合が変わっていれば再購読する。 */
async function refresh({ transitions } = {}) {
  if (refreshing) {
    // 走行中の list は購読開始前に取った可能性があるので、遷移の要求は落とさず後続に引き継ぐ
    refreshAgain = { transitions: refreshAgain?.transitions || transitions }
    return refreshing
  }
  refreshing = (async () => {
    let agents
    try {
      agents = await herdrAgentList()
      unavailableLogged = false
    } catch (err) {
      if (!unavailableLogged) {
        log(`herdr source unavailable, skipping: ${err?.message || err}`)
        unavailableLogged = true
      }
      if (!live) scheduleRetry()
      return
    }
    if (applyHerdrAgents(agents, { transitions: transitions ?? !live })) broadcastSessionActivity()
    const ids = new Set(agents.map((a) => a?.pane_id).filter((id) => typeof id === 'string' && id))
    if (!unsubscribe || !setsEqual(ids, subscribedIds)) subscribe(ids)
  })()
  try {
    await refreshing
  } finally {
    refreshing = null
  }
  if (refreshAgain) {
    const next = refreshAgain
    refreshAgain = null
    await refresh(next)
  }
}

function startHerdrWatcher() {
  void refresh()
  setInterval(() => void refresh(), FALLBACK_POLL_MS).unref?.()
}

export {
  parseHerdrAgents,
  applyHerdrAgents,
  applyHerdrStatusEvent,
  classifyHerdrEvent,
  startHerdrWatcher,
  broadcastSessionActivity,
  HERDR_KEY_PREFIX,
}
