/**
 * G2 画面: 通知一覧・通知詳細・通知アクションメニュー
 *
 * リファクタ Phase 5 で src/glasses-ui.ts から無編集移動
 * （showNotificationList 内の this.showText のみ引数 showText への機械置換）。
 * core（描画ロック・レイアウト状態を内包）は createGlassesUI() が1回だけ生成し、
 * ここへは関数引数で渡す（モジュールレベル import でロックを共有しない。
 * src/g2/render-core.ts の凍結ヘッダ参照）。
 */
import {
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
} from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from '../../bridge'
import type { NotificationItem, NotificationDetail } from '../../notifications'
import { log } from '../../log'
import {
  formatCurrentDateTime,
  formatListItemName,
  paginateText,
} from '../text-format'
import { createGhostListContainer, upgradeText, type RenderCore } from '../render-core'

export type SessionActivityState = 'active' | 'idle' | 'error' | 'dead'
type SessionActivityEntry = { tmuxTarget: string; label: string; state: SessionActivityState }

/** 通知アクションメニューの項目（index 直書きを避け id でディスパッチする） */
export type NotificationAction = {
  id: 'comment' | 'approve' | 'deny' | 'view-image' | 'back'
  label: string
}

/** 通知詳細からのアクションメニューを組み立てる */
export function buildNotificationActions(detail: NotificationDetail): NotificationAction[] {
  const hasImage = typeof detail.metadata?.imageId === 'string' && detail.metadata.imageId !== ''
  const hookType = typeof detail.metadata?.hookType === 'string' ? detail.metadata.hookType : ''

  // 画像専用通知（hookType なし）: コメント/Approve/Deny は承認フローと紐づかず
  // 必ず失敗するため出さない。メニューを最小化して誤操作と行数を減らす
  if (hasImage && !hookType) {
    return [
      { id: 'view-image', label: '画像を見る' },
      { id: 'back', label: '◀ 戻る' },
    ]
  }

  const actions: NotificationAction[] = [
    { id: 'comment', label: 'コメント' },
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ]
  if (hasImage) {
    actions.push({ id: 'view-image', label: '画像を見る' })
  }
  actions.push({ id: 'back', label: '◀ 戻る' })
  return actions
}

export function createNotificationScreens(
  core: RenderCore,
  showText: (conn: BridgeConnection, text: string) => Promise<void>,
) {
  const {
    startupRenderedBridges,
    layoutByBridge,
    bridgeKeyOf,
    renderStartupPage,
    renderHeaderListPage,
  } = core

  let currentSessionActivities: SessionActivityEntry[] = []

  const SESSION_STATE_MARK: Record<SessionActivityState, string> = {
    active: '▶',
    idle: '○',
    error: '!',
    dead: 'X',
  }

  function sessionShortName(entry: SessionActivityEntry): string {
    // "g2-cc-g2-private-4c4a:0.0" → "cc-g2" , "g2-minimalmem-246c:0.0" → "mm"
    const session = entry.tmuxTarget.split(':')[0] || ''
    const slug = session.replace(/^g2-/, '').replace(/-[0-9a-f]{4}$/, '')
    // Truncate at word boundary, strip trailing hyphen
    if (slug.length <= 5) return slug
    const cut = slug.slice(0, 6).replace(/-$/, '')
    return cut
  }

  function formatSessionActivityHeader(): string {
    if (currentSessionActivities.length === 0) return ''
    // 4セッション超は先頭4つのみ表示（G2ヘッダーの横幅制約）
    const shown = currentSessionActivities.slice(0, 4)
    return shown
      .map((s) => `${SESSION_STATE_MARK[s.state]}${sessionShortName(s)}`)
      .join(' ')
  }

  return {
    setSessionActivities(entries: SessionActivityEntry[]): void {
      currentSessionActivities = entries
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
        await showText(conn, '通知なし')
        return
      }

      // 重要: 実機ファームは ListContainer + TextContainer 複数 の組み合わせを
      // silently 破棄する（createStartUp の戻り値は 0/1 を返すが描画されない）。
      // 検証 (2026-04-15):
      //   - TextContainer 1個 + ListContainer 1個 → 表示 OK
      //   - TextContainer 2個 + ListContainer 1個 → 矩形重なりを 8px ギャップで解消しても NG
      // → ヘッダに時刻をインラインして TextContainer を1個に保つ。シミュレータは寛容で
      //    どちらでも描画してしまうので、ここを変更したら必ず実機で確認する。
      const activityPart = formatSessionActivityHeader()
      const headerText = activityPart
        ? `${activityPart} ${items.length}件 ${formatCurrentDateTime()}`
        : `通知 ${items.length}件  ${formatCurrentDateTime()}`
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
     * 通知詳細からのアクション選択（SDK標準ListContainer）
     * メニュー項目は buildNotificationActions() で組み立てた typed 配列を渡す。
     * イベント側は index ではなく actions[index].id でディスパッチすること。
     * ※実機ではスクロール方向が物理操作と逆になる
     */
    async showNotificationActions(
      conn: BridgeConnection,
      detail: NotificationDetail,
      actions: NotificationAction[],
    ): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2通知アクション: "${detail.title}" actions=${actions.map((a) => a.id).join(',')}`)
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
        listItems: actions.map((a) => a.label),
        targetLayout: 'notif-actions',
        layoutSet: 'notif-actions',
      })
      log(`G2に通知アクション表示: "${detail.title}" actions=${actions.map((a) => a.id).join(',')}`)
    },
  }
}
