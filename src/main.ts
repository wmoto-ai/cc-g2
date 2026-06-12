import './styles.css'
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { createGlassesUI, buildNotificationActions } from './glasses-ui'
import { log } from './log'
import { transcribePcmChunks } from './stt/groq'
import { formatForG2ScrollableText } from './g2/text-format'
import { appConfig, canUseOpenaiRealtimeStt, canUseSonioxStt, createHubHeaders } from './config'
import { OpenAIRealtimeSTT } from './stt/openai-realtime'
import { SonioxRealtimeSTT } from './stt/soniox-realtime'
import { getWebSpeechSupport, startWebSpeechCapture } from './stt/webspeech'
import { createNotificationClient } from './notifications'
import { errorMessage, escapeHtml, formatRelativeTime, replyStatusLabel, screenLabel } from './app/format'
import { createAppContext } from './app/context'
import { connectGlasses } from './app/connect'
import { connectNotificationSSE, flushPendingNotificationUi } from './hub/sse-client'
import { openImageDetail } from './g2/flows'
import { ensureNotifEventHandler } from './g2/event-router'

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

const glassesUI = createGlassesUI()
const notifClient = createNotificationClient(appConfig.notificationHubUrl)
// 共有可変状態は AppContext 1オブジェクトに集約（生成はここで1回のみ。src/app/context.ts 参照）
const ctx = createAppContext({ glassesUI, notifClient, ui: { setPill, updateDashboard, updateNotifInfo } })

