import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, appendFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
  deriveSessionLabel,
  getString,
  normalizeMoshiPayload,
  persistedApproval,
  persistedNotification,
  readRequestBody,
  safeJsonParse,
} from './notification-utils.mjs'
import { transcribeAudioWithGroq } from './stt.mjs'

const host = process.env.HUB_BIND || '0.0.0.0'
const port = Number(process.env.HUB_PORT || '8787')
const dataDir = path.resolve(process.env.HUB_DATA_DIR || 'tmp/notification-hub')
const hubAuthToken = String(process.env.HUB_AUTH_TOKEN || '').trim()
const hubAllowedOrigins = new Set(
  String(process.env.HUB_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
const hubPersistRaw = ['1', 'true', 'yes', 'on'].includes(String(process.env.HUB_PERSIST_RAW || '').toLowerCase())
const hubPersistToolInput = ['1', 'true', 'yes', 'on'].includes(String(process.env.HUB_PERSIST_TOOL_INPUT || '').toLowerCase())
const groqApiKey = String(process.env.GROQ_API_KEY || '').trim()
const groqModelDefault = String(process.env.GROQ_MODEL || 'whisper-large-v3').trim()
const notificationsFile = path.join(dataDir, 'notifications.jsonl')
const repliesFile = path.join(dataDir, 'replies.jsonl')
const clientEventsFile = path.join(dataDir, 'client-events.jsonl')
const hubReplyRelayCmd = String(process.env.HUB_REPLY_RELAY_CMD || '').trim()
const hubReplyRelayTimeoutMs = Math.max(
  1000,
  Number.parseInt(process.env.HUB_REPLY_RELAY_TIMEOUT_MS || '15000', 10) || 15000,
)
const hubReplyRelaySources = new Set(
  String(process.env.HUB_REPLY_RELAY_SOURCES || 'g2,web')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
const hubPermissionThreadDedupMs = Math.max(
  0,
  Number.parseInt(process.env.HUB_PERMISSION_THREAD_DEDUP_MS || '8000', 10) || 8000,
)
const hubMaxBodyBytes = Math.max(
  1024,
  Number.parseInt(process.env.HUB_MAX_BODY_BYTES || '1048576', 10) || 1048576,
)
const hubMaxSttBodyBytes = Math.max(
  hubMaxBodyBytes,
  Number.parseInt(process.env.HUB_MAX_STT_BODY_BYTES || '12582912', 10) || 12582912,
)

/** @typedef {{id:string,source:'moshi'|'claude-code',title:string,summary:string,fullText:string,createdAt:string,replyCapable:boolean,raw?:unknown,metadata?:Record<string, unknown>}} NotificationItem */
/** @typedef {{id:string,notificationId:string,replyText:string,createdAt:string,status:'stubbed'|'forwarded'|'failed',action?:'approve'|'deny'|'comment',resolvedAction?:'approve'|'deny'|'comment',result?:'resolved'|'relayed'|'ignored',ignoredReason?:'approval-not-pending'|'approval-link-not-found',comment?:string,source?:string,error?:string}} ReplyRecord */
/** @typedef {{id:string,notificationId:string,source:string,toolName:string,toolInput:unknown,toolId:string,cwd:string,reason:string,agentName:string,status:'pending'|'decided'|'expired',decision?:'approve'|'deny',resolution?:'superseded'|'session-ended'|'terminal-disconnect',comment?:string,decidedBy?:string,createdAt:string,decidedAt?:string,deliveredAt?:string}} ApprovalRecord */

/** @type {NotificationItem[]} */
const notifications = []
/** @type {Map<string, NotificationItem>} */
const notificationsById = new Map()
/** @type {ReplyRecord[]} */
const replies = []
/** @type {Set<string>} */
const notificationExternalIds = new Set()
/** @type {Map<string, number>} */
const permissionThreadSeenAt = new Map()
/** @type {Map<string, {sessionId:string,cwd:string,usedPercentage:number,model:string,updatedAt:string}>} */
const contextStatusBySession = new Map()
/** @type {ApprovalRecord[]} */
const approvals = []
/** @type {Map<string, ApprovalRecord>} */
const approvalsById = new Map()
/** @type {Map<string, ApprovalRecord>} */
const approvalsByNotificationId = new Map()
/** @type {Map<string, number>} */
const uiSessions = new Map()
/** @type {{lat:number,lng:number,altitude:number|null,timestamp:string,speed:number|null,battery:number|null,receivedAt:string}|null} */
let lastLocation = null
const approvalsFile = path.join(dataDir, 'approvals.jsonl')
const UI_SESSION_COOKIE = 'cc_g2_ui_session'
const UI_SESSION_MAX_AGE_SEC = 60 * 60 * 12

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true })
}

async function loadJsonl(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return []
    throw err
  }
}

async function appendJsonl(filePath, obj) {
  await appendFile(filePath, `${JSON.stringify(obj)}\n`, 'utf8')
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function withCorsHeaders(res) {
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CC-G2-Token')
}

function getHostname(value, assumeHttp = false) {
  try {
    if (assumeHttp) return new URL(`http://${value}`).hostname
    return new URL(value).hostname
  } catch {
    return ''
  }
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  const originHostname = getHostname(origin)
  const requestHostname = getHostname(String(req.headers.host || ''), true)
  if (!originHostname) return false
  if (originHostname === requestHostname) return true
  if (hubAllowedOrigins.has(origin)) return true
  return false
}

function applyCors(req, res) {
  withCorsHeaders(res)
  const origin = req.headers.origin
  if (!origin) return true
  if (!isAllowedOrigin(req)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  return true
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body, null, 2))
}

