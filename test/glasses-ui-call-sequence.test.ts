/**
 * glasses-ui characterization テスト（リファクタ Phase 0）
 *
 * 目的: mock bridge に渡る SDK payload 全体（メソッド・containerID・containerName・
 * 座標・content・isEventCapture・呼び出し順）をスナップショットとして固定し、
 * リファクタ前後で「bridge に流れるデータが 1 バイトも変わらない」ことを保証する。
 *
 * 重要: このテストは「現在の挙動が正しい」ことではなく「挙動が変わらない」ことを
 * 検証する。スナップショットの更新（-u）はリファクタ中は原則禁止。
 * 意図的に挙動を変える場合のみ、変更内容をコミットメッセージに明記して更新する。
 *
 * docs/refactor-plan.md Phase 0 / docs/known-limitations.md 参照。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildNotificationActions, createGlassesUI } from '../src/glasses-ui'
import { IMAGE_TILES } from '../src/image/image-pipeline'
import type { NotificationDetail, NotificationItem } from '../src/notifications'
import type { BridgeConnection } from '../src/bridge'

// formatAge / formatCurrentDateTime / log のタイムスタンプを決定的にする
process.env.TZ = 'Asia/Tokyo'
const FIXED_NOW = new Date('2026-06-10T12:00:00+09:00') // 水曜日

type RecordedCall = { method: string; payload: unknown }

/** SDK クラスインスタンスを比較可能な plain JSON に落とす */
function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

type MockBridgeBehavior = {
  createStartUpResult?: number | (() => number)
  rebuildResult?: boolean | (() => boolean)
  upgradeResult?: boolean | (() => boolean)
  /** updateImageRawData の戻り値。'hang' は永久に解決しない Promise を返す */
  imageResult?: number | 'hang'
}

function resolveBehavior<T>(v: T | (() => T)): T {
  return typeof v === 'function' ? (v as () => T)() : v
}

function createMockConn(behavior: MockBridgeBehavior = {}) {
  const calls: RecordedCall[] = []
  const eventHandlers: Array<(event: unknown) => void> = []

  const bridge = {
    createStartUpPageContainer: vi.fn(async (payload: unknown) => {
      calls.push({ method: 'createStartUpPageContainer', payload: toPlain(payload) })
      return resolveBehavior(behavior.createStartUpResult ?? 0)
    }),
    rebuildPageContainer: vi.fn(async (payload: unknown) => {
      calls.push({ method: 'rebuildPageContainer', payload: toPlain(payload) })
      return resolveBehavior(behavior.rebuildResult ?? true)
    }),
    textContainerUpgrade: vi.fn(async (payload: unknown) => {
      calls.push({ method: 'textContainerUpgrade', payload: toPlain(payload) })
      return resolveBehavior(behavior.upgradeResult ?? true)
    }),
    updateImageRawData: vi.fn((payload: { containerID: number; containerName: string; imageData: number[] }) => {
      calls.push({
        method: 'updateImageRawData',
        payload: {
          containerID: payload.containerID,
          containerName: payload.containerName,
          imageDataLength: payload.imageData.length,
        },
      })
      if (behavior.imageResult === 'hang') return new Promise<never>(() => {})
      return Promise.resolve(behavior.imageResult ?? 0)
    }),
  }

  const conn = {
    mode: 'bridge',
    bridge,
    onEvent: (handler: (event: unknown) => void) => eventHandlers.push(handler),
    onAudio: () => {},
    startAudio: async () => {},
    stopAudio: async () => {},
  } as unknown as BridgeConnection

  return {
    conn,
    calls,
    bridge,
    fireEvent: (event: unknown) => {
      for (const handler of eventHandlers) handler(event)
    },
  }
}

