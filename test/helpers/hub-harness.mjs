/**
 * Shared test harness for notification-hub integration tests.
 *
 * Provides common utilities that are duplicated across hub-*.test.mjs files:
 * randomPort, postJson, getJson, startHub, stopHub.
 *
 * Each test file spawns its own isolated server instance — only the helper
 * functions are shared, not the server process.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const TEST_HUB_TOKEN = 'test-hub-token'

/** Pick a random high port to avoid collisions with other tests / services. */
function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000)
}

/** POST JSON helper. Headers are merged on top of the default auth header. */
async function postJson(base, pathname, body, headers = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-G2-Token': TEST_HUB_TOKEN, ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

/** GET JSON helper. */
async function getJson(base, pathname) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'X-CC-G2-Token': TEST_HUB_TOKEN },
  })
  return { status: res.status, data: await res.json() }
}

/**
 * Start a notification-hub server with the given env overrides.
 * Returns { proc, hubBase, tmpDataDir, port }.
 */
async function startHub(envOverrides = {}) {
  const tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-test-'))
  const port = randomPort()
  const hubBase = `http://127.0.0.1:${port}`

  const proc = spawn('node', ['server/notification-hub/index.mjs'], {
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
      ...envOverrides,
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

  return { proc, hubBase, tmpDataDir, port }
}

/** Stop the hub process and clean up the temp data directory. */
async function stopHub(proc, tmpDataDir) {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
    if (!proc.killed) proc.kill('SIGKILL')
  }
  await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {})
}

export { PROJECT_ROOT, TEST_HUB_TOKEN, randomPort, postJson, getJson, startHub, stopHub }
