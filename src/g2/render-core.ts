/**
 * G2 描画基盤（render core）【凍結ファイル】
 *
 * ============================================================================
 * 警告: このファイルの変更は docs/known-limitations.md の全読＋実機検証が必須。
 *
 * - withRenderLock の直列化範囲は「レイアウト構築（createStartUp/rebuild）＋
 *   画像転送のみ」。upgradeText はロック外。この範囲を変更してはならない
 *   （広げても狭めても実機クラッシュの前科がある。docs/refactor-plan.md 参照）。
 * - rebuildPageContainer は必ず呼んでから createStartUp にフォールバックする
 *   （§2: rebuild 呼び出し自体にイベントルーティング登録の副作用がある）。
 * - createStartUp 失敗時の連続リトライ禁止（CREATE/REBUILD 連発はホストを殺す）。
 * - renderLock・layoutByBridge・startupRenderedBridges は createRenderCore()
 *   ファクトリ内に閉じている。モジュールレベルへ移動するとロック/状態が
 *   HMR・多重 import で分裂し、BLE 書き込み交錯クラッシュが再発する。
 *   core オブジェクトは createGlassesUI() で1回だけ生成し、各画面モジュールへ
 *   関数引数で渡すこと（モジュールレベル import でロックを共有しようとしない）。
 * ============================================================================
 *
 * リファクタ Phase 5 で src/glasses-ui.ts から無編集移動。
 */
import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  ImageContainerProperty,
  RebuildPageContainer,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from '../bridge'
import { log } from '../log'
import { LIST_ITEM_MAX_BYTES, truncateByBytes } from './text-format'

// 画像タイル1枚の送信タイムアウト。実機BLE転送は0.5〜2秒/フレームが公称のため余裕を持たせる。
// updateImageRawData がハングすると renderLock が解放されず全UIが固まるため必須。
export const IMAGE_TILE_TIMEOUT_MS = 10000

export type LayoutName = 'base' | 'text' | 'idle-launcher' | 'approval' | 'notif-list' | 'notif-detail' | 'notif-actions' | 'image-detail' | 'ask-question' | 'reply-recording' | 'reply-confirm-actions' | 'reply-result'