/** 通知一覧の代表フィクスチャ（prefix 分岐を網羅: project+session / cwd 由来 / moshi / ステータスマーク） */
function makeItems(): NotificationItem[] {
  return [
    {
      id: 'n1',
      source: 'claude-code',
      title: 'Bash',
      summary: 'Tool: Bash CWD: /Users/x $ pnpm test --run',
      createdAt: new Date(FIXED_NOW.getTime() - 30_000).toISOString(), // now
      replyCapable: true,
      replyStatus: 'pending',
      metadata: { project: 'cc-g2', sessionLabel: '#2', tmuxTarget: 'g2-cc-g2-private-4c4a:0.0' },
    },
    {
      id: 'n2',
      source: 'claude-code',
      title: 'Edit',
      summary: 'Tool: Edit /Users/iwa/Repos/github.com/wmoto-ai/cc-g2-private/src/glasses-ui.ts',
      createdAt: new Date(FIXED_NOW.getTime() - 5 * 60_000).toISOString(), // 5m
      replyCapable: true,
      replyStatus: 'delivered',
      metadata: { cwd: '/Users/iwa/Repos/very-long-project-name-here', tmuxTarget: 'g2-myrepo-1a2b-2:0.0' },
    },
    {
      id: 'n3',
      source: 'moshi',
      title: 'タスク完了通知のとても長い日本語タイトルでバイト切り詰めを確認する',
      summary: '',
      createdAt: new Date(FIXED_NOW.getTime() - 3 * 3600_000).toISOString(), // 3h
      replyCapable: false,
      replyStatus: 'decided',
    },
    {
      id: 'n4',
      source: 'claude-code',
      title: 'Stop',
      summary: 'セッションが完了しました',
      createdAt: new Date(FIXED_NOW.getTime() - 2 * 86400_000).toISOString(), // 2d
      replyCapable: true,
      replyStatus: 'replied',
      metadata: { cwd: '[REDACTED]', tmuxTarget: '[REDACTED]' },
    },
  ]
}

