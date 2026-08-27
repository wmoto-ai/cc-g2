/**
 * build_g2_tmux_env の Copilot BYOK env gate のテスト
 *
 * COPILOT_MODEL / COPILOT_HOME / COPILOT_PROVIDER_*（BYOK の API キーを含み得る）は
 * copilot モードのセッションにのみ伝搬し、claude/codex セッションには注入しない。
 * COPILOT_BIN は鍵ではないので常時伝搬する。tmux 不要の純関数テスト。
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// build_g2_tmux_env を指定 agent_mode で呼び、生成された G2_TMUX_ENV 配列を 1 行ずつ返す
function runBuildEnv(agentMode) {
  const snippet = `
    source scripts/lib/common.sh
    source scripts/lib/tmux-session.sh
    export COPILOT_MODEL=qwen36
    export COPILOT_HOME=/tmp/copilot-home
    export COPILOT_PROVIDER_QWEN_API_KEY=secret123
    build_g2_tmux_env "g2-test-abcd${agentMode === 'copilot' ? '-copilot' : ''}" "${agentMode}"
    printf '%s\\n' "\${G2_TMUX_ENV[@]}"
  `
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', snippet], { cwd: repoRoot }, (err, stdout) => {
      if (err && !stdout) return reject(err)
      resolve(stdout.split('\n').filter(Boolean))
    })
  })
}

describe('build_g2_tmux_env copilot BYOK env gate', () => {
  it('copilot モードでは COPILOT_MODEL/HOME/PROVIDER_* を伝搬する', async () => {
    const lines = await runBuildEnv('copilot')
    expect(lines).toContain('COPILOT_MODEL=qwen36')
    expect(lines).toContain('COPILOT_HOME=/tmp/copilot-home')
    expect(lines).toContain('COPILOT_PROVIDER_QWEN_API_KEY=secret123')
    expect(lines).toContain('COPILOT_BIN=')
  })

  it('claude モードでは BYOK env を注入しない（COPILOT_BIN のみ）', async () => {
    const lines = await runBuildEnv('claude')
    expect(lines).not.toContain('COPILOT_MODEL=qwen36')
    expect(lines).not.toContain('COPILOT_HOME=/tmp/copilot-home')
    expect(lines).not.toContain('COPILOT_PROVIDER_QWEN_API_KEY=secret123')
    // COPILOT_BIN は鍵ではないので常時伝搬される
    expect(lines).toContain('COPILOT_BIN=')
  })

  it('codex モードでも BYOK env を注入しない', async () => {
    const lines = await runBuildEnv('codex')
    expect(lines).not.toContain('COPILOT_MODEL=qwen36')
    expect(lines).not.toContain('COPILOT_PROVIDER_QWEN_API_KEY=secret123')
  })
})
