/**
 * reply-relay-herdr.sh の Copilot focus 前置のテスト
 *
 * copilot の herdr ペインは focused=true でないと Enter を submit として受理しない
 * （テキストは入力欄に残るだけで送信されない）。claude/codex は focus 非依存。
 * このテストは herdr CLI をシムに差し替えて呼び出し列を記録し、submit(Enter/番号キー)
 * の直前に `agent focus` が入ることを検証する。tmux 不要。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT } from './helpers/hub-harness.mjs'

const TARGET = 'w1:p1'

describe('reply-relay-herdr copilot focus-before-submit', () => {
  let workDir = ''
  let herdrBin = ''
  let herdrLog = ''

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'herdr-copilot-'))
    herdrBin = path.join(workDir, 'herdr')
    herdrLog = path.join(workDir, 'herdr-calls.log')
    // herdr シム: 呼び出しの argv を 1 行ずつ記録し、必要な JSON/画面を返す。
    //   agent list  → pane_exists 判定を通すため対象 pane を含む JSON
    //   pane read   → send-text 反映確認を通すため "Pasted text"
    //   agent focus → focused:true（成功扱い）
    const shim = [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${herdrLog}"`,
      'case "$1 $2" in',
      '  "agent list") echo \'{"result":{"agents":[{"pane_id":"w1:p1"}]}}\' ;;',
      '  "agent focus") echo \'{"focused":true}\' ;;',
      '  "pane read") echo "Pasted text" ;;',
      '  *) : ;;',
      'esac',
      '',
    ].join('\n')
    await writeFile(herdrBin, shim)
    await chmod(herdrBin, 0o755)
  })

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  async function runHerdrRelay(payload) {
    await writeFile(herdrLog, '')
    const res = spawnSync('bash', ['server/notification-hub/reply-relay-herdr.sh'], {
      cwd: PROJECT_ROOT,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        HERDR_BIN: herdrBin,
        RELAY_LOG_FILE: path.join(workDir, 'events.jsonl'),
        RELAY_AGENT_LOG_FILE: path.join(workDir, 'agent.log'),
        RELAY_HERDR_SEND_TEXT_WAIT: '0',
      },
    })
    const calls = (await readFile(herdrLog, 'utf8')).split('\n').filter(Boolean)
    return { res, calls }
  }

  it('通常返信: agent focus が pane send-keys Enter の直前に入る', async () => {
    const { res, calls } = await runHerdrRelay({
      reply: { action: 'comment', comment: 'pong-reply', source: 'g2' },
      notification: {
        id: 'n-reply',
        title: 'done',
        metadata: { agentName: 'copilot', tmuxTarget: `herdr:${TARGET}` },
      },
    })
    expect(res.status, res.stderr).toBe(0)
    const focusIdx = calls.findIndex((c) => c === `agent focus ${TARGET}`)
    const enterIdx = calls.findIndex((c) => c === `pane send-keys ${TARGET} Enter`)
    expect(focusIdx).toBeGreaterThanOrEqual(0)
    expect(enterIdx).toBeGreaterThanOrEqual(0)
    expect(focusIdx).toBeLessThan(enterIdx)
  })

  it('承認 approve: agent focus の後に番号キー 1 を送る', async () => {
    const { res, calls } = await runHerdrRelay({
      reply: { action: 'approve', source: 'g2' },
      notification: {
        id: 'n-approve',
        title: 'bash',
        metadata: { hookType: 'permission-request', agentName: 'copilot', tmuxTarget: `herdr:${TARGET}` },
      },
    })
    expect(res.status, res.stderr).toBe(0)
    const focusIdx = calls.findIndex((c) => c === `agent focus ${TARGET}`)
    const oneIdx = calls.findIndex((c) => c === `pane send-keys ${TARGET} 1`)
    expect(focusIdx).toBeGreaterThanOrEqual(0)
    expect(oneIdx).toBeGreaterThanOrEqual(0)
    expect(focusIdx).toBeLessThan(oneIdx)
    // approve は Escape を送らない
    expect(calls.some((c) => c.includes('Escape'))).toBe(false)
  })

  it('非 copilot(claude) の herdr 返信では agent focus を呼ばない', async () => {
    const { res, calls } = await runHerdrRelay({
      reply: { action: 'comment', comment: 'hi-claude', source: 'g2' },
      notification: {
        id: 'n-claude',
        title: 'done',
        metadata: { agentName: 'claude-code', tmuxTarget: `herdr:${TARGET}` },
      },
    })
    expect(res.status, res.stderr).toBe(0)
    expect(calls.some((c) => c.startsWith('agent focus'))).toBe(false)
    // 従来どおり Enter で submit する
    expect(calls.some((c) => c === `pane send-keys ${TARGET} Enter`)).toBe(true)
  })
})
