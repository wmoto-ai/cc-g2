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

async function postJson(base, pathname, body, { auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) headers['X-CC-G2-Token'] = TEST_HUB_TOKEN
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

async function getJson(base, pathname, { auth = false } = {}) {
  const headers = {}
  if (auth) headers['X-CC-G2-Token'] = TEST_HUB_TOKEN
  const res = await fetch(`${base}${pathname}`, { headers })
  return { status: res.status, data: await res.json() }
}

describe('Notification Hub — Location API', () => {
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-loc-test-'))
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
      await new Promise((r) => setTimeout(r, 500))
    }
    await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('GET /api/location returns null initially (requires auth)', async () => {
    const { status, data } = await getJson(hubBase, '/api/location', { auth: true })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.location).toBeNull()
  })

  it('GET /api/location without auth returns 401', async () => {
    const { status } = await getJson(hubBase, '/api/location', { auth: false })
    expect(status).toBe(401)
  })

  it('POST /api/location stores Overland payload (no auth required)', async () => {
    const payload = {
      locations: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.7671, 35.6812, 15.3] },
        properties: { timestamp: '2026-03-20T10:00:00Z', speed: 1.2, battery_level: 0.85 },
      }],
    }
    const { status, data } = await postJson(hubBase, '/api/location', payload)
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
  })

  it('GET /api/location returns stored location', async () => {
    const { status, data } = await getJson(hubBase, '/api/location', { auth: true })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.location.lat).toBe(35.6812)
    expect(data.location.lng).toBe(139.7671)
    expect(data.location.altitude).toBe(15.3)
    expect(data.location.speed).toBe(1.2)
    expect(data.location.battery).toBe(0.85)
    expect(data.location.timestamp).toBe('2026-03-20T10:00:00Z')
    expect(data.location.receivedAt).toBeTruthy()
  })

  it('POST /api/location rejects invalid JSON body', async () => {
    const res = await fetch(`${hubBase}/api/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.ok).toBe(false)
  })

  it('POST /api/location rejects out-of-range coordinates', async () => {
    const payload = {
      locations: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [999, 999] },
        properties: {},
      }],
    }
    const { status, data } = await postJson(hubBase, '/api/location', payload)
    expect(status).toBe(400)
    expect(data.error).toContain('latitude/longitude')
  })

  it('POST /api/location accepts empty locations array', async () => {
    const { status, data } = await postJson(hubBase, '/api/location', { locations: [] })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
  })
})
