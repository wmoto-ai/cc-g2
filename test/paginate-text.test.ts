import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlassesUI, paginateText } from '../src/glasses-ui'

/** UTF-8バイト数を返すヘルパー */
const byteLen = (s: string) => new TextEncoder().encode(s).length

describe('paginateText', () => {
  it('空文字列 → ["（本文なし）"]', () => {
    expect(paginateText('')).toEqual(['（本文なし）'])
  })

  it('null/undefined → ["（本文なし）"]', () => {
    // @ts-expect-error -- 防御的テスト
    expect(paginateText(null)).toEqual(['（本文なし）'])
    // @ts-expect-error
    expect(paginateText(undefined)).toEqual(['（本文なし）'])
  })

  it('999バイト以下のASCII → 1チャンク', () => {
    const text = 'a'.repeat(999) // 999 bytes
    const result = paginateText(text)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(text)
  })

  it('1000バイトのASCII → 2チャンク', () => {
    const text = 'a'.repeat(1000)
    const result = paginateText(text)
    expect(result).toHaveLength(2)
    expect(byteLen(result[0])).toBe(999)
    expect(byteLen(result[1])).toBe(1)
  })

  it('日本語テキストは3bytes/文字でチャンク分割される', () => {
    // 'あ' = 3 bytes → 333文字 = 999 bytes (1チャンク), 334文字 = 1002 bytes (2チャンク) ※SDK上限999bytes
    const text333 = 'あ'.repeat(333)
    expect(paginateText(text333)).toHaveLength(1)
    expect(byteLen(text333)).toBe(999)

    const text334 = 'あ'.repeat(334)
    expect(paginateText(text334)).toHaveLength(2)
  })

  it('各チャンクが999バイトを超えない', () => {
    const text = 'あ'.repeat(1000) // 3000 bytes
    const result = paginateText(text)
    for (const chunk of result) {
      expect(byteLen(chunk)).toBeLessThanOrEqual(999)
    }
    // 全チャンク結合で元テキストと一致
    expect(result.join('')).toBe(text)
  })

  it('改行位置でチャンク分割される', () => {
    // 989 bytes + \n + 20 bytes = 1010 bytes
    const before = 'x'.repeat(989)
    const after = 'y'.repeat(20)
    const text = `${before}\n${after}`
    const result = paginateText(text)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(before + '\n')
    expect(result[1]).toBe(after)
  })

  it('カスタム maxBytes で分割できる', () => {
    const text = 'a'.repeat(300)
    const result = paginateText(text, 100)
    expect(result).toHaveLength(3)
  })

  it('サロゲートペア（絵文字）を途中分割しない', () => {
    // 🎉 = 4 UTF-8 bytes, 1 code point
    const emoji = '🎉'
    const text = emoji.repeat(250) // 250 * 4 = 1000 bytes → 2チャンク (999バイト上限)
    const result = paginateText(text)
    expect(result).toHaveLength(2)
    // 各チャンクが不正な文字列を含まないことを確認
    for (const chunk of result) {
      expect(chunk).toBe(Array.from(chunk).join(''))
      expect(byteLen(chunk)).toBeLessThanOrEqual(999)
    }
    expect(result.join('')).toBe(text)
  })

  it('チャンク内のインデントを保持する（先頭・末尾の全体trimは許容）', () => {
    const text = 'line1\n    indented\nline3'
    const result = paginateText(text)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('    indented')
  })

  it('\\r\\n を \\n に正規化する', () => {
    const text = 'line1\r\nline2\r\nline3'
    const result = paginateText(text)
    expect(result.join('')).not.toContain('\r')
    expect(result.join('')).toContain('line1\nline2\nline3')
  })

  it('空白のみのテキスト → ["（本文なし）"]', () => {
    expect(paginateText('   \n\n  ')).toEqual(['（本文なし）'])
  })

  it('混合テキスト（ASCII+日本語）が正しくバイト分割される', () => {
    // 実際のユースケース: コマンド(ASCII) + 日本語説明
    const ascii = 'gh pr create --title "test" --body "'
    const japanese = '通知詳細画面のテキスト表示を変更' // 16文字 * 3 = 48 bytes
    const text = ascii + japanese.repeat(20) // ascii(36bytes) + 960bytes = 996bytes → 1チャンク内
    const result = paginateText(text)
    expect(result).toHaveLength(1)
    expect(byteLen(result[0])).toBeLessThanOrEqual(999)
  })

  it('816コードポイント/1424バイトの混合テキストがバイト基準で分割される', () => {
    // 実際に問題が発生したケース: 816 cp / 1424 bytes
    const mixed = 'ASCII部分 ' + '日本語テキスト'.repeat(50) // 多めの日本語
    const result = paginateText(mixed)
    expect(result.length).toBeGreaterThanOrEqual(2) // 1424 bytes > 999 maxBytes → 2チャンク以上
    for (const chunk of result) {
      expect(byteLen(chunk)).toBeLessThanOrEqual(999)
    }
    expect(result.join('')).toBe(mixed.replace(/\r\n/g, '\n').trim())
  })
})

describe('createGlassesUI startup result handling', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { getElementById: () => null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not mark startup as rendered when createStartUp returns invalid', async () => {
    const ui = createGlassesUI()
    const conn = {
      bridge: {
        createStartUpPageContainer: vi.fn().mockResolvedValue(1),
      },
    }

    await ui.showText(conn as never, 'hello')

    expect(conn.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1)
    expect(ui.hasRenderedPage(conn as never)).toBe(false)
  })

  it('marks startup as rendered only when createStartUp succeeds', async () => {
    const ui = createGlassesUI()
    const conn = {
      bridge: {
        createStartUpPageContainer: vi.fn().mockResolvedValue(0),
      },
    }

    await ui.showText(conn as never, 'hello')

    expect(conn.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1)
    expect(ui.hasRenderedPage(conn as never)).toBe(true)
  })
})
