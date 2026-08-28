/**
 * HUB_APPROVAL_MODE=nonblocking の承認モードのテスト
 *
 * - permission-request hook は待たず即 {} を返す（CLI のローカルダイアログを出す）。
 * - decide 時に reply-relay を spawn してキー注入する（合成ペイロードを検証）。
 * - AskUserQuestion は nonblocking でも従来のロングポールを維持する。
 *
 * reply-relay は capturing shim に差し替え、注入ペイロードをファイルへ記録して検証する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT, TEST_HUB_TOKEN, postJson, getJson } from './helpers/hub-harness.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForApproval(base, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await getJson(base, '/api/approvals')
    const match = data.items.find(predicate)
    if (match) return match
    await sleep(80)
  }
  throw new Error('timed out waiting for approval')
}

async function waitForFileLine(file, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
      const match = lines.map((l) => JSON.parse(l)).find(predicate)
      if (match) return match
    }
    await sleep(80)
  }
  return null
}

/**
 * nonblocking モードの hub を起動する。startHub と同じ枠組みだが、
 * HUB_APPROVAL_MODE と capturing relay shim の env を渡す。
 */
async function startNonblockingHub(relayOut, shimPath) {
  const tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-nb-'))
  const port = 20000 + Math.floor(Math.random() * 40000)
  const hubBase = `http://127.0.0.1:${port}`
  const proc = spawn('node', ['server/notification-hub/index.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HUB_PORT: String(port),
      HUB_BIND: '127.0.0.1',
      HUB_DATA_DIR: tmpDataDir,
      HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
      NTFY_BASE_URL: '',
      HUB_APPROVAL_MODE: 'nonblocking',
      HUB_REPLY_RELAY_CMD: `sh ${shimPath}`,
      // relay は allowlist を持つが、承認注入は relayApprovalInjection が bypass する。
      HUB_REPLY_RELAY_SOURCES: 'g2,web',
      RELAY_OUT: relayOut,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${hubBase}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) break
    } catch { /* not ready */ }
    await sleep(120)
  }
  return { proc, hubBase, tmpDataDir }
}

describe('HUB_APPROVAL_MODE=nonblocking', () => {
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''
  let workDir = ''
  let relayOut = ''

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'hub-nb-shim-'))
    relayOut = path.join(workDir, 'relay-payloads.jsonl')
    const shimPath = path.join(workDir, 'relay-shim.sh')
    // stdin の注入ペイロードを 1 行 1 JSON で追記する capturing shim
    await writeFile(shimPath, '#!/bin/sh\ncat >> "$RELAY_OUT"\nprintf "\\n" >> "$RELAY_OUT"\n')
    await chmod(shimPath, 0o755)
    ;({ proc: hubProc, hubBase, tmpDataDir } = await startNonblockingHub(relayOut, shimPath))
  }, 15000)

  afterAll(async () => {
    if (hubProc && hubProc.exitCode === null) {
      hubProc.kill('SIGTERM')
      await sleep(300)
      if (hubProc.exitCode === null) hubProc.kill('SIGKILL')
    }
    await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {})
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  it('/api/health が approvalMode=nonblocking を報告する', async () => {
    const { data } = await getJson(hubBase, '/api/health')
    expect(data.approvalMode).toBe('nonblocking')
  })

  it('permission-request hook は待たず即 {} を返す', async () => {
    const t0 = Date.now()
    const { status, data } = await postJson(
      hubBase,
      '/api/hooks/permission-request',
      {
        session_id: 'nb-1',
        cwd: '/tmp/nb-project',
        tool_name: 'Bash',
        tool_input: { command: 'echo nonblocking' },
      },
      { 'X-Tmux-Target': '%42' },
    )
    const elapsed = Date.now() - t0
    expect(status).toBe(200)
    expect(data).toEqual({})
    // ロングポール（2 秒間隔）ではなく即応答であること
    expect(elapsed).toBeLessThan(1500)

    // 承認は pending のまま残る
    const pending = await waitForApproval(hubBase, (a) => a.cwd === '/tmp/nb-project')
    expect(pending.status).toBe('pending')
  })

  it('decide 時に reply-relay へ承認注入ペイロードを spawn する', async () => {
    // 別セッションの承認を作る
    await postJson(
      hubBase,
      '/api/hooks/permission-request',
      {
        session_id: 'nb-inject',
        cwd: '/tmp/nb-inject',
        tool_name: 'Bash',
        tool_input: { command: 'rm file' },
      },
      { 'X-Tmux-Target': '%77' },
    )
    const pending = await waitForApproval(hubBase, (a) => a.cwd === '/tmp/nb-inject')

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'approve',
      source: 'telegram',
    })

    // fire-and-forget の注入 spawn を待つ
    const payload = await waitForFileLine(
      relayOut,
      (p) => p?.notification?.metadata?.approvalId === pending.id,
    )
    expect(payload, 'relay shim が承認注入ペイロードを受け取る').toBeTruthy()
    expect(payload.reply.resolvedAction).toBe('approve')
    expect(payload.reply.source).toBe('telegram')
    expect(payload.notification.metadata.hookType).toBe('permission-request')
    expect(payload.notification.metadata.tmuxTarget).toBe('%77')
    expect(payload.notification.metadata.agentName).toBe('claude-code')
  })

  it('AskUserQuestion は nonblocking でもロングポールを維持し、注入しない', async () => {
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'nb-askq',
      cwd: '/tmp/nb-askq',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '続けますか?', options: [{ label: 'はい' }] }] },
    })

    const pending = await waitForApproval(hubBase, (a) => a.cwd === '/tmp/nb-askq')

    // 即 {} ではなくブロックしていることを確認（400ms 経っても未解決）
    const raced = await Promise.race([
      hookPromise.then(() => 'resolved'),
      sleep(400).then(() => 'blocking'),
    ])
    expect(raced).toBe('blocking')

    // deny で決着 → hook 応答が返る（ロングポール経路）
    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'deny',
      comment: '選択回答: はい',
      source: 'g2',
    })
    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('deny')

    // AskUserQuestion は注入対象外（relay shim に届かない）
    const injected = await waitForFileLine(
      relayOut,
      (p) => p?.notification?.metadata?.approvalId === pending.id,
      800,
    )
    expect(injected, 'AskUserQuestion は注入されない').toBeNull()
  })
})
