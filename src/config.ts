function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export const appConfig = {
  sttEnabled: readBool(import.meta.env.VITE_STT_ENABLED, true),
  sttForceError: readBool(import.meta.env.VITE_STT_FORCE_ERROR, false),
  sttProvider: ((import.meta.env.VITE_STT_PROVIDER as string)?.trim() || 'groq') as 'groq' | 'openai-realtime' | 'soniox',
  groqModel: (import.meta.env.VITE_GROQ_MODEL as string | undefined)?.trim() || 'whisper-large-v3',
  hubAuthToken: (import.meta.env.VITE_HUB_TOKEN as string | undefined)?.trim() ?? '',
  notificationHubUrl: (import.meta.env.VITE_HUB_URL as string | undefined)?.trim() || `http://${globalThis.location?.hostname || '127.0.0.1'}:8787`,
  notificationAutoOpenOnNew: readBool(import.meta.env.VITE_NOTIF_AUTO_OPEN_ON_NEW, true),
  notificationIdleDimMode: readBool(import.meta.env.VITE_NOTIF_IDLE_DIM_MODE, true),
  /** Web Speech API の比較診断を有効にする（開発時のみ） */
  webSpeechCompare: readBool(import.meta.env.VITE_WEBSPEECH_COMPARE, false),
  /** クライアントの全ログを Hub にミラー送信する（診断時のみ。デフォルト無効）
   *  URL パラメータ ?logmirror=1 でもセッション限定で有効化できる。
   *  注意: 有効時はログ1行ごとに WebView から POST が飛び、「G2 rebuild:」は BLE 書き込み
   *  直前に毎回 POST する構図になる。恒常負荷になるため常用しないこと。
   *  （2026-06-10 の切り分けで一時強制 OFF にしたが、クラッシュ多発の根本原因は
   *  SDK 0.0.10 の ShadowTimers 二重発火と判明したため復活。known-limitations §11） */
  logMirror:
    readBool(import.meta.env.VITE_LOG_MIRROR, false) ||
    new URLSearchParams(globalThis.location?.search || '').get('logmirror') === '1',
}

export function canUseGroqStt() {
  return appConfig.sttEnabled && appConfig.sttProvider === 'groq'
}

export function canUseOpenaiRealtimeStt() {
  return appConfig.sttEnabled && appConfig.sttProvider === 'openai-realtime'
}

export function canUseSonioxStt() {
  return appConfig.sttEnabled && appConfig.sttProvider === 'soniox'
}

export function createHubHeaders(extra?: HeadersInit): HeadersInit {
  const base: Record<string, string> = {}
  if (appConfig.hubAuthToken) base['X-CC-G2-Token'] = appConfig.hubAuthToken

  if (!extra) return base
  if (Array.isArray(extra)) return [...Object.entries(base), ...extra]
  if (extra instanceof Headers) {
    const merged = new Headers(extra)
    for (const [key, value] of Object.entries(base)) merged.set(key, value)
    return merged
  }
  return { ...base, ...extra }
}
