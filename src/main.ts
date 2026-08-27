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
import { errorMessage, escapeHtml, formatRelativeTime, replyStatusLabel, screenLabel } from './app/format'
import { createAppContext } from './app/context'
import { detectSettingsStore } from './app/settings-store'
import { loadAppSettings, resolveTransportMode, saveAppSettings } from './app/app-settings'
import { createHubTransport } from './transport/hub'
import { createTelegramBoot } from './transport/telegram/boot'
import { connectGlasses } from './app/connect'
import { flushPendingNotificationUi, resetListFilter } from './app/notification-events'
import { filterItemsBySession } from './g2/session-groups'
import { openImageDetail } from './g2/flows'
import { ensureNotifEventHandler } from './g2/event-router'
import { initI18n, localeTag, t, tp } from './i18n'
import { createMirrorStore } from './mirror/state'
import { attachMirrorCanvas } from './mirror/renderer'
import { attachMirrorPublisher } from './mirror/publisher'

const appRoot = document.querySelector<HTMLDivElement>('#app')!
const uiSearch = new URLSearchParams(globalThis.location?.search || '')
const devUiEnabled = import.meta.env.DEV || uiSearch.get('dev') === '1'
// 輸送路の選択。優先順:
// ?transport=(dev/シミュレータ自動化) > 設定画面で保存した値 > VITE_TRANSPORT > hub
// 設定ストアの解決に bridge 検出を伴うため top-level await(build.target=esnext)。
// bridge 無し環境(通常ブラウザ)ではタイムアウトまで最大 2.5 秒かかるため、
// 真っ白なままにせず仮描画を出しておく(i18n 初期化前なので静的文言)
appRoot.innerHTML = '<p class="inline-note" style="padding: 24px">cc-g2 — loading…</p>'
const settingsStore = await detectSettingsStore()
const savedAppSettings = await loadAppSettings(settingsStore)
// UI 文言のロケールを確定(以後 t()/tp() は同期)。settings.locale '' は navigator から自動判定
initI18n(savedAppSettings.locale)
const transportMode = resolveTransportMode(
  uiSearch.get('transport'),
  savedAppSettings,
  import.meta.env.VITE_TRANSPORT as string | undefined,
)
// hub 接続先も保存設定を優先(未設定ならビルド時 env / hostname フォールバックのまま)
if (savedAppSettings.hubUrl) appConfig.notificationHubUrl = savedAppSettings.hubUrl
if (savedAppSettings.hubToken) appConfig.hubAuthToken = savedAppSettings.hubToken