function sendText(res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(body)
}

function sendRequestBodyTooLarge(res, err) {
  const maxBytes =
    err && typeof err === 'object' && 'maxBytes' in err && Number.isFinite(err.maxBytes)
      ? err.maxBytes
      : undefined
  return sendJson(res, 413, {
    ok: false,
    error: maxBytes ? `Request body too large (max ${maxBytes} bytes)` : 'Request body too large',
  })
}

function isBodyTooLargeError(err) {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'BODY_TOO_LARGE'
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '')
  if (!raw) return new Map()
  return new Map(
    raw
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=')
        if (idx < 0) return [part, '']
        return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))]
      }),
  )
}

function createUiSession() {
  const token = randomUUID()
  uiSessions.set(token, Date.now() + UI_SESSION_MAX_AGE_SEC * 1000)
  return token
}

function cleanupExpiredUiSessions() {
  const now = Date.now()
  for (const [token, expiresAt] of uiSessions.entries()) {
    if (expiresAt <= now) uiSessions.delete(token)
  }
}

function hasValidUiSession(req) {
  cleanupExpiredUiSessions()
  const token = parseCookies(req).get(UI_SESSION_COOKIE)
  if (!token) return false
  const expiresAt = uiSessions.get(token)
  if (!expiresAt || expiresAt <= Date.now()) {
    uiSessions.delete(token)
    return false
  }
  return true
}

function requireApiAuth(req, res) {
  if (!hubAuthToken) return true
  const provided = String(req.headers['x-cc-g2-token'] || '').trim()
  if (provided === hubAuthToken) return true
  if (hasValidUiSession(req)) return true
  sendJson(res, 401, { ok: false, error: 'Unauthorized' })
  return false
}

function isPublicApiRequest(method, pathname) {
  if (method === 'GET' && pathname === '/api/health') return true
  if (method === 'GET' && pathname === '/api/context-status') return true
  if (method === 'GET' && pathname === '/api/notifications') return true
  if (method === 'POST' && pathname === '/api/client-events') return true
  if (method === 'POST' && pathname === '/api/location') return true
  if (method === 'GET' && matchNotificationDetail(pathname)) return true
  return false
}

async function addNotification(payload, logPrefix = 'notification') {
  const item = normalizeMoshiPayload(payload, {
    persistRaw: hubPersistRaw,
    createId: () => randomUUID(),
  })
  const extId =
    item && item.metadata && typeof item.metadata.externalId === 'string'
      ? item.metadata.externalId
      : ''
  const hookType =
    item && item.metadata && typeof item.metadata.hookType === 'string'
      ? item.metadata.hookType
      : ''
  const threadId =
    item && item.metadata && typeof item.metadata.threadId === 'string'
      ? item.metadata.threadId
      : ''
  const hasApprovalId =
    item &&
    item.metadata &&
    (typeof item.metadata.approvalId === 'string' ||
      typeof item.metadata.approvalId === 'number')

  // Some hook-originated notifications can arrive almost simultaneously from
  // multiple hook sources. Dedup by threadId only in a short TTL window to avoid
  // dropping legitimate later events.
  if (
    hubPermissionThreadDedupMs > 0 &&
    (hookType === 'permission-request' || hookType === 'stop') &&
    !hasApprovalId &&
    threadId
  ) {
    const nowMs = Date.now()
    const lastMs = permissionThreadSeenAt.get(threadId) || 0
    if (nowMs - lastMs < hubPermissionThreadDedupMs) {
      return { ok: true, duplicate: true, item }
    }
    permissionThreadSeenAt.set(threadId, nowMs)
  }

  if (extId && notificationExternalIds.has(extId)) {
    return { ok: true, duplicate: true, item }
  }

  notifications.push(item)
  notificationsById.set(item.id, item)
  if (extId) notificationExternalIds.add(extId)
  await appendJsonl(notificationsFile, persistedNotification(item, { persistRaw: hubPersistRaw }))

  // stop通知が来たら同セッションの全pending承認を自動解決
  if (hookType === 'stop') {
    const sessionId = item.metadata?.sessionId
    if (sessionId) {
      const now = new Date().toISOString()
      for (const a of approvals) {
        if (a.status === 'pending') {
          const n = notificationsById.get(a.notificationId)
          if (n?.metadata?.sessionId === sessionId) {
            markApprovalCleanup(a, 'session-ended', 'auto-session-end', now)
            log(`approval auto-cleaned on stop id=${a.id} session=${sessionId}`)
          }
        }
      }
    }
  }

  log(
    `${logPrefix} received id=${item.id} title=${JSON.stringify(item.title)} summary=${JSON.stringify(item.summary)}`,
  )
  return { ok: true, duplicate: false, item }
}


async function forwardReplyIfConfigured(record) {
  const url = process.env.MOSHI_REPLY_WEBHOOK_URL
  if (!url) {
    return { status: 'stubbed' }
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    })
    if (!resp.ok) {
      return { status: 'failed', error: `HTTP ${resp.status}` }
    }
    return { status: 'forwarded' }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

async function relayReplyIfConfigured(payload) {
  if (!hubReplyRelayCmd) return { status: 'stubbed' }
  const source = payload?.reply?.source || ''
  if (hubReplyRelaySources.size > 0 && source && !hubReplyRelaySources.has(source)) {
    return { status: 'stubbed' }
  }

  return new Promise((resolve) => {
    const child = spawn(hubReplyRelayCmd, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    const maxCapture = 2000
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ status: 'failed', error: `relay timeout ${hubReplyRelayTimeoutMs}ms` })
    }, hubReplyRelayTimeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
    })

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxCapture) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxCapture) stderr += String(chunk)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        return finish({ status: 'forwarded' })
      }
      const msg = (stderr || stdout || '').trim()
      return finish({ status: 'failed', error: `relay exit=${code}${msg ? ` ${msg}` : ''}` })
    })

    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