function makeDetail(overrides: Partial<NotificationDetail> = {}): NotificationDetail {
  return {
    id: 'n1',
    source: 'claude-code',
    title: 'Bash',
    summary: 'Tool: Bash $ pnpm test',
    createdAt: new Date(FIXED_NOW.getTime() - 60_000).toISOString(),
    replyCapable: true,
    fullText: 'pnpm test を実行してもよいですか？\n\n$ pnpm test --run\n対象: 103 tests',
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
  vi.stubGlobal('document', { getElementById: () => null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('buildNotificationActions', () => {
  it('hookType あり（承認系）はフルメニュー', () => {
    const detail = makeDetail({ metadata: { hookType: 'PreToolUse' } })
    expect(buildNotificationActions(detail)).toMatchSnapshot()
  })

  it('hookType + imageId は「画像を見る」付きフルメニュー', () => {
    const detail = makeDetail({ metadata: { hookType: 'PreToolUse', imageId: 'img-1' } })
    expect(buildNotificationActions(detail)).toMatchSnapshot()
  })

  it('画像専用通知（hookType なし + imageId）は最小メニュー', () => {
    const detail = makeDetail({ metadata: { imageId: 'img-1' } })
    expect(buildNotificationActions(detail)).toMatchSnapshot()
  })

  it('metadata なしはフルメニュー（画像なし）', () => {
    expect(buildNotificationActions(makeDetail())).toMatchSnapshot()
  })
})

describe('初回描画と rebuild/フォールバックの遷移', () => {
  it('初回 showText は createStartUp、2回目以降の別レイアウトは rebuild', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showText(conn, 'hello')
    await ui.showIdleLauncher(conn)
    expect(calls).toMatchSnapshot()
  })

  it('createStartUp が code=1 の間は rendered 扱いせず createStartUp を続ける', async () => {
    let result = 1
    const { conn, calls } = createMockConn({ createStartUpResult: () => result })
    const ui = createGlassesUI()
    await ui.showText(conn, 'first (fails)')
    expect(ui.hasRenderedPage(conn)).toBe(false)
    result = 0
    await ui.showText(conn, 'second (succeeds)')
    expect(ui.hasRenderedPage(conn)).toBe(true)
    expect(calls.map((c) => c.method)).toMatchSnapshot()
  })

  it('rebuild 失敗時は必ず rebuild を呼んでから createStartUp にフォールバックする（順序が契約）', async () => {
    const { conn, calls } = createMockConn({ rebuildResult: false })
    const ui = createGlassesUI()
    await ui.showText(conn, 'initial')
    calls.length = 0
    await ui.showIdleLauncher(conn)
    // known-limitations §2: rebuild 呼び出し自体に副作用があるためスキップ禁止
    expect(calls.map((c) => c.method)).toEqual(['rebuildPageContainer', 'createStartUpPageContainer'])
    expect(calls).toMatchSnapshot()
  })

  it('フォールバック createStartUp も失敗した場合はリトライしない', async () => {
    const { conn, calls } = createMockConn({ rebuildResult: false, createStartUpResult: () => calls.length <= 1 ? 0 : 1 })
    const ui = createGlassesUI()
    await ui.showText(conn, 'initial')
    calls.length = 0
    await ui.showIdleLauncher(conn)
    expect(calls.map((c) => c.method)).toEqual(['rebuildPageContainer', 'createStartUpPageContainer'])
  })

  it('ensureBasePage は未描画時のみ描画する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.ensureBasePage(conn)
    await ui.ensureBasePage(conn, 'second call is no-op')
    expect(calls).toMatchSnapshot()
  })
})

describe('showText', () => {
  it('text レイアウト時は textContainerUpgrade で更新する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showText(conn, 'first')
    await ui.showText(conn, 'second (upgrade path)')
    expect(calls).toMatchSnapshot()
  })

  it('upgrade 失敗時はページ再描画にフォールバックする', async () => {
    const { conn, calls } = createMockConn({ upgradeResult: false })
    const ui = createGlassesUI()
    await ui.showText(conn, 'first')
    await ui.showText(conn, 'second (fallback)')
    expect(calls.map((c) => c.method)).toEqual([
      'createStartUpPageContainer',
      'textContainerUpgrade',
      'rebuildPageContainer',
    ])
  })

  it('mock モード（bridge なし）は SDK を呼ばない', async () => {
    const ui = createGlassesUI()
    const conn = { bridge: null } as unknown as BridgeConnection
    await ui.showText(conn, 'hello')
    // bridge が無いので記録対象の呼び出しは発生しない（クラッシュしないことの確認）
  })
})

describe('showIdleLauncher', () => {
  it('通常モードと dim モードの payload', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showIdleLauncher(conn)
    await ui.showIdleLauncher(conn, { dimMode: true })
    expect(calls).toMatchSnapshot()
  })
})

describe('showNotificationList', () => {
  it('代表4種の通知で header/list payload を固定する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showNotificationList(conn, makeItems())
    expect(calls).toMatchSnapshot()
  })

  it('セッションアクティビティがヘッダーに反映される', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    ui.setSessionActivities([
      { tmuxTarget: 'g2-cc-g2-private-4c4a:0.0', label: 'cc-g2', state: 'active' },
      { tmuxTarget: 'g2-minimalmem-246c:0.0', label: 'mm', state: 'idle' },
      { tmuxTarget: 'g2-other-1111:0.0', label: 'other', state: 'error' },
      { tmuxTarget: 'g2-dead-2222:0.0', label: 'dead', state: 'dead' },
      { tmuxTarget: 'g2-fifth-3333:0.0', label: 'fifth', state: 'active' }, // 5件目は表示されない
    ])
    await ui.showNotificationList(conn, makeItems().slice(0, 1))
    expect(calls).toMatchSnapshot()
  })

  it('0件は showText("通知なし") に委譲する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showNotificationList(conn, [])
    expect(calls).toMatchSnapshot()
  })
})

