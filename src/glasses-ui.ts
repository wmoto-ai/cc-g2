/**
 * Even G2 グラス側のUI操作
 *
 * テキスト表示、承認リクエスト（リスト選択）を提供。
 * G2ディスプレイ仕様: 576x288px, 4bitグレースケール（緑）, 最大4コンテナ
 *
 * 注意: G2実機ではリストのスクロール方向がファームウェア制御で物理操作と逆になる。
 * 現時点ではSDK標準ListContainerをそのまま使用し、方向反転は許容する。
 */
import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerUpgrade,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from './bridge'
import type { NotificationItem, NotificationDetail } from './notifications'
import { log } from './log'

type ApprovalRequest = {
  title: string
  detail: string
  options: string[]
}

// ヘッダー（52px, isEventCapture=0で非スクロール）に収まるバイト上限。
// 超える質問は先にページネーション付き詳細画面で全文を表示する。
const ASK_QUESTION_SHORT_THRESHOLD = 150

/** AskUserQuestion の質問データ（Hub metadata から取得） */
export type AskQuestionData = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

/** G2ディスプレイ上の通知UIの状態 */
export type NotificationUIState = {
  screen: 'idle' | 'list' | 'detail' | 'detail-actions' | 'ask-question' | 'ask-question-detail' | 'reply-recording' | 'reply-confirm' | 'reply-confirm-actions' | 'reply-sending'
  items: NotificationItem[]
  selectedIndex: number
  /** detail画面のページ送り用（fullTextを複数ページに分割） */
  detailPages: string[]
  detailPageIndex: number
  detailItem: NotificationDetail | null
  /** 返信用STT結果テキスト */
  replyText: string
  /** AskUserQuestion: 現在表示中の質問データ */
  askQuestions: AskQuestionData[]
  /** AskUserQuestion: 現在の質問インデックス（複数質問対応） */
  askQuestionIndex: number
  /** AskUserQuestion: 回答の蓄積 { "質問テキスト": "選択ラベル" } */
  askAnswers: Record<string, string>
}

/**
 * G2表示用: fullTextをチャンク分割する（UTF-8バイト数基準）。
 * ファームウェアがコンテナ内テキストの自動スクロールを処理するため、
 * 1チャンクを maxBytes UTF-8バイト以内に収める。
 * SDKの文字数制限はUTF-8バイト基準（日本語3bytes/文字のため
 * コードポイント数では正確に制御できない）。
 * SCROLL_TOP/SCROLL_BOTTOM イベントはチャンク境界でのみ発火される。
 *
 * コードポイント単位で走査しサロゲートペア安全。
 * 本文のインデントや空白は保持する（全体のtrimのみ）。
 */
const textEncoder = new TextEncoder()

export function paginateText(text: string, maxBytes = 999): string[] {
  const normalized = text?.replace(/\r\n/g, '\n').trim() ?? ''
  if (!normalized) return ['（本文なし）']

  const chars = Array.from(normalized)
  const pages: string[] = []
  let pos = 0

  while (pos < chars.length) {
    let end = pos
    let byteCount = 0
    while (end < chars.length) {
      const charBytes = textEncoder.encode(chars[end]).length
      if (byteCount + charBytes > maxBytes) break
      byteCount += charBytes
      end++
    }
    if (end === pos) end = pos + 1 // 1文字がmaxBytesを超える場合は最低1文字進める

    // 改行位置でチャンクを切る（改行なしの場合はバイト上限で強制カット）
    if (end < chars.length) {
      for (let i = end - 1; i > pos; i--) {
        if (chars[i] === '\n') {
          end = i + 1
          break
        }
      }
    }
    pages.push(chars.slice(pos, end).join(''))
    pos = end
  }

  return pages.length > 0 ? pages : ['（本文なし）']
}

/** metadata.cwdからプロジェクト名を抽出（短縮） */
function extractProjectSlug(cwd: string): string {
  const name = cwd.split('/').filter(Boolean).pop() || ''
  return name.length > 10 ? name.slice(0, 9) + '…' : name
}

function deriveSessionLabel(tmuxTarget: string): string {
  const session = tmuxTarget.split(':')[0] || ''
  const numbered = session.match(/-(\d+)$/)
  if (numbered) {
    const prefix = session.slice(0, -numbered[0].length)
    if (/-[0-9a-f]{4}$/.test(prefix)) return `#${numbered[1]}`
  }
  if (/-[0-9a-f]{4}$/.test(session)) return '#1'
  return ''
}