function getReplyStatus(item) {
  const approval = approvalsByNotificationId.get(item.id)
  if (approval) {
    if (approval.deliveredAt) return 'delivered'
    if (approval.status === 'decided') return 'decided'
    return 'pending'
  }
  const hasReply = replies.some((r) => r.notificationId === item.id)
  if (hasReply) return 'replied'
  // 非approval通知（stop hookなど）: 同セッションの新しい通知があれば暗黙的に対応済み
  // PC側のコメントはHubを経由しないため、後続通知の存在で判定する
  // sessionIdがない通知（stop hookなど）はtmuxTargetとcwdで同一セッション判定
  if (item.replyCapable && item.metadata) {
    const sid = item.metadata.sessionId
    const tmux = item.metadata.tmuxTarget
    const cwd = item.metadata.cwd
    const t = new Date(item.createdAt).getTime()
    const isSameSession = (n) => {
      if (!n.metadata) return false
      if (sid && n.metadata.sessionId === sid) return true
      if (tmux && n.metadata.tmuxTarget === tmux) return true
      if (!sid && !tmux && cwd && n.metadata.cwd === cwd) return true
      return false
    }
    const hasNewer = notifications.some((n) =>
      n.id !== item.id && isSameSession(n) && new Date(n.createdAt).getTime() > t,
    )
    if (hasNewer) return 'delivered'
  }
  return undefined
}

function listNotifications(limit) {
  const sorted = [...notifications].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return sorted.slice(0, limit).map((item) => ({
    id: item.id,
    source: item.source,
    title: item.title,
    summary: item.summary,
    createdAt: item.createdAt,
    replyCapable: item.replyCapable,
    metadata: item.metadata,
    replyStatus: getReplyStatus(item),
  }))
}

async function createApproval(params) {
  const {
    source, toolName, toolInput, toolId, cwd, reason,
    agentName, title: titleOverride, body: bodyOverride, metadata: extraMeta,
    threadId: incomingThreadId,
  } = params

  const approvalId = randomUUID()
  const now = new Date().toISOString()

  const lines = []
  lines.push(`Tool: ${toolName}`)
  if (cwd) lines.push(`CWD: ${cwd}`)
  if (reason) lines.push(`理由: ${reason}`)
  const inputPreview = typeof toolInput === 'object' && toolInput !== null
    ? (toolInput.command || toolInput.file_path || JSON.stringify(toolInput))
    : String(toolInput || '')
  if (inputPreview) lines.push('', `$ ${inputPreview}`)

  const title = titleOverride || toolName
  const fullText = bodyOverride || lines.join('\n')

  const callerHookType = (extraMeta && typeof extraMeta.hookType === 'string')
    ? extraMeta.hookType
    : 'permission-request'
  const notifPayload = {
    title,
    body: fullText,
    hookType: callerHookType,
    threadId: incomingThreadId || undefined,
    metadata: {
      ...extraMeta,
      hookType: callerHookType,
      approvalId,
      externalId: `approval:${approvalId}`,
      source: `${agentName}-approval-broker`,
      toolName,
      toolId,
      cwd: cwd || undefined,
      agentName,
    },
  }
  const { item: notification } = await addNotification(notifPayload, 'approval-broker')

  /** @type {ApprovalRecord} */
  const record = {
    id: approvalId,
    notificationId: notification.id,
    source: source || agentName,
    toolName,
    toolInput,
    toolId: toolId || '',
    cwd: cwd || '',
    reason: reason || '',
    agentName: agentName || '',
    status: 'pending',
    createdAt: now,
  }
  approvals.push(record)
  approvalsById.set(record.id, record)
  approvalsByNotificationId.set(notification.id, record)
  await appendJsonl(approvalsFile, persistedApproval(record, { persistToolInput: hubPersistToolInput }))

  log(`approval created id=${record.id} notificationId=${notification.id} tool=${toolName}`)
  return { approval: record, notification }
}

function resolveApproval(approvalId, decision, comment, decidedBy) {
  const record = approvalsById.get(approvalId)
  if (!record) return null
  if (record.status !== 'pending') return record
  record.status = 'decided'
  record.decision = decision
  record.resolution = undefined
  record.comment = comment || undefined
  record.decidedBy = decidedBy || undefined
  record.decidedAt = new Date().toISOString()
  appendJsonl(
    approvalsFile,
    persistedApproval({ ...record, _event: 'decided' }, { persistToolInput: hubPersistToolInput }),
  ).catch((err) =>
    log(`approval persist error ${err instanceof Error ? err.message : String(err)}`),
  )
  log(`approval decided id=${record.id} decision=${decision} by=${decidedBy || 'unknown'}`)
  return record
}

function markApprovalCleanup(record, resolution, decidedBy, decidedAt = new Date().toISOString()) {
  if (!record || record.status !== 'pending') return record
  record.status = 'decided'
  record.decision = undefined
  record.resolution = resolution
  record.comment = undefined
  record.decidedBy = decidedBy || undefined
  record.decidedAt = decidedAt
  record.deliveredAt = decidedAt
  appendJsonl(
    approvalsFile,
    persistedApproval({ ...record, _event: 'decided' }, { persistToolInput: hubPersistToolInput }),
  ).catch((err) =>
    log(`approval persist error ${err instanceof Error ? err.message : String(err)}`),
  )
  log(`approval cleaned up id=${record.id} resolution=${resolution} by=${decidedBy || 'unknown'}`)
  return record
}

