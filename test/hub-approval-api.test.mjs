import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_HUB_TOKEN = 'test-hub-token'

/** Pick a random high port to avoid collisions with other tests / services. */
function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000)
}

/** POST JSON helper */
async function postJson(base, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-G2-Token': TEST_HUB_TOKEN },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

/** GET JSON helper */
async function getJson(base, pathname) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'X-CC-G2-Token': TEST_HUB_TOKEN },
  })
  return { status: res.status, data: await res.json() }
}

describe('Notification Hub — Approval Broker API', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-test-'))
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

    // Wait for the health endpoint to respond (up to 8 seconds).
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

    // Final check — if health still fails, surface a useful error.
    const check = await fetch(`${hubBase}/api/health`).then((r) => r.json())
    expect(check.ok).toBe(true)
  }, 15000)

  afterAll(async () => {
    if (hubProc && !hubProc.killed) {
      hubProc.kill('SIGTERM')
      // Give it a moment to shut down gracefully.
      await new Promise((r) => setTimeout(r, 300))
      if (!hubProc.killed) hubProc.kill('SIGKILL')
    }
    await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {})
  })

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Create an approval with sensible defaults, returning the 201 response body. */
  async function createTestApproval(overrides = {}) {
    const payload = {
      toolName: 'Bash',
      toolInput: { command: 'echo hello' },
      cwd: '/tmp/test-workspace',
      agentName: 'test-agent',
      title: 'Approve: echo hello',
      body: 'Run echo hello in /tmp/test-workspace',
      ...overrides,
    }
    const { status, data } = await postJson(hubBase, '/api/approvals', payload)
    expect(status).toBe(201)
    expect(data.ok).toBe(true)
    return data
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('POST /api/approvals — creates an approval and linked notification', async () => {
    const created = await createTestApproval()
    expect(created.approvalId).toEqual(expect.any(String))
    expect(created.approval.id).toBe(created.approvalId)
    expect(created.notificationId).toEqual(expect.any(String))

    // The approval should exist and be pending.
    const { status, data } = await getJson(hubBase, `/api/approvals/${created.approvalId}`)
    expect(status).toBe(200)
    expect(data.approval.status).toBe('pending')
  })

  it('POST /api/approvals — rejects missing toolName', async () => {
    const { status, data } = await postJson(hubBase, '/api/approvals', {})
    expect(status).toBe(400)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/toolName/i)
  })

  it('POST /api/notify/moshi — permission-request is not stored in notifications', async () => {
    const payload = {
      hookType: 'permission-request',
      title: 'Approval candidate',
      body: 'need approval',
      threadId: 'permission_test_thread',
      metadata: { hookType: 'permission-request' },
    }

    const first = await postJson(hubBase, '/api/notify/moshi', payload)
    expect(first.status).toBe(201)
    expect(first.data.stored).toBe(false)

    const second = await postJson(hubBase, '/api/notify/moshi', payload)
    expect(second.status).toBe(201)
    expect(second.data.stored).toBe(false)

    // permission-request 通知は notifications 一覧に保存されない
    const listNow = await getJson(hubBase, '/api/notifications?limit=100')
    const nowMatches = listNow.data.items.filter((i) => i.title === 'Approval candidate')
    expect(nowMatches.length).toBe(0)
  })

  it('GET /api/approvals/:id — returns pending approval with correct fields', async () => {
    const created = await createTestApproval({
      toolName: 'Write',
      cwd: '/tmp/xyz',
      agentName: 'field-check-agent',
    })

    const { status, data } = await getJson(hubBase, `/api/approvals/${created.approvalId}`)
    expect(status).toBe(200)
    const a = data.approval
    expect(a.toolName).toBe('Write')
    expect(a.cwd).toBe('/tmp/xyz')
    expect(a.agentName).toBe('field-check-agent')
    expect(a.status).toBe('pending')
    expect(a.id).toBe(created.approvalId)
    expect(a.notificationId).toBe(created.notificationId)
    expect(a.createdAt).toEqual(expect.any(String))
  })

  it('POST /api/approvals/:id/decide — approve with comment', async () => {
    const created = await createTestApproval()

    const { status, data } = await postJson(
      hubBase,
      `/api/approvals/${created.approvalId}/decide`,
      { decision: 'approve', comment: 'Looks good' },
    )
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.approval.status).toBe('decided')
    expect(data.approval.decision).toBe('approve')
    expect(data.approval.comment).toBe('Looks good')
    expect(data.approval.decidedAt).toEqual(expect.any(String))
  })

  it('POST /api/approvals/:id/decide — deny', async () => {
    const created = await createTestApproval()

    const { status, data } = await postJson(
      hubBase,
      `/api/approvals/${created.approvalId}/decide`,
      { decision: 'deny' },
    )
    expect(status).toBe(200)
    expect(data.approval.status).toBe('decided')
    expect(data.approval.decision).toBe('deny')
  })

  it('POST /api/approvals/:id/decide — rejects double decision (409)', async () => {
    const created = await createTestApproval()

    // First decide succeeds.
    const first = await postJson(hubBase, `/api/approvals/${created.approvalId}/decide`, {
      decision: 'approve',
    })
    expect(first.status).toBe(200)

    // Second decide must be 409.
    const second = await postJson(hubBase, `/api/approvals/${created.approvalId}/decide`, {
      decision: 'deny',
    })
    expect(second.status).toBe(409)
    expect(second.data.ok).toBe(false)
    expect(second.data.error).toMatch(/already decided/i)
  })

  it('GET /api/approvals — lists only pending approvals', async () => {
    // Snapshot pending count before we add ours.
    const before = await getJson(hubBase, '/api/approvals')
    const countBefore = before.data.items.length

    // Create two new approvals.
    const a1 = await createTestApproval({ toolName: 'PendingTool1' })
    const a2 = await createTestApproval({ toolName: 'PendingTool2' })

    // Decide a1 so it's no longer pending.
    await postJson(hubBase, `/api/approvals/${a1.approvalId}/decide`, { decision: 'approve' })

    const after = await getJson(hubBase, '/api/approvals')
    expect(after.status).toBe(200)
    // We added 2 and decided 1, so net +1 pending relative to before.
    expect(after.data.items.length).toBe(countBefore + 1)

    const ids = after.data.items.map((i) => i.id)
    expect(ids).not.toContain(a1.approvalId)
    expect(ids).toContain(a2.approvalId)
  })

  it('same-session approvals remain independently pending until individually resolved', async () => {
    const first = await createTestApproval({
      toolName: 'SessionTool1',
      metadata: { sessionId: 'cleanup-session-1' },
    })
    const second = await createTestApproval({
      toolName: 'SessionTool2',
      metadata: { sessionId: 'cleanup-session-1' },
    })

    expect(second.approvalId).toEqual(expect.any(String))

    const firstDetail = await getJson(hubBase, `/api/approvals/${first.approvalId}`)
    const secondDetail = await getJson(hubBase, `/api/approvals/${second.approvalId}`)
    expect(firstDetail.status).toBe(200)
    expect(secondDetail.status).toBe(200)
    expect(firstDetail.data.approval.status).toBe('pending')
    expect(secondDetail.data.approval.status).toBe('pending')

    const pending = await getJson(hubBase, '/api/approvals')
    const pendingIds = pending.data.items.map((item) => item.id)
    expect(pendingIds).toContain(first.approvalId)
    expect(pendingIds).toContain(second.approvalId)
  })

  it('stop notification cleans up same-session pending approvals without approving them', async () => {
    const created = await createTestApproval({
      toolName: 'StopCleanupTool',
      metadata: { sessionId: 'cleanup-session-stop' },
    })

    const stopPayload = {
      hookType: 'stop',
      title: 'Claude Code stopped',
      body: 'Session ended',
      metadata: { hookType: 'stop', sessionId: 'cleanup-session-stop' },
    }
    const stop = await postJson(hubBase, '/api/notify/moshi', stopPayload)
    expect(stop.status).toBe(201)

    const { status, data } = await getJson(hubBase, `/api/approvals/${created.approvalId}`)
    expect(status).toBe(200)
    expect(data.approval.status).toBe('decided')
    expect(data.approval.decision).toBeUndefined()
    expect(data.approval.resolution).toBe('session-ended')
    expect(data.approval.decidedBy).toBe('auto-session-end')
  })

  it('Notification linkage — approval notification appears in /api/notifications', async () => {
    const title = `Link-test-${Date.now()}`
    const created = await createTestApproval({ title })

    const { status, data } = await getJson(hubBase, '/api/notifications?limit=100')
    expect(status).toBe(200)

    const match = data.items.find((n) => n.id === created.notificationId)
    expect(match).toBeDefined()
    expect(match.title).toBe(title)
    expect(match.metadata.approvalId).toBe(created.approvalId)
  })

  it('G2 reply to approval notification resolves approval AND does not short-circuit relay', async () => {
    const created = await createTestApproval({ toolName: 'ReplyRelay' })

    // Simulate G2 replying "approve" to the linked notification
    const { status, data } = await postJson(
      hubBase,
      `/api/notifications/${created.notificationId}/reply`,
      { reply: '承認', action: 'approve', comment: 'LGTM', source: 'g2' },
    )
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    // Reply should go through the normal relay path (not short-circuit)
    // The reply status depends on whether relay is configured, but should not error
    expect(data.reply.status).toMatch(/^(stubbed|forwarded)$/)
    expect(data.reply.resolvedAction).toBe('approve')

    // The linked approval should also be resolved
    const { data: approvalData } = await getJson(hubBase, `/api/approvals/${created.approvalId}`)
    expect(approvalData.approval.status).toBe('decided')
    expect(approvalData.approval.decision).toBe('approve')
    expect(approvalData.approval.comment).toBe('LGTM')
  })

  it('POST /api/notifications/:id/reply — rejects unauthenticated requests when token is enabled', async () => {
    const created = await createTestApproval({ toolName: 'ReplyAuth' })
    const res = await fetch(`${hubBase}/api/notifications/${created.notificationId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', source: 'g2' }),
    })
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/Unauthorized/i)
  })

  it('GET /ui — requires bootstrap token when hub auth is enabled', async () => {
    const denied = await fetch(`${hubBase}/ui`)
    expect(denied.status).toBe(401)

    const login = await fetch(`${hubBase}/ui?token=${TEST_HUB_TOKEN}`, {
      redirect: 'manual',
    })
    expect(login.status).toBe(302)
    const cookie = login.headers.get('set-cookie')
    expect(cookie).toContain('cc_g2_ui_session=')

    const res = await fetch(`${hubBase}/ui`, {
      headers: { cookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const body = await res.text()
    expect(body).toContain('Approval Dashboard')
    expect(body).toContain('/api/approvals')
    expect(body).not.toContain(TEST_HUB_TOKEN)
  })

  it('stale second reply on same approval notification does not flip decision', async () => {
    const created = await createTestApproval({ toolName: 'NoStaleRelay' })

    const first = await postJson(
      hubBase,
      `/api/notifications/${created.notificationId}/reply`,
      { action: 'approve', source: 'g2' },
    )
    expect(first.status).toBe(200)
    expect(first.data.reply.resolvedAction).toBe('approve')

    const second = await postJson(
      hubBase,
      `/api/notifications/${created.notificationId}/reply`,
      { action: 'deny', source: 'g2' },
    )
    expect(second.status).toBe(200)
    expect(second.data.reply.resolvedAction).toBeUndefined()
    expect(second.data.reply.result).toBe('ignored')
    expect(second.data.reply.ignoredReason).toBe('approval-not-pending')

    const { data: approvalData } = await getJson(hubBase, `/api/approvals/${created.approvalId}`)
    expect(approvalData.approval.status).toBe('decided')
    expect(approvalData.approval.decision).toBe('approve')
  })
})
