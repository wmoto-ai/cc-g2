// HTTP 共通ユーティリティ: CORS / JSON・テキスト応答 / ボディ解析 /
// Cookie・UI セッション認証 / パスパラメータマッチ。
// 可変状態は持たない（uiSessions は store から参照で受け取る）。
import { randomUUID } from 'node:crypto'
import { readRequestBody, safeJsonParse } from './notification-utils.mjs'
import {
  hubAllowedOrigins,
  hubAuthToken,
  hubMaxBodyBytes,
  UI_SESSION_COOKIE,
  UI_SESSION_MAX_AGE_SEC,
} from './config.mjs'
import { store } from './store.mjs'

const { uiSessions } = store

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

async function parseJsonBody(req, res, maxBytes = hubMaxBodyBytes) {
  const rawBody = await readRequestBody(req, { maxBytes })
  const parsed = safeJsonParse(rawBody || '{}')
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    return null
  }
  return parsed.value
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

function matchPathParam(pathname, prefix, suffix = '') {
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (suffix) {
    if (!rest.endsWith(suffix)) return null
    const param = rest.slice(0, -suffix.length)
    return param && !param.includes('/') ? decodeURIComponent(param) : null
  }
  return rest && !rest.includes('/') ? decodeURIComponent(rest) : null
}

export {
  applyCors,
  sendJson,
  sendText,
  parseJsonBody,
  sendRequestBodyTooLarge,
  isBodyTooLargeError,
  createUiSession,
  hasValidUiSession,
  requireApiAuth,
  matchPathParam,
}