appRoot.innerHTML = `
  <header class="hero">
    <h1>cc-g2</h1>
    <p class="subtitle">Claude Code companion for Even G2</p>
    <p class="hero-copy">${t('hero_copy')}</p>
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
        <span id="connection-status" class="status-pill">${t('status_disconnected')}</span>
      </div>
      <div class="status-block">
        <span class="status-label">${transportMode === 'telegram' ? 'Telegram' : 'Hub'}</span>
        <span id="hub-status" class="status-pill">${t('status_unverified')}</span>
      </div>
      <div class="status-block">
        <span class="status-label">Notifications</span>
        <span id="notif-count" class="status-pill">${tp('notif_count', { n: 0 })}</span>
      </div>
      <div class="status-block">
        <span class="status-label">G2 Screen</span>
        <span id="g2-screen-status" class="status-pill">idle</span>
      </div>
    </div>
    <p id="last-sync-status" class="inline-note">${t('last_updated')}: ${t('rel_none')}</p>
  </section>

  <section class="card" id="transport-settings-card">
    <h2>${t('transport_card_title')}</h2>
    <p class="card-copy">${t('transport_card_copy')}</p>
    <div class="tool-grid">
      <section class="tool-block">
        <label><input type="radio" name="transport-mode" value="hub" /> ${t('transport_hub_label')}</label>
        <label><input type="radio" name="transport-mode" value="telegram" /> Telegram</label>
      </section>
      <section class="tool-block">
        <input id="hub-url" type="text" placeholder="${t('hub_url_placeholder')}" />
        <input id="hub-token" type="password" placeholder="${t('hub_token_placeholder')}" />
        ${(import.meta.env.VITE_TRANSPORT as string | undefined) === 'telegram'
          ? `<p class="inline-note">${t('hub_store_note')}</p>`
          : ''}
      </section>
      <section class="tool-block">
        <label>${t('language_label')}
          <select id="locale-select">
            <option value="">${t('language_auto')}</option>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </label>
      </section>
    </div>
    <button id="transport-save-btn" class="btn" type="button">${t('save_and_reload')}</button>
  </section>

  ${transportMode === 'telegram' ? `
  <section class="card" id="tg-settings-card">
    <h2>${t('tg_card_title')}</h2>
    <p class="card-copy">${t('tg_card_copy')}</p>
    <p id="tg-status" class="status-line">${t('tg_status_init')}</p>
    <div class="tool-grid">
      <section class="tool-block">
        <input id="tg-api-id" type="text" inputmode="numeric" placeholder="API ID (my.telegram.org)" />
        <input id="tg-api-hash" type="password" placeholder="API Hash" />
        <input id="tg-chat" type="text" placeholder="${t('tg_chat_placeholder')}" />
        <input id="tg-soniox-key" type="password" placeholder="${t('tg_soniox_placeholder')}" />
        <button id="tg-save-btn" class="btn" type="button">${t('tg_save_settings')}</button>
      </section>
      <section class="tool-block" id="tg-login-block">
        <input id="tg-phone" type="tel" placeholder="${t('tg_phone_placeholder')}" />
        <button id="tg-login-btn" class="btn btn-primary" type="button">${t('tg_login_start')}</button>
        <div id="tg-code-row" style="display:none">
          <input id="tg-code" type="text" inputmode="numeric" placeholder="${t('tg_code_placeholder')}" />
          <button id="tg-code-btn" class="btn" type="button">${t('tg_code_send')}</button>
        </div>
        <div id="tg-password-row" style="display:none">
          <input id="tg-password" type="password" placeholder="${t('tg_password_placeholder')}" />
          <button id="tg-password-btn" class="btn" type="button">${t('send')}</button>
        </div>
        <button id="tg-logout-btn" class="btn" type="button">Log out &amp; revoke</button>
      </section>
    </div>
  </section>
  ` : ''}

  ${appConfig.mirrorView ? `
  <section class="card">
    <div class="section-head">
      <div>
        <h2>G2 Mirror</h2>
        <p class="card-copy">G2 に表示中の画面の近似ミラー（接続後に描画が走ると更新されます）</p>
      </div>
    </div>
    <canvas id="g2-mirror-canvas" class="mirror-canvas"></canvas>
  </section>
  ` : ''}

  <section class="card">
    <div class="section-head">
      <div>
        <h2>Recent Notifications</h2>
        <p class="card-copy">${t('recent_copy')}</p>
      </div>
      <span id="notif-status" class="inline-status">${t('notif_not_fetched')}</span>
    </div>
    <ul id="recent-notifs" class="queue-list"></ul>
    <pre id="notif-info" class="queue-detail"></pre>
  </section>

  ${devUiEnabled ? `
  <details class="card dev-card">
    <summary>Developer Tools</summary>
    <div class="tool-grid">
      <section class="tool-block">
        <h2>${t('dev_text_test_title')}</h2>
        <input id="display-text" type="text" placeholder="${t('dev_display_placeholder')}" value="Hello from cc-g2!" />
        <button id="send-text-btn" class="btn" type="button">${t('dev_send_to_g2')}</button>
      </section>

      <section class="tool-block">
        <h2>${t('dev_approval_test_title')}</h2>
        <p class="tool-copy">${t('dev_approval_copy')}</p>
        <button id="approval-btn" class="btn" type="button">${t('dev_send_approval')}</button>
        <span id="approval-result" class="status-line">${t('dev_not_run')}</span>
      </section>

      <section class="tool-block">
        <h2>${t('dev_mic_test_title')}</h2>
        <button id="mic-start-btn" class="btn" type="button">${t('dev_rec_start')}</button>
        <button id="mic-stop-btn" class="btn" type="button" disabled>${t('dev_rec_stop')}</button>
        <p id="mic-status" class="status-line">${t('mic_waiting')}</p>
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
    <p class="card-copy">${t('debug_ui_copy')}</p>
  </section>
  `}
`