export type HeaderListPageOptions = {
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

export type HeaderBodyPageOptions = {
  headerContainerName: string
  headerContent: string
  bodyContainerName: string
  bodyContent: string
  targetLayout: string
  layoutSet: LayoutName
}

/** ghostListContainer: 実機で text+list -> text+text の切替が不安定なため保持するダミー */
export function createGhostListContainer(): ListContainerProperty {
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
export async function upgradeText(
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

/** createRenderCore() が返す描画基盤オブジェクト。生成は createGlassesUI() 内の1回のみ。 */
export type RenderCore = ReturnType<typeof createRenderCore>

export function createRenderCore() {
  // The host treats startup-page creation as one-time init; later UI changes should use rebuild.
  const startupRenderedBridges = new WeakSet<object>()
  const layoutByBridge = new WeakMap<object, LayoutName>()
  const bridgeKeyOf = (conn: BridgeConnection) => conn.bridge as unknown as object

  // 描画ロック: SDK呼び出しの同時実行を防ぐ（実機で衝突するとG2が固まる）
  let renderLock: Promise<void> = Promise.resolve()
  let rendering = false

  // 注意: レイアウト構築（createStartUp/rebuild）にはタイムアウトを付けない。
  // 一度8秒タイムアウト+フォールバックを試したが、タイムアウトは呼び出しの
  // キャンセルではないため、宙吊りのBLE書き込みが生きたままロックが解放され、
  // 次の描画と交錯してホストクラッシュを踏んだ（2026-06-10 実機で確認、レビュー指摘）。
  // BLEリンク断で呼び出しが返らない場合はUIが固まるが、クラッシュよりは安全
  // （main と同じ挙動。復帰はページ再読み込みで行う）。

  // 切り分けメモ (2026-06-10): 一時導入していた minGap（直前SDK呼び出しから600ms空ける）、
  // 軽量 upgradeText のロック化、STT字幕の自己直列キュー、ghost用レイアウト時刻計測は
  // すべて撤去し、ロック範囲を main と同じ「レイアウト構築・画像転送のみ」に戻した。
  // これらの機構を入れた後もクラッシュが続き、mainになかったBLE書き込みタイミング
  // パターン（ロック解放直後の連射等）を作っている疑いが残ったため、main挙動との
  // 差分を最小化して原因を二分する。

  /** Promise にタイムアウトを付ける。超過時は fallback を返す（reject しない）。
   *  updateImageRawData はホスト側がハングすることがあり（コミュニティ実装の共通対策）、
   *  タイムアウトなしだと renderLock が永久に保持され UI 全体が固まる。 */
  function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms)
      p.then(
        (v) => { clearTimeout(timer); resolve(v) },
        () => { clearTimeout(timer); resolve(fallback) },
      )
    })
  }

  /** 描画ロックを取って fn を実行する（レイアウト構築・画像転送の同時実行を防ぐ） */
  async function withRenderLock<T>(fn: () => Promise<T>): Promise<T> {
    await renderLock
    let unlock: () => void
    renderLock = new Promise((resolve) => { unlock = resolve })
    rendering = true
    try {
      return await fn()
    } finally {
      rendering = false
      unlock!()
    }
  }

  async function renderStartupPage(
    conn: BridgeConnection,
    {
      texts = [],
      lists = [],
      images = [],
      targetLayout,
    }: {
      texts?: TextContainerProperty[]
      lists?: ListContainerProperty[]
      images?: ImageContainerProperty[]
      targetLayout?: string
    },
  ) {
    if (!conn.bridge) return
    await withRenderLock(() => _renderStartupPageInner(conn, texts, lists, targetLayout, images))
  }

  async function _renderStartupPageInner(
    conn: BridgeConnection,
    texts: TextContainerProperty[],
    lists: ListContainerProperty[],
    targetLayout?: string,
    images: ImageContainerProperty[] = [],
  ) {
    if (!conn.bridge) return

    const payload = new CreateStartUpPageContainer({
      containerTotalNum: texts.length + lists.length + images.length,
      textObject: texts,
      listObject: lists,
      imageObject: images,
    })

    const bridgeKey = bridgeKeyOf(conn)
    const currentLayout = layoutByBridge.get(bridgeKey)

    // 初回のみ createStartUp、以降は rebuild（SDKの仕様: createStartUpは1回のみ）
    if (!startupRenderedBridges.has(bridgeKey)) {
      const startupInfo = {
        total: texts.length + lists.length + images.length,
        texts: texts.map((t) => ({ id: t.containerID, name: t.containerName })),
        lists: lists.map((l) => ({ id: l.containerID, name: l.containerName })),
        images: images.map((i) => ({ id: i.containerID, name: i.containerName })),
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
      total: texts.length + lists.length + images.length,
      texts: texts.map((t) => ({ id: t.containerID, name: t.containerName, y: t.yPosition, h: t.height, event: t.isEventCapture })),
      lists: lists.map((l) => ({ id: l.containerID, name: l.containerName, y: l.yPosition, h: l.height, event: l.isEventCapture })),
      images: images.map((i) => ({ id: i.containerID, name: i.containerName, y: i.yPosition, h: i.height })),
    }
    log(`G2 rebuild: ${currentLayout} → ${targetLayout} containers=${JSON.stringify(containerInfo)}`)

    const rebuildPayload = new RebuildPageContainer({
      containerTotalNum: texts.length + lists.length + images.length,
      textObject: texts,
      listObject: lists,
      imageObject: images,
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
        // 注意: ここで自動リトライしない。コミュニティ知見（EvenChess / g2-kit-unofficial）
        // では失敗時の CREATE/REBUILD 連発がファームをさらに圧迫し SYSTEM_EXIT に
        // エスカレートする。失敗はログに残し、次のユーザー操作由来の描画に委ねる。
        log(`G2 createStartUp フォールバック失敗: code=${forced}`)
      }
    }
  }

  /** header TextContainer + list ListContainer の共通描画パターン */
  async function renderHeaderListPage(conn: BridgeConnection, opts: HeaderListPageOptions): Promise<void> {
    // 公式仕様 (hub.evenrealities.com/docs/guides/display): リストは最大20件、
    // アイテムは1件あたり最大64文字（実体はUTF-8バイト基準、LIST_ITEM_MAX_BYTES 参照）。
    // 超過すると rebuild が失敗し createStartUp も code=1 (Invalid parameters) で失敗、
    // 失敗描画の連発がホスト(Even App)クラッシュを誘発する
    // （2026-06-10 実機の AskUserQuestion 103文字選択肢で再現・特定）。
    // さらにページ全体の実測バイト予算（known-limitations §5: 999 bytes）に収まるよう
    // アイテム数に応じたバイト上限も併用する。呼び出し側の事前切り詰めに頼らず
    // ここで必ず適合させる。
    const perItemByteCap = Math.min(
      LIST_ITEM_MAX_BYTES,
      Math.max(24, Math.floor(900 / Math.max(1, opts.listItems.length))),
    )
    const safeItems = opts.listItems.slice(0, 20).map((item) => truncateByBytes(item, perItemByteCap))

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
        itemCount: safeItems.length,
        itemWidth: 0,
        isItemSelectBorderEn: 1,
        itemName: safeItems,
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
    startupRenderedBridges,
    layoutByBridge,
    bridgeKeyOf,
    /** 描画中かどうか（ポーリング等で衝突を避けるために使用） */
    isRendering: () => rendering,
    withTimeout,
    withRenderLock,
    renderStartupPage,
    _renderStartupPageInner,
    renderHeaderListPage,
    renderHeaderBodyPage,
  }
}
