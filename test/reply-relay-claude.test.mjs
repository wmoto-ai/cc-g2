/**
 * reply-relay.sh / reply-relay-herdr.sh の Claude Code 承認キー操作のテスト
 *
 * 現行 Claude Code v2.1（実測）は番号選択式:
 *   ❯ 1. Yes / 2. Yes, and always allow … / 3. No（Esc to cancel）
 * 承認 = `1` 単押し（Escape 前置なし・Enter なし）。Escape はキャンセルするため送らない。
 * 拒否 = `3` + 任意コメント → Enter。agentName=claude(-code) を signal に claude 分岐へ。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT } from './helpers/hub-harness.mjs'

const SOCKET = `cc-g2-claude-test-${process.pid}`

const realTmux = (() => {
  try {
    return execFileSync('bash', ['-lc', 'command -v tmux'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()
const hasTmux = realTmux !== ''

function tmux(...args) {
  return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim()
}

async function waitForPaneContent(pane, text, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (tmux('capture-pane', '-p', '-t', pane).includes(text)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

describe.skipIf(!hasTmux)('reply-relay claude approval keys (tmux)', () => {
  let binDir = ''
  let workDir = ''

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), 'claude-relay-bin-'))
    workDir = await mkdtemp(path.join(tmpdir(), 'claude-relay-work-'))
    const shim = path.join(binDir, 'tmux')
    await writeFile(shim, `#!/bin/sh\nexec "${realTmux}" -L "${SOCKET}" "$@"\n`)
    await chmod(shim, 0o755)
  })

  afterAll(async () => {
    try {
      execFileSync(realTmux, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' })
    } catch { /* already gone */ }
    await rm(binDir, { recursive: true, force: true }).catch(() => {})
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  function newCatPane(session) {
    tmux('new-session', '-d', '-s', session, '-x', '80', '-y', '24', 'cat')
    return tmux('display-message', '-p', '-t', `${session}:0.0`, '#{pane_id}')
  }

  function runRelay(payload) {
    return spawnSync('bash', ['server/notification-hub/reply-relay.sh'], {
      cwd: PROJECT_ROOT,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        RELAY_ENABLE_TMUX: '1',
        RELAY_TMUX_STRICT_APPROVAL_TARGET: '1',
        RELAY_LOG_FILE: path.join(workDir, 'events.jsonl'),
        RELAY_AGENT_LOG_FILE: path.join(workDir, 'agent.log'),
      },
    })
  }

  it('approve は 1 の単押しを送る', async () => {
    const pane = newCatPane('g2-claude-approve')
    const res = runRelay({
      reply: { action: 'approve', source: 'g2' },
      notification: {
        id: 'n',
        title: 'Bash',
        metadata: { hookType: 'permission-request', agentName: 'claude-code', tmuxTarget: pane },
      },
    })
    expect(res.status, res.stderr).toBe(0)
    expect(await waitForPaneContent(pane, '1')).toBe(true)
  })

  it('deny+コメントは 3 → テキストを送る', async () => {
    const pane = newCatPane('g2-claude-deny')
    const res = runRelay({
      reply: { action: 'deny', source: 'g2', comment: 'CLAUDE_MARKER' },
      notification: {
        id: 'n',
        title: 'Bash',
        metadata: { hookType: 'permission-request', agentName: 'claude-code', tmuxTarget: pane },
      },
    })
    expect(res.status, res.stderr).toBe(0)
    expect(await waitForPaneContent(pane, 'CLAUDE_MARKER')).toBe(true)
    expect(tmux('capture-pane', '-p', '-t', pane)).toContain('3')
  })
})

// herdr シムでキー列を厳密検証（1 のみ・Escape 非送出・3 送出・focus 前置）
describe('reply-relay-herdr claude approval keys (shim)', () => {
  let workDir = ''

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'claude-herdr-'))
  })
  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  async function makeHerdrShim() {
    const dir = await mkdtemp(path.join(workDir, 'shim-'))
    const bin = path.join(dir, 'herdr')
    const log = path.join(dir, 'calls.log')
    const shim = [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${log}"`,
      'case "$1 $2" in',
      '  "agent list") echo \'{"result":{"agents":[{"pane_id":"w1:p1"}]}}\' ;;',
      '  "agent focus") echo \'{"focused":true}\' ;;',
      '  "pane read") echo "Do you want to proceed? 1. Yes 3. No" ;;',
      '  *) : ;;',
      'esac',
      '',
    ].join('\n')
    await writeFile(bin, shim)
    await chmod(bin, 0o755)
    return { bin, log }
  }

  function runHerdrRelay(bin, action, comment) {
    return spawnSync('bash', ['server/notification-hub/reply-relay-herdr.sh'], {
      cwd: PROJECT_ROOT,
      input: JSON.stringify({
        reply: { action, source: 'g2', comment },
        notification: {
          id: 'n',
          title: 'Bash',
          metadata: { hookType: 'permission-request', agentName: 'claude-code', tmuxTarget: 'herdr:w1:p1' },
        },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        HERDR_BIN: bin,
        RELAY_HERDR_SEND_TEXT_WAIT: '0',
        RELAY_LOG_FILE: path.join(workDir, 'events.jsonl'),
        RELAY_AGENT_LOG_FILE: path.join(workDir, 'agent.log'),
      },
    })
  }

  it('approve は focus 後に 1 のみ送り、Escape/n を送らない', async () => {
    const { bin, log } = await makeHerdrShim()
    const res = runHerdrRelay(bin, 'approve', '')
    expect(res.status, res.stderr).toBe(0)
    const calls = await readFile(log, 'utf8')
    expect(calls).toContain('agent focus w1:p1')
    expect(calls).toContain('pane send-keys w1:p1 1')
    expect(calls).not.toContain('Escape')
    expect(calls).not.toContain('pane send-keys w1:p1 n')
  })

  it('deny+コメントは 3 → send-text → Enter（Escape 非送出）', async () => {
    const { bin, log } = await makeHerdrShim()
    const res = runHerdrRelay(bin, 'deny', 'HERDR_CLAUDE_MARKER')
    expect(res.status, res.stderr).toBe(0)
    const calls = await readFile(log, 'utf8')
    expect(calls).toContain('pane send-keys w1:p1 3')
    expect(calls).toContain('pane send-text w1:p1 HERDR_CLAUDE_MARKER')
    expect(calls).toContain('pane send-keys w1:p1 Enter')
    expect(calls).not.toContain('Escape')
  })
})
