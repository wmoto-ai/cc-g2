// telegram トランスポートのメッセージ分類・通知モデル変換(純ロジック)
import { describe, expect, it } from 'vitest'
import {
  classifyTgMessage,
  parseStatusPayload,
  TG_MARKER,
  TG_META,
  toNotificationDetail,
  toNotificationItem,
  type TgMessageLike,
} from '../src/transport/telegram/model'
import {
  buildStatusPayload,
  formatApprovalMessage,
  formatImageCaption,
  formatStatusMessage,
  formatStopMessage,
  G2_MARKER,
  G2_META,
} from '../packages/telegram-adapter/src/telegram/format'

/** Telegram が配信するプレーンテキスト相当(HTML タグ除去 + エンティティ復元) */
function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function msg(overrides: Partial<TgMessageLike>): TgMessageLike {
  return {
    id: 42,
    dateSec: 1_800_000_000,
    text: '',
    out: false,
    hasPhoto: false,
    buttonData: [],
    ...overrides,
  }
}

describe('マーカー定数の相互検証', () => {
  it('アダプタの G2_MARKER と完全一致する', () => {
    expect(TG_MARKER).toEqual(G2_MARKER)
  })

  it('meta 行プレフィックス(TG_META)がアダプタ G2_META と完全一致する', () => {
    expect(TG_META).toEqual(G2_META)
  })
})

describe('classifyTgMessage', () => {
  it('マーカー行で stop / generic / approval / image を判定する', () => {
    expect(classifyTgMessage(msg({ text: '🏁 done — repo\n本文\nこのメッセージに返信するとセッションへ送信されます\n· cc-g2:stop' }))).toBe('stop')
    expect(classifyTgMessage(msg({ text: '📣 brew check\n本文\n· cc-g2:generic' }))).toBe('generic')
    expect(classifyTgMessage(msg({ text: '🔐 Bash — repo\n$ pnpm test\n· cc-g2:approval' }))).toBe('approval')
    expect(classifyTgMessage(msg({ text: 'スクショ\n· cc-g2:image', hasPhoto: true }))).toBe('image')
  })

  it('決着フッタが追記されてもマーカーより後の行が無ければ判定は変わらない(フッタは edit で本文側に付く)', () => {
    // アダプタの closeEntry は「投稿時 text + \n\n + フッタ」なのでマーカーは本文側最終行でなくなる
    // → 最終非空行判定だと 'other' になってしまうため、この形も approval と判定できることを保証する
    const closed = msg({
      text: '🔐 Bash — repo\n$ rm -rf tmp\n· cc-g2:approval\n\n✅ Approved via Telegram (12:34)',
      buttonData: [],
    })
    expect(classifyTgMessage(closed)).toBe('approval')
  })

  it('自分の送信・マーカー無しは other', () => {
    expect(classifyTgMessage(msg({ text: 'ok', out: true }))).toBe('other')
    expect(classifyTgMessage(msg({ text: '✅ セッションに送信しました' }))).toBe('other')
  })

  it('マーカー無しでも承認ボタンがあれば approval(旧メッセージ互換)', () => {
    expect(classifyTgMessage(msg({ text: '🔐 Bash', buttonData: ['apr|0f0e...'] }))).toBe('approval')
  })

  it('ステータスマーカーは status(通知一覧に出さない種別)', () => {
    expect(classifyTgMessage(msg({ text: '📊 cc-g2 status — ctx 42%\n{"v":1}\n· cc-g2:status' }))).toBe('status')
  })
})

describe('ステータスペイロードの相互検証(アダプタ format → ミニアプリ parse)', () => {
  const ctxSessions = [
    { sessionId: 's1', cwd: '/work/repo-a', usedPercentage: 42.5, model: 'model-a' },
    { sessionId: 's2', cwd: '/work/repo-b', usedPercentage: 17, model: 'model-b' },
  ]
  const activities = [
    { tmuxTarget: 'cc:1.0', label: 'repo-a', state: 'active' },
    { tmuxTarget: 'cc:2.0', label: 'repo-b', state: 'idle' },
  ]
  const at = new Date(1_800_000_000_000)

  it('formatStatusMessage の出力を parseStatusPayload が読める', () => {
    const html = formatStatusMessage(buildStatusPayload(ctxSessions, activities, at))
    const plain = htmlToPlain(html)
    expect(classifyTgMessage(msg({ text: plain }))).toBe('status')
    const parsed = parseStatusPayload(plain)
    expect(parsed).not.toBeNull()
    expect(parsed!.ts).toBe(1_800_000_000)
    expect(parsed!.contextSessions).toEqual(ctxSessions)
    expect(parsed!.sessionActivities).toEqual(activities)
  })

  it('未知の activity state は idle に落とす(前方互換)', () => {
    const html = formatStatusMessage(
      buildStatusPayload([], [{ tmuxTarget: 'cc:1.0', label: 'x', state: 'brand-new-state' }], at),
    )
    const parsed = parseStatusPayload(htmlToPlain(html))
    expect(parsed!.sessionActivities![0]!.state).toBe('idle')
  })

  it('フィールド欠落(取得失敗)= null、空配列(0 件)= [] を区別して往復する', () => {
    // ctx 取得失敗(null)+ activity 0 件([])
    const html = formatStatusMessage(buildStatusPayload(null, [], at))
    const parsed = parseStatusPayload(htmlToPlain(html))
    expect(parsed!.contextSessions).toBeNull() // 前回値維持の指示
    expect(parsed!.sessionActivities).toEqual([]) // クリアの指示
  })

  it('JSON 行が無い・壊れている・バージョン不一致は null', () => {
    expect(parseStatusPayload('📊 status\n· cc-g2:status')).toBeNull()
    expect(parseStatusPayload('{broken\n· cc-g2:status')).toBeNull()
    expect(parseStatusPayload('{"v":2,"ts":1}\n· cc-g2:status')).toBeNull()
  })
})

