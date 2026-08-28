/**
 * reply-relay.sh の承認注入 precheck（RELAY_APPROVAL_PRECHECK=1）のテスト
 *
 * ノンブロッキング承認注入では、ローカルで既に決着してダイアログが消えている場合に
 * stray キーを撃たないよう、対象ペインに承認ダイアログが実在するときだけ注入する
 * （fail-closed）。実 tmux（隔離ソケット）+ cat ペインで検証する。tmux が無ければ skip。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT } from './helpers/hub-harness.mjs'

const SOCKET = `cc-g2-precheck-${process.pid}`

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

describe.skipIf(!hasTmux)('reply-relay approval precheck (fail-closed)', () => {
  let binDir = ''
  let workDir = ''

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), 'precheck-bin-'))
    workDir = await mkdtemp(path.join(tmpdir(), 'precheck-work-'))
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
        RELAY_APPROVAL_PRECHECK: '1',
        RELAY_LOG_FILE: path.join(workDir, 'events.jsonl'),
        RELAY_AGENT_LOG_FILE: path.join(workDir, 'agent.log'),
      },
    })
  }

  function denyPayload(pane, comment) {
    return {
      reply: { action: 'deny', source: 'g2', comment },
      notification: {
        id: 'n',
        title: 'bash',
        metadata: { hookType: 'permission-request', agentName: 'copilot', tmuxTarget: pane },
      },
    }
  }

  it('ダイアログ非表示なら注入せず非ゼロ exit する', async () => {
    // cat ペイン: 承認ダイアログテキストなし
    tmux('new-session', '-d', '-s', 'pc-nodialog', '-x', '80', '-y', '24', 'cat')
    const pane = tmux('display-message', '-p', '-t', 'pc-nodialog:0.0', '#{pane_id}')

    const res = runRelay(denyPayload(pane, 'SHOULD_NOT_APPEAR'))
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('approval dialog not found')
    // コメントテキストが注入されていない
    expect(tmux('capture-pane', '-p', '-t', pane)).not.toContain('SHOULD_NOT_APPEAR')
  })

  it('ダイアログ表示中なら precheck を通過して注入する', async () => {
    // ペインに承認ダイアログ相当のテキストを表示してから cat で入力を受ける
    tmux(
      'new-session', '-d', '-s', 'pc-dialog', '-x', '80', '-y', '24',
      'sh', '-c', 'printf "Do you want to run this command?\\n1. Yes\\n2. No, and tell Copilot what to do differently\\n"; cat',
    )
    const pane = tmux('display-message', '-p', '-t', 'pc-dialog:0.0', '#{pane_id}')
    // ダイアログ行が capture-pane に出るまで待つ
    expect(await waitForPaneContent(pane, 'Do you want to run this command?')).toBe(true)

    const res = runRelay(denyPayload(pane, 'PRECHECK_OK_MARKER'))
    expect(res.status, res.stderr).toBe(0)
    // 注入されたコメントがペインに届く（precheck 通過の証拠）
    expect(await waitForPaneContent(pane, 'PRECHECK_OK_MARKER')).toBe(true)
  })
})

// herdr 経路の precheck は tmux 不要（herdr CLI をシムに差し替えて pane read の画面を制御）
describe('reply-relay-herdr approval precheck (fail-closed)', () => {
  let workDir = ''

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'precheck-herdr-'))
  })
  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  // pane read が screenText を返す herdr シムを作る
  async function makeHerdrShim(screenText) {
    const dir = await mkdtemp(path.join(workDir, 'shim-'))
    const bin = path.join(dir, 'herdr')
    const log = path.join(dir, 'calls.log')
    const shim = [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${log}"`,
      'case "$1 $2" in',
      '  "agent list") echo \'{"result":{"agents":[{"pane_id":"w1:p1"}]}}\' ;;',
      '  "agent focus") echo \'{"focused":true}\' ;;',
      `  "pane read") printf '%s\\n' ${JSON.stringify(screenText)} ;;`,
      '  *) : ;;',
      'esac',
      '',
    ].join('\n')
    await writeFile(bin, shim)
    await chmod(bin, 0o755)
    return { bin, log }
  }

  function runHerdrRelay(bin) {
    return spawnSync('bash', ['server/notification-hub/reply-relay-herdr.sh'], {
      cwd: PROJECT_ROOT,
      input: JSON.stringify({
        reply: { action: 'deny', source: 'g2', comment: 'HERDR_MARKER' },
        notification: {
          id: 'n',
          title: 'bash',
          metadata: { hookType: 'permission-request', agentName: 'copilot', tmuxTarget: 'herdr:w1:p1' },
        },
      }),
      encoding: 'utf8',
      env: {
        ...process.env,
        HERDR_BIN: bin,
        RELAY_APPROVAL_PRECHECK: '1',
        RELAY_HERDR_SEND_TEXT_WAIT: '0',
        RELAY_LOG_FILE: path.join(workDir, 'events.jsonl'),
        RELAY_AGENT_LOG_FILE: path.join(workDir, 'agent.log'),
      },
    })
  }

  it('ダイアログ非表示なら注入せず非ゼロ exit する', async () => {
    const { bin, log } = await makeHerdrShim('$ some shell prompt only\n')
    const res = runHerdrRelay(bin)
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('approval dialog not found')
    const calls = readFileSync(log, 'utf8')
    expect(calls).not.toContain('send-keys')
    // precheck の pane read は alt-screen（claude）対応のため --source visible で読む
    expect(calls).toContain('pane read w1:p1 --source visible')
  })

  it('ダイアログ表示中なら precheck を通過して注入する', async () => {
    const { bin, log } = await makeHerdrShim('Do you want to run this command?\n1. Yes\n2. No\n')
    const res = runHerdrRelay(bin)
    expect(res.status, res.stderr).toBe(0)
    const calls = readFileSync(log, 'utf8')
    // precheck の pane read は alt-screen（claude）対応のため --source visible で読む
    expect(calls).toContain('pane read w1:p1 --source visible')
    // precheck 通過 → 番号キー/テキスト送出が行われる
    expect(calls).toContain('pane send-keys w1:p1 2')
  })
})
