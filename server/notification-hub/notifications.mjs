// 通知の登録・重複排除・一覧整形。可変状態は store が所有し、ここでは参照のみ。
// approvals.mjs と相互依存（addNotification → markApprovalCleanup /
// createApproval → addNotification）だが、関数宣言のみの実行時呼び出しなので安全。
import { randomUUID } from 'node:crypto'
import {
  getString,
  normalizeMoshiPayload,
  persistedNotification,
  readRequestBody,
  safeJsonParse,
} from './notification-utils.mjs'
import {
  hubMaxBodyBytes,
  hubPermissionThreadDedupMs,
  hubPersistRaw,
  notificationsFile,
  repliesFile,
} from './config.mjs'
import { store, appendJsonl, log } from './store.mjs'
import { matchPathParam, sendJson, parseJsonBody } from './http-util.mjs'
import { sseBroadcast, sseBroadcastNotificationAdded } from './sse.mjs'
import { markApprovalCleanup, resolveApproval } from './approvals.mjs'
import { forwardReplyIfConfigured, relayReplyIfConfigured } from './relay.mjs'

/** @typedef {import('./store.mjs').ReplyRecord} ReplyRecord */

const {
  notifications,
  notificationsById,
  notificationExternalIds,
  permissionThreadSeenAt,
  replies,
  approvals,
  approvalsByNotificationId,
} = store

async function addNotification(payload, logPrefix = 'notification') {
  const item = normalizeMoshiPayload(payload, {
    persistRaw: hubPersistRaw,
    createId: () => randomUUID(),
  })
  const meta = item.metadata
  const extId = typeof meta?.externalId === 'string' ? meta.externalId : ''
  const hookType = typeof meta?.hookType === 'string' ? meta.hookType : ''
  const threadId = typeof meta?.threadId === 'string' ? meta.threadId : ''
  const hasApprovalId = typeof meta?.approvalId === 'string' || typeof meta?.approvalId === 'number'

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

  // stop通知が来たら同セッションの残 pending 承認を「実行されず終了」として掃除する。
  // longpoll でブロック中の承認は Stop がそもそも届かない（hook がターンを塞ぐ）ため
  // モードによる保護は不要。仮に競合しても poll 側が cleanup を検知して {} を返し
  // CLI のネイティブダイアログに移行する良性動作になる（hooks.mjs の poll ループ参照）。
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

function areSameSession(a, b) {
  if (!a.metadata || !b.metadata) return false
  if (a.metadata.sessionId && a.metadata.sessionId === b.metadata.sessionId) return true
  if (a.metadata.tmuxTarget && a.metadata.tmuxTarget === b.metadata.tmuxTarget) return true
  if (!a.metadata.sessionId && !a.metadata.tmuxTarget && a.metadata.cwd && a.metadata.cwd === b.metadata.cwd) return true
  return false
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
    const t = new Date(item.createdAt).getTime()
    const hasNewer = notifications.some((n) =>
      n.id !== item.id && areSameSession(item, n) && new Date(n.createdAt).getTime() > t,
    )
    if (hasNewer) return 'delivered'
  }
  return undefined
}

function notificationToListItem(item) {
  return {
    id: item.id, source: item.source, title: item.title,
    summary: item.summary, createdAt: item.createdAt,
    replyCapable: item.replyCapable, metadata: item.metadata,
    replyStatus: getReplyStatus(item),
  }
}

function listNotifications(limit) {
  const sorted = [...notifications].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return sorted.slice(0, limit).map(notificationToListItem)
}

function matchNotificationDetail(pathname) {
  return matchPathParam(pathname, '/api/notifications/')
}

function matchNotificationReply(pathname) {
  return matchPathParam(pathname, '/api/notifications/', '/reply')
}

/** POST /api/notify/moshi */
async function handleNotifyMoshi(req, res) {
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

  const result = await addNotification(payload, 'moshi notification')
  const item = result.item
  if (!result.duplicate) sseBroadcastNotificationAdded(item)
  return sendJson(res, 201, { ok: true, item })
}

/** GET /api/notifications */
function handleNotificationsList(req, res, url) {
  const limitRaw = Number(url.searchParams.get('limit') || '20')
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 20
  return sendJson(res, 200, { ok: true, items: listNotifications(limit) })
}

/** GET /api/notifications/:id */
function handleNotificationDetail(req, res, id) {
  const item = notificationsById.get(id)
  if (!item) return sendJson(res, 404, { ok: false, error: 'Notification not found' })
  return sendJson(res, 200, { ok: true, item })
}

/** POST /api/notifications/:id/reply */
async function handleNotificationReply(req, res, id) {
  const item = notificationsById.get(id)
  if (!item) return sendJson(res, 404, { ok: false, error: 'Notification not found' })
  const p = await parseJsonBody(req, res)
  if (!p) return
  const replyTextRaw = getString(p.replyText)
  const action = getString(p.action)
  const comment = getString(p.comment)
  const source = getString(p.source)

  // answerData バリデーション: plain object, キー/値とも string, 上限付き
  let answerData = undefined
  if (p.answerData && typeof p.answerData === 'object' && !Array.isArray(p.answerData)) {
    const entries = Object.entries(p.answerData)
    if (entries.length <= 10 && entries.every(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length <= 2000 && v.length <= 2000)) {
      answerData = p.answerData
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
    // Resolve approval: approve/deny ボタンはそのまま、comment は常に deny+comment
    if (action === 'answer') {
      // already handled above
    } else if (action === 'approve' || action === 'deny') {
      record.resolvedAction = action
      record.result = 'resolved'
      resolveApproval(linkedApproval.id, action, comment, source || 'g2')
      log(
        `approval-broker resolved id=${linkedApproval.id} action=${action} text=${(comment || replyText || '').slice(0, 50)}`,
      )
      shouldRelay = false
    } else if (action === 'comment' || !action) {
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

  const replyPayload = {
    reply: record,
    notification: { id: item.id, title: item.title, summary: item.summary, metadata: item.metadata },
  }
  const fwd = await forwardReplyIfConfigured(replyPayload)
  const relay = shouldRelay
    ? await relayReplyIfConfigured(replyPayload)
    : { status: 'stubbed' }
  const statuses = [fwd.status, relay.status]
  if (statuses.includes('failed')) record.status = 'failed'
  else if (statuses.includes('forwarded')) record.status = 'forwarded'
  else record.status = 'stubbed'
  const errors = [fwd.error, relay.error].filter(Boolean)
  if (errors.length > 0) record.error = [record.error, ...errors].filter(Boolean).join(' | ')
  replies.push(record)
  await appendJsonl(repliesFile, record)
  sseBroadcast('notification-updated', notificationToListItem(item))

  log(
    `reply accepted id=${record.id} notificationId=${record.notificationId} status=${record.status}${record.action ? ` action=${record.action}` : ''}${record.error ? ` error=${record.error}` : ''}`,
  )
  return sendJson(res, 200, { ok: true, reply: record })
}

export {
  addNotification,
  areSameSession,
  notificationToListItem,
  listNotifications,
  matchNotificationDetail,
  matchNotificationReply,
  handleNotifyMoshi,
  handleNotificationsList,
  handleNotificationDetail,
  handleNotificationReply,
}
