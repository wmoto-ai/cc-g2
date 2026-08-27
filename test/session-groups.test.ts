/**
 * セッション別一覧の純ロジック（session-groups.ts）テスト
 *
 * グルーピング / 行生成 / バイト予算 / 絞り込みを SDK・DOM 非依存で固定する。
 * ロケールは既定 ja のまま（sess_all='すべて'）。
 */
import { describe, expect, it } from 'vitest'
import type { NotificationItem } from '../src/notifications'
import {
  ALL_FILTER,
  activitySessionKey,
  buildSessionGroups,
  deriveSessionKey,
  filterItemsBySession,
  formatSessionRow,
  sessionShortName,
  type SessionActivityLike,
} from '../src/g2/session-groups'

const encoder = new TextEncoder()

function item(id: string, metadata?: Record<string, unknown>): NotificationItem {
  return {
    id,
    source: 'claude-code',
    title: 'Bash',
    summary: '',
    createdAt: new Date('2026-06-10T12:00:00+09:00').toISOString(),
    replyCapable: true,
    metadata,
  }
}

describe('deriveSessionKey（優先順: sessionLabel > tmuxTarget > cwd basename > other）', () => {
  it('sessionLabel が最優先', () => {
    expect(deriveSessionKey({ sessionLabel: '#3', tmuxTarget: 'g2-cc-g2-4c4a:0.0', cwd: '/a/b' })).toBe('#3')
  })
  it('sessionLabel 無しは tmuxTarget から deriveSessionLabel', () => {
    expect(deriveSessionKey({ tmuxTarget: 'g2-cc-g2-4c4a:0.0' })).toBe('#1')
    expect(deriveSessionKey({ tmuxTarget: 'g2-myrepo-1a2b-2:0.0' })).toBe('#2')
  })
  it('tmuxTarget が deriveSessionLabel で空なら cwd basename', () => {
    expect(deriveSessionKey({ tmuxTarget: 'plain-session:0.0', cwd: '/work/my-proj' })).toBe('my-proj')
  })
  it('[REDACTED] は無視する', () => {
    expect(deriveSessionKey({ tmuxTarget: '[REDACTED]', cwd: '[REDACTED]' })).toBe('other')
  })
  it('何も無ければ other', () => {
    expect(deriveSessionKey(undefined)).toBe('other')
    expect(deriveSessionKey({})).toBe('other')
  })
})

describe('activitySessionKey は通知キーと突き合わせられる', () => {
  it('activity.tmuxTarget から通知と同じキーを得る', () => {
    const act: SessionActivityLike = { tmuxTarget: 'g2-cc-g2-4c4a:0.0', label: '#1', state: 'active' }
    expect(activitySessionKey(act)).toBe('#1')
    expect(activitySessionKey(act)).toBe(deriveSessionKey({ tmuxTarget: 'g2-cc-g2-4c4a:0.0' }))
  })

  it('herdr エントリは label(cwd basename)にフォールバックし、other と衝突しない', () => {
    // deriveSessionLabel は herdr:w4:p1 を知らず '' → 素通しだと 'other' に落ちて
    // タグなし通知と混ざる(シミュレータ検証 2026-07-13 で発覚)
    const act: SessionActivityLike = { tmuxTarget: 'herdr:w4:p1', label: 'cc-g2', state: 'idle' }
    expect(activitySessionKey(act)).toBe('cc-g2')
    // 通知側: herdr セッションの通知は cwd basename に落ちるため一致する
    expect(deriveSessionKey({ tmuxTarget: 'herdr:%5', cwd: '/work/cc-g2' })).toBe('cc-g2')
    // label まで空なら other(タグなし通知と同グループでよい)
    expect(activitySessionKey({ tmuxTarget: 'herdr:w4:p9', label: ' ', state: 'idle' })).toBe('other')
  })
})

describe('filterItemsBySession', () => {
  const items = [
    item('a', { tmuxTarget: 'g2-cc-g2-4c4a:0.0' }), // #1
    item('b', { tmuxTarget: 'g2-myrepo-1a2b-2:0.0' }), // #2
    item('c', { sessionLabel: '#1' }), // #1
  ]
  it('null は全件', () => {
    expect(filterItemsBySession(items, null)).toHaveLength(3)
    expect(filterItemsBySession(items, ALL_FILTER.key)).toHaveLength(3)
  })
  it('キー一致のみ返す', () => {
    expect(filterItemsBySession(items, '#1').map((i) => i.id)).toEqual(['a', 'c'])
    expect(filterItemsBySession(items, '#2').map((i) => i.id)).toEqual(['b'])
    expect(filterItemsBySession(items, 'nope')).toEqual([])
  })
})