const glassesUI = createGlassesUI()
// 外界への口は Transport 抽象(hub / telegram)
const tgBoot = transportMode === 'telegram' ? createTelegramBoot(settingsStore) : null
const transport = tgBoot ? tgBoot.transport : createHubTransport()
const notifClient = transport.notifications
// G2 ミラー（?mirror=1 / ?mirrorpub=1 時のみ生成）
const mirrorStore = appConfig.mirrorView || appConfig.mirrorPublish ? createMirrorStore() : null
// 共有可変状態は AppContext 1オブジェクトに集約（生成はここで1回のみ。src/app/context.ts 参照）
const ctx = createAppContext({ glassesUI, transport, mirror: mirrorStore, ui: { setPill, updateDashboard, updateNotifInfo } })

if (mirrorStore && appConfig.mirrorView) {
  const mirrorCanvas = document.getElementById('g2-mirror-canvas') as HTMLCanvasElement | null
  // 静音化: 画像BLE転送中は描画を繰り延べる（ctx.imageTransferQuiet を配線）
  if (mirrorCanvas) attachMirrorCanvas(mirrorCanvas, mirrorStore, () => ctx.imageTransferQuiet)
}
if (mirrorStore && appConfig.mirrorPublish) {
  // Hub 経由でビューア（mirror.html）へ配信（静音化も同様に配線）
  attachMirrorPublisher(mirrorStore, {
    hubUrl: appConfig.notificationHubUrl,
    headers: () => createHubHeaders(),
    isQuiet: () => ctx.imageTransferQuiet,
  })
}

// --- 接続モード(transport)設定パネルの配線 ---
{
  const modeRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="transport-mode"]'))
  for (const radio of modeRadios) radio.checked = radio.value === transportMode
  const hubUrlInput = document.getElementById('hub-url') as HTMLInputElement | null
  const hubTokenInput = document.getElementById('hub-token') as HTMLInputElement | null
  const localeSelect = document.getElementById('locale-select') as HTMLSelectElement | null
  if (hubUrlInput) hubUrlInput.value = savedAppSettings.hubUrl
  if (hubTokenInput) hubTokenInput.value = savedAppSettings.hubToken
  if (localeSelect) localeSelect.value = savedAppSettings.locale

  document.getElementById('transport-save-btn')?.addEventListener('click', () => {
    void (async () => {
      const selected = modeRadios.find((r) => r.checked)?.value
      const localeValue = localeSelect?.value
      await saveAppSettings(settingsStore, {
        transport: selected === 'hub' || selected === 'telegram' ? selected : '',
        hubUrl: hubUrlInput?.value.trim() ?? '',
        hubToken: hubTokenInput?.value ?? '',
        locale: localeValue === 'ja' || localeValue === 'en' ? localeValue : '',
      })
      log('接続設定を保存しました — 再読み込みします')
      // ?transport= の一時上書きが残っていると保存値が効かないため、URL から外して再読み込み
      const url = new URL(globalThis.location.href)
      url.searchParams.delete('transport')
      globalThis.location.replace(url.toString())
    })()
  })
}

