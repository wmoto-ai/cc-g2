export function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    const lowered = key.toLowerCase()
    if (
      lowered.includes('token') ||
      lowered.includes('secret') ||
      lowered.includes('password') ||
      lowered.includes('cookie') ||
      lowered.includes('authorization') ||
      lowered.includes('api_key') ||
      lowered.includes('apikey')
    ) {
      out[key] = '[REDACTED]'
      continue
    }
    if (lowered === 'cwd' || lowered === 'tmuxtarget') {
      out[key] = '[REDACTED]'
      continue
    }
    out[key] = redactValue(raw)
  }
  return out
}

export function persistedNotification(item, { persistRaw }) {
  return {
    ...item,
    raw: persistRaw ? redactValue(item.raw) : undefined,
    metadata: redactValue(item.metadata),
  }
}

export function persistedApproval(record, { persistToolInput }) {
  return {
    ...record,
    toolInput: persistToolInput ? redactValue(record.toolInput) : undefined,
    cwd: record.cwd ? '[REDACTED]' : '',
  }
}

export async function readRequestBody(req, options = {}) {
  const maxBytesRaw = Number(options.maxBytes)
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.floor(maxBytesRaw) : 0
  const chunks = []
  let totalBytes = 0
  for await (const chunk of req) {
    totalBytes += chunk.length
    if (maxBytes > 0 && totalBytes > maxBytes) {
      const err = new Error(`Request body too large (max ${maxBytes} bytes)`)
      err.code = 'BODY_TOO_LARGE'
      err.statusCode = 413
      err.maxBytes = maxBytes
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** readRequestBody の binary-safe 版（utf8 変換せず Buffer のまま返す） */
export async function readRequestBodyBinary(req, options = {}) {
  const maxBytesRaw = Number(options.maxBytes)
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.floor(maxBytesRaw) : 0
  const chunks = []
  let totalBytes = 0
  for await (const chunk of req) {
    totalBytes += chunk.length
    if (maxBytes > 0 && totalBytes > maxBytes) {
      const err = new Error(`Request body too large (max ${maxBytes} bytes)`)
      err.code = 'BODY_TOO_LARGE'
      err.statusCode = 413
      err.maxBytes = maxBytes
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function safeJsonParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function getString(val, defaultVal = '') {
  return typeof val === 'string' ? val.trim() : defaultVal
}

// 注意: src/g2/text-format.ts と scripts/lib/common.sh(derive_session_label) に
// 同一ロジックの実装がある（ビルド境界が異なるため統合不可）。変更時は 3 実装を
// 揃えること。同一性は test/derive-session-label-cross.test.ts が監視している。
// セッション名: g2-<slug>-<hash4>[-codex|-copilot][-N]。末尾 -N を剥がしてから
// hash(+エージェント種別)終端を判定する。エージェント種別はラベルに含めない。
export function deriveSessionLabel(tmuxTarget) {
  const target = getString(tmuxTarget)
  if (!target) return ''
  const session = target.split(':')[0] || ''
  if (!session) return ''
  const numbered = session.match(/-(\d+)$/)
  if (numbered) {
    const prefix = session.slice(0, -numbered[0].length)
    if (/-[0-9a-f]{4}(?:-codex|-copilot)?$/.test(prefix)) return `#${numbered[1]}`
  }
  if (/-[0-9a-f]{4}(?:-codex|-copilot)?$/.test(session)) return '#1'
  return ''
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function getNested(obj, pathParts) {
  let cur = obj
  for (const part of pathParts) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function getFirstNested(obj, candidates) {
  for (const pathParts of candidates) {
    const value = getNested(obj, pathParts)
    if (value !== undefined) return value
  }
  return undefined
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

function makeSummary(text, maxLen = 64) {
  const firstLine = String(text || '').replace(/\s+/g, ' ').trim()
  if (!firstLine) return '（本文なし）'
  return firstLine.length <= maxLen ? firstLine : `${firstLine.slice(0, maxLen - 1)}…`
}

export function normalizeMoshiPayload(payload, { persistRaw = false, createId }) {
  const obj = payload && typeof payload === 'object' ? payload : {}

  const title = pickFirstString(
    getFirstNested(obj, [['title']]),
    getFirstNested(obj, [['notification', 'title']]),
    getFirstNested(obj, [['event', 'title']]),
    getFirstNested(obj, [['message', 'title']]),
    'Moshi notification',
  )

  let fullText = pickFirstString(
    getFirstNested(obj, [['body']]),
    getFirstNested(obj, [['text']]),
    getFirstNested(obj, [['message']]),
    getFirstNested(obj, [['content']]),
    getFirstNested(obj, [['notification', 'body']]),
    getFirstNested(obj, [['event', 'body']]),
    getFirstNested(obj, [['data', 'body']]),
    getFirstNested(obj, [['data', 'text']]),
  )

  if (!fullText) {
    try {
      fullText = JSON.stringify(payload)
    } catch {
      fullText = String(payload ?? '')
    }
  }

  const createdAt = normalizeTimestamp(
    getFirstNested(obj, [['createdAt']]) ??
      getFirstNested(obj, [['timestamp']]) ??
      getFirstNested(obj, [['event', 'timestamp']]) ??
      getFirstNested(obj, [['notification', 'createdAt']]),
  )

  const hookType = pickFirstString(
    getFirstNested(obj, [['hookType']]),
    getFirstNested(obj, [['metadata', 'hookType']]),
  )

  const approvalId = pickFirstString(
    getFirstNested(obj, [['approvalId']]),
    getFirstNested(obj, [['metadata', 'approvalId']]),
  )

  const extId = pickFirstString(
    getFirstNested(obj, [['metadata', 'externalId']]),
    approvalId ? `approval:${approvalId}` : '',
    getFirstNested(obj, [['id']]),
    getFirstNested(obj, [['event', 'id']]),
    getFirstNested(obj, [['notification', 'id']]),
    getFirstNested(obj, [['messageId']]),
    getFirstNested(obj, [['taskId']]),
  )

  const incomingMetadata =
    obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}
  const source = hookType ? 'claude-code' : 'moshi'

  return {
    id: createId(),
    source,
    title,
    summary: makeSummary(fullText),
    fullText,
    createdAt,
    replyCapable: hookType === 'permission-request' || hookType === 'stop' ? true : !hookType,
    raw: persistRaw ? payload : undefined,
    metadata: {
      ...incomingMetadata,
      hookType: hookType || undefined,
      externalId: extId || undefined,
      threadId:
        getFirstNested(obj, [['threadId']]) ??
        getFirstNested(obj, [['event', 'threadId']]) ??
        undefined,
      taskId:
        getFirstNested(obj, [['taskId']]) ?? getFirstNested(obj, [['event', 'taskId']]) ?? undefined,
    },
  }
}
