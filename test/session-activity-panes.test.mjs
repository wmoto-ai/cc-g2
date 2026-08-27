/**
 * session-activity のペイン選択・承認マッチングの単体テスト
 *
 * 回帰の背景（fix/qr-pane-and-hub-bugs のレビューで発見）:
 * - metadata.tmuxTarget が pane_id（%N）形式に変わり、`session:0.0` 形式の
 *   list-panes ターゲットとの等値比較が永久に不一致になっていた
 * - QR 常駐ペインの導入で 1 セッションが 2 エントリに二重計上され、
 *   G2 ヘッダーの表示枠（最大4）を浪費していた
 */
import { describe, it, expect } from 'vitest'

// 静的 import は hoist され env 設定より先に実行されるため、動的 import で
// ポーリング開始ガード（CC_G2_SESSION_ACTIVITY_DISABLED）を確実に効かせる
process.env.CC_G2_SESSION_ACTIVITY_DISABLED = '1'
const { selectActivityPanes, approvalTargetsPane } = await import(
  '../server/notification-hub/session-activity.mjs'
)

const line = (target, paneId, agentPane = '', qrPane = '') =>
  `${target}|${paneId}|/dev/ttys001|12345|${agentPane}|${qrPane}`

describe('selectActivityPanes', () => {
  it('QR ペイン（@cc_g2_qr_pane）を除外し、agent ペインだけを対象にする', () => {
    const panes = selectActivityPanes([
      line('g2-myrepo-abcd:0.0', '%19', '%18', '%19'), // QR ペイン（上）
      line('g2-myrepo-abcd:0.1', '%18', '%18', '%19'), // agent ペイン（下）
    ])
    expect(panes).toHaveLength(1)
    expect(panes[0].paneId).toBe('%18')
    expect(panes[0].target).toBe('g2-myrepo-abcd:0.1')
  })

  it('@cc_g2_agent_pane 未記録の旧セッションは従来どおり全ペインを対象にする', () => {
    const panes = selectActivityPanes([line('g2-old-1234:0.0', '%3')])
    expect(panes).toHaveLength(1)
    expect(panes[0].target).toBe('g2-old-1234:0.0')
  })

  it('g2- 以外のセッションは対象外', () => {
    const panes = selectActivityPanes([
      line('main:0.0', '%1'),
      line('g2-repo-aaaa:0.0', '%2', '%2'),
    ])
    expect(panes).toHaveLength(1)
    expect(panes[0].target).toBe('g2-repo-aaaa:0.0')
  })

  it('複数の g2 セッションはそれぞれ 1 エントリになる', () => {
    const panes = selectActivityPanes([
      line('g2-a-1111:0.0', '%10', '%11', '%10'),
      line('g2-a-1111:0.1', '%11', '%11', '%10'),
      line('g2-b-2222:0.0', '%20', '%21', '%20'),
      line('g2-b-2222:0.1', '%21', '%21', '%20'),
    ])
    expect(panes.map((p) => p.paneId).sort()).toEqual(['%11', '%21'])
  })
})

describe('approvalTargetsPane', () => {
  const pane = { target: 'g2-myrepo-abcd:0.1', paneId: '%18' }

  it('新形式（pane_id）の metadata.tmuxTarget とマッチする', () => {
    expect(approvalTargetsPane('%18', pane)).toBe(true)
  })

  it('旧形式（session:window.pane）の metadata.tmuxTarget ともマッチする', () => {
    expect(approvalTargetsPane('g2-myrepo-abcd:0.1', pane)).toBe(true)
  })

  it('別ペインの承認はマッチしない', () => {
    expect(approvalTargetsPane('%19', pane)).toBe(false)
    expect(approvalTargetsPane('g2-other-9999:0.0', pane)).toBe(false)
    expect(approvalTargetsPane('', pane)).toBe(false)
    expect(approvalTargetsPane(undefined, pane)).toBe(false)
  })
})
