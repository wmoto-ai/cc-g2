import './styles.css'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { initBridge, type BridgeConnection } from './bridge'
import { createGlassesUI, type NotificationUIState } from './glasses-ui'
import { log } from './log'
import { transcribePcmChunks } from './stt/groq'
import { formatForG2Display } from './g2-format'
import { appConfig, canUseGroqStt, createHubHeaders } from './config'
import { getWebSpeechSupport, startWebSpeechCapture, type WebSpeechSession } from './stt/webspeech'
import { createNotificationClient, type NotificationDetail, type NotificationItem } from './notifications'
import { G2_EVENT, getNormalizedEventType, isDoubleTapEventType, isTapEventType, normalizeHubEvent } from './even-events'

const appRoot = document.querySelector<HTMLDivElement>('#app')!
const uiSearch = new URLSearchParams(globalThis.location?.search || '')
const devUiEnabled = import.meta.env.DEV || uiSearch.get('dev') === '1'

appRoot.innerHTML = `
  <header class="hero">
    <h1>cc-g2</h1>
    <p class="subtitle">Claude Code companion for Even G2</p>
    <p class="hero-copy">G2 で通知を見て、承認・拒否・音声コメントを返すための companion console。</p>
  </header>

  <section class="card hero-card">
    <div class="hero-actions">
      <button id="connect-btn" class="btn btn-primary" type="button">Connect Glasses</button>
      <button id="notif-fetch-btn" class="btn" type="button">Refresh Notifications</button>
      <button id="notif-show-g2-btn" class="btn" type="button" disabled>Open On G2</button>
    </div>
    <div class="status-grid">
      <div class="status-block">
        <span class="status-label">G2</span>
        <span id="connection-status" class="status-pill">未接続</span>
      </div>
      <div class="status-block">
        <span class="status-label">Hub</span>
        <span id="hub-status" class="status-pill">未確認</span>
      </div>
      <div class="status-block">
        <span class="status-label">Notifications</span>
        <span id="notif-count" class="status-pill">0件</span>
      </div>
      <div class="status-block">
        <span class="status-label">G2 Screen</span>
        <span id="g2-screen-status" class="status-pill">idle</span>
      </div>
    </div>
    <p id="last-sync-status" class="inline-note">最終更新: まだありません</p>
  </section>

  <section class="card">
    <div class="section-head">
      <div>
        <h2>Recent Notifications</h2>
        <p class="card-copy">最新 5 件。スマホ側では状態確認、主操作は G2 側で行います。</p>
      </div>
      <span id="notif-status" class="inline-status">未取得</span>
    </div>
    <ul id="recent-notifs" class="queue-list"></ul>
    <pre id="notif-info" class="queue-detail"></pre>
  </section>

  ${devUiEnabled ? `
  <details class="card dev-card">
    <summary>Developer Tools</summary>
    <div class="tool-grid">
      <section class="tool-block">
        <h2>テキスト表示テスト</h2>
        <input id="display-text" type="text" placeholder="G2に表示するテキスト" value="Hello from claw-lab!" />
        <button id="send-text-btn" class="btn" type="button">G2に送信</button>
      </section>

      <section class="tool-block">
        <h2>承認UIテスト</h2>
        <p class="tool-copy">G2上にリスト表示して承認/拒否を試す</p>
        <button id="approval-btn" class="btn" type="button">承認リクエスト送信</button>
        <span id="approval-result" class="status-line">未実行</span>
      </section>

      <section class="tool-block">
        <h2>マイクテスト</h2>
        <button id="mic-start-btn" class="btn" type="button">録音開始</button>
        <button id="mic-stop-btn" class="btn" type="button" disabled>録音停止</button>
        <p id="mic-status" class="status-line">待機中</p>
        <pre id="audio-info"></pre>
      </section>
    </div>
  </details>

  <details class="card dev-card">
    <summary>Event Log</summary>
    <pre id="event-log"></pre>
  </details>
  ` : `
  <section class="card debug-note">
    <h2>Debug UI</h2>
    <p class="card-copy">Developer Tools と Event Log は <code>?dev=1</code> を付けると表示されます。</p>
  </section>
  `}
`

let connection: BridgeConnection | null = null
const glassesUI = createGlassesUI()
const notifClient = createNotificationClient(appConfig.notificationHubUrl)
let audioListenerAttached = false
let isRecording = false
let audioTotalBytes = 0
let speechCapabilityLogged = false
let webSpeechSession: WebSpeechSession | null = null
let webSpeechFinalText = ''
let webSpeechInterimText = ''
let webSpeechError = ''
let deviceStatusListenerAttached = false
let replyAudioChunks: Uint8Array[] = []
let replyAudioTotalBytes = 0
let replyIsRecording = false
let replyStopInFlight = false
let lastIdleEventAt = 0
let idleTapDuringRender = false
let idleOpenBlockedUntil = 0
let pendingNotifEvent: EvenHubEvent | null = null
let pendingNotifEventFlushTimer: ReturnType<typeof setTimeout> | null = null
let notifEventInFlight = false
let lastDetailScrollAt = 0
let lastTapEventAt = 0
let latestContextPct: number | undefined
let hubReachable: boolean | null = null
let lastNotifRefreshAt: number | null = null
type ContextSession = { sessionId: string; cwd: string; usedPercentage: number; model: string }
let contextSessions: ContextSession[] = []

const DETAIL_SCROLL_COOLDOWN_MS = 250
const TAP_SCROLL_SUPPRESS_MS = 150
const IDLE_DOUBLE_TAP_WINDOW_MS = 700
const IDLE_REOPEN_COOLDOWN_MS = 4000

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function screenLabel(screen: NotificationUIState['screen']): string {
  switch (screen) {
    case 'idle': return 'idle'
    case 'list': return 'list'
    case 'detail': return 'detail'
    case 'detail-actions': return 'actions'
    case 'reply-recording': return 'recording'
    case 'reply-confirm': return 'confirm'
    case 'reply-sending': return 'sending'
  }
}

