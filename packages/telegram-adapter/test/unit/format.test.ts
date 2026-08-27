import { describe, expect, it } from 'vitest'
import type { ApprovalRecord } from '../../src/hub/types'
import {
  escapeHtml,
  formatApprovalMessage,
  formatGenericMessage,
  formatImageCaption,
  formatOutcomeFooter,
  formatStopMessage,
  G2_META,
  outcomeFromApproval,
  PREVIEW_MAX_CHARS,
  repoNameFromCwd,
  sanitizeSessionSlug,
  sessionMetaLine,
  TRUNCATION_NOTICE,
  truncateText,
} from '../../src/telegram/format'

describe('escapeHtml / truncateText', () => {
  it('& < > をエスケープする', () => {
    expect(escapeHtml('<b>&"x"</b>')).toBe('&lt;b&gt;&amp;"x"&lt;/b&gt;')
  })

  it('上限以内はそのまま、超えたら切詰め表示を付ける', () => {
    expect(truncateText('abc')).toBe('abc')
    const long = 'あ'.repeat(PREVIEW_MAX_CHARS + 1)
    const out = truncateText(long)
    expect(out.endsWith(TRUNCATION_NOTICE)).toBe(true)
    expect(out.length).toBe(PREVIEW_MAX_CHARS + TRUNCATION_NOTICE.length)
  })
})

describe('repoNameFromCwd', () => {
  it('末尾要素を返す', () => {
    expect(repoNameFromCwd('/work/example-repo')).toBe('example-repo')
    expect(repoNameFromCwd('/tmp/demo/')).toBe('demo')
    expect(repoNameFromCwd(undefined)).toBe('')
    expect(repoNameFromCwd('/')).toBe('')
  })
})

describe('sanitizeSessionSlug / sessionMetaLine', () => {
  it('空白を - に畳み、許可外文字を除去し、24 文字に切る', () => {
    expect(sanitizeSessionSlug('cc-g2')).toBe('cc-g2')
    expect(sanitizeSessionSlug('  repo name  ')).toBe('repo-name')
    expect(sanitizeSessionSlug('feat/telegram #1')).toBe('feattelegram-1')
    expect(sanitizeSessionSlug('日本語ラベル')).toBe('')
    expect(sanitizeSessionSlug('a'.repeat(40))).toBe('a'.repeat(24))
    expect(sanitizeSessionSlug(undefined)).toBe('')
  })

  it('sessionLabel 優先・無ければ cwd 末尾 repo 名から meta 行を組む', () => {
    expect(sessionMetaLine('#1', '/tmp/demo')).toBe(`${G2_META.sessPrefix}1`)
    expect(sessionMetaLine(undefined, '/repo/my-app')).toBe(`${G2_META.sessPrefix}my-app`)
    // スラグが空になる(サニタイズで消える・情報なし)場合は行を付けない
    expect(sessionMetaLine('日本語', undefined)).toBeNull()
    expect(sessionMetaLine(undefined, undefined)).toBeNull()
  })
})

describe('formatApprovalMessage', () => {
  it('ツール名・repo・エージェント・cwd・プレビューを含む HTML を組む', () => {
    const html = formatApprovalMessage({
      toolName: 'Bash',
      agentName: 'claude-code',
      sessionLabel: '#1',
      cwd: '/tmp/demo',
      preview: '$ rm -rf <dir>',
    })
    expect(html).toContain('🔐 <b>Bash</b> — demo <i>(claude-code #1)</i>')
    expect(html).toContain('<code>/tmp/demo</code>')
    expect(html).toContain('<blockquote expandable><pre>$ rm -rf &lt;dir&gt;</pre></blockquote>')
    // マーカー行の直後に meta 行(sessionLabel 由来)が付く
    expect(html).toContain(`<i>· cc-g2:approval</i>\n<i>${G2_META.sessPrefix}1</i>`)
  })

  it('セッション情報が無ければ meta 行を付けない(後方互換)', () => {
    const html = formatApprovalMessage({ toolName: 'Edit' })
    expect(html).not.toContain(G2_META.sessPrefix)
  })

  it('cwd・プレビューなしでも壊れない', () => {
    const html = formatApprovalMessage({ toolName: 'Edit' })
    expect(html).toBe('🔐 <b>Edit</b>\n<i>· cc-g2:approval</i>')
  })

  it('4096 字制限に収まる(長大プレビュー + フッタ余白)', () => {
    const html = formatApprovalMessage({
      toolName: 'Bash',
      cwd: '/tmp/demo',
      preview: 'x'.repeat(10_000),
    })
    expect(html.length).toBeLessThan(4_000)
  })
})