function matchApprovalPath(pathname) {
  const m = pathname.match(/^\/api\/approvals\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}
function matchApprovalDecidePath(pathname) {
  const m = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/)
  return m ? decodeURIComponent(m[1]) : null
}

async function bootstrap() {
  await ensureDataDir()
  const storedNotifications = await loadJsonl(notificationsFile)
  for (const item of storedNotifications) {
    notifications.push(item)
    if (item && item.id) notificationsById.set(item.id, item)
    const extId =
      item &&
      item.metadata &&
      typeof item.metadata === 'object' &&
      typeof item.metadata.externalId === 'string'
        ? item.metadata.externalId
        : ''
    if (extId) notificationExternalIds.add(extId)
  }
  const storedReplies = await loadJsonl(repliesFile)
  for (const reply of storedReplies) replies.push(reply)
  const storedApprovals = await loadJsonl(approvalsFile)
  for (const a of storedApprovals) {
    if (a && a.id && !a._event) {
      approvals.push(a)
      approvalsById.set(a.id, a)
      if (a.notificationId) approvalsByNotificationId.set(a.notificationId, a)
    } else if (a && a._event === 'decided' && a.id) {
      const existing = approvalsById.get(a.id)
      if (existing) {
        existing.status = a.status
        existing.decision = a.decision
        existing.resolution = a.resolution
        existing.comment = a.comment
        existing.decidedBy = a.decidedBy
        existing.decidedAt = a.decidedAt
        if (a.deliveredAt) existing.deliveredAt = a.deliveredAt
      }
    }
  }
  log(
    `notification-hub loaded notifications=${notifications.length} replies=${replies.length} approvals=${approvals.length} dataDir=${dataDir}`,
  )
}