// --- Telegram 設定パネルの配線(telegram モード時のみ DOM に存在) ---
if (tgBoot) {
  const el = (id: string) => document.getElementById(id)
  const input = (id: string) => el(id) as HTMLInputElement | null
  const statusEl = el('tg-status')
  const setTgStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text
  }

  tgBoot.onStatus((s) => {
    const label =
      s.state === 'connected' ? t('tg_connected')
        : s.state === 'connecting' ? t('tg_connecting')
          : s.state === 'need-login' ? t('tg_need_login')
            : s.state === 'error' ? t('tg_error')
              : t('tg_status_init')
    setTgStatus(s.detail ? `${label} — ${s.detail}` : label)
    // 初期化後に保存済み設定をフォームへ反映(secret は表示済みの値をそのまま保持)
    const saved = tgBoot.getSettings()
    if (input('tg-api-id') && !input('tg-api-id')!.value && saved.apiId != null) input('tg-api-id')!.value = String(saved.apiId)
    if (input('tg-api-hash') && !input('tg-api-hash')!.value && saved.apiHash) input('tg-api-hash')!.value = saved.apiHash
    if (input('tg-chat') && !input('tg-chat')!.value && saved.chat) input('tg-chat')!.value = saved.chat
    if (input('tg-soniox-key') && !input('tg-soniox-key')!.value && saved.sonioxKey) input('tg-soniox-key')!.value = saved.sonioxKey
  })

  el('tg-save-btn')?.addEventListener('click', () => {
    void (async () => {
      const current = tgBoot.getSettings()
      const apiIdRaw = input('tg-api-id')?.value.trim() ?? ''
      await tgBoot.saveSettings({
        ...current,
        apiId: apiIdRaw ? Number(apiIdRaw) : null,
        apiHash: input('tg-api-hash')?.value.trim() ?? '',
        chat: input('tg-chat')?.value.trim() ?? '',
        sonioxKey: input('tg-soniox-key')?.value.trim() ?? '',
      })
      log('Telegram 設定を保存しました')
    })()
  })

  // ログインウィザード: code / 2FA password はボタン押下で resolve する Promise パターン(ERGram 方式)
  let resolveCode: ((code: string) => void) | null = null
  let resolvePassword: ((pw: string) => void) | null = null

  el('tg-login-btn')?.addEventListener('click', () => {
    void (async () => {
      try {
        await tgBoot.login({
          phoneNumber: async () => input('tg-phone')?.value.trim() ?? '',
          phoneCode: async () => {
            ;(el('tg-code-row') as HTMLElement).style.display = ''
            setTgStatus(t('tg_enter_code'))
            return new Promise<string>((r) => { resolveCode = r })
          },
          password: async () => {
            ;(el('tg-password-row') as HTMLElement).style.display = ''
            setTgStatus(t('tg_enter_2fa'))
            return new Promise<string>((r) => { resolvePassword = r })
          },
          onError: (e) => setTgStatus(`${t('tg_login_error')}: ${String(e)}`),
        })
      } catch (err) {
        setTgStatus(`${t('tg_login_failed')}: ${String(err)}`)
      } finally {
        ;(el('tg-code-row') as HTMLElement).style.display = 'none'
        ;(el('tg-password-row') as HTMLElement).style.display = 'none'
      }
    })()
  })

  el('tg-code-btn')?.addEventListener('click', () => {
    resolveCode?.(input('tg-code')?.value.trim() ?? '')
    resolveCode = null
  })
  el('tg-password-btn')?.addEventListener('click', () => {
    resolvePassword?.(input('tg-password')?.value ?? '')
    resolvePassword = null
  })

  el('tg-logout-btn')?.addEventListener('click', () => {
    void tgBoot.logout()
  })
}

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
    listEl.innerHTML = `<li class="queue-empty">${t('notif_empty_list')}</li>`
    return
  }
  listEl.innerHTML = items.map((item, index) => {
    const active = ctx.notifState.screen === 'list' && index === ctx.notifState.selectedIndex ? ' active' : ''
    const title = escapeHtml(item.title)
    const source = escapeHtml(item.source)
    const status = escapeHtml(replyStatusLabel(item))
    const age = escapeHtml(new Date(item.createdAt).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }))
    return `<li class="queue-item${active}">
      <div class="queue-title">${title}</div>
      <div class="queue-meta">${source} · ${status} · ${age}</div>
    </li>`
  }).join('')
}

