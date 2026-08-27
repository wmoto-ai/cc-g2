// Claude Code / codex の PermissionRequest HTTP hook。
// 承認が decide されるまでロングポーリングし、hook 応答として返す。
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  deriveSessionLabel,
  getString,
  readRequestBody,
  safeJsonParse,
} from './notification-utils.mjs'
import { hubApprovalMode, hubAuthToken, hubMaxBodyBytes, port } from './config.mjs'
import { store, log } from './store.mjs'
import { sendJson, sendRequestBodyTooLarge, isBodyTooLargeError } from './http-util.mjs'
import { createApproval, markApprovalCleanup, resolveApproval } from './approvals.mjs'

const { approvals, approvalsById, notificationsById } = store

const HOOK_POLL_TIMEOUT_MS = 600_000
const HOOK_POLL_INTERVAL_MS = 2_000

function buildToolPreview(toolName, toolInput) {
  if (toolName === 'Bash') {
    return toolInput?.command || ''
  } else if (toolName === 'apply_patch') {
    return buildApplyPatchPreview(toolInput)
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

function buildApplyPatchPreview(toolInput) {
  const patch = getApplyPatchRawString(toolInput)
  if (patch === null) return JSON.stringify(toolInput || {}).slice(0, 2000)

  const fileLines = []
  const seen = new Set()
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (match) {
      const label = match[1] === 'Add' ? 'add' : match[1] === 'Update' ? 'edit' : 'delete'
      const key = `${label}:${match[2]}`
      if (!seen.has(key)) {
        seen.add(key)
        fileLines.push(`- ${label} ${match[2]}`)
      }
    }
  }

  const patchLines = patch
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 80)
    .map((line) => (line.length > 160 ? `${line.slice(0, 159)}…` : line))
    .join('\n')

  const summary = fileLines.length > 0
    ? ['Files:', ...fileLines.slice(0, 12), ''].join('\n')
    : ''
  const truncated = patch.split(/\r?\n/).length > 80 ? '\n…' : ''
  return `${summary}${patchLines}${truncated}`.slice(0, 4000)
}

