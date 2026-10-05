// cc-g2 統合サーバ: Hub（+ G2 アプリ配信）・Voice Entry・Telegram adapter を 1 プロセスで動かす。
// 起動は scripts/lib/infra.sh の ensure_infra（slim モード）から。Telegram を使うときは tsx が要る:
//   node --import tsx server/cc-g2-server.mjs
// 各機能の env は従来の個別プロセス（CC_G2_SLIM=0 の旧構成）と同じ名前を使う。
import { execFileSync } from 'node:child_process'

process.env.CC_G2_SERVER = '1'

function log(msg) {
  console.log(`[${new Date().toISOString()}] cc-g2-server ${msg}`)
}

// HUB_PORT の解釈は Hub 本体と同じ config.mjs に一本化する
const { port: hubPort } = await import('./notification-hub/config.mjs')

// Hub は import 時に listen する（従来の notification-hub/index.mjs と同じ）
await import('./notification-hub/index.mjs')

if (process.env.CC_G2_VOICE_ENTRY_ENABLED === '1') {
  try {
    await import('./voice-entry/index.mjs')
  } catch (err) {
    log(`voice-entry disabled: ${err?.message || err}`)
  }
}

if (process.env.CC_G2_TELEGRAM === '1') {
  await startTelegram()
}

function legacyAdapterRunning() {
  const session = process.env.CC_G2_TG_LEGACY_SESSION || 'cc-tg-adapter'
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function waitForHub() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${hubPort}/api/health`)).ok) return true
    } catch { /* listen 前 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

async function startTelegram() {
  // 同じ bot token を 2 プロセスで polling すると 409 で両方止まるため、旧 adapter が居れば譲る
  if (legacyAdapterRunning()) {
    log('telegram: legacy adapter (tmux) is running; not starting in-process adapter')
    return
  }
  if (!(await waitForHub())) {
    log('telegram: hub did not become ready; not starting')
    return
  }
  try {
    const { startTelegramAdapter } = await import('../packages/telegram-adapter/src/adapter.ts')
    await startTelegramAdapter({
      ...process.env,
      HUB_BASE_URL: `http://127.0.0.1:${hubPort}`,
      HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN || '',
      DATA_DIR: process.env.CC_G2_TG_DATA_DIR || process.env.DATA_DIR,
      INBOX_DIR: process.env.CC_G2_TG_INBOX_DIR || process.env.INBOX_DIR,
    })
    log('telegram: adapter started in-process')
  } catch (err) {
    // token をログに出さない（adapter 側の logger はまだ無い段階の失敗）
    const msg = String(err?.message || err).replaceAll(process.env.TELEGRAM_BOT_TOKEN || '\0', '***')
    log(`telegram: failed to start: ${msg}`)
  }
}