function updateDashboard() {
  const g2Tone = ctx.connection ? 'ok' : 'neutral'
  const g2Text = ctx.connection ? (ctx.connection.mode === 'bridge' ? t('status_connected_bridge') : t('status_connected_mock')) : t('status_disconnected')
  ctx.ui.setPill('connection-status', g2Text, g2Tone)

  if (ctx.hubReachable == null) ctx.ui.setPill('hub-status', t('status_unverified'), 'neutral')
  else ctx.ui.setPill('hub-status', ctx.hubReachable ? 'reachable' : 'error', ctx.hubReachable ? 'ok' : 'error')

  const notifTone = ctx.notifState.items.length > 0 ? 'ok' : 'neutral'
  ctx.ui.setPill('notif-count', tp('notif_count', { n: ctx.notifState.items.length }), notifTone)
  ctx.ui.setPill('g2-screen-status', screenLabel(ctx.notifState.screen), 'neutral')

  const syncEl = document.getElementById('last-sync-status')
  if (syncEl) syncEl.textContent = `${t('last_updated')}: ${formatRelativeTime(ctx.lastNotifRefreshAt)}`

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
  resultEl.textContent = t('dev_approval_waiting')
  log('承認リクエスト送信: ファイル編集の承認')

  const result = await glassesUI.requestApproval(ctx.connection, {
    title: t('dev_approval_title'),
    detail: t('dev_approval_detail'),
    options: ['Approve', 'Deny'],
  })

  resultEl.textContent = `${t('dev_result')}: ${result}`
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
  micStatus.textContent = t('mic_recording')
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

  // Start realtime STT if configured(dev マイクテストも transport 経由で生成)
  const devRealtimeStt = ctx.transport.createRealtimeStt()
  if (devRealtimeStt) {
    try {
      ctx.realtimeSTT = devRealtimeStt
      await ctx.realtimeSTT.start((text, isFinal) => {
        const audioInfo = document.getElementById('audio-info')!
        const prefix = isFinal ? '[final]' : '[partial]'
        audioInfo.textContent = `${prefix} ${text}`
      })
      log(`${appConfig.sttProvider} Realtime STT開始`)
    } catch (err) {
      ctx.realtimeSTT = null
      log(`Realtime STT開始失敗: ${errorMessage(err)}`)
      micStatus.textContent = `${t('rt_stt_failed')}: ${errorMessage(err)}`
      startBtn.disabled = false
      stopBtn.disabled = true
      ctx.isRecording = false
      return
    }
  }

  // evenhub-simulator requires at least one created page/container before audioControl().
  if (ctx.connection.mode === 'bridge' && !glassesUI.hasRenderedPage(ctx.connection)) {
    log('マイク前にG2ベースページを初期化（simulator対策）')
    await glassesUI.ensureBasePage(ctx.connection, t('mic_rec_base'))
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

  micStatus.textContent = `${t('mic_rec_done')} (${ctx.realtimeSTT ? 'realtime' : `${ctx.audioChunks.length}${t('unit_chunks')}`}, ${ctx.audioTotalBytes}${t('unit_bytes')})`
  log(`マイク停止: ${ctx.realtimeSTT ? 'realtime' : `${ctx.audioChunks.length}チャンク`}, ${ctx.audioTotalBytes}バイト取得`)

  if (ctx.audioTotalBytes === 0) {
    if (ctx.realtimeSTT) { ctx.realtimeSTT.abort(); ctx.realtimeSTT = null }
    return
  }

  micStatus.textContent = t('stt_processing')
  log('STT開始')

  try {
    const stt = ctx.realtimeSTT
      ? await (async () => { const r = await ctx.realtimeSTT!.stop(); ctx.realtimeSTT = null; return r })()
      : await transcribePcmChunks(ctx.audioChunks)
    const formatted = formatForG2ScrollableText(stt.text || t('stt_no_result'))
    micStatus.textContent = `${t('stt_done')} (${stt.provider}${stt.model ? `:${stt.model}` : ''})`
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
    micStatus.textContent = t('stt_failed')
    log(`STT失敗: ${message}`)
    if (ctx.connection) {
      await glassesUI.showText(ctx.connection, t('stt_failed_retry'))
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
      infoEl.textContent = `${t('panel_idle_hint')}\n${t('panel_auto_open')}: ${autoOpenLabel}`
      break
    }
    case 'list': {
      // list index 0 は固定行「▸ Sessions」。以降は絞り込み後の通知（最大19件）。
      const displayItems = filterItemsBySession(ctx.notifState.items, ctx.notifState.sessionFilter)
      const head = ctx.notifState.sessionFilter !== null
        ? `[${ctx.notifState.sessionFilterLabel || ctx.notifState.sessionFilter}]\n`
        : ''
      const lines = [
        `${ctx.notifState.selectedIndex === 0 ? '>' : ' '} ${t('sess_entry')}`,
        ...displayItems.slice(0, 19).map((item, i) => {
          const marker = i + 1 === ctx.notifState.selectedIndex ? '>' : ' '
          return `${marker} ${item.title} (${item.source})`
        }),
      ]
      infoEl.textContent = head + lines.join('\n')
      break
    }
    case 'session-list': {
      const rows = ctx.notifState.sessionGroups.map((g, i) => {
        const marker = i === ctx.notifState.sessionListIndex ? '>' : ' '
        return `${marker} ${g.label} (${g.count})`
      })
      infoEl.textContent = [`[${t('sess_header')}]`, ...rows].join('\n')
      break
    }
    case 'detail': {
      const d = ctx.notifState.detailItem
      if (d) {
        const replyHint = d.replyCapable ? t('panel_reply_hint') : ''
        infoEl.textContent = [
          `[${t('label_detail')}] ${d.title}`,
          `Source: ${d.source} | replyCapable: ${d.replyCapable}`,
          `Chunk: ${ctx.notifState.detailPageIndex + 1}/${ctx.notifState.detailPages.length} (firmware scroll)`,
          `${t('panel_detail_ops')}${replyHint}`,
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
          `[${t('label_actions')}] ${ctx.notifState.detailItem.title}`,
          menu,
          t('panel_select_back_detail'),
        ].join('\n')
      }
      break
    case 'image-detail':
      if (ctx.notifState.detailItem) {
        infoEl.textContent = [
          `[${t('label_image')}] ${ctx.notifState.detailItem.title}`,
          t('panel_image_back'),
        ].join('\n')
      }
      break
    case 'ask-question-detail': {
      const q = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
      infoEl.textContent = [
        `[${t('label_question_detail')} ${ctx.notifState.askQuestionIndex + 1}/${ctx.notifState.askQuestions.length}]`,
        `Page: ${ctx.notifState.detailPageIndex + 1}/${ctx.notifState.detailPages.length}`,
        q?.question?.slice(0, 80) ?? '',
        t('panel_askq_detail_hint'),
      ].join('\n')
      break
    }
    case 'ask-question': {
      const q = ctx.notifState.askQuestions[ctx.notifState.askQuestionIndex]
      const opts = q ? q.options.map((o, i) => `${i}=${o.label}`).join(', ') : ''
      infoEl.textContent = [
        `[${t('label_question')} ${ctx.notifState.askQuestionIndex + 1}/${ctx.notifState.askQuestions.length}]`,
        q?.question ?? '',
        opts,
        t('panel_select_back'),
      ].join('\n')
      break
    }
    case 'reply-recording':
      infoEl.textContent = tp('panel_reply_recording', { bytes: ctx.replyAudioTotalBytes })
      break
    case 'reply-confirm':
      infoEl.textContent = [
        t('panel_reply_confirm'),
        `Page: ${ctx.notifState.detailPageIndex + 1}/${ctx.notifState.detailPages.length}`,
        ctx.notifState.replyText,
        t('panel_reply_confirm_hint'),
      ].join('\n')
      break
    case 'reply-confirm-actions':
      infoEl.textContent = t('panel_reply_confirm_actions')
      break
    case 'reply-sending':
      infoEl.textContent = t('panel_reply_sending')
      break
  }
  ctx.ui.updateDashboard()
}

document.getElementById('notif-fetch-btn')!.addEventListener('click', async () => {
  const statusEl = document.getElementById('notif-status')!
  statusEl.textContent = t('notif_fetching')
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
    statusEl.textContent = tp('notif_fetched', { n: items.length })
    document.getElementById('notif-show-g2-btn')!.removeAttribute('disabled')
    ctx.transport.connectEvents(ctx)
    ctx.ui.updateNotifInfo()
    log(`通知取得: ${items.length}件`)
  } catch (err) {
    ctx.hubReachable = false
    const msg = errorMessage(err)
    statusEl.textContent = `${t('notif_fetch_failed')}: ${msg}`
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
  resetListFilter(ctx)
  await glassesUI.showNotificationList(ctx.connection, ctx.notifState.items)
  ctx.transport.connectEvents(ctx)
  ctx.ui.updateNotifInfo()
})

ctx.ui.updateDashboard()
