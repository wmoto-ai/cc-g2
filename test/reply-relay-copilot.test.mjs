/**
 * reply-relay.sh の Copilot CLI 承認キー操作のテスト
 *
 * Copilot TUI は claude/codex の y/n ホットキーではなく番号選択リスト:
 *   承認 = 「1」の単押し（Enter 不要・Escape 前置なし）
 *   拒否/コメント = 「2」でオプション 2 に移動 → テキスト → Enter
 * agentName=copilot（copilot-hook が付与）を signal に copilot 分岐へ入ることを
 * 実 tmux（隔離ソケット）+ cat ペインへの send-keys で検証する。tmux が無い環境では skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT } from './helpers/hub-harness.mjs'

const SOCKET = `cc-g2-copilot-test-${process.pid}`

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

describe.skipIf(!hasTmux)('reply-relay copilot approval keys', () => {
  let binDir = ''
  let workDir = ''

  beforeAll(async () => {
    // reply-relay.sh は bare `tmux` を呼ぶため、隔離ソケットへ向ける shim を PATH 前段に置く
    binDir = await mkdtemp(path.join(tmpdir(), 'copilot-relay-bin-'))
    workDir = await mkdtemp(path.join(tmpdir(), 'copilot-relay-work-'))
    const shim = path.join(binDir, 'tmux')
    await writeFile(shim, `#!/bin/sh\nexec "${realTmux}" -L "${SOCKET}" "$@"\n`)
    await chmod(shim, 0o755)
  })

  afterAll(async () => {
    try {
      execFileSync(realTmux, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' })
    } catch {
      // 既に終了していれば無視
    }
    await rm(binDir, { recursive: true, force: true }).catch(() => {})
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  function newCatPane(session) {
    // cat ペイン: send-keys された入力が tty echo で capture-pane に見える
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
    const pane = newCatPane('g2-copilot-approve')
    const res = runRelay({
      reply: { action: 'approve', source: 'g2' },
      notification: {
        id: 'n-approve',
        title: 'bash',
        metadata: { hookType: 'permission-request', agentName: 'copilot', tmuxTarget: pane },
      },
    })
    expect(res.status, res.stderr).toBe(0)
    expect(await waitForPaneContent(pane, '1')).toBe(true)
  })

  it('deny+コメントは 2 → テキスト → Enter を送る', async () => {
    const pane = newCatPane('g2-copilot-deny')
    const res = runRelay({
      reply: { action: 'deny', source: 'g2', comment: '危険です' },
      notification: {
        id: 'n-deny',
        title: 'bash',
        metadata: { hookType: 'permission-request', agentName: 'copilot', tmuxTarget: pane },
      },
    })
    expect(res.status, res.stderr).toBe(0)
    expect(await waitForPaneContent(pane, '危険です')).toBe(true)
    // オプション 2 選択のキーが先行している
    expect(tmux('capture-pane', '-p', '-t', pane)).toContain('2')
  })
})
