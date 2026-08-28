import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT, TEST_HUB_TOKEN, postJson, getJson, startHub } from './helpers/hub-harness.mjs'

/** Poll until an approval matching `predicate` appears, or time out. */
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

/** Poll until a notification matching `predicate` appears, or time out. */
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

/**
 * Run a shell script with JSON piped to stdin. Returns { code, stdout, stderr }.
 * `envOverrides` is merged on top of the default bridge env vars.
 */
function runScript(script, input, hubBase, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', [script], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HUB_URL: hubBase,
        HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
        // トークン解決はファイル優先（resolve_hub_auth_token）。repo 実トークンを
        // 拾わないよう空ファイルを指定して env の TEST_HUB_TOKEN を使わせる
        HUB_AUTH_TOKEN_FILE: '/dev/null',
        CC_G2_TMUX_TARGET: '',
        ...envOverrides,
      },
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

/** Convenience wrapper: run copilot-hook-bridge.sh with the given JSON input. */
function runBridge(input, hubBase, envOverrides = {}) {
  return runScript('scripts/copilot-hook-bridge.sh', input, hubBase, envOverrides)
}

describe('Copilot Hook Bridge Integration', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    ;({ proc: hubProc, hubBase, tmpDataDir } = await startHub())
  }, 15000)

  afterAll(async () => {
    await terminateProcess(hubProc)
    await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('X-Agent-Source: copilot ヘッダーで agentName が copilot になる', async () => {
    const hookPromise = postJson(
      hubBase,
      '/api/hooks/permission-request',
      {
        session_id: 'copilot-test-1',
        cwd: '/tmp/copilot-project',
        tool_name: 'bash',
        tool_input: { command: 'echo hello from copilot' },
      },
      { 'X-Agent-Source': 'copilot' },
    )

    const pending = await waitForApproval(
      hubBase,
      (a) => a.cwd === '/tmp/copilot-project' && a.status === 'pending',
    )
    expect(pending.agentName).toBe('copilot')
    expect(pending.source).toBe('copilot-hook')

    const { data: notifDetail } = await getJson(hubBase, `/api/notifications/${pending.notificationId}`)
    expect(notifDetail.item.metadata.agentName).toBe('copilot')

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve', source: 'g2' })
    await hookPromise
  })

  it('ブリッジが Copilot stdin(camelCase) を Hub にPOSTして allow を {behavior:allow} に変換する', async () => {
    const copilotInput = JSON.stringify({
      hookName: 'permissionRequest',
      sessionId: 'copilot-allow-1',
      cwd: '/tmp/copilot-allow',
      toolName: 'bash',
      toolInput: { command: 'mkdir -p /tmp/copilot-hook-test' },
    })

    const bridgePromise = runBridge(copilotInput, hubBase)

    const pending = await waitForApproval(
      hubBase,
      (a) => a.status === 'pending' && a.agentName === 'copilot' && a.toolInput?.command === 'mkdir -p /tmp/copilot-hook-test',
    )
    expect(pending.toolName).toBe('bash')
    expect(pending.cwd).toBe('/tmp/copilot-allow')

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, { decision: 'approve', source: 'g2' })

    const result = await bridgePromise
    expect(result.code).toBe(0)

    const output = JSON.parse(result.stdout.trim())
    expect(output).toEqual({ behavior: 'allow' })
  })

  it('ブリッジが deny を {behavior:deny,message} に変換する', async () => {
    const copilotInput = JSON.stringify({
      hookName: 'permissionRequest',
      sessionId: 'copilot-deny-1',
      cwd: '/tmp/copilot-deny',
      toolName: 'bash',
      toolInput: { command: 'rm -rf /' },
    })

    const bridgePromise = runBridge(copilotInput, hubBase)

    const pending = await waitForApproval(
      hubBase,
      (a) => a.status === 'pending' && a.agentName === 'copilot' && a.toolInput?.command === 'rm -rf /',
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
    expect(output.behavior).toBe('deny')
    expect(output.message).toBe('G2: Dangerous command!')
  })

  it('HUB_AUTH_TOKEN が env に無いと env ゲートで無出力 exit 0（cc-g2 外の起動）', async () => {
    const copilotInput = JSON.stringify({
      hookName: 'permissionRequest',
      sessionId: 'copilot-gate-1',
      cwd: '/tmp/copilot-gate',
      toolName: 'bash',
      toolInput: { command: 'echo gated' },
    })

    const result = await runBridge(copilotInput, hubBase, { HUB_AUTH_TOKEN: '' })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr.trim()).toBe('')
  })

  it('ブリッジが Hub 未接続時にフォールスルー（無出力 exit 0）する', async () => {
    const copilotInput = JSON.stringify({
      hookName: 'permissionRequest',
      sessionId: 'copilot-nohub-1',
      toolName: 'bash',
      toolInput: { command: 'mkdir -p /tmp/copilot-nohub-test' },
    })

    const result = await runBridge(copilotInput, hubBase, {
      HUB_URL: 'http://127.0.0.1:19999',
    })

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr).toContain('Hub に接続できません')
  })

  it('Copilot agentStop hook が events.jsonl から最終応答を抽出して完了通知を送る', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'copilot-state-'))
    const transcriptPath = path.join(stateDir, 'events.jsonl')
    const events = [
      { type: 'session.start', data: {} },
      { type: 'user.message', data: { content: 'やって' } },
      { type: 'assistant.turn_start', data: { turnId: '0' } },
      { type: 'assistant.message', data: { content: '', toolRequests: [{ name: 'bash' }] } },
      { type: 'tool.execution_complete', data: {} },
      { type: 'assistant.message', data: { content: '作業が完了しました。次はレビューできます。' } },
      { type: 'assistant.turn_end', data: { turnId: '0' } },
    ]
    await writeFile(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n')

    const stopInput = JSON.stringify({
      sessionId: 'copilot-stop-1',
      cwd: '/tmp/copilot-stop-project',
      transcriptPath,
      stopReason: 'end_turn',
    })

    const result = await runScript('scripts/copilot-stop-notify.sh', stopInput, hubBase, {
      CC_G2_TMUX_TARGET: 'g2-copilot-stop-project-abcd-copilot:0.0',
    })
    expect(result.code).toBe(0)

    const match = await waitForNotification(
      hubBase,
      (item) => item.metadata?.agentName === 'copilot' && item.metadata?.sessionId === 'copilot-stop-1',
    )
    expect(match.title).toContain('完了: copilot-stop-project')
    expect(match.metadata.hookType).toBe('stop')

    const { data: detailData } = await getJson(hubBase, `/api/notifications/${match.id}`)
    expect(detailData.item.fullText).toContain('作業が完了しました。次はレビューできます。')

    await rm(stateDir, { recursive: true, force: true }).catch(() => {})
  })
})
