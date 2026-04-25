import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_HUB_TOKEN = 'test-hub-token'

function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000)
}

async function postJson(base, pathname, body, headers = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-G2-Token': TEST_HUB_TOKEN, ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

async function getJson(base, pathname) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'X-CC-G2-Token': TEST_HUB_TOKEN },
  })
  return { status: res.status, data: await res.json() }
}

async function waitForApproval(base, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await getJson(base, '/api/approvals')
    const match = data.items.find(predicate)
    if (match) return match
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out waiting for approval')
}

async function waitForNotification(base, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await getJson(base, '/api/notifications?limit=100')
    const match = data.items.find(predicate)
    if (match) return match
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out waiting for notification')
}

async function waitForProcessExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await Promise.race([
    new Promise((resolve) => {
      proc.once('exit', resolve)
      proc.once('close', resolve)
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

async function terminateProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill('SIGTERM')
  await waitForProcessExit(proc, 300)
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL')
    await waitForProcessExit(proc, 1000)
  }
}

describe('Codex Hook Bridge Integration', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-codex-test-'))
    const port = randomPort()
    hubBase = `http://127.0.0.1:${port}`

    hubProc = spawn('node', ['server/notification-hub/index.mjs'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HUB_PORT: String(port),
        HUB_BIND: '127.0.0.1',
        HUB_DATA_DIR: tmpDataDir,
        HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
        HUB_PERMISSION_THREAD_DEDUP_MS: '200',
        NTFY_BASE_URL: '',
        HUB_REPLY_RELAY_CMD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${hubBase}/api/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) break
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 150))
    }

    const check = await fetch(`${hubBase}/api/health`).then((r) => r.json())
    expect(check.ok).toBe(true)
  }, 15000)

  afterAll(async () => {
    await terminateProcess(hubProc)
    await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('X-Agent-Source: codex ヘッダーで agentName が codex になる', async () => {
    const hookPromise = postJson(
      hubBase,
      '/api/hooks/permission-request',
      {
        session_id: 'codex-test-1',
        cwd: '/tmp/codex-project',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello from codex' },
      },
      { 'X-Agent-Source': 'codex' },
    )

    const pending = await waitForApproval(
      hubBase,
      (a) => a.cwd === '/tmp/codex-project' && a.status === 'pending',
    )
    expect(pending.agentName).toBe('codex')
    expect(pending.source).toBe('codex-hook')

    // 通知メタデータも確認
    const { data: notifDetail } = await getJson(hubBase, `/api/notifications/${pending.notificationId}`)
    expect(notifDetail.item.metadata.agentName).toBe('codex')

    // Approve to unblock
    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve', source: 'g2' })
    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('X-Agent-Source なしの場合は従来通り claude-code になる', async () => {
    const hookPromise = postJson(
      hubBase,
      '/api/hooks/permission-request',
      {
        session_id: 'claude-test-1',
        cwd: '/tmp/claude-project',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello from claude' },
      },
    )

    const pending = await waitForApproval(
      hubBase,
      (a) => a.cwd === '/tmp/claude-project' && a.status === 'pending',
    )
    expect(pending.agentName).toBe('claude-code')
    expect(pending.source).toBe('claude-code-hook')

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve' })
    await hookPromise
  })

  it('ブリッジスクリプトが Codex stdin を Hub にPOSTして approve を変換する', async () => {
    const codexInput = JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'mkdir -p /tmp/codex-hook-test' },
    })

    // ブリッジスクリプトをバックグラウンドで実行
    const bridgePromise = new Promise((resolve, reject) => {
      const proc = spawn('bash', ['scripts/codex-hook-bridge.sh'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HUB_URL: hubBase,
          HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
          CC_G2_TMUX_TARGET: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => { stdout += d })
      proc.stderr.on('data', (d) => { stderr += d })
      proc.stdin.write(codexInput)
      proc.stdin.end()
      proc.on('close', (code) => resolve({ code, stdout, stderr }))
      proc.on('error', reject)
    })

    // pending approval を見つけて approve
    const pending = await waitForApproval(
      hubBase,
      (a) => a.status === 'pending' && a.agentName === 'codex' && a.toolInput?.command === 'mkdir -p /tmp/codex-hook-test',
    )
    expect(pending.toolName).toBe('Bash')

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve', source: 'g2' })

    const result = await bridgePromise
    expect(result.code).toBe(0)

    const output = JSON.parse(result.stdout.trim())
    expect(output.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(output.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('ブリッジスクリプトが deny を Codex PermissionRequest decision に変換する', async () => {
    const codexInput = JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    })

    const bridgePromise = new Promise((resolve, reject) => {
      const proc = spawn('bash', ['scripts/codex-hook-bridge.sh'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HUB_URL: hubBase,
          HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
          CC_G2_TMUX_TARGET: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => { stdout += d })
      proc.stderr.on('data', (d) => { stderr += d })
      proc.stdin.write(codexInput)
      proc.stdin.end()
      proc.on('close', (code) => resolve({ code, stdout, stderr }))
      proc.on('error', reject)
    })

    const pending = await waitForApproval(
      hubBase,
      (a) => a.status === 'pending' && a.agentName === 'codex' && a.toolInput?.command === 'rm -rf /',
    )

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'deny',
      comment: 'Dangerous command!',
      source: 'g2',
    })

    const result = await bridgePromise
    expect(result.code).toBe(0)
    expect(result.stderr.trim()).toBe('')

    const output = JSON.parse(result.stdout.trim())
    expect(output.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(output.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(output.hookSpecificOutput.decision.message).toBe('G2: Dangerous command!')
  })

  it('ブリッジスクリプトが Hub 未接続時にフォールスルーする', async () => {
    const codexInput = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'mkdir -p /tmp/codex-nohub-test' },
    })

    const result = await new Promise((resolve, reject) => {
      const proc = spawn('bash', ['scripts/codex-hook-bridge.sh'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HUB_URL: 'http://127.0.0.1:19999',
          HUB_AUTH_TOKEN: '',
          CC_G2_TMUX_TARGET: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => { stdout += d })
      proc.stderr.on('data', (d) => { stderr += d })
      proc.stdin.write(codexInput)
      proc.stdin.end()
      proc.on('close', (code) => resolve({ code, stdout, stderr }))
      proc.on('error', reject)
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('Hub に接続できません')
  })

  it('ブリッジスクリプトは PermissionRequest 入力をローカル判定で間引かない', async () => {
    const codexInput = JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' },
    })

    const bridgePromise = new Promise((resolve, reject) => {
      const proc = spawn('bash', ['scripts/codex-hook-bridge.sh'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HUB_URL: hubBase,
          HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
          CC_G2_TMUX_TARGET: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => { stdout += d })
      proc.stderr.on('data', (d) => { stderr += d })
      proc.stdin.write(codexInput)
      proc.stdin.end()
      proc.on('close', (code) => resolve({ code, stdout, stderr }))
      proc.on('error', reject)
    })

    const pending = await waitForApproval(
      hubBase,
      (a) => a.status === 'pending' && a.agentName === 'codex' && a.toolInput?.command === 'ls -la /tmp',
    )

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve', source: 'g2' })

    const result = await bridgePromise
    expect(result.code).toBe(0)
    expect(result.stderr.trim()).toBe('')

    const output = JSON.parse(result.stdout.trim())
    expect(output.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('Codex Stop hook が完了通知を Hub に送る', async () => {
    const stopInput = JSON.stringify({
      session_id: 'codex-stop-1',
      cwd: '/tmp/codex-stop-project',
      stop_reason: 'finished',
      last_assistant_message: '作業が完了しました。次はレビューできます。',
    })

    const result = await new Promise((resolve, reject) => {
      const proc = spawn('bash', ['scripts/codex-stop-notify.sh'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HUB_URL: hubBase,
          HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
          CC_G2_TMUX_TARGET: 'cc-g2-codex:0.0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d) => { stdout += d })
      proc.stderr.on('data', (d) => { stderr += d })
      proc.stdin.write(stopInput)
      proc.stdin.end()
      proc.on('close', (code) => resolve({ code, stdout, stderr }))
      proc.on('error', reject)
    })

    expect(result.code).toBe(0)

    const match = await waitForNotification(
      hubBase,
      (item) => item.metadata?.agentName === 'codex' && item.metadata?.sessionId === 'codex-stop-1',
    )
    expect(match.title).toContain('完了: codex-stop-project')
    expect(match.metadata.tmuxTarget).toBe('cc-g2-codex:0.0')
    expect(match.metadata.hookType).toBe('stop')

    const { data: detailData } = await getJson(hubBase, `/api/notifications/${match.id}`)
    expect(detailData.item.fullText).toContain('作業が完了しました。次はレビューできます。')
  })
})
