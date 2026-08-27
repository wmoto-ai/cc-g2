// 承認レコードの作成・解決・クリーンアップ。可変状態は store が所有し、ここでは参照のみ。
// notifications.mjs と相互依存（createApproval → addNotification /
// addNotification → markApprovalCleanup）だが、関数宣言のみの実行時呼び出しなので安全。
import { randomUUID } from 'node:crypto'
import { getString, persistedApproval } from './notification-utils.mjs'
import { approvalsFile, hubApprovalMode, hubPersistToolInput } from './config.mjs'
import { store, appendJsonl, log } from './store.mjs'
import { matchPathParam, sendJson, parseJsonBody } from './http-util.mjs'
import { sseBroadcast, sseBroadcastNotificationAdded } from './sse.mjs'
import { addNotification, notificationToListItem } from './notifications.mjs'
import { relayApprovalInjection } from './relay.mjs'

/** @typedef {import('./store.mjs').ApprovalRecord} ApprovalRecord */

const { approvals, approvalsById, approvalsByNotificationId, notificationsById } = store

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
  sseBroadcastNotificationAdded(notification)
  return { approval: record, notification }
}

function finalizeApproval(record, fields, logMessage) {
  record.status = 'decided'
  Object.assign(record, fields)
  record.decidedBy = fields.decidedBy || undefined
  appendJsonl(
    approvalsFile,
    persistedApproval({ ...record, _event: 'decided' }, { persistToolInput: hubPersistToolInput }),
  ).catch((err) =>
    log(`approval persist error ${err instanceof Error ? err.message : String(err)}`),
  )
  log(logMessage)
  const notif = notificationsById.get(record.notificationId)
  if (notif) sseBroadcast('notification-updated', notificationToListItem(notif))
  return record
}

// options.skipInject: ローカル決着（PostToolUse 由来の tool-executed）では既にツールが
// 実行済みでダイアログが無いため、キー注入を行わない（relay プロセスを起動しない）。
function resolveApproval(approvalId, decision, comment, decidedBy, options = {}) {
  const record = approvalsById.get(approvalId)
  if (!record) return null
  if (record.status !== 'pending') return record
  const updated = finalizeApproval(record, {
    decision,
    resolution: undefined,
    comment: comment || undefined,
    decidedBy: decidedBy || undefined,
    decidedAt: new Date().toISOString(),
  }, `approval decided id=${record.id} decision=${decision} by=${decidedBy || 'unknown'}`)
  if (!options.skipInject) maybeInjectApprovalDecision(updated, decision, comment, decidedBy)
  return updated
}

// ノンブロッキングモードでは hook が既に {} を返して CLI のローカルダイアログが出ているため、
// decide 時に reply-relay へ合成ペイロードを渡してキー注入し、ダイアログを閉じる。
// longpoll モードでは hook 応答で決定が届くので何もしない（既定挙動不変）。
// 対象は permission-request 承認のみ（AskUserQuestion 等の選択肢ダイアログは注入対象外）。
function maybeInjectApprovalDecision(record, decision, comment, decidedBy) {
  if (hubApprovalMode !== 'nonblocking') return
  const notif = notificationsById.get(record.notificationId)
  if (!notif) return
  const hookType = notif.metadata && notif.metadata.hookType
  if (hookType !== 'permission-request') return
  const payload = {
    reply: {
      resolvedAction: decision,
      action: decision,
      comment: comment || '',
      source: decidedBy || 'hub',
    },
    notification: {
      id: notif.id,
      title: notif.title,
      summary: notif.summary,
      metadata: notif.metadata,
    },
  }
  relayApprovalInjection(payload)
    .then((result) => {
      // 注入成功時のみ deliveredAt を付ける（失敗時は付けない）
      if (result && result.status === 'forwarded') {
        record.deliveredAt = new Date().toISOString()
      }
      log(
        `approval inject id=${record.id} decision=${decision} relay=${result ? result.status : 'unknown'}${result && result.error ? ` error=${result.error}` : ''}`,
      )
    })
    .catch((err) =>
      log(`approval inject error id=${record.id} ${err instanceof Error ? err.message : String(err)}`),
    )
}

function markApprovalCleanup(record, resolution, decidedBy, decidedAt = new Date().toISOString()) {
  if (!record || record.status !== 'pending') return record
  return finalizeApproval(record, {
    decision: undefined,
    resolution,
    comment: undefined,
    decidedBy: decidedBy || undefined,
    decidedAt,
    deliveredAt: decidedAt,
  }, `approval cleaned up id=${record.id} resolution=${resolution} by=${decidedBy || 'unknown'}`)
}

function matchApprovalPath(pathname) {
  return matchPathParam(pathname, '/api/approvals/')
}
function matchApprovalDecidePath(pathname) {
  return matchPathParam(pathname, '/api/approvals/', '/decide')
}

/** POST /api/approvals */
async function handleApprovalCreate(req, res) {
  const p = await parseJsonBody(req, res)
  if (!p) return
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

/** GET /api/approvals/:id */
function handleApprovalGet(req, res, approvalId) {
  const record = approvalsById.get(approvalId)
  if (!record) return sendJson(res, 404, { ok: false, error: 'Approval not found' })
  return sendJson(res, 200, { ok: true, approval: record })
}

/** POST /api/approvals/:id/decide */
async function handleApprovalDecide(req, res, approvalId) {
  const record = approvalsById.get(approvalId)
  if (!record) return sendJson(res, 404, { ok: false, error: 'Approval not found' })
  if (record.status !== 'pending') {
    return sendJson(res, 409, { ok: false, error: 'Approval already decided', approval: record })
  }
  const p = await parseJsonBody(req, res)
  if (!p) return
  const decision = getString(p.decision)
  if (decision !== 'approve' && decision !== 'deny') {
    return sendJson(res, 400, { ok: false, error: '`decision` must be "approve" or "deny"' })
  }
  const comment = getString(p.comment)
  const source = getString(p.source)
  const updated = resolveApproval(approvalId, decision, comment, source)
  return sendJson(res, 200, { ok: true, approval: updated })
}

/** GET /api/approvals */
function handleApprovalsList(req, res) {
  const pending = approvals.filter((a) => a.status === 'pending')
  return sendJson(res, 200, { ok: true, items: pending })
}

export {
  createApproval,
  resolveApproval,
  markApprovalCleanup,
  matchApprovalPath,
  matchApprovalDecidePath,
  handleApprovalCreate,
  handleApprovalGet,
  handleApprovalDecide,
  handleApprovalsList,
}