// ?autoconnect=1 のときのみ自動接続する（opt-in。シミュレーター自動検証用）。
// 一時期 bridge 検出時のデフォルト自動接続にしていたが、Vite dev のページリロードのたびに
// 「リロード → 即接続 → 即 createStartUp」が走り、描画/BLE 書き込み中のリロードが
// G2 ファームの多フラグメント書き込みを中断してクラッシュを誘発した（2026-06-10 実測）。
// デフォルトは従来どおり手動 Connect。
if (uiSearch.get('autoconnect') === '1') {
  void (async () => {
    try {
      await Promise.race([
        waitForEvenAppBridge(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no bridge')), 2500)),
      ])
    } catch {
      // bridge なし（通常ブラウザでの dev 検証）→ そのまま Connect を試す
    }
    if (!ctx.connection) {
      log('autoconnect=1 → 自動接続')
      document.getElementById('connect-btn')?.click()
    }
  })()
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
  const items = ctx.notifState.items.slice(0, 5)
  if (items.length === 0) {
    listEl.innerHTML = '<li class="queue-empty">通知はまだありません。</li>'
    return
  }
  listEl.innerHTML = items.map((item, index) => {
    const active = ctx.notifState.screen === 'list' && index === ctx.notifState.selectedIndex ? ' active' : ''
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
  const g2Tone = ctx.connection ? 'ok' : 'neutral'
  const g2Text = ctx.connection ? (ctx.connection.mode === 'bridge' ? '接続済み (Bridge)' : '接続済み (Mock)') : '未接続'
  ctx.ui.setPill('connection-status', g2Text, g2Tone)

  if (ctx.hubReachable == null) ctx.ui.setPill('hub-status', '未確認', 'neutral')
  else ctx.ui.setPill('hub-status', ctx.hubReachable ? 'reachable' : 'error', ctx.hubReachable ? 'ok' : 'error')

  const notifTone = ctx.notifState.items.length > 0 ? 'ok' : 'neutral'
  ctx.ui.setPill('notif-count', `${ctx.notifState.items.length}件`, notifTone)
  ctx.ui.setPill('g2-screen-status', screenLabel(ctx.notifState.screen), 'neutral')

  const syncEl = document.getElementById('last-sync-status')
  if (syncEl) syncEl.textContent = `最終更新: ${formatRelativeTime(ctx.lastNotifRefreshAt)}`

  renderRecentNotifications()
}

// --- Connect ---
// 接続フロー本体は src/app/connect.ts（connectInFlight による冪等化込み）
document.getElementById('connect-btn')!.addEventListener('click', () => {
  void connectGlasses(ctx)
})

// --- Text Display ---
// 注意: 以下4つは dev UI（devUiEnabled 時のみ DOM に存在）のボタン。
// `!` だと dev UI 非表示時に addEventListener が throw してページ全体が死ぬため `?.` で配線する。
document.getElementById('send-text-btn')?.addEventListener('click', async () => {
  const text = (document.getElementById('display-text') as HTMLInputElement).value
  if (!ctx.connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  log(`テキスト送信: "${text}"`)
  await glassesUI.showText(ctx.connection, text)
})

// --- Approval UI ---
document.getElementById('approval-btn')?.addEventListener('click', async () => {
  const resultEl = document.getElementById('approval-result')!
  if (!ctx.connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  resultEl.textContent = '承認待ち...'
  log('承認リクエスト送信: ファイル編集の承認')

  const result = await glassesUI.requestApproval(ctx.connection, {
    title: 'ファイル編集の承認',
    detail: 'src/auth.ts +12行/-3行',
    options: ['Approve', 'Deny'],
  })

  resultEl.textContent = `結果: ${result}`
  resultEl.classList.add(result === 'Approve' ? 'approved' : 'rejected')
  log(`承認結果: ${result}`)
})

// --- Mic ---
document.getElementById('mic-start-btn')?.addEventListener('click', async () => {
  if (!ctx.connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  ctx.audioChunks = []
  ctx.audioTotalBytes = 0
  ctx.isRecording = true
  const micStatus = document.getElementById('mic-status')!
  const startBtn = document.getElementById('mic-start-btn') as HTMLButtonElement
  const stopBtn = document.getElementById('mic-stop-btn') as HTMLButtonElement
  const audioInfo = document.getElementById('audio-info')!

  startBtn.disabled = true
  stopBtn.disabled = false
  micStatus.textContent = '録音中...'
  audioInfo.textContent = ''
  log('マイク開始')

  ctx.webSpeechFinalText = ''
  ctx.webSpeechInterimText = ''
  ctx.webSpeechError = ''
  if (appConfig.webSpeechCompare) {
    const wsCap = getWebSpeechSupport()
    if (wsCap.available) {
      try {
        ctx.webSpeechSession = startWebSpeechCapture(({ finalText, interimText }) => {
          ctx.webSpeechFinalText = finalText
          ctx.webSpeechInterimText = interimText
        })
        log('Web Speech比較キャプチャ開始（ブラウザ/端末マイク系）')
      } catch (err) {
        ctx.webSpeechSession = null
        ctx.webSpeechError = errorMessage(err)
        log(`Web Speech開始失敗: ${ctx.webSpeechError}`)
      }
    }
  }

  // Start realtime STT if configured
  if (canUseOpenaiRealtimeStt() || canUseSonioxStt()) {
    try {
      ctx.realtimeSTT = canUseSonioxStt()
        ? new SonioxRealtimeSTT(appConfig.notificationHubUrl, createHubHeaders())
        : new OpenAIRealtimeSTT(appConfig.notificationHubUrl, createHubHeaders())
      await ctx.realtimeSTT.start((text, isFinal) => {
        const audioInfo = document.getElementById('audio-info')!
        const prefix = isFinal ? '[final]' : '[partial]'
        audioInfo.textContent = `${prefix} ${text}`
      })
      log(`${appConfig.sttProvider} Realtime STT開始`)
    } catch (err) {
      ctx.realtimeSTT = null
      log(`Realtime STT開始失敗: ${errorMessage(err)}`)
      micStatus.textContent = `Realtime STT開始失敗: ${errorMessage(err)}`
      startBtn.disabled = false
      stopBtn.disabled = true
      ctx.isRecording = false
      return
    }
  }

  // evenhub-simulator requires at least one created page/container before audioControl().
  if (ctx.connection.mode === 'bridge' && !glassesUI.hasRenderedPage(ctx.connection)) {
    log('マイク前にG2ベースページを初期化（simulator対策）')
    await glassesUI.ensureBasePage(ctx.connection, 'マイク録音中...')
  }

  await ctx.connection.startAudio()
})

document.getElementById('mic-stop-btn')?.addEventListener('click', async () => {
  if (!ctx.connection) return
  const micStatus = document.getElementById('mic-status')!
  const startBtn = document.getElementById('mic-start-btn') as HTMLButtonElement
  const stopBtn = document.getElementById('mic-stop-btn') as HTMLButtonElement
  const audioInfo = document.getElementById('audio-info')!

  await ctx.connection.stopAudio()
  ctx.isRecording = false
  if (appConfig.webSpeechCompare && ctx.webSpeechSession) {
    try {
      const ws = await ctx.webSpeechSession.stop()
      ctx.webSpeechFinalText = ws.finalText
      ctx.webSpeechInterimText = ws.interimText
      if (ws.error) ctx.webSpeechError = ws.error
      log(
        `Web Speech停止: final=${ws.finalText ? 'yes' : 'no'}, interim=${ws.interimText ? 'yes' : 'no'}${ws.error ? `, error=${ws.error}` : ''}`,
      )
    } catch (err) {
      ctx.webSpeechError = errorMessage(err)
      log(`Web Speech停止失敗: ${ctx.webSpeechError}`)
    } finally {
      ctx.webSpeechSession = null
    }
  }
  startBtn.disabled = false
  stopBtn.disabled = true

  micStatus.textContent = `録音完了 (${ctx.realtimeSTT ? 'realtime' : `${ctx.audioChunks.length}チャンク`}, ${ctx.audioTotalBytes}バイト)`
  log(`マイク停止: ${ctx.realtimeSTT ? 'realtime' : `${ctx.audioChunks.length}チャンク`}, ${ctx.audioTotalBytes}バイト取得`)

  if (ctx.audioTotalBytes === 0) {
    if (ctx.realtimeSTT) { ctx.realtimeSTT.abort(); ctx.realtimeSTT = null }
    return
  }

  micStatus.textContent = 'STT処理中...'
  log('STT開始')

  try {
    const stt = ctx.realtimeSTT
      ? await (async () => { const r = await ctx.realtimeSTT!.stop(); ctx.realtimeSTT = null; return r })()
      : await transcribePcmChunks(ctx.audioChunks)
    const formatted = formatForG2ScrollableText(stt.text || '（認識結果なし）')
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
        `Web Speech final: ${ctx.webSpeechFinalText || '（空）'}`,
        `Web Speech interim: ${ctx.webSpeechInterimText || '（空）'}`,
        `Web Speech error: ${ctx.webSpeechError || 'なし'}`,
      )
    }
    infoLines.push('', 'G2表示用:', formatted)
    audioInfo.textContent = infoLines.join('\n')
    log(`STT完了: provider=${stt.provider}${stt.model ? ` model=${stt.model}` : ''}`)
    log(`STT結果: ${stt.text || '（空）'}`)
    if (appConfig.webSpeechCompare && ctx.webSpeechFinalText) {
      log(`Web Speech結果(比較): ${ctx.webSpeechFinalText}`)
    }
    await glassesUI.showText(ctx.connection, formatted)
  } catch (err) {
    if (ctx.realtimeSTT) { ctx.realtimeSTT.abort(); ctx.realtimeSTT = null }
    const message = errorMessage(err)
    micStatus.textContent = 'STT失敗'
    log(`STT失敗: ${message}`)
    if (ctx.connection) {
      await glassesUI.showText(ctx.connection, 'STT失敗\n再試行してください')
    }
  }
})

// --- AskUserQuestion helpers ---
// --- Notifications ---

// 画面復帰時は保留中のUIを即反映する
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ctx.connection) void flushPendingNotificationUi(ctx, 'visible')
  })
}