function getNotificationPrefix(item: NotificationItem): string {
  const meta = item.metadata ?? {}
  const sessionLabelFromMeta = typeof meta.sessionLabel === 'string' ? meta.sessionLabel.trim() : ''
  const tmuxTarget = typeof meta.tmuxTarget === 'string' ? meta.tmuxTarget.trim() : ''
  const sessionLabel = sessionLabelFromMeta || (tmuxTarget && tmuxTarget !== '[REDACTED]' ? deriveSessionLabel(tmuxTarget) : '')
  const cwd = typeof meta.cwd === 'string' ? meta.cwd.trim() : ''
  const projectMeta = typeof meta.project === 'string' ? meta.project.trim() : ''
  const safeProject = projectMeta || (cwd && cwd !== '[REDACTED]' ? extractProjectSlug(cwd) : '')
  const moshi = item.source !== 'claude-code' ? 'M:' : ''
  if (moshi) return moshi
  if (safeProject && sessionLabel) return `${safeProject}${sessionLabel}:`
  if (safeProject) return `${safeProject}:`
  if (sessionLabel) return `${sessionLabel}:`
  return ''
}

/** summaryからツール操作の要約を抽出（コマンド先頭やファイルパスなど） */
function extractSnippet(summary: string, toolName: string): string {
  if (!summary) return ''
  // "Tool: Bash CWD: ..." 形式のプレフィックスを除去
  let s = summary.replace(/^Tool:\s*\S+\s*/i, '').replace(/^CWD:\s*\S+\s*/i, '').trim()
  // "$ " プレフィックスを除去
  s = s.replace(/^\$\s*/, '')
  // ファイルパスの場合はbasename
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
    const firstLine = s.split('\n')[0]
    const base = firstLine.split('/').pop() || firstLine
    return base.trim()
  }
  // コマンドの場合はそのまま（先頭の不要部分は除去済み）
  return s.split('\n')[0].trim()
}

/** 通知一覧のリスト項目を生成（G2リスト表示用） */
/** UTF-8 バイト数で文字列を切り詰め。末尾に '…' を付ける。サロゲートペア安全。 */
function truncateByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const fullBytes = textEncoder.encode(text).length
  if (fullBytes <= maxBytes) return text
  const ellipsis = '…'
  const ellipsisBytes = textEncoder.encode(ellipsis).length
  const budget = Math.max(0, maxBytes - ellipsisBytes)
  const chars = Array.from(text)
  let used = 0
  let out = ''
  for (const ch of chars) {
    const chBytes = textEncoder.encode(ch).length
    if (used + chBytes > budget) break
    out += ch
    used += chBytes
  }
  return out + ellipsis
}

function byteLen(text: string): number {
  return textEncoder.encode(text).length
}

function formatListItemName(item: NotificationItem): string {
  const age = formatAge(item.createdAt)
  const s = item.replyStatus
  const mark = s === 'delivered' || s === 'replied' ? '○' : s === 'decided' ? '>' : '●'
  // バイト基準の切り詰め: createStartUp の総バイト上限 (known-limitations §5: 999 bytes) を
  // 必ず下回るよう 1 アイテムあたり 45 bytes を上限とする。
  // 日本語(3byte/char)主体でも 20件 × 45byte = 900 bytes、ヘッダ ~40 bytes、合計 ~940 bytes。
  // 旧実装はコードポイント数で切っていたため日本語が混ざると 45char × 3byte = 135byte/item まで
  // 膨らみ、20件で 2700 bytes に達してファームがページ全体を silently 破棄していた。
  const prefix = mark + getNotificationPrefix(item)
  const suffix = ` (${age})`
  const maxBytes = 45
  const available = Math.max(6, maxBytes - byteLen(prefix) - byteLen(suffix))
  const toolName = item.title
  const snippet = extractSnippet(item.summary, toolName)
  let body: string
  if (snippet) {
    const combined = `${toolName} ${snippet}`
    if (byteLen(combined) <= available) {
      body = combined
    } else {
      // ツール名は最低限残し、残りをスニペットに割り当てる
      const toolBytes = Math.min(byteLen(toolName), Math.max(6, Math.floor(available / 2)))
      const toolPart = truncateByBytes(toolName, toolBytes)
      const snipSpace = available - byteLen(toolPart) - 1
      if (snipSpace >= 4) {
        body = `${toolPart} ${truncateByBytes(snippet, snipSpace)}`
      } else {
        body = truncateByBytes(toolName, available)
      }
    }
  } else {
    body = truncateByBytes(toolName, available)
  }
  return `${prefix}${body}${suffix}`
}

