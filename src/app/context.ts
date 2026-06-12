/**
 * アプリ全体の共有可変状態（AppContext）
 *
 * リファクタ Phase 4 で main.ts のモジュールレベル let 群を 1 オブジェクトに集約。
 * モジュール間の let export は「書き込みが他モジュールから見えない」事故の元のため、
 * 必ずこのオブジェクトのプロパティ参照で読み書きする。
 *
 * インスタンスは main.ts（エントリーポイント）で 1 個だけ生成し、各モジュールへ
 * 関数引数で渡す。このモジュール自体はステートレス（型とファクトリのみ）に保つ。
 * Vite HMR でモジュール状態が二重化する事故を防ぐため、可変状態をモジュール
 * レベルに置かないこと。
 */
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from '../bridge'
import type { createGlassesUI, NotificationUIState, SessionActivityState } from '../glasses-ui'
import type { createNotificationClient } from '../notifications'
import type { WebSpeechSession } from '../stt/webspeech'
import type { OpenAIRealtimeSTT } from '../stt/openai-realtime'
import type { SonioxRealtimeSTT } from '../stt/soniox-realtime'
import type { MirrorStore } from '../mirror/state'

export type GlassesUI = ReturnType<typeof createGlassesUI>
export type NotificationClient = ReturnType<typeof createNotificationClient>

export type ContextSession = { sessionId: string; cwd: string; usedPercentage: number; model: string }
export type SessionActivityEntry = { tmuxTarget: string; label: string; state: SessionActivityState }

// --- ガード窓定数群（main.ts から無編集移動。数値・分岐順は変更禁止） ---
export const DETAIL_SCROLL_COOLDOWN_MS = 250
export const TAP_SCROLL_SUPPRESS_MS = 150
export const IDLE_DOUBLE_TAP_WINDOW_MS = 700
export const IDLE_REOPEN_COOLDOWN_MS = 4000
// idle→一覧を開いた直後は、同じダブルタップ動作の「2発目」が一覧の
// クローズ（待機復帰）として誤発火しやすい。この窓の間はクローズを握り潰す。
export const LIST_OPEN_CLOSE_GUARD_MS = 800
// 録音停止のdoubleTap/listEvent残りが返信確認画面に刺さるため、描画直後だけ捨てる。
export const REPLY_CONFIRM_EVENT_GUARD_MS = 1200
// 画像転送完了直後の戻る操作をブロックするクールダウン（ホスト安定待ち、クラッシュ対策）
export const IMAGE_BACK_COOLDOWN_MS = 800

/**
 * main.ts に残る DOM 更新関数への参照（dashboard 系は main.ts から動かさない方針のため、
 * 分割先モジュールからはこのフックを経由して呼ぶ）。
 */
export type AppUi = {
  setPill(id: string, text: string, tone?: 'neutral' | 'ok' | 'warn' | 'error'): void
  updateDashboard(): void
  updateNotifInfo(): void
}