describe('showNotificationDetail', () => {
  it('初回は ghost list 付き 3 コンテナで描画する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showNotificationDetail(conn, makeDetail(), 0, 1)
    expect(calls).toMatchSnapshot()
  })

  it('notif-detail レイアウト中のページ送りは upgradeText 2 連で行う', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    const longDetail = makeDetail({ fullText: 'あ'.repeat(400) + '\n' + 'い'.repeat(400) }) // 2400 bytes → 3ページ
    await ui.showNotificationDetail(conn, longDetail, 0, 3)
    calls.length = 0
    await ui.showNotificationDetail(conn, longDetail, 1, 3, 42.5)
    expect(calls).toMatchSnapshot()
  })

  it('updateDetailHeaderBadge は notif-detail レイアウト時のみ動作する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    expect(await ui.updateDetailHeaderBadge(conn, 'badge')).toBe(false) // レイアウト未設定
    await ui.showNotificationDetail(conn, makeDetail(), 0, 1)
    calls.length = 0
    expect(await ui.updateDetailHeaderBadge(conn, 'Bash ●新着1')).toBe(true)
    expect(calls).toMatchSnapshot()
  })
})

describe('showNotificationActions', () => {
  it('長いタイトルは 20 文字で切り詰められる', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    const detail = makeDetail({ title: 'とても長い通知タイトルでヘッダー切り詰めを確認する', metadata: { hookType: 'PreToolUse', imageId: 'img-1' } })
    await ui.showNotificationActions(conn, detail, buildNotificationActions(detail))
    expect(calls).toMatchSnapshot()
  })
})

describe('showAskUserQuestion', () => {
  it('短い質問は質問+選択肢+固定項目のリスト', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showAskUserQuestion(
      conn,
      {
        question: 'マージしてよいですか？',
        header: 'Merge',
        options: [
          { label: 'はい', description: 'マージする' },
          { label: 'いいえ', description: '中止する' },
        ],
        multiSelect: false,
      },
      0,
      1,
    )
    expect(calls).toMatchSnapshot()
  })

  it('リスト上限の強制適合: 21 個以上の選択肢は 20 件に、長い項目は byte cap に切り詰める', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    const options = Array.from({ length: 23 }, (_, i) => ({
      label: `選択肢${i + 1} ` + 'とても長い日本語ラベルでバイト超過させる'.repeat(2),
      description: '',
    }))
    await ui.showAskUserQuestion(conn, { question: 'どれにしますか？', header: '', options, multiSelect: false }, 1, 3)
    const payload = calls[0].payload as { listObject: Array<{ itemContainer: { itemName: string[]; itemCount: number } }> }
    const items = payload.listObject[0].itemContainer.itemName
    expect(items.length).toBeLessThanOrEqual(20)
    const encoder = new TextEncoder()
    for (const item of items) {
      expect(encoder.encode(item).length).toBeLessThanOrEqual(63)
    }
    expect(calls).toMatchSnapshot()
  })

  it('長い質問ヘッダーは 999 バイト予算に切り詰められる', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showAskUserQuestion(
      conn,
      { question: 'あ'.repeat(500), header: '', options: [{ label: 'OK', description: '' }], multiSelect: false },
      0,
      2,
    )
    const payload = calls[0].payload as { textObject: Array<{ content: string }> }
    const encoder = new TextEncoder()
    expect(encoder.encode(payload.textObject[0].content).length).toBeLessThanOrEqual(999)
    expect(calls.map((c) => c.method)).toMatchSnapshot()
  })
})