describe('formatStopMessage', () => {
  it('タイトル・場所・本文・返信ガイドを含む', () => {
    const html = formatStopMessage({
      title: 'Session finished',
      body: '作業完了',
      cwd: '/repo/my-app',
    })
    expect(html).toContain('🏁 <b>Session finished</b> — my-app')
    expect(html).toContain('<blockquote expandable>作業完了</blockquote>')
    expect(html).toContain('返信するとセッションへ送信されます')
  })

  it('cwd がなければ sessionLabel → tmuxTarget の順で場所を出す', () => {
    expect(formatStopMessage({ title: 't', sessionLabel: '#2' })).toContain('— #2')
    expect(formatStopMessage({ title: 't', tmuxTarget: 'demo:0.0' })).toContain('— demo:0.0')
  })

  it('マーカー行の直後に meta 行(cwd 由来の repo 名)を付ける', () => {
    const html = formatStopMessage({ title: 'done', cwd: '/repo/my-app' })
    expect(html).toContain(`<i>· cc-g2:stop</i>\n<i>${G2_META.sessPrefix}my-app</i>`)
  })

  it('セッション情報が無ければ meta 行を付けない(後方互換)', () => {
    expect(formatStopMessage({ title: 't', tmuxTarget: 'demo:0.0' })).not.toContain(
      G2_META.sessPrefix,
    )
  })
})

describe('formatImageCaption', () => {
  it('タイトル + 画像マーカー(parse_mode 無しのプレーン)を返す', () => {
    expect(formatImageCaption({ title: 'スクショ' })).toBe('スクショ\n· cc-g2:image')
  })

  it('cwd / セッション情報があれば meta 行を付ける', () => {
    expect(formatImageCaption({ title: 'スクショ', cwd: '/repo/my-app' })).toBe(
      `スクショ\n· cc-g2:image\n${G2_META.sessPrefix}my-app`,
    )
    expect(formatImageCaption({ title: 'スクショ', sessionLabel: '#3' })).toBe(
      `スクショ\n· cc-g2:image\n${G2_META.sessPrefix}3`,
    )
  })
})

describe('formatGenericMessage', () => {
  it('タイトル・source・本文を含み、返信ガイドは付けない', () => {
    const html = formatGenericMessage({
      title: 'brew: CVE検出 (mini)',
      body: 'CVEあり対応不可: pcre2',
      source: 'brew-security-check',
    })
    expect(html).toContain('📣 <b>brew: CVE検出 (mini)</b> <i>(brew-security-check)</i>')
    expect(html).toContain('<blockquote expandable>CVEあり対応不可: pcre2</blockquote>')
    expect(html).not.toContain('返信するとセッションへ送信されます')
  })

  it('body/source なしでもタイトルだけで成立し、HTML はエスケープされる', () => {
    expect(formatGenericMessage({ title: '<t>' })).toBe(
      '📣 <b>&lt;t&gt;</b>\n<i>· cc-g2:generic</i>',
    )
  })
})

describe('formatOutcomeFooter / outcomeFromApproval', () => {
  const at = new Date(2026, 6, 7, 12, 34)

  it('Telegram 発の approve/deny(コメント込み)', () => {
    expect(formatOutcomeFooter({ kind: 'approved-via-telegram' }, at)).toBe(
      '✅ <b>Approved</b> via Telegram (12:34)',
    )
    const deny = formatOutcomeFooter({ kind: 'denied-via-telegram', comment: '<危険>' }, at)
    expect(deny).toContain('⛔ <b>Denied</b> via Telegram (12:34)')
    expect(deny).toContain('💬 &lt;危険&gt;')
  })

  it('別経路決着・自動クローズ・期限切れ', () => {
    expect(
      formatOutcomeFooter({ kind: 'decided-elsewhere', decision: 'approve', decidedBy: 'g2' }, at),
    ).toContain('別経路 (g2) で対応済み')
    expect(formatOutcomeFooter({ kind: 'terminal-disconnect' }, at)).toContain('PC 側で対応済み')
    expect(formatOutcomeFooter({ kind: 'session-ended' }, at)).toContain('セッション終了')
    expect(formatOutcomeFooter({ kind: 'expired' }, at)).toContain('期限切れ')
  })

  it('outcomeFromApproval は decision → resolution の順で導出する', () => {
    const base: ApprovalRecord = {
      id: 'a',
      notificationId: 'n',
      source: 's',
      toolName: 'Bash',
      toolInput: null,
      toolId: '',
      cwd: '',
      reason: '',
      agentName: 'claude-code',
      status: 'decided',
      createdAt: new Date().toISOString(),
    }
    expect(outcomeFromApproval({ ...base, decision: 'deny', decidedBy: 'web', comment: 'c' })).toEqual({
      kind: 'decided-elsewhere',
      decision: 'deny',
      decidedBy: 'web',
      comment: 'c',
    })
    expect(outcomeFromApproval({ ...base, resolution: 'terminal-disconnect' })).toEqual({
      kind: 'terminal-disconnect',
    })
    expect(outcomeFromApproval({ ...base, resolution: 'session-ended' })).toEqual({
      kind: 'session-ended',
    })
    expect(outcomeFromApproval({ ...base, resolution: 'weird' })).toEqual({
      kind: 'closed-other',
      note: 'weird',
    })
  })
})