describe('buildSessionGroups', () => {
  it('先頭は All 行（key=null, 件数=全件）', () => {
    const groups = buildSessionGroups([item('a', { sessionLabel: '#1' })], [])
    expect(groups[0]).toEqual({ key: null, label: 'すべて', state: null, count: 1 })
  })

  it('通知キーと activities の和集合を作り、件数と状態マークを付ける', () => {
    const items = [
      item('a', { tmuxTarget: 'g2-cc-g2-4c4a:0.0' }), // #1
      item('b', { tmuxTarget: 'g2-cc-g2-4c4a:0.0' }), // #1
      item('c', { sessionLabel: '#2' }), // #2 (activity 無し)
    ]
    const activities: SessionActivityLike[] = [
      { tmuxTarget: 'g2-cc-g2-4c4a:0.0', label: '#1', state: 'active' }, // #1 → active
      { tmuxTarget: 'g2-idle-9999:0.0', label: '#1', state: 'idle' }, // 通知0件のセッション
    ]
    const groups = buildSessionGroups(items, activities)
    const byKey = Object.fromEntries(groups.filter((g) => g.key !== null).map((g) => [g.key, g]))
    // #1: 通知2件 + active activity。表示ラベルは activity の短縮名
    expect(byKey['#1']).toEqual({ key: '#1', label: 'cc-g2', state: 'active', count: 2 })
    // #2: 通知1件、activity 無し → 状態 null、ラベルはキーそのもの
    expect(byKey['#2']).toEqual({ key: '#2', label: '#2', state: null, count: 1 })
    // All 行 + #1 + #2 の 3 行（#1 の2つの activity は同一キーに畳まれる）
    expect(groups).toHaveLength(3)
  })

  it('件数降順→ラベル昇順で決定的に並ぶ', () => {
    const items = [
      item('a', { sessionLabel: 'zzz' }),
      item('b', { sessionLabel: 'aaa' }),
      item('c', { sessionLabel: 'aaa' }),
    ]
    const groups = buildSessionGroups(items, [])
    expect(groups.map((g) => g.key)).toEqual([null, 'aaa', 'zzz'])
  })
})

describe('formatSessionRow', () => {
  it('状態マーク + ラベル + 件数', () => {
    expect(formatSessionRow({ key: '#1', label: 'cc-g2', state: 'active', count: 3 })).toBe('▶ cc-g2 (3)')
    expect(formatSessionRow({ key: '#2', label: '#2', state: null, count: 1 })).toBe('· #2 (1)')
    expect(formatSessionRow({ key: null, label: 'すべて', state: null, count: 12 })).toBe('☰ すべて (12)')
  })

  it('長いラベルは 45 バイト予算に切り詰める', () => {
    const row = formatSessionRow({ key: 'k', label: 'とても長い日本語ラベル'.repeat(5), state: 'active', count: 7 })
    expect(encoder.encode(row).length).toBeLessThanOrEqual(45)
    expect(row.endsWith(' (7)')).toBe(true)
  })
})

describe('sessionShortName', () => {
  it('g2- とハッシュを除去して短縮', () => {
    expect(sessionShortName({ tmuxTarget: 'g2-cc-g2-4c4a:0.0' })).toBe('cc-g2')
    expect(sessionShortName({ tmuxTarget: 'g2-minimalmem-246c:0.0' })).toBe('minima')
  })

  it('herdr エントリは label を優先(全部 "herdr" 表示になる問題の回避)', () => {
    expect(sessionShortName({ tmuxTarget: 'herdr:w4:p2', label: 'cc-g2' })).toBe('cc-g2')
    expect(sessionShortName({ tmuxTarget: 'herdr:w4:p1', label: 'mem' })).toBe('mem')
    expect(sessionShortName({ tmuxTarget: 'herdr:w4:p1' })).toBe('herdr')
  })
})