describe('セッションタグ meta 行の相互検証(アダプタ format → ミニアプリ parse)', () => {
  it('approval の meta 行を sessionLabel に載せ、classify は不変・本文からは除去する', () => {
    const plain = htmlToPlain(
      formatApprovalMessage({ toolName: 'Bash', cwd: '/repo/my-app', preview: '$ pnpm test' }),
    )
    expect(plain).toContain('· cc-g2:meta sess=my-app')
    const m = msg({ text: plain, buttonData: ['apr|x', 'dny|x'] })
    // meta 行は分類に影響しない
    expect(classifyTgMessage(m)).toBe('approval')
    const item = toNotificationItem(m, 'approval')
    expect(item.metadata).toEqual({ hookType: 'permission-request', sessionLabel: 'my-app' })
    // 本文に meta 行(とマーカー行)は出さない
    const detail = toNotificationDetail(m, 'approval')
    expect(detail.fullText).not.toContain('cc-g2:meta')
    expect(detail.fullText).not.toContain('cc-g2:approval')
  })

  it('stop の meta 行を sessionLabel に載せる(既存 hookType とマージ)', () => {
    const plain = htmlToPlain(formatStopMessage({ title: 'done', cwd: '/repo/my-app' }))
    const item = toNotificationItem(msg({ text: plain }), 'stop')
    expect(item.metadata).toEqual({ hookType: 'stop', sessionLabel: 'my-app' })
  })

  it('画像 caption の meta 行を sessionLabel に載せる(imageId とマージ)', () => {
    // caption は parse_mode 無しのプレーンなのでそのまま渡る
    const caption = formatImageCaption({ title: 'スクショ', sessionLabel: '#3' })
    const item = toNotificationItem(msg({ id: 7, text: caption, hasPhoto: true }), 'image')
    expect(item.metadata).toEqual({ imageId: 'tg:7', sessionLabel: '3' })
  })

  it('meta 行が無い旧メッセージは sessionLabel を付けない(後方互換)', () => {
    const m = msg({ text: '🏁 done — repo\n本文\n· cc-g2:stop' })
    expect(toNotificationItem(m, 'stop').metadata).toEqual({ hookType: 'stop' })
  })
})

describe('toNotificationItem / Detail', () => {
  it('タイトルの絵文字除去・マーカー行除去・メタデータ付与', () => {
    const m = msg({ text: '🏁 Session finished — repo\n完了しました\n· cc-g2:stop' })
    const item = toNotificationItem(m, 'stop')
    expect(item.id).toBe('42')
    expect(item.title).toBe('Session finished — repo')
    expect(item.replyCapable).toBe(true)
    expect(item.metadata).toEqual({ hookType: 'stop' })
    expect(item.replyStatus).toBe('delivered')
    const detail = toNotificationDetail(m, 'stop')
    expect(detail.fullText).not.toContain('· cc-g2:stop')
    expect(detail.fullText).toContain('完了しました')
  })

  it('承認はボタン有無で pending / decided', () => {
    const open = msg({ text: '🔐 Bash\n· cc-g2:approval', buttonData: ['apr|x', 'dny|x'] })
    expect(toNotificationItem(open, 'approval').replyStatus).toBe('pending')
    const closed = msg({ text: '🔐 Bash\n· cc-g2:approval\n\n✅ Approved via Telegram (12:34)' })
    expect(toNotificationItem(closed, 'approval').replyStatus).toBe('decided')
  })

  it('画像は imageId=tg:<msgId> かつ replyCapable(操作メニュー遷移に必須)', () => {
    const m = msg({ id: 7, text: 'スクショ\n· cc-g2:image', hasPhoto: true })
    const item = toNotificationItem(m, 'image')
    expect(item.metadata).toEqual({ imageId: 'tg:7' })
    // Hub 仕様(hookType なしは replyCapable=true)とのパリティ。false だと
    // 詳細から操作メニューに入れず「画像を見る」に到達できない(実機で発覚したバグ)
    expect(item.replyCapable).toBe(true)
  })
})
