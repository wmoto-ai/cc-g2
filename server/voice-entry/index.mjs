import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = path.resolve(SCRIPT_DIR, '../..')
const DEFAULT_REPO_ROOT = path.join(process.env.HOME || PROJECT_DIR, 'Repos')
const HOST = process.env.CC_G2_VOICE_ENTRY_BIND || '0.0.0.0'
const PORT = Number(process.env.CC_G2_VOICE_ENTRY_PORT || '8797')
const VOICE_ENTRY_TOKEN = resolveVoiceEntryToken()
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
const VOICE_ENTRY_LOG_FILE =
  process.env.CC_G2_VOICE_ENTRY_LOG_FILE ||
  path.join(PROJECT_DIR, 'tmp/voice-entry/voice-entry.log')
const VOICE_ENTRY_TIMEOUT_MS = Number(
  process.env.CC_G2_VOICE_ENTRY_TIMEOUT_MS || '7000',
)
const VOICE_ENTRY_MAX_CHARS = Number(
  process.env.CC_G2_VOICE_ENTRY_MAX_CHARS || '140',
)
const VOICE_ENTRY_MODE = process.env.CC_G2_VOICE_ENTRY_MODE || 'session-entry'
const VOICE_ENTRY_SELECTOR_TIMEOUT_MS = Number(
  process.env.CC_G2_SELECTOR_TIMEOUT_MS || '25000',
)
const VOICE_ENTRY_SELECTOR_MODEL = process.env.CC_G2_SELECTOR_MODEL || ''
const VOICE_ENTRY_SELECTOR_EFFORT = process.env.CC_G2_SELECTOR_EFFORT || 'low'
const VOICE_ENTRY_LAST_SESSION_FILE =
  process.env.CC_G2_VOICE_ENTRY_LAST_SESSION_FILE ||
  path.join(PROJECT_DIR, 'tmp/voice-entry/last-session.json')
const CC_G2_REPO_ROOTS = parseRepoRoots(process.env.CC_G2_REPO_ROOTS || DEFAULT_REPO_ROOT)
const CC_G2_REPO_SCAN_DEPTH = Number(process.env.CC_G2_REPO_SCAN_DEPTH || '3')
const CC_G2_LAUNCH_SCRIPT =
  process.env.CC_G2_LAUNCH_SCRIPT ||
  path.join(PROJECT_DIR, 'scripts/cc-g2.sh')
const CC_G2_COMMAND_TIMEOUT_MS = Number(process.env.CC_G2_COMMAND_TIMEOUT_MS || '30000')
const CC_G2_INTERNAL_ENV = {
  ...process.env,
  CC_G2_INTERNAL_JSON: '1',
}
const SCAN_EXCLUDE = new Set(['.git', '.claude', 'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__'])
const DIRECTORY_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.claude', 'README.md', 'README.ja.md']
const OUTPUT_INSTRUCTION = [
  'You are answering for a smart-glasses UI with strict latency and very limited display space.',
  'Return plain natural language only.',
  'Never include XML tags such as <function_calls>, <invoke>, or <parameter> in the final answer.',
  'Never include bullets, tables, code blocks, markdown headings, or long preambles.',
  `Keep the final answer within ${VOICE_ENTRY_MAX_CHARS} characters if possible.`,
  'Prefer one short Japanese sentence, or two very short sentences at most.',
  'If a task would require long work, say briefly that it is too long for this UI and ask the user to narrow the request.',
].join(' ')
const DEDUP_WINDOW_MS = 1000
let _lastRequest = { content: '', time: 0, response: null }

ensureParentDir(VOICE_ENTRY_LOG_FILE)
ensureParentDir(VOICE_ENTRY_LAST_SESSION_FILE)

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function resolveVoiceEntryToken() {
  const token = (process.env.CC_G2_VOICE_ENTRY_TOKEN || '').trim()
  if (token && token !== 'replace-me') return token
  throw new Error('CC_G2_VOICE_ENTRY_TOKEN is required for voice-entry startup')
}

function existsDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