function replyStatusLabel(item: NotificationItem): string {
  switch (item.replyStatus) {
    case 'replied': return 'replied'
    case 'delivered': return 'delivered'
    case 'decided': return 'decided'
    case 'pending': return 'pending'
    default: return 'new'
  }
}

function formatRelativeTime(ms: number | null): string {
  if (!ms) return 'まだありません'
  const diff = Date.now() - ms
  if (diff < 5_000) return 'たった今'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分前`
  return new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

function getReplyResultMessage(res: { reply?: { status?: string; result?: string; error?: string; ignoredReason?: string } } | undefined): { ok: boolean; message?: string } {
  const reply = res?.reply
  if (!reply) return { ok: true }
  if (reply.status === 'failed') {
    return { ok: false, message: reply.error || 'reply failed' }
  }
  if (reply.result === 'ignored') {
    if (reply.ignoredReason === 'approval-not-pending') {
      return { ok: false, message: 'この承認は既に無効です' }
    }
    if (reply.ignoredReason === 'approval-link-not-found') {
      return { ok: false, message: '承認リンクが見つかりません' }
    }
    return { ok: false, message: reply.error || 'reply ignored' }
  }
  return { ok: true }
}

function setPill(id: string, text: string, tone: 'neutral' | 'ok' | 'warn' | 'error' = 'neutral') {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = text
  el.className = `status-pill ${tone}`
}

function renderRecentNotifications() {
  const listEl = document.getElementById('recent-notifs')
  if (!listEl) return
  const items = notifState.items.slice(0, 5)
  if (items.length === 0) {
    listEl.innerHTML = '<li class="queue-empty">通知はまだありません。</li>'
    return
  }
  listEl.innerHTML = items.map((item, index) => {
    const active = notifState.screen === 'list' && index === notifState.selectedIndex ? ' active' : ''
    const title = escapeHtml(item.title)
    const source = escapeHtml(item.source)
    const status = escapeHtml(replyStatusLabel(item))
    const age = escapeHtml(new Date(item.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }))
    return `<li class="queue-item${active}">
      <div class="queue-title">${title}</div>
      <div class="queue-meta">${source} · ${status} · ${age}</div>
    </li>`
  }).join('')
}

function updateDashboard() {
  const g2Tone = connection ? 'ok' : 'neutral'
  const g2Text = connection ? (connection.mode === 'bridge' ? '接続済み (Bridge)' : '接続済み (Mock)') : '未接続'
  setPill('connection-status', g2Text, g2Tone)

  if (hubReachable == null) setPill('hub-status', '未確認', 'neutral')
  else setPill('hub-status', hubReachable ? 'reachable' : 'error', hubReachable ? 'ok' : 'error')

  const notifTone = notifState.items.length > 0 ? 'ok' : 'neutral'
  setPill('notif-count', `${notifState.items.length}件`, notifTone)
  setPill('g2-screen-status', screenLabel(notifState.screen), 'neutral')

  const syncEl = document.getElementById('last-sync-status')
  if (syncEl) syncEl.textContent = `最終更新: ${formatRelativeTime(lastNotifRefreshAt)}`

  renderRecentNotifications()
}

// --- Context status polling ---
async function fetchContextStatus() {
  try {
    const res = await fetch(`${appConfig.notificationHubUrl}/api/context-status`, {
      headers: createHubHeaders(),
    })
    if (!res.ok) return
    const data = await res.json() as { ok: boolean; sessions: ContextSession[] }
    if (data.sessions && data.sessions.length > 0) {
      contextSessions = data.sessions
      latestContextPct = Math.max(...data.sessions.map((s) => s.usedPercentage))
    }
  } catch { /* ignore */ }
}

/** 通知のmetadata.cwdに一致するセッションのコンテキスト占有率を返す */
function getContextPctForNotification(detail: { metadata?: Record<string, unknown> }): number | undefined {
  const cwd = detail.metadata?.cwd
  if (typeof cwd !== 'string' || contextSessions.length === 0) return latestContextPct
  const matches = contextSessions.filter((s) => s.cwd === cwd)
  if (matches.length === 0) return latestContextPct
  return Math.max(...matches.map((s) => s.usedPercentage))
}

// --- Connect ---
document.getElementById('connect-btn')!.addEventListener('click', async () => {
  setPill('connection-status', '接続中...', 'warn')
  log('Bridge接続を開始...')

  try {
    connection = await initBridge()
    updateDashboard()
    log(`接続成功: ${connection.mode} モード`)

    if (connection.bridge) {
      try {
        const info = await connection.bridge.getDeviceInfo()
        if (info) {
          log(
            `DeviceInfo: model=${info.model}, sn=${info.sn || '-'}, connectType=${info.status?.connectType || '-'}, battery=${info.status?.batteryLevel ?? '-'}%`,
          )
        } else {
          log('DeviceInfo: 取得結果なし')
        }
      } catch (err) {
        log(`DeviceInfo取得失敗: ${err instanceof Error ? err.message : String(err)}`)
      }

      if (!deviceStatusListenerAttached) {
        try {
          connection.bridge.onDeviceStatusChanged((status) => {
            log(
              `DeviceStatus: connectType=${status.connectType}, wearing=${status.isWearing}, battery=${status.batteryLevel}%`,
            )
          })
          deviceStatusListenerAttached = true
        } catch (err) {
          log(`DeviceStatus購読失敗: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    if (!speechCapabilityLogged) {
      log(
        `STT設定: enabled=${appConfig.sttEnabled ? 'yes' : 'no'}, forceError=${appConfig.sttForceError ? 'yes' : 'no'}, provider=${canUseGroqStt() ? 'hub' : 'mock'}`,
      )
      if (appConfig.webSpeechCompare) {
        const cap = getWebSpeechSupport()
        log(
          `Web Speech API可否: SpeechRecognition=${cap.speechRecognition ? 'yes' : 'no'}, webkitSpeechRecognition=${cap.webkitSpeechRecognition ? 'yes' : 'no'}`,
        )
      }
      speechCapabilityLogged = true
    }

    if (!audioListenerAttached) {
      const audioInfo = document.getElementById('audio-info')!
      connection.onAudio((pcm: Uint8Array) => {
        // 返信録音中なら返信用チャンクに追加
        if (replyIsRecording) {
          replyAudioChunks.push(pcm)
          replyAudioTotalBytes += pcm.length
          return
        }

        if (!isRecording) return

        audioChunks.push(pcm)
        audioTotalBytes += pcm.length
        const durationMs = (audioTotalBytes / 2) / 16 // 16kHz, 16bit = 2 bytes/sample
        audioInfo.textContent = [
          `チャンク数: ${audioChunks.length}`,
          `合計バイト: ${audioTotalBytes}`,
          `推定時間: ${(durationMs / 1000).toFixed(1)}秒`,
          `最新チャンク: ${pcm.length} bytes`,
        ].join('\n')
      })
      audioListenerAttached = true
    }
    ensureNotifEventHandler(connection)
    startNotificationPolling()
  } catch (err) {
    setPill('connection-status', '接続失敗', 'error')
    log(`接続失敗: ${err}`)
  }
})

