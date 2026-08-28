/**
 * tmux 返信ターゲットの pane 固有 ID（%N）ルーティングのテスト
 *
 * QR 常駐ペインを agent ペインの上に追加すると、ペインインデックス形式
 * （session:0.0）のターゲットは QR ペインを指してしまい G2 返信が誤配信される。
 * cc-g2.sh は @cc_g2_agent_pane に agent ペインの %id を記録し、
 * send_to_tmux_session はそれを優先する。
 *
 * 実 tmux を隔離ソケット（-L）で起動して検証する。tmux が無い環境では skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { PROJECT_ROOT } from './helpers/hub-harness.mjs'

const SOCKET = `cc-g2-test-${process.pid}`

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

function tmux(...args) {
  return execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' }).trim()
}

/** lib/tmux-session.sh の関数を隔離ソケットの tmux に向けて実行する */
function runLib(snippet) {
  const script = [
    'set -euo pipefail',
    `tmux() { command tmux -L '${SOCKET}' "$@"; }`,
    'source scripts/lib/common.sh',
    'source scripts/lib/tmux-session.sh',
    snippet,
  ].join('\n')
  return spawnSync('bash', ['-c', script], { cwd: PROJECT_ROOT, encoding: 'utf8' })
}

async function waitForPaneContent(pane, text, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (tmux('capture-pane', '-p', '-t', pane).includes(text)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

describe.skipIf(!hasTmux)('tmux target pane-id routing', () => {
  const SESSION = 'g2-target-test'
  let agentPane = ''

  beforeAll(() => {
    tmux('new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24', '/bin/sh')
    agentPane = tmux('display-message', '-p', '-t', `${SESSION}:0.0`, '#{pane_id}')
  })

  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' })
    } catch {
      // サーバーが既に終了している場合は無視
    }
  })

  it('上にペインを足すと :0.0 は agent ペインを指さなくなる（%id 化の根拠）', () => {
    tmux('split-window', '-v', '-b', '-d', '-t', agentPane, '/bin/sh')
    const topPane = tmux('display-message', '-p', '-t', `${SESSION}:0.0`, '#{pane_id}')
    expect(topPane).not.toBe(agentPane)
    // %id 直指定なら分割後も同じペインを指す
    expect(tmux('display-message', '-p', '-t', agentPane, '#{pane_id}')).toBe(agentPane)
  })

  it('send_to_tmux_session は @cc_g2_agent_pane のペインへ送る', async () => {
    tmux('set-option', '-t', SESSION, '@cc_g2_agent_pane', agentPane)
    const res = runLib(`send_to_tmux_session '${SESSION}' 'hello-agent-pane'`)
    expect(res.status, res.stderr).toBe(0)

    expect(await waitForPaneContent(agentPane, 'hello-agent-pane')).toBe(true)
    // 上のペイン（:0.0 = QR ペイン相当）には送られていない
    const topPane = tmux('display-message', '-p', '-t', `${SESSION}:0.0`, '#{pane_id}')
    expect(tmux('capture-pane', '-p', '-t', topPane)).not.toContain('hello-agent-pane')
  })

  it('@cc_g2_agent_pane が無いセッションは従来どおり :0.0 に送る', async () => {
    tmux('new-session', '-d', '-s', 'g2-fallback-test', '-x', '80', '-y', '24', '/bin/sh')
    const res = runLib(`send_to_tmux_session 'g2-fallback-test' 'hello-fallback'`)
    expect(res.status, res.stderr).toBe(0)
    const pane = tmux('display-message', '-p', '-t', 'g2-fallback-test:0.0', '#{pane_id}')
    expect(await waitForPaneContent(pane, 'hello-fallback')).toBe(true)
  })
})