function matchNotificationDetail(pathname) {
  const m = pathname.match(/^\/api\/notifications\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

function matchNotificationReply(pathname) {
  const m = pathname.match(/^\/api\/notifications\/([^/]+)\/reply$/)
  return m ? decodeURIComponent(m[1]) : null
}

const HOOK_POLL_TIMEOUT_MS = 600_000
const HOOK_POLL_INTERVAL_MS = 2_000

function buildToolPreview(toolName, toolInput) {
  if (toolName === 'Bash') {
    return toolInput?.command || ''
  } else if (toolName === 'Edit') {
    const file = toolInput?.file_path || ''
    const old = (toolInput?.old_string || '').slice(0, 2000)
    const new_ = (toolInput?.new_string || '').slice(0, 2000)
    return `${file}\n--- old ---\n${old}\n+++ new +++\n${new_}`
  } else if (toolName === 'Write') {
    const file = toolInput?.file_path || ''
    const content = (toolInput?.content || '').slice(0, 2000)
    return `${file}\n${content}`
  } else {
    return JSON.stringify(toolInput || {}).slice(0, 2000)
  }
}

function spawnLocalNotification(toolName) {
  try {
    const child = spawn('terminal-notifier', [
      '-title', 'Permission',
      '-message', toolName,
      '-sound', 'Glass',
    ], { timeout: 5000, stdio: 'ignore' })
    child.on('error', () => {}) // コマンド未導入時の ENOENT を無視
  } catch { /* ignore */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function handlePermissionRequestHook(req, res) {
  let body
  try {
    body = await readRequestBody(req, { maxBytes: hubMaxBodyBytes })
  } catch (err) {
    if (isBodyTooLargeError(err)) {
      return sendRequestBodyTooLarge(res, err)
    }
    throw err
  }
  const parsed = safeJsonParse(body || '{}')
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON body' })
  }
  const p = parsed.value
  const tmuxTarget = req.headers['x-tmux-target'] || ''
  const toolName = getString(p.tool_name)
  const toolInput = p.tool_input || {}
  const cwd = getString(p.cwd)
  const sessionId = getString(p.session_id)

  const title = toolName
  let preview = buildToolPreview(toolName, toolInput)

  // AskUserQuestion: questions metadata を追加し、プレビューを整形
  const isAskQ = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions)
  const extraMeta = {}
  if (isAskQ) {
    const previewLines = []
    for (const q of toolInput.questions) {
      previewLines.push(q.question || '')
      if (Array.isArray(q.options)) {
        for (const opt of q.options) {
          previewLines.push(`  • ${opt.label}: ${opt.description || ''}`)
        }
      }
    }
    preview = previewLines.join('\n')
    extraMeta.hookType = 'ask-user-question'
    extraMeta.questions = toolInput.questions
  }

  const projectSlug = path.basename(cwd || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const sessionSlug = (sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const threadId = `permission_${projectSlug}_${sessionSlug}_${Date.now()}`

  const { approval } = await createApproval({
    source: 'claude-code-hook',
    toolName,
    toolInput,
    toolId: '',
    cwd,
    agentName: 'claude-code',
    title,
    body: preview,
    threadId,
    metadata: {
      ...extraMeta,
      tmuxTarget,
      sessionLabel: deriveSessionLabel(tmuxTarget),
      sessionId,
      agentName: 'claude-code',
    },
  })

  spawnLocalNotification(toolName)

  // PC側で承認/拒否された場合、Claude Codeが接続を切る → 検知してマーク
  let clientDisconnected = false
  const onClose = () => { clientDisconnected = true }
  req.on('close', onClose)
  res.on('close', onClose)

  const deadline = Date.now() + HOOK_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(HOOK_POLL_INTERVAL_MS)
    if (clientDisconnected) {
      const record = approvalsById.get(approval.id)
      if (record && record.status === 'pending') {
        markApprovalCleanup(record, 'terminal-disconnect', 'terminal')
        log(`approval cleaned up by terminal disconnect id=${record.id}`)
      }
      req.off('close', onClose)
      res.off('close', onClose)
      return
    }
    const record = approvalsById.get(approval.id)
    if (record && record.status === 'decided') {
      record.deliveredAt = new Date().toISOString()
      req.off('close', onClose)
      res.off('close', onClose)
      if (record.decision === 'approve') {
        return sendJson(res, 200, {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        })
      }
      if (record.decision === 'deny') {
        const message = record.comment
          ? `G2: ${record.comment}`
          : 'G2から拒否されました'
        return sendJson(res, 200, {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message },
          },
        })
      }
      log(
        `approval cleanup observed while waiting id=${record.id} resolution=${record.resolution || 'unknown'}`,
      )
      return sendJson(res, 200, {})
    }
  }

  // Timeout: return empty response → Claude Code shows normal dialog
  req.off('close', onClose)
  res.off('close', onClose)
  sendJson(res, 200, {})
}

const server = createServer(async (req, res) => {
  const method = req.method || 'GET'
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  if (!applyCors(req, res)) {
    return sendJson(res, 403, { ok: false, error: 'Origin not allowed' })
  }

  if (method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  if (pathname.startsWith('/api/') && !isPublicApiRequest(method, pathname)) {
    if (!requireApiAuth(req, res)) return
  }

  try {

  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'notification-hub',
      notifications: notifications.length,
      replies: replies.length,
      approvals: approvals.length,
      pendingApprovals: approvals.filter((a) => a.status === 'pending').length,
      now: new Date().toISOString(),
    })
  }

  if (method === 'GET' && pathname === '/api/auth-check') {
    if (!requireApiAuth(req, res)) return
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && pathname === '/api/hooks/permission-request') {
    return handlePermissionRequestHook(req, res)
  }


  if (method === 'POST' && pathname === '/api/notify/moshi') {
    const rawBody = await readRequestBody(req, { maxBytes: hubMaxBodyBytes })
    const ctype = req.headers['content-type'] || ''
    let payload = null

    if (ctype.includes('application/json')) {
      const parsed = safeJsonParse(rawBody || '{}')
      if (!parsed.ok) {
        return sendJson(res, 400, { ok: false, error: `Invalid JSON: ${parsed.error}` })
      }
      payload = parsed.value
    } else if (ctype.includes('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(rawBody)
      payload = Object.fromEntries(form.entries())
    } else {
      const parsed = safeJsonParse(rawBody)
      payload = parsed.ok ? parsed.value : { rawBody }
    }

    // MOSHI の permission-request 通知は HTTP hook が既に notification + approval を
    // 作成済みのため、notifications 配列には保存しない（G2 重複防止）。
    const preItem = normalizeMoshiPayload(payload, {
      persistRaw: hubPersistRaw,
      createId: () => randomUUID(),
    })
    if (preItem.metadata && preItem.metadata.hookType === 'permission-request') {
      log(`moshi permission-request notification: skipped (not stored) title=${JSON.stringify(preItem.title)}`)
      return sendJson(res, 201, { ok: true, item: preItem, stored: false })
    }

    const { item } = await addNotification(payload, 'moshi notification')
    return sendJson(res, 201, { ok: true, item })
  }

  if (method === 'POST' && pathname === '/api/client-events') {
    const rawBody = await readRequestBody(req, { maxBytes: hubMaxBodyBytes })
    const parsed = safeJsonParse(rawBody || '{}')
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    }
    const p = parsed.value
    const line = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      source: getString(p.source, 'web-client'),
      message: getString(p.message),
      level: getString(p.level, 'info'),
      context: typeof p.context === 'object' && p.context !== null ? p.context : undefined,
    }
    await appendJsonl(clientEventsFile, line)
    return sendJson(res, 201, { ok: true })
  }

  // --- 位置情報 (Overland / 汎用 GPS ロガー対応) ---

  if (method === 'POST' && pathname === '/api/location') {
    const rawBody = await readRequestBody(req, { maxBytes: hubMaxBodyBytes })
    const parsed = safeJsonParse(rawBody || '{}')
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    }
    const p = parsed.value
    // Overland GeoJSON format: { locations: [{ geometry: { coordinates: [lng, lat] }, properties: { timestamp, ... } }] }
    const locations = Array.isArray(p.locations) ? p.locations : []
    if (locations.length > 0) {
      const latest = locations[locations.length - 1]
      const coords = latest?.geometry?.coordinates
      if (!Array.isArray(coords) || coords.length < 2) {
        return sendJson(res, 400, { ok: false, error: 'Invalid coordinates array' })
      }
      const lat = Number(coords[1])
      const lng = Number(coords[0])
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return sendJson(res, 400, { ok: false, error: 'Invalid latitude/longitude values' })
      }
      const alt = coords.length >= 3 ? Number(coords[2]) : NaN
      const props = latest.properties && typeof latest.properties === 'object' ? latest.properties : {}
      const spd = Number(props.speed)
      const bat = Number(props.battery_level)
      lastLocation = {
        lat,
        lng,
        altitude: Number.isFinite(alt) ? alt : null,
        timestamp: String(props.timestamp || '') || new Date().toISOString(),
        speed: Number.isFinite(spd) ? spd : null,
        battery: Number.isFinite(bat) ? bat : null,
        receivedAt: new Date().toISOString(),
      }
      log(`location updated: lat=${lastLocation.lat} lng=${lastLocation.lng}`)
    }
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'GET' && pathname === '/api/location') {
    if (!lastLocation) {
      return sendJson(res, 200, { ok: true, location: null, message: 'No location data received yet' })
    }
    return sendJson(res, 200, { ok: true, location: lastLocation })
  }

  if (method === 'POST' && pathname === '/api/stt/transcriptions') {
    const rawBody = await readRequestBody(req, { maxBytes: hubMaxSttBodyBytes })
    const parsed = safeJsonParse(rawBody || '{}')
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    }
    const p = parsed.value
    const audioBase64 = getString(p.audioBase64)
    if (!audioBase64) {
      return sendJson(res, 400, { ok: false, error: '`audioBase64` is required' })
    }
    const result = await transcribeAudioWithGroq(
      {
        audioBase64,
        mimeType: getString(p.mimeType),
        model: getString(p.model),
        language: getString(p.language),
        responseFormat: getString(p.response_format),
      },
      {
        apiKey: groqApiKey,
        defaultModel: groqModelDefault,
      },
    )
    if (!result.ok) {
      return sendJson(res, result.status, { ok: false, error: result.error })
    }
    return sendJson(res, 200, result.payload)
  }

  // Context status: StatusLine hook からコンテキストウィンドウ占有率を受信
  if (method === 'POST' && pathname === '/api/context-status') {
    const rawBody = await readRequestBody(req, { maxBytes: hubMaxBodyBytes })
    const parsed = safeJsonParse(rawBody || '{}')
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    }
    const p = parsed.value
    const sessionId = getString(p.sessionId, 'default')
    contextStatusBySession.set(sessionId, {
      sessionId,
      cwd: getString(p.cwd),
      usedPercentage: typeof p.usedPercentage === 'number' ? p.usedPercentage : 0,
      model: getString(p.model),
      updatedAt: new Date().toISOString(),
    })
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'GET' && pathname === '/api/context-status') {
    return sendJson(res, 200, { ok: true, sessions: [...contextStatusBySession.values()] })
  }

  if (method === 'GET' && pathname === '/api/notifications') {
    const limitRaw = Number(url.searchParams.get('limit') || '20')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 20
    return sendJson(res, 200, { ok: true, items: listNotifications(limit) })
  }

  if (method === 'GET') {
    const id = matchNotificationDetail(pathname)
    if (id) {
      const item = notificationsById.get(id)
      if (!item) return sendJson(res, 404, { ok: false, error: 'Notification not found' })
      return sendJson(res, 200, { ok: true, item })
    }
  }

  if (method === 'POST') {
    const id = matchNotificationReply(pathname)
    if (id) {
      const item = notificationsById.get(id)
      if (!item) return sendJson(res, 404, { ok: false, error: 'Notification not found' })
      const rawBody = await readRequestBody(req, { maxBytes: hubMaxBodyBytes })
      const parsed = safeJsonParse(rawBody || '{}')
      if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
        return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      }
      const replyTextRaw = getString(parsed.value.replyText)
      const action = getString(parsed.value.action)
      const comment = getString(parsed.value.comment)
      const source = getString(parsed.value.source)

      // answerData バリデーション: plain object, キー/値とも string, 上限付き
      let answerData = undefined
      if (parsed.value.answerData && typeof parsed.value.answerData === 'object' && !Array.isArray(parsed.value.answerData)) {
        const entries = Object.entries(parsed.value.answerData)
        if (entries.length <= 10 && entries.every(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length <= 2000 && v.length <= 2000)) {
          answerData = parsed.value.answerData
        }
      }

      const validActions = new Set(['approve', 'deny', 'comment', 'answer'])
      if (action && !validActions.has(action)) {
        return sendJson(res, 400, { ok: false, error: 'Invalid `action`' })
      }
      if (action === 'answer') {
        if (!answerData) {
          return sendJson(res, 400, { ok: false, error: '`answerData` is required for action=answer' })
        }
        const isAskQ = item.metadata && item.metadata.hookType === 'ask-user-question'
        if (!isAskQ) {
          return sendJson(res, 400, { ok: false, error: 'action=answer is only valid for ask-user-question notifications' })
        }
      }

      const replyText =
        replyTextRaw ||
        (action === 'approve' ? '[ACTION] approve' : '') ||
        (action === 'deny' ? '[ACTION] deny' : '') ||
        (action === 'answer' ? '[ACTION] answer' : '') ||
        (action === 'comment' ? comment : '') ||
        ''
      if (!replyText) {
        return sendJson(res, 400, {
          ok: false,
          error: '`replyText` or (`action` + optional `comment`) is required',
        })
      }

      /** @type {ReplyRecord} */
      const record = {
        id: randomUUID(),
        notificationId: id,
        replyText,
        createdAt: new Date().toISOString(),
        status: 'stubbed',
        action: action ? /** @type {'approve'|'deny'|'comment'} */ (action) : undefined,
        resolvedAction: undefined,
        result: undefined,
        ignoredReason: undefined,
        comment: comment || undefined,
        source: source || undefined,
      }
      let linkedApproval = approvalsByNotificationId.get(id)
      const isAskUserQuestion = item.metadata && item.metadata.hookType === 'ask-user-question'
      const isApprovalNotification =
        isAskUserQuestion ||
        (item.metadata && item.metadata.hookType === 'permission-request') ||
        (item.metadata && item.metadata.approvalId)
      let shouldRelay = true
      // Fallback: if no direct link but notification looks like an approval,
      // find a matching pending approval by content similarity.
      // MOSHI notifications don't carry approvalId, so we match by toolName
      // and file path / command to avoid resolving the wrong approval.
      if (!linkedApproval && isApprovalNotification) {
        const replyToolName = (item.metadata && item.metadata.toolName) || ''
        const replyTitle = item.title || ''
        const replySummary = item.summary || ''
        const replyFullText = item.fullText || ''

        let bestMatch = null
        for (let i = approvals.length - 1; i >= 0; i--) {
          if (approvals[i].status !== 'pending') continue

          // Same toolName is required for a match
          if (replyToolName && approvals[i].toolName !== replyToolName) continue

          // Try to match by file path or command content
          const approvalNotif = notificationsById.get(approvals[i].notificationId)
          if (approvalNotif && replyToolName) {
            const approvalText = (approvalNotif.summary || '') + ' ' + (approvalNotif.fullText || '')
            const input = approvals[i].toolInput || {}
            const filePath = input.file_path || ''
            const command = input.command || ''
            const identifier = filePath || command

            // Check if the reply notification mentions the same file/command
            if (identifier) {
              const shortId = identifier.split('/').pop() || identifier.slice(0, 30)
              if (replyTitle.includes(shortId) || replySummary.includes(shortId) || replyFullText.includes(shortId)) {
                bestMatch = approvals[i]
                break
              }
            }
          }

          // If no content match found yet, keep as fallback (most recent pending with same toolName)
          if (!bestMatch) {
            bestMatch = approvals[i]
          }
        }

        linkedApproval = bestMatch
        if (linkedApproval) {
          const matchType = replyToolName ? 'content' : 'most-recent'
          log(`approval-broker fallback: matched reply to approval id=${linkedApproval.id} (${matchType} match, no direct link)`)
        }
      }
      if (linkedApproval && linkedApproval.status === 'pending') {
        // AskUserQuestion の回答: deny+コメントとして返す（PermissionRequest経由でClaude Codeに届く）
        if (action === 'answer' && answerData && isAskUserQuestion) {
          linkedApproval.answerData = answerData
          const answerPairs = Object.entries(answerData).map(([q, a]) => `${q} → ${a}`)
          const answerComment = `選択回答: ${answerPairs.join(' / ')}`
          record.resolvedAction = 'deny'
          record.result = 'resolved'
          resolveApproval(linkedApproval.id, 'deny', answerComment, source || 'g2')
          log(`ask-user-question answered id=${linkedApproval.id} answers=${JSON.stringify(answerData)}`)
          shouldRelay = false
        }
        // Resolve approval: explicit approve/deny actions, or parse comment text
        let resolvedAction = null
        if (action === 'answer') {
          // already handled above
        } else if (action === 'approve' || action === 'deny') {
          resolvedAction = action
        } else if (action === 'comment' || !action) {
          // G2 sends comments (not explicit approve/deny buttons).
          // Parse comment text for intent keywords. If no keyword matches,
          // do NOT resolve the approval — let the comment be relayed as plain text
          // to the Claude Code input. Explicit approve/deny buttons should be used
          // for approval decisions.
          const text = (comment || replyText || '').toLowerCase().trim()
          const denyPatterns = ['拒否', 'deny', 'no', 'reject', 'だめ', 'ダメ', 'いいえ']
          const approvePatterns = ['承認', 'approve', 'yes', 'ok', 'おk', 'いいよ', 'はい', '許可']
          if (denyPatterns.some((p) => text.includes(p))) {
            resolvedAction = 'deny'
          } else if (approvePatterns.some((p) => text.includes(p))) {
            resolvedAction = 'approve'
          }
          // else: no keyword match → resolvedAction stays null → approval not resolved
          // comment is still relayed to tmux as plain text input
        }
        if (resolvedAction) {
          record.resolvedAction = resolvedAction
          record.result = 'resolved'
          resolveApproval(linkedApproval.id, resolvedAction, comment, source || 'g2')
          log(
            `approval-broker resolved id=${linkedApproval.id} action=${resolvedAction} (original=${action || 'none'} text=${(comment || replyText || '').slice(0, 50)})`,
          )
          // HTTP hook が承認を解決済みなので tmux relay は不要。
          // relay すると承認ダイアログ消失後に y/n キーが入力欄に漏れる。
          shouldRelay = false
        } else if (action === 'comment') {
          // Comment without keyword match on an approval notification:
          // HTTP hook 経由の場合は deny + comment として approval を解決し、
          // HTTP レスポンスで Claude Code に返す。tmux relay は不要。
          const commentText = comment || replyText || ''
          record.resolvedAction = 'deny'
          record.result = 'resolved'
          resolveApproval(linkedApproval.id, 'deny', commentText, source || 'g2')
          log(
            `approval-broker resolved as deny+comment id=${linkedApproval.id} text=${commentText.slice(0, 50)}`,
          )
          shouldRelay = false
        }
      } else if (isApprovalNotification) {
        // Stale/ambiguous approval replies must not be relayed to tmux.
        // Otherwise an old "approve" tap can affect a newer pending prompt.
        shouldRelay = false
        record.result = 'ignored'
        if (linkedApproval) {
          record.ignoredReason = 'approval-not-pending'
          record.error = 'Approval is no longer pending'
          log(
            `reply relay skipped: approval already decided id=${linkedApproval.id} action=${action || 'none'}`,
          )
        } else {
          record.ignoredReason = 'approval-link-not-found'
          record.error = 'Approval link not found'
          log(`reply relay skipped: approval link not found notificationId=${id} action=${action || 'none'}`)
        }
      }

      if (!record.result) {
        record.result = 'relayed'
      }

      const fwd = await forwardReplyIfConfigured({
        reply: record,
        notification: {
          id: item.id,
          title: item.title,
          summary: item.summary,
          metadata: item.metadata,
        },
      })
      const relay = shouldRelay
        ? await relayReplyIfConfigured({
            reply: record,
            notification: {
              id: item.id,
              title: item.title,
              summary: item.summary,
              metadata: item.metadata,
            },
          })
        : { status: 'stubbed' }
      const statuses = [fwd.status, relay.status]
      if (statuses.includes('failed')) record.status = 'failed'
      else if (statuses.includes('forwarded')) record.status = 'forwarded'
      else record.status = 'stubbed'
      const errors = [fwd.error, relay.error].filter(Boolean)
      if (errors.length > 0) record.error = [record.error, ...errors].filter(Boolean).join(' | ')
      replies.push(record)
      await appendJsonl(repliesFile, record)

      log(
        `reply accepted id=${record.id} notificationId=${record.notificationId} status=${record.status}${record.action ? ` action=${record.action}` : ''}${record.error ? ` error=${record.error}` : ''}`,
      )
      return sendJson(res, 200, { ok: true, reply: record })
    }
  }

  if (method === 'POST' && pathname === '/api/approvals') {
    const rawBody = await readRequestBody(req, { maxBytes: hubMaxBodyBytes })
    const parsed = safeJsonParse(rawBody || '{}')
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    }
    const p = parsed.value
    const toolName = getString(p.toolName)
    if (!toolName) {
      return sendJson(res, 400, { ok: false, error: '`toolName` is required' })
    }
    const { approval, notification } = await createApproval({
      source: getString(p.source),
      toolName,
      toolInput: p.toolInput ?? null,
      toolId: getString(p.toolId),
      cwd: getString(p.cwd),
      reason: getString(p.reason),
      agentName: getString(p.agentName),
      title: getString(p.title),
      body: getString(p.body),
      metadata: typeof p.metadata === 'object' && p.metadata !== null ? p.metadata : {},
      threadId: getString(p.threadId),
    })
    return sendJson(res, 201, {
      ok: true,
      approvalId: approval.id,
      approval,
      notificationId: notification.id,
    })
  }

  if (method === 'GET') {
    const approvalId = matchApprovalPath(pathname)
    if (approvalId) {
      const record = approvalsById.get(approvalId)
      if (!record) return sendJson(res, 404, { ok: false, error: 'Approval not found' })
      return sendJson(res, 200, { ok: true, approval: record })
    }
  }

  if (method === 'POST') {
    const approvalId = matchApprovalDecidePath(pathname)
    if (approvalId) {
      const record = approvalsById.get(approvalId)
      if (!record) return sendJson(res, 404, { ok: false, error: 'Approval not found' })
      if (record.status !== 'pending') {
        return sendJson(res, 409, { ok: false, error: 'Approval already decided', approval: record })
      }
      const rawBody = await readRequestBody(req, { maxBytes: hubMaxBodyBytes })
      const parsed = safeJsonParse(rawBody || '{}')
      if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
        return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      }
      const decision = getString(parsed.value.decision)
      if (decision !== 'approve' && decision !== 'deny') {
        return sendJson(res, 400, { ok: false, error: '`decision` must be "approve" or "deny"' })
      }
      const comment = getString(parsed.value.comment)
      const source = getString(parsed.value.source)
      const updated = resolveApproval(approvalId, decision, comment, source)
      return sendJson(res, 200, { ok: true, approval: updated })
    }
  }

  if (method === 'GET' && pathname === '/api/approvals') {
    const pending = approvals.filter((a) => a.status === 'pending')
    return sendJson(res, 200, { ok: true, items: pending })
  }

  if (method === 'GET' && (pathname === '/ui' || pathname === '/ui/')) {
    if (hubAuthToken) {
      const validSession = hasValidUiSession(req)
      const queryToken = getString(url.searchParams.get('token'))
      if (!validSession) {
        if (queryToken !== hubAuthToken) {
          return sendText(
            res,
            401,
            'Unauthorized. Open /ui?token=<HUB_AUTH_TOKEN> once to create a browser session.',
          )
        }
        const session = createUiSession()
        res.statusCode = 302
        res.setHeader(
          'Set-Cookie',
          `${UI_SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${UI_SESSION_MAX_AGE_SEC}`,
        )
        res.setHeader('Location', '/ui')
        return res.end()
      }
    }
    const uiPath = new URL('./approval-ui.html', import.meta.url)
    const html = await readFile(uiPath, 'utf8')
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(html)
    return
  }

  if (method === 'GET' && pathname === '/') {
    return sendText(
      res,
      200,
      [
        'notification-hub (approval-broker)',
        '',
        'GET  /api/health',
        'POST /api/hooks/permission-request  (HTTP hook for Claude Code)',
        'POST /api/notify/moshi',
        'GET  /api/notifications?limit=20',
        'GET  /api/notifications/:id',
        'POST /api/notifications/:id/reply',
        '',
        'POST /api/approvals              (create approval request)',
        'GET  /api/approvals              (list pending approvals)',
        'GET  /api/approvals/:id          (poll approval status)',
        'POST /api/approvals/:id/decide   (submit decision)',
        '',
        'GET  /ui                         (approval dashboard)',
        'POST /api/client-events          (frontend event log intake)',
        'POST /api/location               (receive GPS from Overland/etc)',
        'GET  /api/location               (get latest GPS location)',
      ].join('\n'),
    )
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' })
  } catch (err) {
    if (isBodyTooLargeError(err)) {
      return sendRequestBodyTooLarge(res, err)
    }
    throw err
  }
})

await bootstrap()
server.listen(port, host, () => {
  log(`notification-hub listening on http://${host}:${port}`)
})
