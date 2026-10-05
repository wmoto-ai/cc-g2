/**
 * ensure_claude_folder_trust（lib/agent-launch.sh）のテスト
 *
 * Claude Code 2.1.231 前後から、folder trust（~/.claude.json の
 * projects[<dir>].hasTrustDialogAccepted）が true でないディレクトリでは
 * 対話セッションの hooks / statusLine が黙って無効化され、cc-g2 の通知注入が
 * 全滅する。launch_claude_agent はこのガードで起動前に state file を修復する。
 *
 * テストは CLAUDE_STATE_FILE で state file を一時ファイルに差し替え、
 * 非対話 stdin の経路を検証する（既定は記録せず警告のみ、CC_G2_AUTO_TRUST=1 で修復適用）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT } from './helpers/hub-harness.mjs'

let workDir

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'cc-g2-trust-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

/** state file を差し替えて ensure_claude_folder_trust を実行する */
function runGuard(stateFile, targetDir, env = {}) {
  const script = [
    'set -euo pipefail',
    'info() { echo "INFO:$*"; }',
    'warn() { echo "WARN:$*"; }',
    'source scripts/lib/common.sh',
    'source scripts/lib/agent-launch.sh',
    `CLAUDE_STATE_FILE='${stateFile}' ensure_claude_folder_trust '${targetDir}'`,
  ].join('\n')
  return spawnSync('bash', ['-c', script], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function readTrust(stateFile, dir) {
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  return state.projects?.[dir]?.hasTrustDialogAccepted
}

describe('ensure_claude_folder_trust', () => {
  it('非対話起動では既定で記録せず、警告だけ出して続行する', async () => {
    const stateFile = path.join(workDir, 'claude.json')
    const original = JSON.stringify({ projects: { '/proj/a': { hasTrustDialogAccepted: false } } })
    await writeFile(stateFile, original)
    const r = runGuard(stateFile, '/proj/a')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('folder trust は記録しません')
    expect(await readFile(stateFile, 'utf8')).toBe(original)
  })

  it('CC_G2_AUTO_TRUST=1 なら未信頼 (false) のエントリを true に修復する', async () => {
    const stateFile = path.join(workDir, 'claude.json')
    await writeFile(
      stateFile,
      JSON.stringify({ projects: { '/proj/a': { hasTrustDialogAccepted: false, allowedTools: [] } } }),
    )
    const r = runGuard(stateFile, '/proj/a', { CC_G2_AUTO_TRUST: '1' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('folder trust を記録しました')
    expect(await readTrust(stateFile, '/proj/a')).toBe(true)
    // 既存フィールドは保持される
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    expect(state.projects['/proj/a'].allowedTools).toEqual([])
  })

  it('エントリが無いディレクトリはエントリごと作成する', async () => {
    const stateFile = path.join(workDir, 'claude.json')
    await writeFile(stateFile, JSON.stringify({ projects: {} }))
    const r = runGuard(stateFile, '/proj/new', { CC_G2_AUTO_TRUST: '1' })
    expect(r.status).toBe(0)
    expect(await readTrust(stateFile, '/proj/new')).toBe(true)
  })

  it('信頼済み (true) なら state file に触れない', async () => {
    const stateFile = path.join(workDir, 'claude.json')
    const original = JSON.stringify({ projects: { '/proj/a': { hasTrustDialogAccepted: true } } })
    await writeFile(stateFile, original)
    const r = runGuard(stateFile, '/proj/a')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(await readFile(stateFile, 'utf8')).toBe(original)
  })

  it('state file が無ければ何もしない（新規作成もしない）', async () => {
    const stateFile = path.join(workDir, 'missing.json')
    const r = runGuard(stateFile, '/proj/a')
    expect(r.status).toBe(0)
    expect(existsSync(stateFile)).toBe(false)
  })

  it('壊れた JSON でも起動を止めず、state file を壊さない', async () => {
    const stateFile = path.join(workDir, 'claude.json')
    await writeFile(stateFile, '{not json')
    const r = runGuard(stateFile, '/proj/a')
    expect(r.status).toBe(0)
    expect(await readFile(stateFile, 'utf8')).toBe('{not json')
  })
})
