import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_TOKEN = 'voice-entry-test-token'
const execFileAsync = promisify(execFile)

function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000)
}

async function waitForHealth(base) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('voice-entry health check timed out')
}

function extractContent(data) {
  return data?.choices?.[0]?.message?.content || ''
}

describe('Voice entry bridge', () => {
  it('fails fast when token is missing or placeholder', async () => {
    await expect(
      execFileAsync('node', ['server/voice-entry/index.mjs'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          CC_G2_VOICE_ENTRY_TOKEN: 'replace-me',
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('CC_G2_VOICE_ENTRY_TOKEN is required'),
    })
  })

  let proc
  let base = ''
  let workspace = ''
  let repoRoot = ''
  let stateDir = ''
  let lastSessionFile = ''

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'voice-entry-test-'))
    repoRoot = path.join(workspace, 'repos')
    stateDir = path.join(workspace, 'state')
    lastSessionFile = path.join(stateDir, 'last-session.json')
    await mkdir(repoRoot, { recursive: true })
    await mkdir(stateDir, { recursive: true })

    for (const name of ['alpha-tool', 'beta-tool', 'even-g2']) {
      const dir = path.join(repoRoot, name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }), 'utf8')
    }

    const ccg2Stub = path.join(workspace, 'cc-g2-stub.sh')
    await writeFile(
      ccg2Stub,
      `#!/bin/sh
set -eu
STATE_DIR=${JSON.stringify(stateDir)}
cmd="$1"
shift || true
case "$cmd" in
  has-session)
    session=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --session) session="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -f "$STATE_DIR/continue-ok" ]; then
      node -e 'console.log(JSON.stringify({ok:true, exists:true, sessionName:process.argv[1]}))' "$session"
    else
      node -e 'console.log(JSON.stringify({ok:true, exists:false, sessionName:process.argv[1]}))' "$session"
    fi
    ;;
  find-session)
    workdir=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --workdir) workdir="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    base=$(basename "$workdir")
    if [ -f "$STATE_DIR/continue-ok" ]; then
      node -e 'console.log(JSON.stringify({ok:true, exists:true, sessionName:process.argv[1]}))' "g2-$base-stub"
    else
      node -e 'console.log(JSON.stringify({ok:true, exists:false}))'
    fi
    ;;
  launch-detached)
    workdir=""
    prompt=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --workdir) workdir="$2"; shift 2 ;;
        --prompt) prompt="$2"; shift 2 ;;
        --codex) shift ;;
        *) shift ;;
      esac
    done
    base=$(basename "$workdir")
    node -e 'console.log(JSON.stringify({ok:true, sessionName:process.argv[1], tmuxTarget:process.argv[2], workdir:process.argv[3], prompt:process.argv[4]}))' "g2-$base-stub" "g2-$base-stub:0.0" "$workdir" "$prompt"
    ;;
  send)
    session=""
    text=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --session) session="$2"; shift 2 ;;
        --text) text="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    node -e 'console.log(JSON.stringify({ok:true, sessionName:process.argv[1], tmuxTarget:process.argv[2], text:process.argv[3]}))' "$session" "$session:0.0" "$text"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
`,
      'utf8',
    )
    await chmod(ccg2Stub, 0o755)

    const claudeStub = path.join(workspace, 'claude-stub.mjs')
    await writeFile(
      claudeStub,
      `const args = process.argv.slice(2)
const prompt = args[args.length - 1] || ''
const textOutput = args.includes('text')
const readRecentSession = () => {
  const line = prompt.split(/\\n/).find((entry) => entry.startsWith('recent_session: '))
  if (!line) return null
  const raw = line.slice('recent_session: '.length)
  if (raw === 'none') return null
  try { return JSON.parse(raw) } catch { return null }
}
const chooseCandidate = (suffix) => {
  const line = prompt.split(/\\n/).find((entry) => entry.includes('/' + suffix) || entry.includes('label=' + suffix))
  if (!line) return ''
  return line.replace(/^-\\s*/, '').split(' | ')[0].trim()
}
if (textOutput) {
  const recent = readRecentSession()
  const spoken = prompt.split(/\\n/).find((l) => l.startsWith('spoken_request: '))?.slice('spoken_request: '.length) || ''
  if (prompt.includes('続けて')) {
    const candidates = ['alpha-tool', 'beta-tool']
    const mentioned = candidates.find((c) => spoken.includes(c))
    const target = mentioned ? chooseCandidate(mentioned) : (recent?.workdir || '')
    process.stdout.write(JSON.stringify({ mode: 'continue_latest', workdir: target, prompt: '続けて' }))
  } else {
    const alpha = chooseCandidate('alpha-tool')
    process.stdout.write(JSON.stringify({ mode: 'start', workdir: alpha, prompt: 'alpha の修正して' }))
  }
  process.exit(0)
}
process.stdout.write(JSON.stringify({ result: 'stubbed response' }))
`,
      'utf8',
    )

    const claudeLauncher = path.join(workspace, 'claude-launcher.sh')
    await writeFile(
      claudeLauncher,
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(claudeStub)} "$@"
`,
      'utf8',
    )
    await chmod(claudeLauncher, 0o755)

    const port = randomPort()
    base = `http://127.0.0.1:${port}`
    proc = spawn('node', ['server/voice-entry/index.mjs'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CC_G2_VOICE_ENTRY_BIND: '127.0.0.1',
        CC_G2_VOICE_ENTRY_PORT: String(port),
        CC_G2_VOICE_ENTRY_TOKEN: TEST_TOKEN,
        CC_G2_VOICE_ENTRY_LAST_SESSION_FILE: lastSessionFile,
        CC_G2_VOICE_ENTRY_LOG_FILE: path.join(stateDir, 'voice-entry.log'),
        CC_G2_REPO_ROOTS: repoRoot,
        CC_G2_REPO_SCAN_DEPTH: '2',
        CC_G2_LAUNCH_SCRIPT: ccg2Stub,
        CLAUDE_BIN: claudeLauncher,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await waitForHealth(base)
  }, 20000)

  afterAll(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (!proc.killed) proc.kill('SIGKILL')
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  })

  it('selects repo from natural language without special-casing even-g2', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: 'alpha tool の修正して' }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(extractContent(data)).toContain('alpha-tool')

    const lastSession = JSON.parse(await readFile(lastSessionFile, 'utf8'))
    expect(lastSession.sessionName).toBe('g2-alpha-tool-stub')
    expect(lastSession.workdir).toContain(path.join('repos', 'alpha-tool'))
  })

  it('continues latest session when follow-up voice request refers to current work', async () => {
    await writeFile(
      lastSessionFile,
      JSON.stringify(
        {
          sessionName: 'g2-beta-tool-stub',
          workdir: path.join(repoRoot, 'beta-tool'),
          prompt: '前回の依頼',
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(path.join(stateDir, 'continue-ok'), '1', 'utf8')

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: 'ここで続けてログ見て' }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(extractContent(data)).toContain('既存のClaude Codeセッションに続けて依頼しました')
    expect(extractContent(data)).toContain('beta-tool')
  })

  it('continues session for selector-chosen workdir even when lastSession differs', async () => {
    // lastSession points to alpha-tool, but user asks to continue in beta-tool
    await writeFile(
      lastSessionFile,
      JSON.stringify(
        {
          sessionName: 'g2-alpha-tool-stub',
          workdir: path.join(repoRoot, 'alpha-tool'),
          prompt: '前回の依頼',
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    )
    await writeFile(path.join(stateDir, 'continue-ok'), '1', 'utf8')

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: 'beta-toolで続けて' }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(extractContent(data)).toContain('既存のClaude Codeセッションに続けて依頼しました')
    expect(extractContent(data)).toContain('beta-tool')
  })

  it('starts new session when continue requested but no session exists for workdir', async () => {
    await writeFile(
      lastSessionFile,
      JSON.stringify(
        {
          sessionName: 'g2-alpha-tool-stub',
          workdir: path.join(repoRoot, 'alpha-tool'),
          prompt: '前回の依頼',
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    )
    // Ensure continue-ok does not exist — find-session will return exists:false
    try { await unlink(path.join(stateDir, 'continue-ok')) } catch {}

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: 'beta-toolで続けてお願い' }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(extractContent(data)).toContain('新しいClaude Codeセッションを開始しました')
  })

  it('deduplicates identical requests sent within the dedup window', async () => {
    const body = JSON.stringify({
      model: 'openclaw',
      messages: [{ role: 'user', content: 'dedup テスト用のユニークテキスト' }],
    })
    const headers = {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
    }

    // First request should succeed normally
    const res1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body,
    })
    expect(res1.status).toBe(200)
    const data1 = await res1.json()
    expect(extractContent(data1)).not.toBe('')

    // Second identical request sent immediately should replay the first response
    const res2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body,
    })
    expect(res2.status).toBe(200)
    const data2 = await res2.json()
    expect(extractContent(data2)).toBe(extractContent(data1))

    // Verify dedup_replay was logged
    const logContent = await readFile(path.join(stateDir, 'voice-entry.log'), 'utf8')
    expect(logContent).toContain('"type":"dedup_replay"')
  })

  it('does not deduplicate when content differs', async () => {
    const headers = {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
    }

    const res1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: 'ユニークリクエストA' }],
      }),
    })
    expect(res1.status).toBe(200)
    const data1 = await res1.json()
    expect(extractContent(data1)).not.toBe('')

    // Different content should NOT be deduped
    const res2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: 'ユニークリクエストB' }],
      }),
    })
    expect(res2.status).toBe(200)
    const data2 = await res2.json()
    expect(extractContent(data2)).not.toBe('')
  })
})
