import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getString } from './notification-utils.mjs'
import {
  host,
  port,
  dataDir,
  hubAuthToken,
  notificationsFile,
  repliesFile,
  clientEventsFile,
  approvalsFile,
  UI_SESSION_COOKIE,
  UI_SESSION_MAX_AGE_SEC,
} from './config.mjs'
import { store, ensureDataDir, loadJsonl, appendJsonl, log } from './store.mjs'
import {
  applyCors,
  sendJson,
  sendText,
  parseJsonBody,
  sendRequestBodyTooLarge,
  isBodyTooLargeError,
  createUiSession,
  hasValidUiSession,
  requireApiAuth,
} from './http-util.mjs'
import {
  matchNotificationDetail,
  matchNotificationReply,
  handleNotifyMoshi,
  handleNotificationsList,
  handleNotificationDetail,
  handleNotificationReply,
} from './notifications.mjs'
import {
  matchApprovalPath,
  matchApprovalDecidePath,
  handleApprovalCreate,
  handleApprovalGet,
  handleApprovalDecide,
  handleApprovalsList,
} from './approvals.mjs'
import { matchImagePath, loadStoredImages, handleImagePost, handleImageGet } from './images.mjs'
import { handleG2DisplayPost, handleG2DisplayGet } from './g2-display.mjs'
import { handleSseEvents } from './sse.mjs'
import { handlePermissionRequestHook } from './hooks.mjs'
import { handleSttTranscription, handleSttRealtimeToken, handleSttSonioxToken } from './stt-routes.mjs'
import { handleLocationPost, handleLocationGet } from './location.mjs'
// session-activity モニター（tmux ポーリング interval）は import 時に起動する（従来挙動と同順）
import './session-activity.mjs'

// 可変状態は store が単一所有。コレクションは参照で受け取る。
// 再代入される lastLocation のみ store.lastLocation 経由で読み書きする。
const {
  notifications,
  notificationsById,
  replies,
  notificationExternalIds,
  contextStatusBySession,
  approvals,
  approvalsById,
  approvalsByNotificationId,
  sessionActivity,
} = store

const publicApiRoutes = new Set([
  'GET /api/health',
  'GET /api/context-status',
  'GET /api/notifications',
  'GET /api/events',
  'POST /api/client-events',
  'POST /api/location',
  // ミラービューア（mirror.html）はトークンを持たないため画像 GET と同じ公開扱い
  // （trusted network 前提。POST /api/g2-display は要トークンのまま）
  'GET /api/g2-display',
])

function isPublicApiRequest(method, pathname) {
  if (publicApiRoutes.has(`${method} ${pathname}`)) return true
  if (method === 'GET' && matchNotificationDetail(pathname)) return true
  // 画像 GET は通知詳細 GET と同じ公開扱い（trusted network 前提、plan/g2-image-display.md 参照）
  if (method === 'GET' && matchImagePath(pathname)) return true
  return false
}

async function bootstrap() {
  await ensureDataDir()
  await loadStoredImages()
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
    return await handleNotifyMoshi(req, res)
  }

  // --- 画像 (G2 画像表示用) ---

  if (method === 'POST' && pathname === '/api/images') {
    return await handleImagePost(req, res, url)
  }

  if (method === 'GET') {
    const imageId = matchImagePath(pathname)
    if (imageId) {
      return await handleImageGet(req, res, imageId)
    }
  }

  // --- G2 ミラー表示状態 (plan/g2-mirror.md) ---

  if (method === 'POST' && pathname === '/api/g2-display') {
    return await handleG2DisplayPost(req, res)
  }

  if (method === 'GET' && pathname === '/api/g2-display') {
    return handleG2DisplayGet(req, res)
  }

  if (method === 'POST' && pathname === '/api/client-events') {
    const p = await parseJsonBody(req, res)
    if (!p) return
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
    return await handleLocationPost(req, res)
  }

  if (method === 'GET' && pathname === '/api/location') {
    return handleLocationGet(req, res)
  }

  if (method === 'POST' && pathname === '/api/stt/transcriptions') {
    return await handleSttTranscription(req, res)
  }

  if (method === 'POST' && pathname === '/api/stt/realtime-token') {
    return await handleSttRealtimeToken(req, res)
  }

  if (method === 'POST' && pathname === '/api/stt/soniox-token') {
    return await handleSttSonioxToken(req, res)
  }

  // Context status: StatusLine hook からコンテキストウィンドウ占有率を受信
  if (method === 'POST' && pathname === '/api/context-status') {
    const p = await parseJsonBody(req, res)
    if (!p) return
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

  if (method === 'GET' && pathname === '/api/session-activity') {
    return sendJson(res, 200, { ok: true, sessions: [...sessionActivity.values()] })
  }

  if (method === 'GET' && pathname === '/api/events') {
    return handleSseEvents(req, res)
  }

  if (method === 'GET' && pathname === '/api/notifications') {
    return handleNotificationsList(req, res, url)
  }

  if (method === 'GET') {
    const id = matchNotificationDetail(pathname)
    if (id) {
      return handleNotificationDetail(req, res, id)
    }
  }

  if (method === 'POST') {
    const id = matchNotificationReply(pathname)
    if (id) {
      return await handleNotificationReply(req, res, id)
    }
  }

  if (method === 'POST' && pathname === '/api/approvals') {
    return await handleApprovalCreate(req, res)
  }

  if (method === 'GET') {
    const approvalId = matchApprovalPath(pathname)
    if (approvalId) {
      return handleApprovalGet(req, res, approvalId)
    }
  }

  if (method === 'POST') {
    const approvalId = matchApprovalDecidePath(pathname)
    if (approvalId) {
      return await handleApprovalDecide(req, res, approvalId)
    }
  }

  if (method === 'GET' && pathname === '/api/approvals') {
    return handleApprovalsList(req, res)
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
        'GET  /api/events                 (SSE stream)',
        'GET  /api/notifications?limit=20',
        'GET  /api/notifications/:id',
        'POST /api/notifications/:id/reply',
        '',
        'POST /api/approvals              (create approval request)',
        'GET  /api/approvals              (list pending approvals)',
        'GET  /api/approvals/:id          (poll approval status)',
        'POST /api/approvals/:id/decide   (submit decision)',
        '',
        'POST /api/stt/realtime-token     (OpenAI Realtime ephemeral token)',
        '',
        'GET  /ui                         (approval dashboard)',
        'POST /api/client-events          (frontend event log intake)',
        'POST /api/location               (receive GPS from Overland/etc)',
        'GET  /api/location               (get latest GPS location)',
        '',
        'POST /api/images?title=...       (raw png/jpeg body -> G2 image notification)',
        'GET  /api/images/:id             (serve stored image)',
        '',
        'POST /api/g2-display             (receive G2 mirror display state)',
        'GET  /api/g2-display             (latest G2 mirror display state)',
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
