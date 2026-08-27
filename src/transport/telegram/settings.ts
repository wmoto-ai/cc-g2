/**
 * telegram トランスポートの設定永続化。
 * ストア実装(SDK localStorage / ブラウザフォールバック)は app/settings-store.ts に共有化。
 *
 * 注意: StringSession はアカウント全権限相当の機密(設計 §6)。値をログに
 * 出さない・エラーメッセージに混ぜないこと。
 */
import { log } from '../../log'
import type { SettingsStore } from '../../app/settings-store'

export interface TelegramSettings {
  apiId: number | null
  apiHash: string
  /** GramJS StringSession(空 = 未ログイン) */
  session: string
  sonioxKey: string
  /** cc-tg bot とのチャット(@username or 数値 id 文字列) */
  chat: string
}

const STORAGE_KEY = 'cc-g2-telegram-settings-v1'

export function emptyTelegramSettings(): TelegramSettings {
  return { apiId: null, apiHash: '', session: '', sonioxKey: '', chat: '' }
}

export type { SettingsStore } from '../../app/settings-store'

export async function loadTelegramSettings(store: SettingsStore): Promise<TelegramSettings> {
  try {
    const raw = await store.get(STORAGE_KEY)
    if (!raw) return emptyTelegramSettings()
    const parsed = JSON.parse(raw) as Partial<TelegramSettings>
    return {
      apiId: typeof parsed.apiId === 'number' ? parsed.apiId : null,
      apiHash: typeof parsed.apiHash === 'string' ? parsed.apiHash : '',
      session: typeof parsed.session === 'string' ? parsed.session : '',
      sonioxKey: typeof parsed.sonioxKey === 'string' ? parsed.sonioxKey : '',
      chat: typeof parsed.chat === 'string' ? parsed.chat : '',
    }
  } catch {
    log('telegram settings: 読み込み失敗 — 空設定で開始')
    return emptyTelegramSettings()
  }
}

export async function saveTelegramSettings(store: SettingsStore, settings: TelegramSettings): Promise<void> {
  await store.set(STORAGE_KEY, JSON.stringify(settings))
}

export function hasTelegramCredentials(s: TelegramSettings): boolean {
  return s.apiId != null && s.apiHash !== '' && s.session !== ''
}