function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function formatCurrentTime(now = new Date()): string {
  return now.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function formatCurrentDateTime(now = new Date()): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${now.getMonth() + 1}/${now.getDate()} ${weekdays[now.getDay()]} ${formatCurrentTime(now)}`
}

type LayoutName = 'base' | 'text' | 'idle-launcher' | 'approval' | 'notif-list' | 'notif-detail' | 'notif-actions' | 'ask-question' | 'reply-recording' | 'reply-confirm-actions' | 'reply-result'

type HeaderListPageOptions = {
  headerContainerName: string
  headerYPosition: number
  headerHeight: number
  headerContent: string
  listContainerName: string
  listYPosition: number
  listHeight: number
  listItems: string[]
  targetLayout: string | undefined
  layoutSet: LayoutName
}

type HeaderBodyPageOptions = {
  headerContainerName: string
  headerContent: string
  bodyContainerName: string
  bodyContent: string
  targetLayout: string
  layoutSet: LayoutName
}

/** ghostListContainer: 実機で text+list -> text+text の切替が不安定なため保持するダミー */
function createGhostListContainer(): ListContainerProperty {
  return new ListContainerProperty({
    xPosition: 8,
    yPosition: 250,
    width: 560,
    height: 18,
    containerID: 3,
    containerName: 'notif-list',
    itemContainer: new ListItemContainerProperty({
      itemCount: 1,
      itemWidth: 0,
      isItemSelectBorderEn: 0,
      itemName: [' '],
    }),
    isEventCapture: 0,
  })
}

/** textContainerUpgrade の boilerplate ラッパー（contentOffset は常に 0） */
async function upgradeText(
  conn: BridgeConnection,
  containerID: number,
  containerName: string,
  text: string,
): Promise<boolean> {
  const result = await conn.bridge!.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID,
      containerName,
      contentOffset: 0,
      contentLength: text.length,
      content: text,
    }),
  )
  return !!result
}

export function createGlassesUI() {
  // The host treats startup-page creation as one-time init; later UI changes should use rebuild.
  const startupRenderedBridges = new WeakSet<object>()
  const layoutByBridge = new WeakMap<object, LayoutName>()
  const bridgeKeyOf = (conn: BridgeConnection) => conn.bridge as unknown as object

  // 描画ロック: SDK呼び出しの同時実行を防ぐ（実機で衝突するとG2が固まる）
  let renderLock: Promise<void> = Promise.resolve()
  let rendering = false

  async function renderStartupPage(
    conn: BridgeConnection,
    {
      texts = [],
      lists = [],
      targetLayout,
    }: {
      texts?: TextContainerProperty[]
      lists?: ListContainerProperty[]
      targetLayout?: string
    },
  ) {
    if (!conn.bridge) return

    // 描画ロック: 前の描画が完了するまで待つ
    await renderLock
    let unlock: () => void
    renderLock = new Promise((resolve) => { unlock = resolve })
    rendering = true
    try {
      await _renderStartupPageInner(conn, texts, lists, targetLayout)
    } finally {
      rendering = false
      unlock!()
    }
  }

  async function _renderStartupPageInner(
    conn: BridgeConnection,
    texts: TextContainerProperty[],
    lists: ListContainerProperty[],
    targetLayout?: string,
  ) {
    if (!conn.bridge) return

    const payload = new CreateStartUpPageContainer({
      containerTotalNum: texts.length + lists.length,
      textObject: texts,
      listObject: lists,
      imageObject: [],
    })

    const bridgeKey = bridgeKeyOf(conn)
    const currentLayout = layoutByBridge.get(bridgeKey)

    // 初回のみ createStartUp、以降は rebuild（SDKの仕様: createStartUpは1回のみ）
    if (!startupRenderedBridges.has(bridgeKey)) {
      const startupInfo = {
        total: texts.length + lists.length,
        texts: texts.map((t) => ({ id: t.containerID, name: t.containerName })),
        lists: lists.map((l) => ({ id: l.containerID, name: l.containerName })),
      }
      log(`G2 createStartUp: layout=${targetLayout} containers=${JSON.stringify(startupInfo)}`)
      const result = await conn.bridge.createStartUpPageContainer(payload)
      // SDK StartUpPageCreateResult: 0=success, 1=invalid, 2=oversize, 3=outOfMemory.
      // Only success means the startup page is present.
      if (result === 0) {
        startupRenderedBridges.add(bridgeKey)
      } else {
        log(`G2 startup描画失敗: code=${result}`)
      }
      return
    }

    const containerInfo = {
      total: texts.length + lists.length,
      texts: texts.map((t) => ({ id: t.containerID, name: t.containerName, y: t.yPosition, h: t.height, event: t.isEventCapture })),
      lists: lists.map((l) => ({ id: l.containerID, name: l.containerName, y: l.yPosition, h: l.height, event: l.isEventCapture })),
    }
    log(`G2 rebuild: ${currentLayout} → ${targetLayout} containers=${JSON.stringify(containerInfo)}`)

    const rebuildPayload = new RebuildPageContainer({
      containerTotalNum: texts.length + lists.length,
      textObject: texts,
      listObject: lists,
      imageObject: [],
    })

    const rebuilt = await conn.bridge.rebuildPageContainer(rebuildPayload)
    if (!rebuilt) {
      // 実機では rebuild が常に失敗する（描画は更新されることもある）。
      // ただし rebuild 呼び出し自体がハードウェアのイベントルーティング登録に必要な副作用を持つため、
      // スキップせず毎回呼び出してから createStartUp にフォールバックする。
      log(`G2 rebuild 失敗 (${currentLayout} → ${targetLayout}) → createStartUp フォールバック`)
      const forced = await conn.bridge.createStartUpPageContainer(payload)
      if (forced === 0) {
        startupRenderedBridges.add(bridgeKey)
      } else {
        log(`G2 createStartUp フォールバック失敗: code=${forced}`)
      }
    }
  }

  /** header TextContainer + list ListContainer の共通描画パターン */
  async function renderHeaderListPage(conn: BridgeConnection, opts: HeaderListPageOptions): Promise<void> {
    const headerContainer = new TextContainerProperty({
      xPosition: 8,
      yPosition: opts.headerYPosition,
      width: 560,
      height: opts.headerHeight,
      containerID: 1,
      containerName: opts.headerContainerName,
      content: opts.headerContent,
      isEventCapture: 0,
    })

    const listContainer = new ListContainerProperty({
      xPosition: 8,
      yPosition: opts.listYPosition,
      width: 560,
      height: opts.listHeight,
      containerID: 2,
      containerName: opts.listContainerName,
      itemContainer: new ListItemContainerProperty({
        itemCount: opts.listItems.length,
        itemWidth: 0,
        isItemSelectBorderEn: 1,
        itemName: opts.listItems,
      }),
      isEventCapture: 1,
    })

    await renderStartupPage(conn, {
      texts: [headerContainer],
      lists: [listContainer],
      targetLayout: opts.targetLayout,
    })
    layoutByBridge.set(bridgeKeyOf(conn), opts.layoutSet)
  }

  /** header TextContainer + body TextContainer の共通描画パターン */
  async function renderHeaderBodyPage(conn: BridgeConnection, opts: HeaderBodyPageOptions): Promise<void> {
    const headerContainer = new TextContainerProperty({
      xPosition: 8,
      yPosition: 4,
      width: 560,
      height: 28,
      containerID: 1,
      containerName: opts.headerContainerName,
      content: opts.headerContent,
      isEventCapture: 0,
    })

    const bodyContainer = new TextContainerProperty({
      xPosition: 8,
      yPosition: 36,
      width: 560,
      height: 240,
      containerID: 2,
      containerName: opts.bodyContainerName,
      content: opts.bodyContent,
      isEventCapture: 1,
    })

    await renderStartupPage(conn, {
      texts: [headerContainer, bodyContainer],
      targetLayout: opts.targetLayout,
    })
    layoutByBridge.set(bridgeKeyOf(conn), opts.layoutSet)
  }

  return {
    /** 描画中かどうか（ポーリング等で衝突を避けるために使用） */
    isRendering(): boolean {
      return rendering
    },

    hasRenderedPage(conn: BridgeConnection): boolean {
      return !!conn.bridge && startupRenderedBridges.has(bridgeKeyOf(conn))
    },

    async ensureBasePage(conn: BridgeConnection, text = 'Ready'): Promise<void> {
      if (!conn.bridge || startupRenderedBridges.has(bridgeKeyOf(conn))) return

      const container = new TextContainerProperty({
        xPosition: 8,
        yPosition: 10,
        width: 560,
        height: 80,
        containerID: 1,
        containerName: 'boot-text',
        content: text,
        isEventCapture: 1,
      })
      await renderStartupPage(conn, { texts: [container] })
      layoutByBridge.set(bridgeKeyOf(conn), 'base')
    },

    /**
     * G2にテキストを表示する
     */
    async showText(conn: BridgeConnection, text: string): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2表示: "${text}"`)
        return
      }

      const bridgeKey = bridgeKeyOf(conn)
      const currentLayout = layoutByBridge.get(bridgeKey)
      if (startupRenderedBridges.has(bridgeKey) && currentLayout === 'text') {
        if (await upgradeText(conn, 1, 'main-text', text)) {
          layoutByBridge.set(bridgeKey, 'text')
          log(`G2にテキスト表示完了: "${text}"`)
          return
        }
        log('G2 textContainerUpgrade に失敗 → ページ再描画へフォールバック')
      }

      const container = new TextContainerProperty({
        xPosition: 8,
        yPosition: 10,
        width: 560,
        height: 260,
        containerID: 1,
        containerName: 'main-text',
        content: text,
        isEventCapture: 1,
      })

      await renderStartupPage(conn, { texts: [container] })
      layoutByBridge.set(bridgeKey, 'text')
      log(`G2にテキスト表示完了: "${text}"`)
    },

    async showIdleLauncher(
      conn: BridgeConnection,
      options?: { dimMode?: boolean },
    ): Promise<void> {
      if (!conn.bridge) return
      const dimMode = options?.dimMode === true

      const idleContainer = new TextContainerProperty({
        xPosition: 8,
        yPosition: 4,
        width: 560,
        height: 272,
        containerID: 1,
        containerName: 'idle-touch',
        content: dimMode ? ' ' : '待機中\n\nDblTap = 通知一覧',
        isEventCapture: 1,
      })

      await renderStartupPage(conn, {
        texts: [idleContainer],
        targetLayout: 'idle-launcher',
      })
      layoutByBridge.set(bridgeKeyOf(conn), 'idle-launcher')
      log('G2待機画面表示（DblTapで通知一覧）')
    },

    /**
     * G2に通知一覧を表示する（SDK標準ListContainer）
     * ※実機ではスクロール方向が物理操作と逆になる（ファームウェア仕様）
     */
    async showNotificationList(
      conn: BridgeConnection,
      items: NotificationItem[],
    ): Promise<void> {
      if (items.length === 0) {
        await this.showText(conn, '通知なし')
        return
      }

      // 重要: 実機ファームは ListContainer + TextContainer 複数 の組み合わせを
      // silently 破棄する（createStartUp の戻り値は 0/1 を返すが描画されない）。
      // 検証 (2026-04-15):
      //   - TextContainer 1個 + ListContainer 1個 → 表示 OK
      //   - TextContainer 2個 + ListContainer 1個 → 矩形重なりを 8px ギャップで解消しても NG
      // → ヘッダに時刻をインラインして TextContainer を1個に保つ。シミュレータは寛容で
      //    どちらでも描画してしまうので、ここを変更したら必ず実機で確認する。
      const headerText = `通知 ${items.length}件  ${formatCurrentDateTime()}`
      const titleContainer = new TextContainerProperty({
        xPosition: 8,
        yPosition: 8,
        width: 560,
        height: 28,
        containerID: 1,
        containerName: 'notif-header',
        content: headerText,
        isEventCapture: 0,
      })

      const listContainer = new ListContainerProperty({
        xPosition: 8,
        yPosition: 42,
        width: 560,
        height: 232,
        containerID: 2,
        containerName: 'notif-list',
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: items.map(formatListItemName),
        }),
        isEventCapture: 1,
      })

      await renderStartupPage(conn, {
        texts: [titleContainer],
        lists: [listContainer],
        targetLayout: 'notif-list',
      })
      layoutByBridge.set(bridgeKeyOf(conn), 'notif-list')
      log(`G2に通知一覧表示: ${items.length}件`)
    },

    /**
     * G2に通知詳細を表示する（ファームウェアスクロール対応）
     *
     * fullTextをUTF-8バイト基準（デフォルト999bytes）でチャンク分割し、
     * ファームウェアがコンテナ内テキストの自動スクロールを処理する。
     * SCROLL_TOP/SCROLL_BOTTOM イベントはチャンク境界到達時のみアプリに通知される。
     *
     * 既にnotif-detailレイアウトの場合は textContainerUpgrade でテキストだけ更新する。
     * レイアウト変更が必要な場合は createStartUp/rebuild で描画する。
     */
    async showNotificationDetail(
      conn: BridgeConnection,
      detail: NotificationDetail,
      pageIndex: number,
      totalPages: number,
      contextPct?: number,
    ): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2通知詳細: "${detail.title}" page=${pageIndex + 1}/${totalPages}`)
        return
      }

      const pages = paginateText(detail.fullText)
      const page = pages[pageIndex] ?? pages[0]
      const ctxSuffix = contextPct != null ? ` ctx:${Math.round(contextPct)}%` : ''
      const pageInfo = pages.length > 1 ? ` [${pageIndex + 1}/${pages.length}]${ctxSuffix}` : ctxSuffix

      const headerText = `${detail.title}${pageInfo}`
      const bodyText = page

      // 既に notif-detail レイアウトなら textContainerUpgrade でテキストだけ更新
      const bridgeKey = bridgeKeyOf(conn)
      if (startupRenderedBridges.has(bridgeKey) && layoutByBridge.get(bridgeKey) === 'notif-detail') {
        const h = await upgradeText(conn, 1, 'notif-dtl-hdr', headerText)
        const b = await upgradeText(conn, 2, 'notif-body', bodyText)
        if (h && b) {
          log(`G2に通知詳細表示: "${detail.title}" chunk=${pageIndex + 1}/${pages.length} (${bodyText.length}chars, firmware scroll)`)
          return
        }
        log('G2 textContainerUpgrade に失敗 → ページ再描画へフォールバック')
      }

      // paginateText() のデフォルト maxBytes=999 により、各チャンクは
      // UTF-8で999バイト以内に収まっている（SDK上限 <1000 bytes）
      const headerContainer = new TextContainerProperty({
        xPosition: 8,
        yPosition: 4,
        width: 560,
        height: 28,
        containerID: 1,
        containerName: 'notif-dtl-hdr',
        content: headerText,
        isEventCapture: 0,
      })

      const bodyContainer = new TextContainerProperty({
        xPosition: 8,
        yPosition: 34,
        width: 560,
        height: 210,
        containerID: 2,
        containerName: 'notif-body',
        content: bodyText,
        isEventCapture: 1,
      })

      // 実機で text+list -> text+text の切替が不安定なため、通知系画面は常に list コンテナも保持する
      await renderStartupPage(conn, {
        texts: [headerContainer, bodyContainer],
        lists: [createGhostListContainer()],
        targetLayout: 'notif-detail',
      })
      layoutByBridge.set(bridgeKeyOf(conn), 'notif-detail')
      log(`G2に通知詳細表示: "${detail.title}" chunk=${pageIndex + 1}/${pages.length} (${bodyText.length}chars, firmware scroll)`)
    },

    /** 詳細画面のヘッダーに新着バッジを付与する（rebuild 不要） */
    async updateDetailHeaderBadge(conn: BridgeConnection, badgeText: string): Promise<boolean> {
      if (!conn.bridge) return false
      const bridgeKey = bridgeKeyOf(conn)
      if (layoutByBridge.get(bridgeKey) !== 'notif-detail') return false
      return upgradeText(conn, 1, 'notif-dtl-hdr', badgeText)
    },

    /** fullTextのチャンク数を返す（各チャンクUTF-8で最大999bytes、ファームウェアスクロール） */
    getDetailPageCount(fullText: string): number {
      return paginateText(fullText).length
    },

    /**
     * AskUserQuestion の質問本文が短いかを判定（[i/n]プレフィックスは含まない）。
     * 短い場合は質問+選択肢の複合画面、長い場合は先にページネーション付き詳細表示。
     */
    isAskQuestionShort(questionData: AskQuestionData): boolean {
      return byteLen(questionData.question) <= ASK_QUESTION_SHORT_THRESHOLD
    },

    /**
     * AskUserQuestion の質問テキスト全文を詳細表示用に組み立てる。
     * 質問本文＋選択肢ラベル・説明を含む。
     */
    buildAskQuestionFullText(questionData: AskQuestionData, questionIndex: number, totalQuestions: number): string {
      const parts: string[] = []
      const qNum = totalQuestions > 1 ? `[${questionIndex + 1}/${totalQuestions}] ` : ''
      parts.push(`${qNum}${questionData.question}`)
      if (questionData.options.length > 0) {
        parts.push('')
        parts.push('--- 選択肢 ---')
        for (const opt of questionData.options) {
          const desc = opt.description ? `: ${opt.description}` : ''
          parts.push(`• ${opt.label}${desc}`)
        }
      }
      return parts.join('\n')
    },

    /**
     * 通知詳細からのアクション選択（SDK標準ListContainer）
     * ※実機ではスクロール方向が物理操作と逆になる
     */
    async showNotificationActions(conn: BridgeConnection, detail: NotificationDetail): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2通知アクション: "${detail.title}"`)
        return
      }

      await renderHeaderListPage(conn, {
        headerContainerName: 'notif-act-hdr',
        headerYPosition: 4,
        headerHeight: 52,
        headerContent: `操作を選択\n${detail.title.length > 20 ? `${detail.title.slice(0, 19)}…` : detail.title}`,
        listContainerName: 'notif-act-lst',
        listYPosition: 58,
        listHeight: 210,
        listItems: ['コメント', 'Approve', 'Deny', '◀ 戻る'],
        targetLayout: 'notif-actions',
        layoutSet: 'notif-actions',
      })
      log(`G2に通知アクション表示: "${detail.title}"`)
    },

    /**
     * AskUserQuestion の選択肢をG2に表示する
     * 質問テキスト + 選択肢リスト（ListContainer）
     */
    async showAskUserQuestion(
      conn: BridgeConnection,
      questionData: AskQuestionData,
      questionIndex: number,
      totalQuestions: number,
    ): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2 AskUserQuestion: "${questionData.question}"`)
        return
      }

      const qNum = totalQuestions > 1 ? `[${questionIndex + 1}/${totalQuestions}] ` : ''

      const optionLabels = questionData.options.map((o) => o.label)
      optionLabels.push('その他（音声）', '◀ 戻る')

      // SDK上限: TextContainer + ListContainer 各コンテンツが 999 bytes 以内
      // ヘッダーテキストが長すぎるとファームウェアがページ全体を破棄するため切り詰める
      const headerBudget = 999 - byteLen(qNum)
      const headerText = `${qNum}${truncateByBytes(questionData.question, headerBudget)}`

      await renderHeaderListPage(conn, {
        headerContainerName: 'ask-q-hdr',
        headerYPosition: 4,
        headerHeight: 52,
        headerContent: headerText,
        listContainerName: 'ask-q-lst',
        listYPosition: 58,
        listHeight: 210,
        listItems: optionLabels,
        targetLayout: 'ask-question',
        layoutSet: 'ask-question',
      })
      log(`G2に AskUserQuestion 表示: "${questionData.question}" options=${optionLabels.length}`)
    },

    /**
     * G2に録音中画面を表示する
     * Click: 録音停止
     */
    async showReplyRecording(conn: BridgeConnection): Promise<void> {
      if (!conn.bridge) {
        log('[Mock] G2返信録音中')
        return
      }

      await renderHeaderBodyPage(conn, {
        headerContainerName: 'reply-header',
        headerContent: '音声返信',
        bodyContainerName: 'reply-body',
        bodyContent: '録音中...\n\nDblClick = 停止\nSwipe = キャンセル',
        targetLayout: 'reply-recording',
        layoutSet: 'reply-recording',
      })
      log('G2に録音中画面表示')
    },

    /**
     * 録音中画面のbodyテキストをリアルタイム更新する（ストリーミングSTT表示用）
     */
    async updateReplyRecordingBody(conn: BridgeConnection, text: string): Promise<void> {
      if (!conn.bridge) return
      const bridgeKey = bridgeKeyOf(conn)
      if (layoutByBridge.get(bridgeKey) !== 'reply-recording') return
      await upgradeText(conn, 2, 'reply-body', text)
    },

    /**
     * G2にSTT処理中画面を表示する
     */
    async showReplySttProcessing(conn: BridgeConnection): Promise<void> {
      if (!conn.bridge) {
        log('[Mock] G2 STT処理中')
        return
      }

      // reply-recording レイアウト時は textContainerUpgrade で body だけ差し替え（特殊最適化パス）
      const bridgeKey = bridgeKeyOf(conn)
      if (startupRenderedBridges.has(bridgeKey) && layoutByBridge.get(bridgeKey) === 'reply-recording') {
        if (await upgradeText(conn, 2, 'reply-body', 'STT処理中...')) {
          log('G2にSTT処理中表示')
          return
        }
      }

      await renderHeaderBodyPage(conn, {
        headerContainerName: 'reply-header',
        headerContent: '音声返信',
        bodyContainerName: 'reply-body',
        bodyContent: 'STT処理中...',
        targetLayout: 'reply-recording',
        layoutSet: 'reply-recording',
      })
      log('G2にSTT処理中表示')
    },

    /**
     * G2に返信確認後の操作メニューを表示する（SDK標準ListContainer）
     */
    async showReplyConfirmActions(conn: BridgeConnection): Promise<void> {
      if (!conn.bridge) {
        log('[Mock] G2返信確認アクション')
        return
      }

      await renderHeaderListPage(conn, {
        headerContainerName: 'rply-act-hdr',
        headerYPosition: 4,
        headerHeight: 52,
        headerContent: '返信内容 OK?',
        listContainerName: 'rply-act-lst',
        listYPosition: 58,
        listHeight: 210,
        listItems: ['送信', '再録', 'キャンセル', '◀ 本文'],
        targetLayout: 'reply-confirm-actions',
        layoutSet: 'reply-confirm-actions',
      })
      log('G2に返信確認アクション表示')
    },

    /**
     * G2に送信結果を表示する
     */
    async showReplyResult(conn: BridgeConnection, success: boolean, message?: string): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2返信結果: ${success ? '成功' : '失敗'}`)
        return
      }

      const statusLabel = success ? '返信完了' : '返信失敗'
      const statusPrefix = success ? '送信完了' : '送信失敗'

      await renderHeaderBodyPage(conn, {
        headerContainerName: 'rply-rst-hdr',
        headerContent: statusLabel,
        bodyContainerName: 'rply-rst-body',
        bodyContent: `${statusPrefix}\n${message || ''}`,
        targetLayout: 'reply-result',
        layoutSet: 'reply-result',
      })
      log(`G2に返信結果表示: ${statusLabel}`)
    },

    /**
     * G2に承認UIを表示し、ユーザーの選択を待つ
     */
    async requestApproval(
      conn: BridgeConnection,
      request: ApprovalRequest,
    ): Promise<string> {
      if (!conn.bridge) {
        log(`[Mock] 承認リクエスト: ${request.title}`)
        // Mockモードでは2秒後に自動承認
        return new Promise((resolve) => {
          setTimeout(() => {
            log('[Mock] 自動承認')
            resolve(request.options[0])
          }, 2000)
        })
      }

      // Use a compact layout that fits both 576x288 and 640x200 displays/simulators.
      await renderHeaderListPage(conn, {
        headerContainerName: 'approval-title',
        headerYPosition: 10,
        headerHeight: 48,
        headerContent: `${request.title}\n${request.detail}`,
        listContainerName: 'approval-list',
        listYPosition: 64,
        listHeight: 120,
        listItems: request.options,
        targetLayout: undefined,
        layoutSet: 'approval',
      })
      log('G2に承認UIを表示')

      // イベント待ち
      return new Promise<string>((resolve) => {
        const timeoutId = setTimeout(() => {
          log('承認タイムアウト（60秒）→ 自動拒否')
          resolve(request.options[request.options.length - 1]) // 最後の選択肢（拒否）
        }, 60_000)

        conn.onEvent((event: EvenHubEvent) => {
          if (event.listEvent) {
            const index = event.listEvent.currentSelectItemIndex ?? 0
            const selected = request.options[index] ?? request.options[0]
            clearTimeout(timeoutId)
            log(`G2で選択: "${selected}" (index=${index})`)
            resolve(selected)
          }
        })
      })
    },
  }
}
