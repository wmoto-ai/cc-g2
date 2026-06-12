// 環境変数の解釈と設定定数。可変状態は持たない（store.mjs 参照）。
import path from 'node:path'

function parseBoolEnv(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').toLowerCase())
}

function parseIntEnv(name, fallback, min = -Infinity) {
  return Math.max(min, Number.parseInt(process.env[name] || String(fallback), 10) || fallback)
}

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
const hubPersistRaw = parseBoolEnv('HUB_PERSIST_RAW')
const hubPersistToolInput = parseBoolEnv('HUB_PERSIST_TOOL_INPUT')
const groqApiKey = String(process.env.GROQ_API_KEY || '').trim()
const groqModelDefault = String(process.env.GROQ_MODEL || 'whisper-large-v3').trim()
const openaiApiKey = String(process.env.OPENAI_API_KEY || '').trim()
const sonioxApiKey = String(process.env.SONIOX_API_KEY || '').trim()
const notificationsFile = path.join(dataDir, 'notifications.jsonl')
const repliesFile = path.join(dataDir, 'replies.jsonl')
const clientEventsFile = path.join(dataDir, 'client-events.jsonl')
const hubReplyRelayCmd = String(process.env.HUB_REPLY_RELAY_CMD || '').trim()
const hubReplyRelayTimeoutMs = parseIntEnv('HUB_REPLY_RELAY_TIMEOUT_MS', 15000, 1000)
const hubReplyRelaySources = new Set(
  String(process.env.HUB_REPLY_RELAY_SOURCES || 'g2,web')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
const hubPermissionThreadDedupMs = parseIntEnv('HUB_PERMISSION_THREAD_DEDUP_MS', 8000, 0)
const hubMaxBodyBytes = parseIntEnv('HUB_MAX_BODY_BYTES', 1048576, 1024)
const hubMaxSttBodyBytes = Math.max(hubMaxBodyBytes, parseIntEnv('HUB_MAX_STT_BODY_BYTES', 12582912))
const hubMaxImageBytes = parseIntEnv('HUB_MAX_IMAGE_BYTES', 10485760, 1024)
const hubMaxImages = parseIntEnv('HUB_MAX_IMAGES', 20, 1)
const imagesDir = path.join(dataDir, 'images')
const approvalsFile = path.join(dataDir, 'approvals.jsonl')
const UI_SESSION_COOKIE = 'cc_g2_ui_session'
const UI_SESSION_MAX_AGE_SEC = 60 * 60 * 12

export {
  host,
  port,
  dataDir,
  hubAuthToken,
  hubAllowedOrigins,
  hubPersistRaw,
  hubPersistToolInput,
  groqApiKey,
  groqModelDefault,
  openaiApiKey,
  sonioxApiKey,
  notificationsFile,
  repliesFile,
  clientEventsFile,
  hubReplyRelayCmd,
  hubReplyRelayTimeoutMs,
  hubReplyRelaySources,
  hubPermissionThreadDedupMs,
  hubMaxBodyBytes,
  hubMaxSttBodyBytes,
  hubMaxImageBytes,
  hubMaxImages,
  imagesDir,
  approvalsFile,
  UI_SESSION_COOKIE,
  UI_SESSION_MAX_AGE_SEC,
}
