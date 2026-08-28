import { afterEach, describe, expect, it } from 'vitest'
import { detectLocale, getLocale, initI18n, localeTag, setLocale, t, tp } from '../src/i18n'

// 各テスト後に既定(ja)へ戻す。他テストは initI18n を呼ばず ja のまま原文一致に依存する。
afterEach(() => setLocale('ja'))

describe('detectLocale', () => {
  it('明示指定(ja/en)が最優先', () => {
    expect(detectLocale('en', 'ja-JP')).toBe('en')
    expect(detectLocale('ja', 'en-US')).toBe('ja')
  })

  it("自動('')は navigator.language が ja 始まりなら ja、それ以外 en", () => {
    expect(detectLocale('', 'ja')).toBe('ja')
    expect(detectLocale('', 'ja-JP')).toBe('ja')
    expect(detectLocale('', 'en-US')).toBe('en')
    expect(detectLocale('', undefined)).toBe('en')
    expect(detectLocale('', '')).toBe('en')
  })

  it('不正な設定値は自動判定に落ちる', () => {
    expect(detectLocale('fr', 'ja-JP')).toBe('ja')
    expect(detectLocale('fr', 'en-US')).toBe('en')
  })
})

describe('t / tp', () => {
  it('既定ロケールは ja(初期化前は原文のまま)', () => {
    expect(getLocale()).toBe('ja')
    expect(t('status_disconnected')).toBe('未接続')
  })

  it('setLocale で en に切り替わる', () => {
    setLocale('en')
    expect(t('status_disconnected')).toBe('Disconnected')
    expect(t('act_back')).toBe('◀ Back')
  })

  it('tp は {name} プレースホルダを差し替える', () => {
    setLocale('ja')
    expect(tp('notif_count', { n: 3 })).toBe('3件')
    setLocale('en')
    expect(tp('notif_count', { n: 3 })).toBe('3 items')
    expect(tp('answer_label', { label: 'Yes' })).toBe('Answer: Yes')
  })
})

describe('initI18n / localeTag', () => {
  it('initI18n が設定値からロケールを確定する', () => {
    initI18n('en')
    expect(getLocale()).toBe('en')
    expect(localeTag()).toBe('en-US')
    initI18n('ja')
    expect(getLocale()).toBe('ja')
    expect(localeTag()).toBe('ja-JP')
  })
})

describe('辞書の健全性', () => {
  it('スナップショット依存の ja 値が原文とバイト一致する', () => {
    // これらは test/__snapshots__/glasses-ui-call-sequence.test.ts.snap と
    // paginate-text / format-and-wav テストが ja のまま参照するため固定する。
    setLocale('ja')
    expect(t('g2_idle')).toBe('待機中\n\nDblTap = 通知一覧')
    expect(t('act_comment')).toBe('コメント')
    expect(t('act_view_image')).toBe('画像を見る')
    expect(t('act_back')).toBe('◀ 戻る')
    expect(t('askq_other_voice')).toBe('その他（音声）')
    expect(t('askq_options_divider')).toBe('--- 選択肢 ---')
    expect(t('reply_send')).toBe('送信')
    expect(t('reply_rerecord')).toBe('再録')
    expect(t('reply_cancel')).toBe('キャンセル')
    expect(t('reply_body')).toBe('◀ 本文')
    expect(t('body_none')).toBe('（本文なし）')
    expect(t('stt_no_result')).toBe('（認識結果なし）')
  })
})
