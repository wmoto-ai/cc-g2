/**
 * 承認のローカル決着検知（PostToolUse → /api/hooks/tool-executed）のテスト
 *
 * nonblocking モードで permission-request が pending のまま残ったあと、
 * PostToolUse hook（tool-executed）が「実行された = ローカルで承認された」を Hub に伝える。
 * Hub は該当 sessionId の pending を approve 解決し、キー注入は行わない
 * （relay プロセスを起動しない）ため、リモートのボタンは reconciler 経由で閉じる。
 *
 * 併せて Stop 掃除（同一セッションの残 pending を印に関わらず閉じる）も検証する。
 * relay は capturing shim に差し替え、注入が起きないことをファイル不在で確認する。
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
    await sleep(60)
  }
  throw new Error('timed out waiting for approval')
}

async function isPending(base, approvalId) {
  const { data } = await getJson(base, '/api/approvals')
  return data.items.some((a) => a.id === approvalId)
}

async function relayFileHasApproval(relayOut, approvalId, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(relayOut)) {
      const lines = (await readFile(relayOut, 'utf8')).split('\n').filter(Boolean)
      const hit = lines
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .some((p) => p?.notification?.metadata?.approvalId === approvalId)
      if (hit) return true
    }
    await sleep(60)
  }
  return false
}

async function startNonblockingHub(relayOut, shimPath) {
  const tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-te-'))
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

describe('ローカル決着検知 /api/hooks/tool-executed', () => {
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''
  let workDir = ''
  let relayOut = ''

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'hub-te-shim-'))
    relayOut = path.join(workDir, 'relay-payloads.jsonl')
    const shimPath = path.join(workDir, 'relay-shim.sh')
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

  async function createPending(sessionId, command, headers = {}) {
    await postJson(
      hubBase,
      '/api/hooks/permission-request',
      {
        session_id: sessionId,
        cwd: `/tmp/${sessionId}`,
        tool_name: 'Bash',
        tool_input: { command, description: 'ダイアログ側にのみ付く付帯キー' },
      },
      headers,
    )
    return waitForApproval(hubBase, (a) => a.cwd === `/tmp/${sessionId}`)
  }

  it('一致する pending を approve 解決し、pending 一覧から消える', async () => {
    const pending = await createPending('te-match', 'touch /tmp/x.txt')

    const { status, data } = await postJson(hubBase, '/api/hooks/tool-executed', {
      session_id: 'te-match',
      tool_name: 'Bash',
      tool_input: { command: 'touch /tmp/x.txt' },
    })
    expect(status).toBe(200)
    expect(data.matched).toBe(true)
    expect(data.approvalId).toBe(pending.id)

    expect(await isPending(hubBase, pending.id)).toBe(false)

    const detail = await getJson(hubBase, `/api/approvals/${pending.id}`)
    expect(detail.data.approval.status).toBe('decided')
    expect(detail.data.approval.decision).toBe('approve')
    expect(detail.data.approval.decidedBy).toBe('local:executed')
  })

  it('ローカル決着では relay（キー注入）プロセスを起動しない', async () => {
    const pending = await createPending('te-noinject', 'rm /tmp/y.txt')

    await postJson(hubBase, '/api/hooks/tool-executed', {
      session_id: 'te-noinject',
      tool_name: 'Bash',
      tool_input: { command: 'rm /tmp/y.txt' },
    })
    expect(await isPending(hubBase, pending.id)).toBe(false)

    // decide 経路と違い、注入ペイロードは relay shim に届かない
    const injected = await relayFileHasApproval(relayOut, pending.id)
    expect(injected).toBe(false)
  })

  it('camelCase ペイロード（copilot 形式）でも解決できる', async () => {
    const pending = await createPending('te-camel', 'ls -la')

    const { status, data } = await postJson(hubBase, '/api/hooks/tool-executed', {
      sessionId: 'te-camel',
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
    })
    expect(status).toBe(200)
    expect(data.matched).toBe(true)
    expect(data.approvalId).toBe(pending.id)
    expect(await isPending(hubBase, pending.id)).toBe(false)
  })

  it('copilot 形式（toolName 小文字 "bash" + camelCase）で解決できる', async () => {
    // copilot の permissionRequest は toolName 小文字・toolInput に description 付きで届く。
    const sessionId = 'te-copilot'
    await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: sessionId,
      cwd: `/tmp/${sessionId}`,
      tool_name: 'bash',
      tool_input: { command: 'echo copilot', description: 'ダイアログ側付帯キー' },
    }, { 'X-Agent-Source': 'copilot' })
    const pending = await waitForApproval(hubBase, (a) => a.cwd === `/tmp/${sessionId}`)
    expect(pending.toolName).toBe('bash')

    // postToolUse ブリッジは toolArgs をパースして tool_input(object) にして送る。
    // toolName 小文字のまま Hub 側で command 文字列突合されること。
    const { status, data } = await postJson(hubBase, '/api/hooks/tool-executed', {
      sessionId,
      toolName: 'bash',
      toolInput: { command: 'echo copilot' },
    }, { 'X-Agent-Source': 'copilot' })
    expect(status).toBe(200)
    expect(data.matched).toBe(true)
    expect(data.approvalId).toBe(pending.id)
    expect(await isPending(hubBase, pending.id)).toBe(false)
  })

  it('一致なしは no-op（200 matched=false）で pending を触らない', async () => {
    const pending = await createPending('te-nomatch', 'echo keep')

    const { status, data } = await postJson(hubBase, '/api/hooks/tool-executed', {
      session_id: 'te-nomatch',
      tool_name: 'Bash',
      tool_input: { command: 'different command' },
    })
    expect(status).toBe(200)
    expect(data.matched).toBe(false)
    expect(await isPending(hubBase, pending.id)).toBe(true)
  })

  it('別ツール名は一致しない（tool_input が同じでも）', async () => {
    const pending = await createPending('te-tool', 'echo tool')

    const { data } = await postJson(hubBase, '/api/hooks/tool-executed', {
      session_id: 'te-tool',
      tool_name: 'Write',
      tool_input: { command: 'echo tool' },
    })
    expect(data.matched).toBe(false)
    expect(await isPending(hubBase, pending.id)).toBe(true)
  })

  it('認証なしは 401', async () => {
    const res = await fetch(`${hubBase}/api/hooks/tool-executed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'te-auth', tool_name: 'Bash', tool_input: { command: 'x' } }),
    })
    expect(res.status).toBe(401)
  })

  it('複数一致時は最も古い pending を解決する', async () => {
    const first = await createPending('te-multi', 'make build')
    // 同一 session・同一 command で 2 件目
    await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'te-multi',
      cwd: '/tmp/te-multi',
      tool_name: 'Bash',
      tool_input: { command: 'make build', description: 'second' },
    })
    // 2 件 pending になるまで待つ
    await waitForApproval(
      hubBase,
      (a) => a.cwd === '/tmp/te-multi' && a.id !== first.id,
    )

    const { data } = await postJson(hubBase, '/api/hooks/tool-executed', {
      session_id: 'te-multi',
      tool_name: 'Bash',
      tool_input: { command: 'make build' },
    })
    expect(data.matched).toBe(true)
    expect(data.approvalId).toBe(first.id)
    // 最古（first）は解決、2 件目は残る
    expect(await isPending(hubBase, first.id)).toBe(false)
  })

  it('Stop 掃除: 同一セッションの残 pending は印に関わらず閉じる', async () => {
    const sessionId = 'te-stop-sweep'
    // nonblocking hook 由来（approvalMode=nonblocking）
    const nb = await createPending(sessionId, 'deploy now')

    // longpoll 印付きの承認も同一 session で作る（hook タイムアウト後に残った承認に相当。
    // ブロック中の longpoll に Stop は届かないため、印による保護はしない）
    const lp = await postJson(hubBase, '/api/approvals', {
      toolName: 'Bash',
      toolInput: { command: 'blocking op' },
      cwd: `/tmp/${sessionId}`,
      agentName: 'test-agent',
      metadata: { sessionId, approvalMode: 'longpoll' },
    })
    expect(lp.status).toBe(201)

    // Stop 通知
    const stop = await postJson(hubBase, '/api/notify/moshi', {
      hookType: 'stop',
      title: 'stopped',
      body: 'done',
      metadata: { hookType: 'stop', sessionId },
    })
    expect(stop.status).toBe(201)

    // どちらも「実行されず終了」として掃除される
    expect(await isPending(hubBase, nb.id)).toBe(false)
    const nbDetail = await getJson(hubBase, `/api/approvals/${nb.id}`)
    expect(nbDetail.data.approval.resolution).toBe('session-ended')
    expect(await isPending(hubBase, lp.data.approvalId)).toBe(false)
  })
})