function updateNotifInfo() {
  const infoEl = document.getElementById('notif-info')!
  switch (ctx.notifState.screen) {
    case 'idle': {
      const autoOpenLabel = appConfig.notificationAutoOpenOnNew ? 'ON' : 'OFF'
      infoEl.textContent = `待機中（G2でダブルタップすると通知一覧）\n新着自動表示: ${autoOpenLabel}`
      break
    }
    case 'list': {
      const lines = ctx.notifState.items.map((item, i) => {
        const marker = i === ctx.notifState.selectedIndex ? '>' : ' '
        return `${marker} ${item.title} (${item.source})`
      })
      infoEl.textContent = lines.length > 0 ? lines.join('\n') : '通知なし'
      break
    }
    case 'detail': {
      const d = ctx.notifState.detailItem
      if (d) {
        const replyHint = d.replyCapable ? ' | Click=操作メニュー' : ''
        infoEl.textContent = [
          `[詳細] ${d.title}`,
          `Source: ${d.source} | replyCapable: ${d.replyCapable}`,
          `Chunk: ${ctx.notifState.detailPageIndex + 1}/${ctx.notifState.detailPages.length} (firmware scroll)`,
          `操作: FW自動スクロール, 境界到達→チャンク切替, DblClick=戻る${replyHint}`,
          '',
          ctx.notifState.detailPages[ctx.notifState.detailPageIndex] ?? '',
        ].join('\n')
      }
      break
    }
    case 'detail-actions':
      if (ctx.notifState.detailItem) {
        const menu = ctx.notifState.detailActions.map((a, i) => `${i}=${a.label}`).join(', ')
        infoEl.textContent = [
          `[操作] ${ctx.notifState.detailItem.title}`,
          menu,
          'Click=選択, DblClick=詳細に戻る',
        ].join('\n')
      }
      break
    case 'image-detail':
      if (ctx.notifState.detailItem) {
        infoEl.textContent = [
          `[画像] ${ctx.notifState.detailItem.title}`,
          'DblClick=操作メニューに戻る',
        ].join('\n')
      }
      break
    case 'ask-question-detail': {
      const q = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
      infoEl.textContent = [
        `[質問詳細 ${ctx.notifState.askQuestionIndex + 1}/${ctx.notifState.askQuestions.length}]`,
        `Page: ${ctx.notifState.detailPageIndex + 1}/${ctx.notifState.detailPages.length}`,
        q?.question?.slice(0, 80) ?? '',
        'Scroll=ページ送り, 最終→選択肢, DblClick=戻る',
      ].join('\n')
      break
    }
    case 'ask-question': {
      const q = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
      const opts = q ? q.options.map((o, i) => `${i}=${o.label}`).join(', ') : ''
      infoEl.textContent = [
        `[質問 ${ctx.notifState.askQuestionIndex + 1}/${ctx.notifState.askQuestions.length}]`,
        q?.question ?? '',
        opts,
        'Click=選択, DblClick=戻る',
      ].join('\n')
      break
    }
    case 'reply-recording':
      infoEl.textContent = `[返信録音中] ${ctx.replyAudioTotalBytes} bytes\nDblClick=停止, Swipe=キャンセル`
      break
    case 'reply-confirm':
      infoEl.textContent = [
        '[返信確認]',
        `Page: ${ctx.notifState.detailPageIndex + 1}/${ctx.notifState.detailPages.length}`,
        ctx.notifState.replyText,
        'Scroll=ページ送り, 最終→操作, DblClick=戻る',
      ].join('\n')
      break
    case 'reply-confirm-actions':
      infoEl.textContent = '[返信確認 操作]\n0=送信, 1=再録, 2=キャンセル, 3=本文'
      break
    case 'reply-sending':
      infoEl.textContent = '[返信送信中...]'
      break
  }
  ctx.ui.updateDashboard()
}

