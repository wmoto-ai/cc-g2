/**
 * hub-token 401 対策（docs/hub-token-401-and-trust-gate.md）のテスト
 *
 * Hub 再起動でトークンがローテートすると、セッション起動時に env へ焼き込まれた
 * 旧トークンのままフックが 401 になっていた。resolve_hub_auth_token（lib/common.sh）が
 * トークンファイルを env より優先することで、稼働中セッションのフックも
 * 現在の正しいトークンで送信できることを検証する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT, TEST_HUB_TOKEN, getJson, startHub, stopHub } from './helpers/hub-harness.mjs'

const STALE_TOKEN = 'stale-token-from-old-session'

function runScript(script, input, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [script], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.stdin.write(input)
    proc.stdin.end()
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
    proc.on('error', reject)
  })
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

describe('hook token resolution (file-first)', () => {
  let hub
  let tokenFile = ''

  beforeAll(async () => {
    hub = await startHub()
    // Hub の現在トークンが書かれたトークンファイル（ローテート後の正）を用意
    const dir = await mkdtemp(path.join(tmpdir(), 'hub-token-test-'))
    tokenFile = path.join(dir, 'hub-auth-token')
    await writeFile(tokenFile, TEST_HUB_TOKEN)
  })

  afterAll(async () => {
    await stopHub(hub.proc, hub.tmpDataDir)
  })

  it('stop-notify: env が旧トークンでもファイルの現行トークンで 200 になる', async () => {
    const { code } = await runScript(
      'scripts/cc-g2-stop-notify.sh',
      JSON.stringify({ stop_hook_active: false, transcript_path: '', cwd: '/tmp/token-test' }),
      {
        HUB_PORT: String(hub.port),
        HUB_AUTH_TOKEN: STALE_TOKEN,
        HUB_AUTH_TOKEN_FILE: tokenFile,
        CC_G2_TMUX_TARGET: '',
      },
    )
    expect(code).toBe(0)

    const found = await waitFor(async () => {
      const { data } = await getJson(hub.hubBase, '/api/notifications?limit=100')
      return data.items.find((n) => n.metadata && n.metadata.cwd === '/tmp/token-test')
    })
    expect(found, 'stop 通知が Hub に届いていること（401 なら届かない）').toBeTruthy()
  })

  it('stop-notify: ファイルがなければ従来どおり env トークンで送る', async () => {
    const { code } = await runScript(
      'scripts/cc-g2-stop-notify.sh',
      JSON.stringify({ stop_hook_active: false, transcript_path: '', cwd: '/tmp/token-env-fallback' }),
      {
        HUB_PORT: String(hub.port),
        HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
        HUB_AUTH_TOKEN_FILE: '/dev/null',
        CC_G2_TMUX_TARGET: '',
      },
    )
    expect(code).toBe(0)

    const found = await waitFor(async () => {
      const { data } = await getJson(hub.hubBase, '/api/notifications?limit=100')
      return data.items.find((n) => n.metadata && n.metadata.cwd === '/tmp/token-env-fallback')
    })
    expect(found).toBeTruthy()
  })

  it('statusline: env が旧トークンでもファイルの現行トークンで context-status が届く', async () => {
    const sessionId = `token-test-${Date.now()}`
    const { code } = await runScript(
      'scripts/cc-g2-statusline.sh',
      JSON.stringify({
        session_id: sessionId,
        cwd: '/tmp/token-test',
        model: { display_name: 'test-model' },
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 50000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
      {
        HUB_PORT: String(hub.port),
        HUB_AUTH_TOKEN: STALE_TOKEN,
        HUB_AUTH_TOKEN_FILE: tokenFile,
        CC_G2_ORIG_STATUSLINE_CMD: '',
      },
    )
    expect(code).toBe(0)

    // statusline の curl は非同期（&）なので反映を待つ
    const found = await waitFor(async () => {
      const { data } = await getJson(hub.hubBase, '/api/context-status')
      const sessions = Array.isArray(data.sessions) ? data.sessions : []
      return sessions.find((s) => s.sessionId === sessionId)
    })
    expect(found, 'context-status が Hub に届いていること（401 なら届かない）').toBeTruthy()
  })
})