describe('返信フロー（録音 → STT → 確認 → 結果）', () => {
  it('代表フロー全体の呼び出し列と payload を固定する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showReplyRecording(conn)
    await ui.updateReplyRecordingBody(conn, '認識中のテキスト…')
    await ui.showReplySttProcessing(conn) // reply-recording レイアウト時は upgrade 最適化パス
    await ui.showReplyConfirmActions(conn)
    await ui.showReplyResult(conn, true, '送信しました')
    await ui.showReplyResult(conn, false, 'Hub error')
    expect(calls).toMatchSnapshot()
  })

  it('updateReplyRecordingBody は reply-recording 以外のレイアウトでは何もしない', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showText(conn, 'text layout')
    calls.length = 0
    await ui.updateReplyRecordingBody(conn, 'should be ignored')
    expect(calls).toEqual([])
  })

  it('showReplySttProcessing はレイアウトが違えばフル描画する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showText(conn, 'text layout')
    calls.length = 0
    await ui.showReplySttProcessing(conn)
    expect(calls.map((c) => c.method)).toEqual(['rebuildPageContainer'])
    expect(calls).toMatchSnapshot()
  })
})

describe('showImage', () => {
  function makeTiles(): Uint8Array[] {
    return IMAGE_TILES.map((_, i) => new Uint8Array(100 + i))
  }

  it('レイアウト構築 → settle → タイル直列転送 → インジケータ消去の順を固定する', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    await ui.showText(conn, 'initial') // startup 済みにして rebuild パスへ
    calls.length = 0
    const promise = ui.showImage(conn, makeTiles())
    await vi.runAllTimersAsync()
    expect(await promise).toBe(true)
    expect(calls).toMatchSnapshot()
  })

  it('タイル数不一致は転送せず false を返す', async () => {
    const { conn, calls } = createMockConn()
    const ui = createGlassesUI()
    expect(await ui.showImage(conn, [new Uint8Array(10)])).toBe(false)
    expect(calls).toEqual([])
  })

  it('タイル送信タイムアウト時は残りタイルをスキップし失敗メッセージを出す', async () => {
    const { conn, calls } = createMockConn({ imageResult: 'hang' })
    const ui = createGlassesUI()
    await ui.showText(conn, 'initial')
    calls.length = 0
    const promise = ui.showImage(conn, makeTiles())
    await vi.runAllTimersAsync()
    expect(await promise).toBe(false)
    // タイル0 で打ち切り → updateImageRawData は 1 回のみ、最後に失敗表示の upgrade
    expect(calls.map((c) => c.method)).toMatchSnapshot()
    const last = calls[calls.length - 1]
    expect(last.method).toBe('textContainerUpgrade')
    expect((last.payload as { content: string }).content).toContain('失敗')
  })

  it('タイル送信失敗（非 success）でも全タイル送信し、最後に失敗表示する', async () => {
    const { conn, calls } = createMockConn({ imageResult: 3 }) // sendFailed
    const ui = createGlassesUI()
    await ui.showText(conn, 'initial')
    calls.length = 0
    const promise = ui.showImage(conn, makeTiles())
    await vi.runAllTimersAsync()
    expect(await promise).toBe(false)
    expect(calls.filter((c) => c.method === 'updateImageRawData')).toHaveLength(IMAGE_TILES.length)
  })
})

describe('requestApproval', () => {
  it('リスト選択イベントで選択肢ラベルを resolve する', async () => {
    const { conn, calls, fireEvent } = createMockConn()
    const ui = createGlassesUI()
    const promise = ui.requestApproval(conn, {
      title: 'pnpm test',
      detail: 'テストを実行します',
      options: ['許可', '拒否'],
    })
    await vi.advanceTimersByTimeAsync(10)
    fireEvent({ listEvent: { currentSelectItemIndex: 1 } })
    expect(await promise).toBe('拒否')
    expect(calls).toMatchSnapshot()
  })

  it('60秒無応答で最後の選択肢（拒否）に自動 resolve する', async () => {
    const { conn } = createMockConn()
    const ui = createGlassesUI()
    const promise = ui.requestApproval(conn, { title: 't', detail: 'd', options: ['許可', '拒否'] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await promise).toBe('拒否')
  })
})
