/**
 * アプリ全体設定(トランスポート選択 + hub 接続先)の永続化。
 *
 * transport は設定画面のトグルで切り替え、保存後に location.reload() で反映する
 * (ライブ切替は GramJS/SSE/G2 画面状態の巻き戻しが絡むため採らない)。
 * 未設定('')のときはビルド時デフォルト(VITE_TRANSPORT)に従う。
 */
import type { SettingsStore } from './settings-store'

export interface AppSettings {
  /** '' = 未設定(ビルド時デフォルトに従う) */
  transport: 'hub' | 'telegram' | ''
  /** hub モードの接続先(空 = VITE_HUB_URL / hostname フォールバック) */
  hubUrl: string
  /** hub の X-CC-G2-Token(空 = VITE_HUB_TOKEN) */
  hubToken: string
  /** UI 表示言語。'' = 自動(navigator.language が ja 始まりなら ja、それ以外 en) */
  locale: 'ja' | 'en' | ''
}

const STORAGE_KEY = 'cc-g2-app-settings-v1'

export function emptyAppSettings(): AppSettings {
  return { transport: '', hubUrl: '', hubToken: '', locale: '' }
}

export async function loadAppSettings(store: SettingsStore): Promise<AppSettings> {
  try {
    const raw = await store.get(STORAGE_KEY)
    if (!raw) return emptyAppSettings()
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      transport: parsed.transport === 'hub' || parsed.transport === 'telegram' ? parsed.transport : '',
      hubUrl: typeof parsed.hubUrl === 'string' ? parsed.hubUrl.trim() : '',
      hubToken: typeof parsed.hubToken === 'string' ? parsed.hubToken : '',
      locale: parsed.locale === 'ja' || parsed.locale === 'en' ? parsed.locale : '',
    }
  } catch {
    return emptyAppSettings()
  }
}

export async function saveAppSettings(store: SettingsStore, settings: AppSettings): Promise<void> {
  await store.set(STORAGE_KEY, JSON.stringify(settings))
}

/**
 * 起動時のトランスポート決定。優先順:
 * URL パラメータ(dev/シミュレータ自動化用) > 保存済み設定 > ビルド時デフォルト > 'hub'
 */
export function resolveTransportMode(
  urlParam: string | null,
  saved: AppSettings,
  buildDefault: string | undefined,
): 'hub' | 'telegram' {
  const pick = (v: string | null | undefined): 'hub' | 'telegram' | null =>
    v === 'hub' || v === 'telegram' ? v : null
  return pick(urlParam) ?? pick(saved.transport) ?? pick(buildDefault?.trim()) ?? 'hub'
}
