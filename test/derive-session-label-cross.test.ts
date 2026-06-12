/**
 * deriveSessionLabel のクライアント/サーバー二重実装の同一性クロステスト
 *
 * クライアント（src/g2/text-format.ts）とサーバー（server/notification-hub/
 * notification-utils.mjs）はビルド境界が異なるため実装を統合できない
 * （docs/refactor-plan.md Phase 7）。代わりに代表入力で出力同一性を固定し、
 * 片側だけ変更されたら検知する。
 */
import { describe, expect, it } from 'vitest'
import { deriveSessionLabel as clientImpl } from '../src/g2/text-format'
// @ts-expect-error -- サーバー側は JSDoc 型の .mjs（ビルド境界の都合で型定義なし）
import { deriveSessionLabel as serverImpl } from '../server/notification-hub/notification-utils.mjs'

const CASES = [
  'g2-cc-g2-4c4a:0.0', // ハッシュ付き → #1
  'g2-myrepo-1a2b-2:0.0', // ハッシュ+連番 → #2
  'g2-myrepo-1a2b-12:0.0', // 2桁連番 → #12
  'g2-minimalmem-246c:0.0', // ハッシュのみ → #1
  'plain-session:0.0', // ハッシュなし → ''
  'g2-foo-12345:0.0', // 5桁はハッシュではない → ''
  'no-colon-session', // window/pane なし
  '', // 空
  ':0.0', // セッション名なし
]

describe('deriveSessionLabel クライアント/サーバー同一性', () => {
  for (const input of CASES) {
    it(`"${input}" で両実装の出力が一致する`, () => {
      expect(clientImpl(input)).toBe(serverImpl(input))
    })
  }

  it('代表値のスナップショット（両実装共通の期待値）', () => {
    expect(CASES.map((c) => ({ input: c, label: clientImpl(c) }))).toMatchSnapshot()
  })
})