function parseRepoRoots(raw) {
  const seen = new Set()
  const roots = String(raw || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
    .filter((entry) => {
      if (!existsDirectory(entry) || seen.has(entry)) return false
      seen.add(entry)
      return true
    })
  return roots.length > 0 ? roots : [DEFAULT_REPO_ROOT]
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function extractContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.input_text === 'string') return part.input_text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'USER: Hello'
  return messages
    .map((message) => {
      const role = typeof message?.role === 'string' ? message.role : 'user'
      const content = extractContent(message?.content)
      return `${role.toUpperCase()}: ${content}`.trim()
    })
    .join('\n\n')
}

function sanitizeClaudeText(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>\s*/g, '')
    .replace(/<function_response>[\s\S]*?<\/function_response>\s*/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\|.*\|/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function truncateForDisplay(text) {
  if (typeof text !== 'string') return ''
  if (text.length <= VOICE_ENTRY_MAX_CHARS) return text
  const clipped = text.slice(0, VOICE_ENTRY_MAX_CHARS)
  const lastBreak = Math.max(
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('、'),
    clipped.lastIndexOf(' '),
    clipped.lastIndexOf('\n'),
  )
  const safe = lastBreak >= VOICE_ENTRY_MAX_CHARS * 0.5 ? clipped.slice(0, lastBreak + 1) : clipped
  return `${safe.trim()}…`
}

function appendLog(entry) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
  fs.appendFileSync(VOICE_ENTRY_LOG_FILE, line, 'utf8')
}