export type AppContext = {
  // 単一所有のインスタンス（生成は main.ts で 1 回のみ）
  readonly glassesUI: GlassesUI
  readonly notifClient: NotificationClient
  readonly ui: AppUi
  // G2 ミラー（?mirror=1 時のみ main.ts が生成。null なら app/connect.ts は
  // bridge 観測タップを配線しない。plan/g2-mirror.md 参照）
  readonly mirror: MirrorStore | null

  // --- 接続状態 ---【主な書き手: app/connect.ts】
  connection: BridgeConnection | null
  // 二重接続防止: initBridge() を複数回呼ぶと SDK bridge への onEvenHubEvent 登録が
  // 重複し、全イベントが二重処理→描画が二重実行されて実機ホストが不安定になる。
  // 手動 Connect ボタンと自動接続の両方から接続処理を通るため、このフラグで冪等化する。
  connectInFlight: boolean
  audioListenerAttached: boolean
  deviceStatusListenerAttached: boolean
  // G2 の装着状態。
  deviceWearing: boolean
  speechCapabilityLogged: boolean

  // --- dev マイクテスト ---【主な書き手: main.ts の dev UI 配線】
  isRecording: boolean
  audioChunks: Uint8Array[]
  audioTotalBytes: number
  webSpeechSession: WebSpeechSession | null
  webSpeechFinalText: string
  webSpeechInterimText: string
  webSpeechError: string

  // --- 返信録音 ---【主な書き手: g2/recording.ts（録音開始/停止は g2/event-router.ts からも）】
  replyAudioChunks: Uint8Array[]
  replyAudioTotalBytes: number
  replyIsRecording: boolean
  replyStopInFlight: boolean
  realtimeSTT: OpenAIRealtimeSTT | SonioxRealtimeSTT | null

  // --- G2 イベントルーティングのガード窓・保留イベント ---
  //【主な書き手: g2/event-router.ts（imageBackBlockedUntil のみ g2/flows.ts）】
  lastIdleEventAt: number
  idleTapDuringRender: boolean
  idleOpenBlockedUntil: number
  listOpenedFromIdleAt: number
  pendingNotifEvent: EvenHubEvent | null
  pendingNotifEventFlushTimer: ReturnType<typeof setTimeout> | null
  notifEventInFlight: boolean
  lastDetailScrollAt: number
  lastTapEventAt: number
  notifEventRegisteredFor: object | null // ハンドラ登録済みの connection を追跡
  // 画像転送完了直後の戻る操作をブロックする期限（ホスト安定待ち、クラッシュ対策）
  imageBackBlockedUntil: number
  replyConfirmIgnoreUntil: number

  // --- 通知 UI 状態 ---
  //【共有状態: hub/sse-client.ts・g2/event-router.ts・g2/flows.ts が読み書きする唯一のグループ。
  //  screen 遷移の不変条件は g2/event-router.ts の分岐順が定義する】
  notifState: NotificationUIState
  pendingAutoOpenOnNew: boolean
  pendingListRefresh: boolean

  // --- Hub 連携（SSE・ポーリング） ---
  //【主な書き手: hub/sse-client.ts（imageTransferQuiet / quietDeferredSse のみ g2/flows.ts が制御）】
  hubReachable: boolean | null
  lastNotifRefreshAt: number | null
  latestContextPct: number | undefined
  contextSessions: ContextSession[]
  sessionActivities: SessionActivityEntry[]
  sseSource: EventSource | null
  contextPollTimer: ReturnType<typeof setInterval> | null
  pendingFlushTimer: ReturnType<typeof setTimeout> | null
  // 画像転送中はSSEイベント処理を後回しにして転送ウィンドウを静かに保つ。
  // 実測 (2026-06-10): 画像転送開始0.4秒後に完了通知のSSEが到着した回だけホストが
  // クラッシュした（通知が転送完了の3秒後に届いた回は無事）。受信時のJS処理
  // （ダッシュボードDOM更新・ログミラーPOST等）がブリッジ経由のチャンク転送と
  // WebViewメインスレッドを取り合うのを避ける。描画自体は元々保留される設計のため、
  // イベントは捨てずに転送完了後へ繰り延べる。
  imageTransferQuiet: boolean
  quietDeferredSse: MessageEvent[]
}

export function createAppContext(deps: {
  glassesUI: GlassesUI
  notifClient: NotificationClient
  ui: AppUi
  mirror?: MirrorStore | null
}): AppContext {
  return {
    glassesUI: deps.glassesUI,
    notifClient: deps.notifClient,
    ui: deps.ui,
    mirror: deps.mirror ?? null,

    connection: null,
    connectInFlight: false,
    audioListenerAttached: false,
    deviceStatusListenerAttached: false,
    deviceWearing: true,
    speechCapabilityLogged: false,

    isRecording: false,
    audioChunks: [],
    audioTotalBytes: 0,
    webSpeechSession: null,
    webSpeechFinalText: '',
    webSpeechInterimText: '',
    webSpeechError: '',

    replyAudioChunks: [],
    replyAudioTotalBytes: 0,
    replyIsRecording: false,
    replyStopInFlight: false,
    realtimeSTT: null,

    lastIdleEventAt: 0,
    idleTapDuringRender: false,
    idleOpenBlockedUntil: 0,
    listOpenedFromIdleAt: 0,
    pendingNotifEvent: null,
    pendingNotifEventFlushTimer: null,
    notifEventInFlight: false,
    lastDetailScrollAt: 0,
    lastTapEventAt: 0,
    notifEventRegisteredFor: null,
    imageBackBlockedUntil: 0,
    replyConfirmIgnoreUntil: 0,

    notifState: {
      screen: 'idle',
      items: [],
      detailActions: [],
      selectedIndex: 0,
      detailPages: [],
      detailPageIndex: 0,
      detailItem: null,
      replyText: '',
      askQuestions: [],
      askQuestionIndex: 0,
      askAnswers: {},
    },
    pendingAutoOpenOnNew: false,
    pendingListRefresh: false,

    hubReachable: null,
    lastNotifRefreshAt: null,
    latestContextPct: undefined,
    contextSessions: [],
    sessionActivities: [],
    sseSource: null,
    contextPollTimer: null,
    pendingFlushTimer: null,
    imageTransferQuiet: false,
    quietDeferredSse: [],
  }
}