document.getElementById('notif-fetch-btn')!.addEventListener('click', async () => {
  const statusEl = document.getElementById('notif-status')!
  statusEl.textContent = '取得中...'
  try {
    const items = await notifClient.list(20)
    ctx.hubReachable = true
    ctx.lastNotifRefreshAt = Date.now()
    ctx.notifState.items = items
    ctx.notifState.selectedIndex = 0
    if (ctx.notifState.screen !== 'list') {
      ctx.notifState.screen = 'idle'
      if (ctx.connection && !glassesUI.isRendering()) {
        await glassesUI.showIdleLauncher(ctx.connection, { dimMode: appConfig.notificationIdleDimMode })
      }
    }
    statusEl.textContent = `${items.length}件取得`
    document.getElementById('notif-show-g2-btn')!.removeAttribute('disabled')
    connectNotificationSSE(ctx)
    ctx.ui.updateNotifInfo()
    log(`通知取得: ${items.length}件`)
  } catch (err) {
    ctx.hubReachable = false
    const msg = errorMessage(err)
    statusEl.textContent = `取得失敗: ${msg}`
    log(`通知取得失敗: ${msg}`)
    ctx.ui.updateDashboard()
  }
})

// dev 専用: ?imgopen=<notificationId|latest> で画像表示フローを自動実行
// （autoconnect=1 と併用。実際の openImageDetail コードパスをシミュレーターで検証する）
if (devUiEnabled && uiSearch.get('imgopen')) {
  void (async () => {
    const targetId = uiSearch.get('imgopen')!
    for (let i = 0; i < 40 && !ctx.connection; i++) {
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!ctx.connection) {
      log('imgopen: 接続タイムアウト')
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
    try {
      const items = await notifClient.list(20)
      const target = targetId === 'latest'
        ? items.find((n) => typeof n.metadata?.imageId === 'string' && n.metadata.imageId)
        : items.find((n) => n.id === targetId)
      if (!target) {
        log(`imgopen: 対象通知が見つかりません (${targetId})`)
        return
      }
      log(`imgopen: 自動実行 "${target.title}"`)
      ctx.notifState.detailItem = await notifClient.detail(target.id)
      ctx.notifState.screen = 'detail-actions'
      ctx.notifState.detailActions = buildNotificationActions(ctx.notifState.detailItem)
      await openImageDetail(ctx)

      // ?imgrepeat=N: 画像→アクションメニュー→画像 の往復を繰り返す（実機の2回目クラッシュ再現用）
      const repeat = Number(uiSearch.get('imgrepeat') || '0')
      for (let r = 0; r < repeat; r++) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        log(`imgopen: repeat ${r + 1}/${repeat} 戻る→再表示`)
        ctx.notifState.screen = 'detail-actions'
        ctx.notifState.detailActions = buildNotificationActions(ctx.notifState.detailItem!)
        await glassesUI.showNotificationActions(ctx.connection!, ctx.notifState.detailItem!, ctx.notifState.detailActions)
        await new Promise((resolve) => setTimeout(resolve, 2000))
        await openImageDetail(ctx)
      }
    } catch (err) {
      log(`imgopen: 失敗 ${errorMessage(err)}`)
    }
  })()
}

document.getElementById('notif-show-g2-btn')!.addEventListener('click', async () => {
  if (!ctx.connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  if (ctx.notifState.items.length === 0) {
    log('通知がありません。先に取得してください。')
    return
  }

  ensureNotifEventHandler(ctx, ctx.connection)
  ctx.notifState.screen = 'list'
  ctx.notifState.selectedIndex = 0
  await glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
  connectNotificationSSE(ctx)
  ctx.ui.updateNotifInfo()
})

ctx.ui.updateDashboard()