function readLastSession() {
  try {
    return JSON.parse(fs.readFileSync(VOICE_ENTRY_LAST_SESSION_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeLastSession(session) {
  fs.writeFileSync(VOICE_ENTRY_LAST_SESSION_FILE, JSON.stringify(session, null, 2), 'utf8')
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return extractContent(message.content).trim()
  }
  return ''
}

function normalizeVoicePrompt(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return 'こんにちは'
  const normalized = raw
    .replace(/claude\s*code/gi, ' ')
    .replace(/\b(z\s*repos?|zee\s*repos?)\b/gi, ' ')
    .replace(/\b(repos?|repo)\b/gi, ' ')
    .replace(/\b(cc\s*-?\s*g2|cg2|ccg\s*two|c c g 2|g2)\b/gi, ' ')
    .replace(/\b(--codex|codex|code\s*x)\b/gi, ' ')
    .replace(/[&％%]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return normalized || raw
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[/._-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function candidateKind(candidatePath) {
  if (fileExists(path.join(candidatePath, '.git'))) return 'repo'
  if (DIRECTORY_MARKERS.some((marker) => fileExists(path.join(candidatePath, marker)))) return 'workspace'
  return 'dir'
}

function relativeFromRoots(candidatePath) {
  for (const root of CC_G2_REPO_ROOTS) {
    const relative = path.relative(root, candidatePath)
    if (relative === '') return '.'
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative
  }
  return path.basename(candidatePath)
}

function listDirectoryCandidates(rootDir, maxDepth, depth = 0, results = []) {
  let entries = []
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return results
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (SCAN_EXCLUDE.has(entry.name)) continue
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(rootDir, entry.name)
    const kind = candidateKind(fullPath)
    if (depth === 0 || kind !== 'dir') {
      results.push(fullPath)
    }
    if (depth + 1 < maxDepth) {
      listDirectoryCandidates(fullPath, maxDepth, depth + 1, results)
    }
  }

  return results
}

function listLaunchCandidates() {
  const seen = new Set()
  const candidates = []

  for (const rootDir of CC_G2_REPO_ROOTS) {
    const rawCandidates = [rootDir, ...listDirectoryCandidates(rootDir, CC_G2_REPO_SCAN_DEPTH)]
    for (const candidatePath of rawCandidates) {
      if (seen.has(candidatePath)) continue
      seen.add(candidatePath)
      candidates.push({
        path: candidatePath,
        label: path.basename(candidatePath),
        relative: relativeFromRoots(candidatePath),
        kind: candidateKind(candidatePath),
      })
    }
  }

  return candidates
}

function scoreCandidate(rawText, candidate) {
  const normalizedText = normalizeForMatch(rawText)
  const haystack = ` ${normalizedText} `
  const compactText = normalizedText.replace(/\s+/g, '')
  const parts = candidate.relative.split(path.sep).filter(Boolean)
  const normalizedParts = parts.map(normalizeForMatch).filter(Boolean)
  let score = candidate.kind === 'repo' ? 8 : candidate.kind === 'workspace' ? 4 : 0

  for (const part of normalizedParts) {
    if (haystack.includes(` ${part} `)) {
      score += 10 + part.length
      continue
    }
    const compact = part.replace(/\s+/g, '')
    if (compact && compactText.includes(compact)) {
      score += 6 + compact.length
      continue
    }
    for (const token of compact.split(/[-_]+/).filter(Boolean)) {
      if (token.length >= 3 && compactText.includes(token)) {
        score += 8 + token.length
      }
    }
  }

  const base = normalizeForMatch(candidate.label)
  const compactBase = base.replace(/\s+/g, '')
  if (base && haystack.includes(` ${base} `)) score += 20
  if (compactBase && compactText.includes(compactBase)) score += 16
  for (const token of compactBase.split(/[-_]+/).filter(Boolean)) {
    if (token.length >= 3 && compactText.includes(token)) {
      score += 12 + token.length
    }
  }
  return score
}

function looksLikeFollowUp(text) {
  const normalized = normalizeForMatch(text)
  return [
    '続けて',
    'つづけて',
    '続き',
    '続きを',
    '続行',
    'さっきの続き',
    'さっき開いたやつ',
    '前のセッション',
    'もう一回',
    'もう 1 回',
    'もう一度',
    'やり直し',
    'retry',
    'continue',
    'resume',
  ].some((keyword) => normalized.includes(normalizeForMatch(keyword)))
}

function prefersRecentWorkdir(text) {
  const normalized = normalizeForMatch(text)
  return ['ここで', 'このディレクトリで', 'このリポジトリで', 'このフォルダで'].some((keyword) =>
    normalized.includes(normalizeForMatch(keyword)),
  )
}

function resolveDynamicWorkdir(text, candidates, lastSession) {
  if (lastSession?.workdir && prefersRecentWorkdir(text)) {
    return { workdir: lastSession.workdir, score: 50 }
  }

  let best = null
  let bestScore = 0
  for (const candidate of candidates) {
    const score = scoreCandidate(text, candidate)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  if (best && bestScore >= 12) {
    return { workdir: best.path, score: bestScore }
  }
  return { workdir: '', score: 0 }
}

function parseJsonObject(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('empty selector output')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced ? fenced[1].trim() : raw
  return JSON.parse(candidate)
}

function runClaudeText(prompt, options = {}) {
  const args = [
    '-p',
    '--output-format',
    'text',
    '--permission-mode',
    'bypassPermissions',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    '{}',
    '--disable-slash-commands',
    '--no-session-persistence',
  ]

  if (options.model) {
    args.push('--model', options.model)
  }
  if (options.effort) {
    args.push('--effort', options.effort)
  }
  if (options.systemPrompt) {
    args.push('--append-system-prompt', options.systemPrompt)
  }

  args.push(prompt)

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      cwd: PROJECT_DIR,
    })
    const timeoutMs = options.timeoutMs || VOICE_ENTRY_TIMEOUT_MS
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`claude timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function resolveLaunchTarget(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  const lastSession = readLastSession()
  const candidates = listLaunchCandidates()
  const fallback = resolveDynamicWorkdir(raw, candidates, lastSession)
  const normalizedPrompt = normalizeVoicePrompt(raw)
  const fallbackMode = lastSession && looksLikeFollowUp(raw) ? 'continue_latest' : 'start'

  const selectorPrompt = [
    'Choose the best working directory for launching cc-g2 from this spoken request.',
    'You must always choose exactly one candidate path, even if uncertain.',
    'Return JSON only with keys mode, workdir, and prompt.',
    'mode must be either start or continue_latest.',
    'Default mode is start (new session). Only use continue_latest when the user EXPLICITLY asks to continue, resume, or reuse a previous session.',
    'Examples of explicit continuation: 続けて, さっきの続き, さっき開いたやつ, 前のセッション, continue, resume, retry, もう一回.',
    'If the user just mentions the same directory as recent_session but gives a new task, use mode start.',
    'workdir must exactly match one candidate path.',
    'prompt must be the cleaned user intent that should be passed to cc-g2 as the initial prompt.',
    'You should decide both the directory and the prompt.',
    'Prefer the repo or workdir the user most likely meant from the spoken request.',
    'Do not ask follow-up questions here. Do not apologize. Decide.',
    '',
    `spoken_request: ${raw || 'こんにちは'}`,
    `fallback_prompt: ${normalizedPrompt}`,
    `recent_session: ${lastSession ? JSON.stringify(lastSession) : 'none'}`,
    'candidates:',
    ...candidates.map(
      (candidate) =>
        `- ${candidate.path} | relative=${candidate.relative} | label=${candidate.label} | kind=${candidate.kind}`,
    ),
  ].join('\n')

  const selectorSystemPrompt = [
    'You are a router for a voice launcher.',
    'Pick exactly one candidate directory from the provided list.',
    'Do not invent paths.',
    'Return compact JSON only.',
    'Do not wrap JSON in markdown fences.',
  ].join(' ')

  try {
    const selectionText = await runClaudeText(selectorPrompt, {
      model: VOICE_ENTRY_SELECTOR_MODEL || undefined,
      effort: VOICE_ENTRY_SELECTOR_EFFORT || undefined,
      systemPrompt: selectorSystemPrompt,
      timeoutMs: VOICE_ENTRY_SELECTOR_TIMEOUT_MS,
    })
    const selection = parseJsonObject(selectionText)
    const matched = candidates.find((candidate) => candidate.path === selection?.workdir)
    if (matched && typeof selection?.prompt === 'string' && selection.prompt.trim()) {
      return {
        mode: selection?.mode === 'continue_latest' ? 'continue_latest' : 'start',
        workdir: matched.path,
        prompt: selection.prompt.trim(),
        score: 999,
        source: 'claude-selector',
      }
    }
  } catch (error) {
    appendLog({
      type: 'selector_error',
      userText: raw,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (fallback.workdir) {
    return {
      mode: fallbackMode,
      workdir: fallback.workdir,
      prompt: normalizedPrompt,
      score: fallback.score,
      source: 'heuristic-fallback',
    }
  }

  throw new Error('unable to resolve workdir from spoken request')
}

function parseCommandJson(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // keep scanning previous lines
    }
  }
  throw new Error('failed to parse command json')
}

function runCcG2Command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(CC_G2_LAUNCH_SCRIPT, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: CC_G2_INTERNAL_ENV,
      cwd: PROJECT_DIR,
    })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`cc-g2 command timed out after ${CC_G2_COMMAND_TIMEOUT_MS}ms`))
    }, CC_G2_COMMAND_TIMEOUT_MS)

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `cc-g2 exited with code ${code}`))
        return
      }
      try {
        resolve(parseCommandJson(stdout))
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function sessionExists(sessionName) {
  if (!sessionName) return false
  try {
    const result = await runCcG2Command(['has-session', '--session', sessionName])
    return result?.exists === true
  } catch {
    return false
  }
}

async function findSessionForWorkdir(workdir) {
  if (!workdir) return null
  try {
    const result = await runCcG2Command(['find-session', '--workdir', workdir])
    return result?.exists ? result.sessionName : null
  } catch {
    return null
  }
}

function launchCcG2Session(prompt, workdir) {
  return runCcG2Command(['launch-detached', '--workdir', workdir, '--prompt', prompt])
}

function continueCcG2Session(prompt, sessionName) {
  return runCcG2Command(['send', '--session', sessionName, '--text', prompt])
}

function runClaude(prompt) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    '{}',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--append-system-prompt',
    OUTPUT_INSTRUCTION,
    prompt,
  ]

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      cwd: PROJECT_DIR,
    })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`claude timed out after ${VOICE_ENTRY_TIMEOUT_MS}ms`))
    }, VOICE_ENTRY_TIMEOUT_MS)

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (error) {
        reject(new Error(`failed to parse claude json: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  })
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { status: 'ok' })
    return
  }

  const auth = req.headers.authorization || ''
  if (req.method === 'GET' && req.url === '/auth-check') {
    if (auth !== `Bearer ${VOICE_ENTRY_TOKEN}`) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    sendJson(res, 404, { error: 'not_found' })
    return
  }

  if (auth !== `Bearer ${VOICE_ENTRY_TOKEN}`) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  let rawBody = ''

  req.on('data', (chunk) => {
    rawBody += chunk.toString()
    if (rawBody.length > 1024 * 1024) {
      req.destroy(new Error('request body too large'))
    }
  })

  req.on('error', (error) => {
    sendJson(res, 500, {
      error: 'bridge_error',
      message: error instanceof Error ? error.message : String(error),
    })
  })

  req.on('end', async () => {
    let requestModel = 'openclaw'
    try {
      const body = JSON.parse(rawBody || '{}')
      requestModel = body.model || requestModel
      const userText = latestUserText(body.messages)

      const now = Date.now()
      if (userText === _lastRequest.content && now - _lastRequest.time < DEDUP_WINDOW_MS && _lastRequest.response) {
        appendLog({ type: 'dedup_replay', userText, deltaMs: now - _lastRequest.time })
        sendJson(res, 200, _lastRequest.response)
        return
      }
      _lastRequest = { content: userText, time: now, response: null }

      if (VOICE_ENTRY_MODE === 'session-entry') {
        const target = await resolveLaunchTarget(userText)

        // continue_latest: find an existing session for the selector-chosen workdir
        let continueSessionName = null
        if (target.mode === 'continue_latest') {
          continueSessionName = await findSessionForWorkdir(target.workdir)
        }

        let launch
        let canContinue = false
        if (continueSessionName) {
          try {
            launch = await continueCcG2Session(target.prompt, continueSessionName)
            canContinue = true
          } catch (error) {
            appendLog({
              type: 'session_continue_error',
              userText,
              message: error instanceof Error ? error.message : String(error),
              sessionName: continueSessionName,
            })
          }
        }
        if (!launch) {
          launch = await launchCcG2Session(target.prompt, target.workdir)
        }

        const effectiveWorkdir = target.workdir
        const effectiveSessionName = launch.sessionName || continueSessionName || ''
        const content = canContinue
          ? `既存のClaude Codeセッションに続けて依頼しました。作業場所は ${path.basename(effectiveWorkdir)} です。結果はG2通知で返ります。`
          : `新しいClaude Codeセッションを開始しました。作業場所は ${path.basename(effectiveWorkdir)} です。結果はG2通知で返ります。`

        writeLastSession({
          sessionName: effectiveSessionName,
          workdir: effectiveWorkdir,
          prompt: target.prompt,
          updatedAt: new Date().toISOString(),
        })

        appendLog({
          type: canContinue ? 'session_continue' : 'session_launch',
          model: requestModel,
          userText,
          prompt: target.prompt,
          sessionName: effectiveSessionName,
          workdir: effectiveWorkdir,
          workdirScore: target.score,
          workdirSource: target.source,
          mode: target.mode,
          content,
        })

        const responseBody = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requestModel,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
        }
        _lastRequest.response = responseBody
        sendJson(res, 200, responseBody)
        return
      }

      const prompt = buildPrompt(body.messages)
      const claudeResult = await runClaude(prompt)
      const rawResult = typeof claudeResult?.result === 'string' ? claudeResult.result : ''
      const content = truncateForDisplay(sanitizeClaudeText(rawResult))

      appendLog({
        type: 'chat_completion',
        model: requestModel,
        prompt,
        rawResult,
        content,
      })

      const responseBody = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requestModel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      }
      _lastRequest.response = responseBody
      sendJson(res, 200, responseBody)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const content = message.includes('timed out')
        ? '時間がかかりすぎています。短く聞き直してください。'
        : 'うまく返せませんでした。短く聞き直してください。'

      appendLog({ type: 'error', message, content })
      sendJson(res, 200, {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requestModel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`Claude Code voice-entry listening on http://${HOST}:${PORT}`)
})
