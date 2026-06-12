// scripts/lib/*.sh の「関数定義のみ」契約を機械的に強制するテスト
//
// cc-g2.sh の分割ライブラリ（Phase 6）は source 順・変数初期化タイミングを
// エントリ側が握る前提のため、lib 側にトップレベルの処理・変数定義・出力が
// 混入すると起動が静かに壊れる。コメントの警告では防げないので、
// 「source しても 出力ゼロ・エラーゼロ・新しいグローバル変数ゼロ
// （増えてよいのは関数定義だけ）」をここで検査する。
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LIB_FILES = [
  'scripts/lib/common.sh',
  'scripts/lib/tokens.sh',
  'scripts/lib/infra.sh',
  'scripts/lib/tmux-session.sh',
  'scripts/lib/agent-launch.sh',
  'scripts/lib/doctor.sh',
]

// source 前後の変数集合を比較し、出力・終了コードと合わせて報告する検査スクリプト。
// __ プレフィックス（この検査自身の変数）と bash が暗黙に触る変数は除外する。
const PROBE = `
__tmp_out=$(mktemp); __tmp_err=$(mktemp)
__b=$(compgen -v | sort)
set -u
source "$1" >"$__tmp_out" 2>"$__tmp_err"
__rc=$?
set +u
__a=$(compgen -v | sort)
echo "RC:$__rc"
echo "OUT_BYTES:$(wc -c < "$__tmp_out" | tr -d ' ')"
echo "ERR_BYTES:$(wc -c < "$__tmp_err" | tr -d ' ')"
echo "NEWVARS:$(comm -13 <(printf '%s\\n' "$__b") <(printf '%s\\n' "$__a") | grep -v '^__' | grep -vE '^(PIPESTATUS|_|OLDPWD)$' | tr '\\n' ' ')"
rm -f "$__tmp_out" "$__tmp_err"
`

function probeLib(libPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      ['--noprofile', '--norc', '-c', PROBE, 'probe', libPath],
      { cwd: repoRoot },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(err)
        const get = (key) => stdout.match(new RegExp(`^${key}:(.*)$`, 'm'))?.[1] ?? null
        resolve({
          rc: get('RC'),
          outBytes: get('OUT_BYTES'),
          errBytes: get('ERR_BYTES'),
          newVars: (get('NEWVARS') ?? '').trim(),
          stderr,
        })
      },
    )
  })
}

describe('scripts/lib は「関数定義のみ」の純粋ライブラリ', () => {
  for (const lib of LIB_FILES) {
    it(`${lib}: source しても出力・エラー・新規グローバル変数が生えない`, async () => {
      const r = await probeLib(path.join(repoRoot, lib))
      expect(r.stderr).toBe('')
      expect(r.rc).toBe('0')
      expect(r.outBytes).toBe('0')
      expect(r.errBytes).toBe('0')
      expect(r.newVars).toBe('')
    })
  }

  it('検査自体が違反を検出できる（自己テスト）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lib-pure-'))
    try {
      const bad = path.join(dir, 'bad.sh')
      await writeFile(bad, '#!/usr/bin/env bash\nBAD_TOPLEVEL_VAR=1\necho "side effect"\n')
      const r = await probeLib(bad)
      expect(r.outBytes).not.toBe('0') // echo を検出
      expect(r.newVars).toContain('BAD_TOPLEVEL_VAR') // トップレベル変数を検出
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
