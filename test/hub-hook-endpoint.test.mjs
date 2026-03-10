import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
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

describe('Notification Hub — Permission Request HTTP Hook Endpoint', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-hook-test-'))
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
    if (hubProc && !hubProc.killed) {
      hubProc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (!hubProc.killed) hubProc.kill('SIGKILL')
    }
    await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('POST /api/hooks/permission-request — creates approval and notification', async () => {
    const hookBody = {
      session_id: 'test-session-1',
      cwd: '/tmp/test-project',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      permission_mode: 'default',
    }

    // Send hook request (will longpoll), but we'll approve it quickly
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', hookBody, {
      'X-Tmux-Target': 'cc-g2-test:0.0',
    })

    // Wait a bit then find and approve the pending approval
    await new Promise((r) => setTimeout(r, 500))

    const { data: pendingData } = await getJson(hubBase, '/api/approvals')
    expect(pendingData.items.length).toBeGreaterThanOrEqual(1)
    const pending = pendingData.items.find((a) => a.toolName === 'Bash')
    expect(pending).toBeDefined()

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'approve',
      source: 'g2',
    })

    const hookResult = await hookPromise
    expect(hookResult.status).toBe(200)
    expect(hookResult.data.hookSpecificOutput).toBeDefined()
    expect(hookResult.data.hookSpecificOutput.hookEventName).toBe('PermissionRequest')
    expect(hookResult.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('POST /api/hooks/permission-request — deny returns deny decision', async () => {
    const hookBody = {
      session_id: 'test-session-deny',
      cwd: '/tmp/deny-project',
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd', content: 'bad' },
    }

    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', hookBody)

    await new Promise((r) => setTimeout(r, 500))

    const { data: pendingData } = await getJson(hubBase, '/api/approvals')
    const pending = pendingData.items.find((a) => a.toolName === 'Write')
    expect(pending).toBeDefined()

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'deny',
      comment: 'Dangerous file',
      source: 'g2',
    })

    const hookResult = await hookPromise
    expect(hookResult.status).toBe(200)
    expect(hookResult.data.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(hookResult.data.hookSpecificOutput.decision.message).toBe('G2: Dangerous file')
  })

  it('POST /api/hooks/permission-request — deny without comment uses default message', async () => {
    const hookBody = {
      session_id: 'test-session-deny-nocomment',
      cwd: '/tmp/deny2',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    }

    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', hookBody)
    await new Promise((r) => setTimeout(r, 500))

    const { data: pendingData } = await getJson(hubBase, '/api/approvals')
    const pending = pendingData.items.find((a) =>
      a.toolName === 'Bash' && a.status === 'pending' && a.cwd === '/tmp/deny2',
    )
    expect(pending).toBeDefined()

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'deny',
      source: 'g2',
    })

    const hookResult = await hookPromise
    expect(hookResult.status).toBe(200)
    expect(hookResult.data.hookSpecificOutput.decision.message).toBe('G2から拒否されました')
  })

  it('POST /api/hooks/permission-request — tmuxTarget is stored in approval metadata', async () => {
    const hookBody = {
      session_id: 'tmux-test',
      cwd: '/tmp/tmux-project',
      tool_name: 'Edit',
      tool_input: { file_path: 'test.js', old_string: 'foo', new_string: 'bar' },
    }

    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', hookBody, {
      'X-Tmux-Target': 'cc-g2-myproject:0.0',
    })

    await new Promise((r) => setTimeout(r, 500))

    // Check that the notification has tmuxTarget in metadata
    const { data: notifs } = await getJson(hubBase, '/api/notifications?limit=100')
    const match = notifs.items.find((n) =>
      n.title === 'Edit' && n.metadata?.tmuxTarget === 'cc-g2-myproject:0.0',
    )
    expect(match).toBeDefined()

    // Approve to unblock the longpoll
    const { data: pendingData } = await getJson(hubBase, '/api/approvals')
    const pending = pendingData.items.find((a) => a.toolName === 'Edit' && a.cwd === '/tmp/tmux-project')
    if (pending) {
      await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve' })
    }
    await hookPromise
  })

  it('POST /api/hooks/permission-request — superseded cleanup returns empty response, not allow', async () => {
    const firstHookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'supersede-session',
      cwd: '/tmp/supersede-project',
      tool_name: 'Bash',
      tool_input: { command: 'echo first' },
    })

    await new Promise((r) => setTimeout(r, 400))

    const secondHookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'supersede-session',
      cwd: '/tmp/supersede-project',
      tool_name: 'Bash',
      tool_input: { command: 'echo second' },
    })

    const firstResult = await firstHookPromise
    expect(firstResult.status).toBe(200)
    expect(firstResult.data).toEqual({})

    const { data: pendingData } = await getJson(hubBase, '/api/approvals')
    const pending = pendingData.items.find((a) => a.cwd === '/tmp/supersede-project' && a.status === 'pending')
    expect(pending).toBeDefined()
    expect(pending.resolution).toBeUndefined()

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve', source: 'g2' })
    const secondResult = await secondHookPromise
    expect(secondResult.status).toBe(200)
    expect(secondResult.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('POST /api/hooks/permission-request — terminal disconnect is recorded as cleanup', async () => {
    const body = JSON.stringify({
      session_id: 'disconnect-session',
      cwd: '/tmp/disconnect-project',
      tool_name: 'Bash',
      tool_input: { command: 'echo disconnect' },
    })
    const url = new URL('/api/hooks/permission-request', hubBase)
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-CC-G2-Token': TEST_HUB_TOKEN,
      },
    })
    req.on('error', () => {})
    req.write(body)
    req.end()

    await new Promise((r) => setTimeout(r, 500))

    const { data: pendingData } = await getJson(hubBase, '/api/approvals')
    const pending = pendingData.items.find((a) => a.cwd === '/tmp/disconnect-project' && a.status === 'pending')
    expect(pending).toBeDefined()

    req.destroy()
    await new Promise((r) => setTimeout(r, 2200))

    const { data: approvalData } = await getJson(hubBase, `/api/approvals/${pending.id}`)
    expect(approvalData.approval.status).toBe('decided')
    expect(approvalData.approval.decision).toBeUndefined()
    expect(approvalData.approval.resolution).toBe('terminal-disconnect')
    expect(approvalData.approval.decidedBy).toBe('terminal')
  })

  it('POST /api/client-events — rejects oversized payloads with 413', async () => {
    const hugeMessage = 'x'.repeat(1024 * 1024 + 128)
    const res = await fetch(`${hubBase}/api/client-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'test', message: hugeMessage }),
    })
    const data = await res.json()
    expect(res.status).toBe(413)
    expect(data.ok).toBe(false)
    expect(data.error).toContain('Request body too large')
  })

  it('POST /api/hooks/permission-request — Edit preview format', async () => {
    const hookBody = {
      session_id: 'preview-test',
      cwd: '/tmp/preview',
      tool_name: 'Edit',
      tool_input: { file_path: '/src/app.ts', old_string: 'const x = 1', new_string: 'const x = 2' },
    }

    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', hookBody)
    await new Promise((r) => setTimeout(r, 500))

    const { data: notifs } = await getJson(hubBase, '/api/notifications?limit=100')
    const match = notifs.items.find((n) => n.title === 'Edit')
    expect(match).toBeDefined()

    // Get full notification to check body
    const { data: detail } = await getJson(hubBase, `/api/notifications/${match.id}`)
    expect(detail.item.fullText).toContain('/src/app.ts')
    expect(detail.item.fullText).toContain('const x = 1')
    expect(detail.item.fullText).toContain('const x = 2')

    // Clean up
    const { data: pendingData } = await getJson(hubBase, '/api/approvals')
    const pending = pendingData.items.find((a) => a.toolName === 'Edit' && a.cwd === '/tmp/preview')
    if (pending) {
      await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve' })
    }
    await hookPromise
  })

  it('POST /api/hooks/permission-request — notification is created alongside approval', async () => {
    const hookBody = {
      session_id: 'notif-check',
      cwd: '/tmp/notif-test',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    }

    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', hookBody)
    await new Promise((r) => setTimeout(r, 500))

    const { data: healthBefore } = await getJson(hubBase, '/api/health')
    expect(healthBefore.pendingApprovals).toBeGreaterThanOrEqual(1)

    // Approve and verify
    const { data: pendingData } = await getJson(hubBase, '/api/approvals')
    const pending = pendingData.items.find((a) => a.toolName === 'Bash' && a.cwd === '/tmp/notif-test')
    expect(pending).toBeDefined()
    expect(pending.notificationId).toEqual(expect.any(String))

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve' })
    await hookPromise
  })

  it('POST /api/hooks/permission-request — invalid JSON returns 400', async () => {
    const res = await fetch(`${hubBase}/api/hooks/permission-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-G2-Token': TEST_HUB_TOKEN,
      },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})