function getApplyPatchRawString(toolInput) {
  for (const key of ['command', 'input', 'patch']) {
    const value = toolInput?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function buildApprovalUiUrl() {
  const base = `http://127.0.0.1:${port}/ui`
  return hubAuthToken ? `${base}?token=${encodeURIComponent(hubAuthToken)}` : base
}

function spawnLocalNotification(toolName) {
  try {
    const approvalUrl = buildApprovalUiUrl()
    const child = spawn('terminal-notifier', [
      '-title', 'Permission',
      '-message', `${toolName} approval pending`,
      '-open', approvalUrl,
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
  // ターゲットは pane 固有 ID（%N）でセッション名を含まないため、ラベル用に別ヘッダーで受ける
  const tmuxSession = req.headers['x-tmux-session'] || ''
  const toolName = getString(p.tool_name)
  const toolInput = p.tool_input || {}
  const cwd = getString(p.cwd)
  const sessionId = getString(p.session_id)
  const rawAgentSource = getString(req.headers['x-agent-source'])
  const agentSource =
    rawAgentSource === 'codex' ? 'codex'
    : rawAgentSource === 'copilot' ? 'copilot'
    : 'claude-code'
  const approvalSource =
    agentSource === 'codex' ? 'codex-hook'
    : agentSource === 'copilot' ? 'copilot-hook'
    : 'claude-code-hook'

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

  // approvalMode: この承認が hook をブロックするか否かをメタデータに刻む。
  //   nonblocking: 即 {} を返してダイアログを CLI に任せる detach 済み承認
  //     → ローカル決着（PostToolUse）や Stop 掃除で安全に解決してよい。
  //   longpoll: hook 応答を待たせている進行中承認（従来モード、または nonblocking 時の
  //     AskUserQuestion）→ Stop 掃除では誤って閉じないよう保護対象にする。
  const approvalMode =
    hubApprovalMode === 'nonblocking' && !isAskQ ? 'nonblocking' : 'longpoll'

  const { approval } = await createApproval({
    source: approvalSource,
    toolName,
    toolInput,
    toolId: '',
    cwd,
    agentName: agentSource,
    title,
    body: preview,
    threadId,
    metadata: {
      ...extraMeta,
      tmuxTarget,
      sessionLabel: deriveSessionLabel(tmuxSession || tmuxTarget),
      sessionId,
      agentName: agentSource,
      approvalMode,
    },
  })

  spawnLocalNotification(toolName)

  // ノンブロッキングモード: hook を待たせず即 {} を返し、CLI のローカルダイアログを出す。
  // 承認レコードは pending のまま残し、後から decide 時に reply-relay でキー注入する
  // （approvals.mjs resolveApproval → relayApprovalInjection）。
  // 例外: AskUserQuestion（選択肢ダイアログ）は注入対象外なので従来のロングポールを維持する。
  // longpoll モードでは以降の既存コードがそのまま動く（挙動不変）。
  if (hubApprovalMode === 'nonblocking' && !isAskQ) {
    return sendJson(res, 200, {})
  }

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

// PermissionRequest 側にのみ付く付帯キー（実行時の tool_input には無い）。
// 突合前に両側から除外して主要キーだけで比較する。
const TOOL_INPUT_NOISE_KEYS = new Set(['description'])

function stripToolInputNoise(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (TOOL_INPUT_NOISE_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

// キー順に依存しない安定した JSON 文字列化（tool_input 突合用）。
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// 承認レコードの tool_input と実行時の tool_input が同一操作かを判定する。
// Bash は command 文字列一致で確実に判定し、他ツールは付帯キーを除いた正規化比較。
// toolName は大文字小文字を無視する（claude/codex は "Bash"、copilot は "bash"）。
function toolInputMatches(approvalInput, executedInput, toolName) {
  const a = approvalInput && typeof approvalInput === 'object' ? approvalInput : {}
  const e = executedInput && typeof executedInput === 'object' ? executedInput : {}
  if (String(toolName).toLowerCase() === 'bash') {
    return typeof e.command === 'string' && a.command === e.command
  }
  return stableStringify(stripToolInputNoise(a)) === stableStringify(stripToolInputNoise(e))
}

// 同一 sessionId・toolName・tool_input を持つ最も古い pending 承認を返す。
// sessionId は承認レコードに紐づく通知の metadata から引く（hook 由来のみ持つ）。
function findPendingForExecution(sessionId, toolName, toolInput) {
  for (const a of approvals) {
    if (a.status !== 'pending') continue
    if (a.toolName !== toolName) continue
    const notif = notificationsById.get(a.notificationId)
    if (!notif || notif.metadata?.sessionId !== sessionId) continue
    if (!toolInputMatches(a.toolInput, toolInput, toolName)) continue
    return a
  }
  return null
}

// PostToolUse hook（claude / codex / copilot）。「ツールが実行された = ローカルで承認された」
// の確実なシグナル。該当 sessionId の pending 承認を approve として解決するが、
// 既にダイアログは存在しないためキー注入は行わない（skipInject）。
// 一致が無ければ 200 no-op（承認不要ツールでも毎回発火するため通常ケース）。
async function handleToolExecutedHook(req, res) {
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
  // snake_case（claude / codex）と camelCase（copilot）の双方を受ける
  const sessionId = getString(p.session_id) || getString(p.sessionId)
  const toolName = getString(p.tool_name) || getString(p.toolName)
  const rawToolInput =
    p.tool_input && typeof p.tool_input === 'object' ? p.tool_input
    : p.toolInput && typeof p.toolInput === 'object' ? p.toolInput
    : {}

  if (!sessionId || !toolName) {
    return sendJson(res, 200, { ok: true, matched: false })
  }

  const match = findPendingForExecution(sessionId, toolName, rawToolInput)
  if (!match) {
    return sendJson(res, 200, { ok: true, matched: false })
  }

  resolveApproval(match.id, 'approve', undefined, 'local:executed', { skipInject: true })
  log(`approval resolved by local execution id=${match.id} session=${sessionId} tool=${toolName}`)
  return sendJson(res, 200, { ok: true, matched: true, approvalId: match.id })
}

export { handlePermissionRequestHook, handleToolExecutedHook }