// --- Text Display ---
document.getElementById('send-text-btn')!.addEventListener('click', async () => {
  const text = (document.getElementById('display-text') as HTMLInputElement).value
  if (!connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  log(`テキスト送信: "${text}"`)
  await glassesUI.showText(connection, text)
})

// --- Approval UI ---
document.getElementById('approval-btn')!.addEventListener('click', async () => {
  const resultEl = document.getElementById('approval-result')!
  if (!connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  resultEl.textContent = '承認待ち...'
  log('承認リクエスト送信: ファイル編集の承認')

  const result = await glassesUI.requestApproval(connection, {
    title: 'ファイル編集の承認',
    detail: 'src/auth.ts +12行/-3行',
    options: ['承認', '拒否'],
  })

  resultEl.textContent = `結果: ${result}`
  resultEl.classList.add(result === '承認' ? 'approved' : 'rejected')
  log(`承認結果: ${result}`)
})

// --- Mic ---
let audioChunks: Uint8Array[] = []

document.getElementById('mic-start-btn')!.addEventListener('click', async () => {
  if (!connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  audioChunks = []
  audioTotalBytes = 0
  isRecording = true
  const micStatus = document.getElementById('mic-status')!
  const startBtn = document.getElementById('mic-start-btn') as HTMLButtonElement
  const stopBtn = document.getElementById('mic-stop-btn') as HTMLButtonElement
  const audioInfo = document.getElementById('audio-info')!

  startBtn.disabled = true
  stopBtn.disabled = false
  micStatus.textContent = '録音中...'
  audioInfo.textContent = ''
  log('マイク開始')

  webSpeechFinalText = ''
  webSpeechInterimText = ''
  webSpeechError = ''
  if (appConfig.webSpeechCompare) {
    const wsCap = getWebSpeechSupport()
    if (wsCap.available) {
      try {
        webSpeechSession = startWebSpeechCapture(({ finalText, interimText }) => {
          webSpeechFinalText = finalText
          webSpeechInterimText = interimText
        })
        log('Web Speech比較キャプチャ開始（ブラウザ/端末マイク系）')
      } catch (err) {
        webSpeechSession = null
        webSpeechError = err instanceof Error ? err.message : String(err)
        log(`Web Speech開始失敗: ${webSpeechError}`)
      }
    }
  }

  // evenhub-simulator requires at least one created page/container before audioControl().
  if (connection.mode === 'bridge' && !glassesUI.hasRenderedPage(connection)) {
    log('マイク前にG2ベースページを初期化（simulator対策）')
    await glassesUI.ensureBasePage(connection, 'マイク録音中...')
  }

  await connection.startAudio()
})

document.getElementById('mic-stop-btn')!.addEventListener('click', async () => {
  if (!connection) return
  const micStatus = document.getElementById('mic-status')!
  const startBtn = document.getElementById('mic-start-btn') as HTMLButtonElement
  const stopBtn = document.getElementById('mic-stop-btn') as HTMLButtonElement
  const audioInfo = document.getElementById('audio-info')!

  await connection.stopAudio()
  isRecording = false
  if (appConfig.webSpeechCompare && webSpeechSession) {
    try {
      const ws = await webSpeechSession.stop()
      webSpeechFinalText = ws.finalText
      webSpeechInterimText = ws.interimText
      if (ws.error) webSpeechError = ws.error
      log(
        `Web Speech停止: final=${ws.finalText ? 'yes' : 'no'}, interim=${ws.interimText ? 'yes' : 'no'}${ws.error ? `, error=${ws.error}` : ''}`,
      )
    } catch (err) {
      webSpeechError = err instanceof Error ? err.message : String(err)
      log(`Web Speech停止失敗: ${webSpeechError}`)
    } finally {
      webSpeechSession = null
    }
  }
  startBtn.disabled = false
  stopBtn.disabled = true

  micStatus.textContent = `録音完了 (${audioChunks.length}チャンク, ${audioTotalBytes}バイト)`
  log(`マイク停止: ${audioChunks.length}チャンク, ${audioTotalBytes}バイト取得`)

  if (audioTotalBytes === 0) {
    return
  }

  micStatus.textContent = 'STT処理中...'
  log('STT開始')

  try {
    const stt = await transcribePcmChunks(audioChunks)
    const formatted = formatForG2Display(stt.text || '（認識結果なし）')
    micStatus.textContent = `STT完了 (${stt.provider}${stt.model ? `:${stt.model}` : ''})`
    const infoLines = [
      audioInfo.textContent,
      '',
      `STT provider: ${stt.provider}${stt.model ? ` (${stt.model})` : ''}`,
      `STT text: ${stt.text || '（空）'}`,
    ]
    if (appConfig.webSpeechCompare) {
      const cap = getWebSpeechSupport()
      infoLines.push(
        `Web Speech API: SpeechRecognition=${cap.speechRecognition ? 'yes' : 'no'}, webkitSpeechRecognition=${cap.webkitSpeechRecognition ? 'yes' : 'no'}`,
        `Web Speech final: ${webSpeechFinalText || '（空）'}`,
        `Web Speech interim: ${webSpeechInterimText || '（空）'}`,
        `Web Speech error: ${webSpeechError || 'なし'}`,
      )
    }
    infoLines.push('', 'G2表示用:', formatted)
    audioInfo.textContent = infoLines.join('\n')
    log(`STT完了: provider=${stt.provider}${stt.model ? ` model=${stt.model}` : ''}`)
    log(`STT結果: ${stt.text || '（空）'}`)
    if (appConfig.webSpeechCompare && webSpeechFinalText) {
      log(`Web Speech結果(比較): ${webSpeechFinalText}`)
    }
    await glassesUI.showText(connection, formatted)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    micStatus.textContent = 'STT失敗'
    log(`STT失敗: ${message}`)
    if (connection) {
      await glassesUI.showText(connection, 'STT失敗\n再試行してください')
    }
  }
})

// --- Notifications ---
const notifState: NotificationUIState = {
  screen: 'idle',
  items: [],
  selectedIndex: 0,
  detailPages: [],
  detailPageIndex: 0,
  detailItem: null,
  replyText: '',
}

let notifEventRegisteredFor: object | null = null // ハンドラ登録済みの connection を追跡
let notifPollingStarted = false
let lastG2UserEventAt = 0
let pendingAutoOpenOnNew = false
let pendingListRefresh = false

function canAutoOpenForScreen(screen: NotificationUIState['screen']): boolean {
  // 録音/送信中は割り込まない。他の画面では新着優先で一覧へ寄せる。
  return screen !== 'reply-recording' && screen !== 'reply-confirm' && screen !== 'reply-sending'
}

async function flushPendingNotificationUi(reason: string) {
  if (!connection || glassesUI.isRendering()) return

  if (pendingAutoOpenOnNew && appConfig.notificationAutoOpenOnNew && canAutoOpenForScreen(notifState.screen)) {
    notifState.screen = 'list'
    notifState.selectedIndex = 0
    await glassesUI.showNotificationList(connection, notifState.items)
    pendingAutoOpenOnNew = false
    log(`通知自動更新: ${notifState.items.length}件 (保留中の自動表示を再試行して成功 reason=${reason})`)
    return
  }

  if (pendingListRefresh && notifState.screen === 'list') {
    await glassesUI.showNotificationList(connection, notifState.items)
    pendingListRefresh = false
    log(`通知自動更新: ${notifState.items.length}件 (保留中のリスト更新を再試行して成功 reason=${reason})`)
  }
}

function startNotificationPolling() {
  if (notifPollingStarted) return
  notifPollingStarted = true
  log(`通知ポーリング開始: interval=${appConfig.notificationPollIntervalMs}ms autoOpen=${appConfig.notificationAutoOpenOnNew ? 'on' : 'off'}`)
  setInterval(async () => {
    if (!connection) return
    fetchContextStatus()
    await flushPendingNotificationUi('polling')
    // 描画中はスキップ（SDK呼び出し衝突防止）
    if (glassesUI.isRendering()) return
    try {
      const items = await notifClient.list(20)
      hubReachable = true
      lastNotifRefreshAt = Date.now()
      const toKey = (list: NotificationItem[]) => list.map((i) => `${i.id}:${i.replyStatus ?? ''}`).join(',')
      const oldKey = toKey(notifState.items)
      const oldIdSet = new Set(notifState.items.map((i) => i.id))
      const newKey = toKey(items)
      if (oldKey === newKey) return // 変化なし

      notifState.items = items
      const hasNewItems = items.some((item) => !oldIdSet.has(item.id))
      const statusEl = document.getElementById('notif-status')!
      statusEl.textContent = `${items.length}件 (自動更新)`
      const wantsAutoOpen = hasNewItems && appConfig.notificationAutoOpenOnNew
      const canAutoOpenNow = wantsAutoOpen && canAutoOpenForScreen(notifState.screen) && !glassesUI.isRendering()

      // 新着が来た時点で pending を立てておく。
      // これにより reply-sending 等で一度スキップしても、画面復帰後の次サイクルで回収できる。
      if (wantsAutoOpen && !canAutoOpenNow) {
        if (!pendingAutoOpenOnNew) {
          const reason = canAutoOpenForScreen(notifState.screen) ? '描画中' : `screen=${notifState.screen}`
          log(`通知自動更新: ${items.length}件 (新着あり/自動表示を保留 reason=${reason})`)
        }
        pendingAutoOpenOnNew = true
      }

      if (canAutoOpenNow) {
        notifState.screen = 'list'
        notifState.selectedIndex = 0
        await glassesUI.showNotificationList(connection!, items)
        pendingAutoOpenOnNew = false
        log(`通知自動更新: ${items.length}件 (新着検知で自動表示)`)
      } else if (notifState.screen === 'list' && !glassesUI.isRendering()) {
        // ユーザー操作直後はリスト再描画を遅延し、連続rebuild競合を抑える
        if (Date.now() - lastG2UserEventAt < 4000) {
          log(`通知自動更新: ${items.length}件 (操作中のため描画保留)`)
          updateNotifInfo()
          return
        }
        // リスト画面かつ描画中でなければG2を更新
        await glassesUI.showNotificationList(connection!, items)
        pendingListRefresh = false
        log(`通知自動更新: ${items.length}件 (リスト更新)`)
      } else {
        if (hasNewItems && notifState.screen === 'list') {
          pendingListRefresh = true
        }
        const mode = hasNewItems
          ? `新着あり/自動表示スキップ screen=${notifState.screen} autoOpen=${appConfig.notificationAutoOpenOnNew ? 'on' : 'off'}`
          : 'バックグラウンド'
        log(`通知自動更新: ${items.length}件 (${mode})`)
      }
      updateNotifInfo()
    } catch {
      hubReachable = false
      updateDashboard()
      // ポーリング失敗は静かに無視
    }
  }, appConfig.notificationPollIntervalMs)
}

function updateNotifInfo() {
  const infoEl = document.getElementById('notif-info')!
  if (notifState.screen === 'idle') {
    const autoOpenLabel = appConfig.notificationAutoOpenOnNew ? 'ON' : 'OFF'
    infoEl.textContent = `待機中（G2でダブルタップすると通知一覧）\n新着自動表示: ${autoOpenLabel}`
  } else if (notifState.screen === 'list') {
    const lines = notifState.items.map((item, i) => {
      const marker = i === notifState.selectedIndex ? '>' : ' '
      return `${marker} ${item.title} (${item.source})`
    })
    infoEl.textContent = lines.length > 0 ? lines.join('\n') : '通知なし'
  } else if (notifState.screen === 'detail' && notifState.detailItem) {
    const d = notifState.detailItem
    const replyHint = d.replyCapable ? ' | Click=操作メニュー' : ''
    infoEl.textContent = [
      `[詳細] ${d.title}`,
      `Source: ${d.source} | replyCapable: ${d.replyCapable}`,
      `Chunk: ${notifState.detailPageIndex + 1}/${notifState.detailPages.length} (firmware scroll)`,
      `操作: FW自動スクロール, 境界到達→チャンク切替, DblClick=戻る${replyHint}`,
      '',
      notifState.detailPages[notifState.detailPageIndex] ?? '',
    ].join('\n')
  } else if (notifState.screen === 'detail-actions' && notifState.detailItem) {
    infoEl.textContent = [
      `[操作] ${notifState.detailItem.title}`,
      '0=コメント, 1=拒否, 2=承認',
      'Click=選択, DblClick=詳細に戻る',
    ].join('\n')
  } else if (notifState.screen === 'reply-recording') {
    infoEl.textContent = `[返信録音中] ${replyAudioTotalBytes} bytes\nDblClick=停止, Swipe=キャンセル`
  } else if (notifState.screen === 'reply-confirm') {
    infoEl.textContent = `[返信確認]\n"${notifState.replyText}"\n\n送信=0, 再録=1, キャンセル=2`
  } else if (notifState.screen === 'reply-sending') {
    infoEl.textContent = '[返信送信中...]'
  }
  updateDashboard()
}

document.getElementById('notif-fetch-btn')!.addEventListener('click', async () => {
  const statusEl = document.getElementById('notif-status')!
  statusEl.textContent = '取得中...'
  try {
    const items = await notifClient.list(20)
    hubReachable = true
    lastNotifRefreshAt = Date.now()
    notifState.items = items
    notifState.selectedIndex = 0
    if (notifState.screen !== 'list') {
      notifState.screen = 'idle'
      if (connection && !glassesUI.isRendering()) {
        await glassesUI.showIdleLauncher(connection, { dimMode: appConfig.notificationIdleDimMode })
      }
    }
    statusEl.textContent = `${items.length}件取得`
    document.getElementById('notif-show-g2-btn')!.removeAttribute('disabled')
    startNotificationPolling()
    updateNotifInfo()
    log(`通知取得: ${items.length}件`)
  } catch (err) {
    hubReachable = false
    const msg = err instanceof Error ? err.message : String(err)
    statusEl.textContent = `取得失敗: ${msg}`
    log(`通知取得失敗: ${msg}`)
    updateDashboard()
  }
})

// 送信結果画面からリスト一覧に復帰する共通処理
async function returnToListFromResult() {
  if (notifState.screen === 'list') return // 既に復帰済み
  log('結果画面 → 通知一覧に復帰')
  notifState.screen = 'list'
  notifState.detailItem = null
  notifState.replyText = ''
  notifState.selectedIndex = 0
  if (connection) {
    try {
      notifState.items = await notifClient.list(20)
    } catch { /* fallback to cached */ }
    await glassesUI.showNotificationList(connection, notifState.items)
  }
  updateNotifInfo()
  await flushPendingNotificationUi('result-return')
}

function clearPendingNotifEvent() {
  pendingNotifEvent = null
  if (pendingNotifEventFlushTimer) {
    clearTimeout(pendingNotifEventFlushTimer)
    pendingNotifEventFlushTimer = null
  }
}

/** キュー中のイベントがスクロールの場合のみクリアする（tap/doubleTap等は保持） */
function clearPendingScrollEvent() {
  if (!pendingNotifEvent) return
  const eventType = getNormalizedEventType(pendingNotifEvent)
  if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
    clearPendingNotifEvent()
  }
}

async function enterIdleScreen(reason: string) {
  notifState.screen = 'idle'
  notifState.detailItem = null
  notifState.replyText = ''
  idleTapDuringRender = false
  lastIdleEventAt = 0
  idleOpenBlockedUntil = Date.now() + IDLE_REOPEN_COOLDOWN_MS
  clearPendingNotifEvent()
  if (connection) {
    await glassesUI.showIdleLauncher(connection, { dimMode: appConfig.notificationIdleDimMode })
  }
  updateNotifInfo()
  log(`${reason} (idle reopen blocked ${IDLE_REOPEN_COOLDOWN_MS}ms)`)
}

function queuePendingNotifEvent(conn: BridgeConnection, event: EvenHubEvent) {
  pendingNotifEvent = event
  if (pendingNotifEventFlushTimer) return
  pendingNotifEventFlushTimer = setTimeout(() => {
    pendingNotifEventFlushTimer = null
    if (glassesUI.isRendering() || notifEventInFlight || !pendingNotifEvent) {
      if (pendingNotifEvent) queuePendingNotifEvent(conn, pendingNotifEvent)
      return
    }
    const nextEvent = pendingNotifEvent
    pendingNotifEvent = null
    void handleNotifEvent(conn, nextEvent)
  }, 120)
}

function shouldIgnoreDetailScroll(eventType: number | undefined): boolean {
  if (eventType !== G2_EVENT.SCROLL_TOP && eventType !== G2_EVENT.SCROLL_BOTTOM) return false
  const now = Date.now()
  if ((now - lastTapEventAt) < TAP_SCROLL_SUPPRESS_MS) {
    log('[event] detail scroll suppressed: tap直後')
    return true
  }
  if ((now - lastDetailScrollAt) < DETAIL_SCROLL_COOLDOWN_MS) {
    log('[event] detail scroll suppressed: cooldown')
    return true
  }
  lastDetailScrollAt = now
  return false
}

// G2イベントリスナーを接続に登録（再接続時は新しい eventHandlers 配列になるため再登録が必要）
function ensureNotifEventHandler(conn: BridgeConnection) {
  if (notifEventRegisteredFor === conn) return
  conn.onEvent((event) => {
      void handleNotifEvent(conn, event)
  })
  notifEventRegisteredFor = conn
}

async function handleNotifEvent(conn: BridgeConnection, event: EvenHubEvent) {
  if (notifEventInFlight) {
    queuePendingNotifEvent(conn, event)
    return
  }
  notifEventInFlight = true
  try {
      if (!connection) return
      const normalized = normalizeHubEvent(event)
      if (normalized.kind === 'unknown') {
        log(
          `[event] ignored unknown screen=${notifState.screen} text=${JSON.stringify(event.textEvent)} list=${JSON.stringify(event.listEvent)} sys=${JSON.stringify(event.sysEvent)}`,
        )
        return
      }
      lastG2UserEventAt = Date.now()
      const eventType = normalized.eventType
      if (normalized.kind === 'tap' || normalized.kind === 'doubleTap') {
        lastTapEventAt = Date.now()
      }

      // idle画面のダブルタップ判定
      // G2実機は textEvent/listEvent なしの2連イベントを送る。
      // 描画中にタップが来た場合は保留フラグを立て、描画完了後の次イベントで即開く。
      if (notifState.screen === 'idle') {
        const now = Date.now()
        const isDoubleTapEvent = isDoubleTapEventType(eventType)
        const isTapLikeEvent = normalized.kind === 'tap' || normalized.kind === 'doubleTap'
        const isRapidTap = isTapLikeEvent && (now - lastIdleEventAt) < IDLE_DOUBLE_TAP_WINDOW_MS
        if (now < idleOpenBlockedUntil) {
          if (isTapLikeEvent) {
            log(`[event] idle open suppressed: cooldown remaining=${idleOpenBlockedUntil - now}ms`)
            lastIdleEventAt = now
          }
          return
        }
        if (isTapLikeEvent) lastIdleEventAt = now
        if (glassesUI.isRendering()) {
          if (!isTapLikeEvent) return
          idleTapDuringRender = true
          log(`[event] idle描画中 (保留フラグON)`)
          return
        }
        // 描画中保留タップ or 短時間連打 or SDK DOUBLE_CLICK のいずれかで発動
        const shouldOpen = idleTapDuringRender || isDoubleTapEvent || isRapidTap
        log(`[event] screen=idle eventType=${eventType} rapid=${isRapidTap} pending=${idleTapDuringRender} open=${shouldOpen}`)
        idleTapDuringRender = false
        if (!shouldOpen) return
        if (notifState.items.length === 0) {
          log('通知がありません。先に取得してください。')
          return
        }
        lastIdleEventAt = 0
        notifState.screen = 'list'
        notifState.selectedIndex = 0
        await glassesUI.showNotificationList(connection!, notifState.items)
        updateNotifInfo()
        log('待機画面から通知一覧を表示')
        return
      }

      if (glassesUI.isRendering()) {
        log('[event] 描画中のため保留')
        queuePendingNotifEvent(conn, event)
        return
      }

      log(
        `[event] screen=${notifState.screen} eventType=${eventType} text=${JSON.stringify(event.textEvent)} list=${JSON.stringify(event.listEvent)} sys=${JSON.stringify(event.sysEvent)}`,
      )

      if (notifState.screen === 'list') {
        if (isDoubleTapEventType(eventType)) {
          await enterIdleScreen('通知一覧を閉じて待機に戻る (double tap)')
          return
        }

        // SDK標準ListContainer: listEventからクリック選択を取得
        // ※実機ではスクロール方向が物理操作と逆（ファームウェア仕様、許容）
        if (normalized.source === 'list') {
          if (normalized.containerName !== 'notif-list') return
          const maybeIndex = typeof normalized.index === 'number'
            ? normalized.index
            : notifState.selectedIndex
          if (typeof maybeIndex !== 'number') {
            log('通知一覧: index未同梱イベントのため無視')
            return
          }
          const index = maybeIndex
          notifState.selectedIndex = index
          const item = notifState.items[index]
          if (!item) return
          log(`通知選択: "${item.title}" (index=${notifState.selectedIndex})`)
          try {
            const detail = await notifClient.detail(item.id)
            notifState.detailItem = detail
            const pageCount = glassesUI.getDetailPageCount(detail.fullText)
            notifState.detailPages = Array.from({ length: pageCount }, (_, i) => String(i))
            notifState.detailPageIndex = 0
            notifState.screen = 'detail'
            await glassesUI.showNotificationDetail(connection!, detail, 0, pageCount, getContextPctForNotification(detail))
            // 描画中（createStartUpフォールバックで数秒かかる）にキューされたスクロールイベントを破棄
            // tap/doubleTap等の非スクロールイベントは保持する
            clearPendingScrollEvent()
            lastDetailScrollAt = Date.now()
            updateNotifInfo()
          } catch (err) {
            log(`通知詳細取得失敗: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } else if (notifState.screen === 'detail') {
        // 詳細画面: スクロールでページ送り＋画面遷移
        if (!notifState.detailItem) return
        // ghostリストコンテナからのイベントを無視（detail画面ではtextEventとsysEventのみ有効）
        if (normalized.source === 'list') return
        // detailPages は showNotificationDetail() で都度算出される（ここでは長さのみ参照）
        const pageCount = notifState.detailPages.length
        if (isDoubleTapEventType(eventType)) {
          log('通知詳細: double tap → リストに戻る')
          notifState.screen = 'list'
          notifState.detailItem = null
          notifState.selectedIndex = 0
          await glassesUI.showNotificationList(connection!, notifState.items)
          updateNotifInfo()
          return
        }
        if (shouldIgnoreDetailScroll(eventType)) return

        // 一覧画面と同じく、実機の逆方向スクロール挙動をそのまま許容する。
        // eventType=1 (物理下) → 前ページ / 最初のページで更に戻る → リストに戻る
        // eventType=2 (物理上) → 次ページ / 最終ページで更に進む → アクションメニュー
        if (eventType === G2_EVENT.SCROLL_TOP) {
          if (notifState.detailPageIndex > 0) {
            notifState.detailPageIndex--
            await glassesUI.showNotificationDetail(
              connection!, notifState.detailItem, notifState.detailPageIndex, pageCount, getContextPctForNotification(notifState.detailItem),
            )
            // 描画完了後にスクロールイベントのみクリア＋クールダウン更新（誤発火を防止）
            clearPendingScrollEvent()
            lastDetailScrollAt = Date.now()
          } else {
            log('通知詳細: 最初のページ → リストに戻る')
            notifState.screen = 'list'
            notifState.detailItem = null
            notifState.selectedIndex = 0
            await glassesUI.showNotificationList(connection!, notifState.items)
          }
          updateNotifInfo()
          return
        }

        // eventType=2 → 次ページ / 最終ページで更に進む → アクションメニュー
        if (eventType === G2_EVENT.SCROLL_BOTTOM) {
          if (notifState.detailPageIndex < pageCount - 1) {
            notifState.detailPageIndex++
            await glassesUI.showNotificationDetail(
              connection!, notifState.detailItem, notifState.detailPageIndex, pageCount, getContextPctForNotification(notifState.detailItem),
            )
            // 描画完了後にスクロールイベントのみクリア＋クールダウン更新（誤発火を防止）
            clearPendingScrollEvent()
            lastDetailScrollAt = Date.now()
          } else if (notifState.detailItem.replyCapable) {
            log('通知詳細: 最終ページ → アクションメニュー')
            notifState.screen = 'detail-actions'
            await glassesUI.showNotificationActions(connection!, notifState.detailItem)
          }
          updateNotifInfo()
          return
        }
      } else if (notifState.screen === 'detail-actions') {
        if (!notifState.detailItem) return

        // SDK標準ListContainer: listEventからクリック選択を取得
        if (normalized.source === 'list') {
          const index = normalized.index ?? 0

          // ◀ 戻る (index=3)
          if (index === 3) {
            log('通知アクション: 一覧に戻る')
            notifState.screen = 'list'
            notifState.detailItem = null
            notifState.selectedIndex = 0
            await glassesUI.showNotificationList(connection!, notifState.items)
            updateNotifInfo()
            return
          }

          if (index === 1 || index === 2) {
            // 拒否(1) or 承認(2)
            const action = index === 2 ? 'approve' : 'deny'
            log(`通知アクション送信: ${action} notificationId=${notifState.detailItem.id}`)
            notifState.screen = 'reply-sending'
            updateNotifInfo()
            try {
              const res = await notifClient.reply(notifState.detailItem.id, {
                action,
                source: 'g2',
              })
              const status = res.reply?.status || 'ok'
              const result = getReplyResultMessage(res)
              log(`通知アクション送信完了: action=${action} status=${status}`)
              // await 中にユーザー操作でリストに戻っていたら結果画面をスキップ
              if (notifState.screen === 'reply-sending') {
                if (result.ok) {
                  await glassesUI.showReplyResult(connection!, true, action === 'approve' ? '承認' : '拒否')
                } else {
                  await glassesUI.showReplyResult(connection!, false, result.message || status)
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              log(`通知アクション送信失敗: action=${action} ${msg}`)
              if (notifState.screen === 'reply-sending') {
                await glassesUI.showReplyResult(connection!, false, msg)
              }
            }
            setTimeout(() => returnToListFromResult(), 3000)
            return
          }

          if (index === 0) {
            // コメント
            log('通知アクション: コメント（録音開始）')
            notifState.screen = 'reply-recording'
            notifState.replyText = ''
            replyAudioChunks = []
            replyAudioTotalBytes = 0
            replyStopInFlight = false

            await glassesUI.showReplyRecording(connection!)

            if (connection!.mode === 'bridge' && !glassesUI.hasRenderedPage(connection!)) {
              await glassesUI.ensureBasePage(connection!, 'マイク録音中...')
            }
            await connection!.startAudio()
            replyIsRecording = true
            updateNotifInfo()
            return
          }
        }
      } else if (notifState.screen === 'reply-recording') {
        // 録音中画面:
        // - 単タップ相当は sysEvent {} とノイズが区別できないため使わない
        // - DOUBLE_CLICK を確実な停止入力として扱う
        if (isDoubleTapEventType(eventType)) {
          if (!replyIsRecording || replyStopInFlight) {
            log('返信録音: 重複停止イベントを無視')
            return
          }
          replyStopInFlight = true
          log('返信録音: 停止 → STT処理開始')
          replyIsRecording = false
          await connection!.stopAudio()

          await glassesUI.showReplySttProcessing(connection!)

          if (replyAudioTotalBytes === 0) {
            log('返信録音: 音声データなし → アクションに戻る')
            notifState.screen = 'detail-actions'
            if (notifState.detailItem) {
              await glassesUI.showNotificationActions(connection!, notifState.detailItem)
            }
            updateNotifInfo()
            replyStopInFlight = false
            return
          }

          try {
            const stt = await transcribePcmChunks(replyAudioChunks)
            const text = stt.text || ''
            log(`返信STT完了: provider=${stt.provider} text="${text}"`)

            if (!text) {
              log('返信STT: テキスト空 → アクションに戻る')
              notifState.screen = 'detail-actions'
              if (notifState.detailItem) {
                await glassesUI.showNotificationActions(connection!, notifState.detailItem)
              }
              updateNotifInfo()
              replyStopInFlight = false
              return
            }

            notifState.replyText = text
            notifState.screen = 'reply-confirm'
            await glassesUI.showReplyConfirm(connection!, text)
            updateNotifInfo()
            replyStopInFlight = false
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            log(`返信STT失敗: ${msg}`)
            await glassesUI.showReplyResult(connection!, false, msg)
            // 3秒後にアクション画面に戻る
            setTimeout(async () => {
              notifState.screen = 'detail-actions'
              if (notifState.detailItem && connection) {
                await glassesUI.showNotificationActions(connection, notifState.detailItem)
              }
              updateNotifInfo()
              replyStopInFlight = false
            }, 3000)
          }
          return
        }

        // スクロール入力はキャンセル → アクションに戻る
        if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
          log('返信録音: キャンセル → アクションに戻る')
          replyIsRecording = false
          await connection!.stopAudio()
          notifState.screen = 'detail-actions'
          if (notifState.detailItem) {
            await glassesUI.showNotificationActions(connection!, notifState.detailItem)
          }
          updateNotifInfo()
          replyStopInFlight = false
          return
        }
      } else if (notifState.screen === 'reply-confirm') {
        // SDK標準ListContainer: listEventからクリック選択を取得
        if (normalized.source === 'list') {
          const index = normalized.index ?? 0

          if (index === 0) {
            // 送信
            if (!notifState.detailItem || !notifState.replyText) return
            log(`返信送信: notificationId=${notifState.detailItem.id}`)
            notifState.screen = 'reply-sending'
            try {
              const res = await notifClient.reply(notifState.detailItem.id, {
                action: 'comment',
                comment: notifState.replyText,
                source: 'g2',
              })
              const status = res.reply?.status || 'ok'
              const result = getReplyResultMessage(res)
              log(`返信送信完了: status=${status}`)
              // await 中にユーザー操作でリストに戻っていたら結果画面をスキップ
              if (notifState.screen === 'reply-sending') {
                if (result.ok) {
                  await glassesUI.showReplyResult(connection!, true)
                } else {
                  await glassesUI.showReplyResult(connection!, false, result.message || status)
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              log(`返信送信失敗: ${msg}`)
              if (notifState.screen === 'reply-sending') {
                await glassesUI.showReplyResult(connection!, false, msg)
              }
            }
            // 3秒後に一覧に戻る（ユーザー操作で先に戻った場合はスキップ）
            setTimeout(() => returnToListFromResult(), 3000)
            return
          }

          if (index === 1) {
            // 再録
            log('返信確認: 再録')
            notifState.screen = 'reply-recording'
            notifState.replyText = ''
            replyAudioChunks = []
            replyAudioTotalBytes = 0
            await glassesUI.showReplyRecording(connection!)
            await connection!.startAudio()
            replyIsRecording = true
            updateNotifInfo()
            return
          }

          if (index === 2) {
            // キャンセル → アクションに戻る
            log('返信確認: キャンセル → アクションに戻る')
            notifState.screen = 'detail-actions'
            notifState.replyText = ''

            if (notifState.detailItem) {
              await glassesUI.showNotificationActions(connection!, notifState.detailItem)
            }
            updateNotifInfo()
            return
          }

          if (index === 3) {
            // ◀ 戻る → アクションに戻る
            log('返信確認: 戻る → アクションに戻る')
            notifState.screen = 'detail-actions'
            notifState.replyText = ''

            if (notifState.detailItem) {
              await glassesUI.showNotificationActions(connection!, notifState.detailItem)
            }
            updateNotifInfo()
            return
          }
        }
      } else if (notifState.screen === 'reply-sending') {
        // 送信結果画面: 任意の操作（タップ/スワイプ）で即座にリスト一覧に戻る
        log('結果画面: ユーザー操作で即座に復帰')
        await returnToListFromResult()
      }
  } finally {
    notifEventInFlight = false
    if (pendingNotifEvent && !glassesUI.isRendering()) {
      queuePendingNotifEvent(conn, pendingNotifEvent)
    }
  }
}

document.getElementById('notif-show-g2-btn')!.addEventListener('click', async () => {
  if (!connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  if (notifState.items.length === 0) {
    log('通知がありません。先に取得してください。')
    return
  }

  ensureNotifEventHandler(connection)
  notifState.screen = 'list'
  notifState.selectedIndex = 0
  await glassesUI.showNotificationList(connection, notifState.items)
  startNotificationPolling()
  updateNotifInfo()
})

updateDashboard()
