/**
 * 設定永続化ストアの共有実装。
 *
 * Even App の WebView(Flutter WebView)はブラウザ localStorage が再起動間で
 * 信頼できないため、Even Hub SDK の set/getLocalStorage を優先し、
 * ブラウザ/シミュレータでの開発時は window.localStorage にフォールバックする。
 * telegram 設定(transport/telegram/settings.ts)とアプリ全体設定
 * (app/app-settings.ts)の両方がこのストアを使う。
 */
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { log } from '../log'

/** Even Hub SDK の localStorage 互換の最小面 */
export interface SettingsStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

/** window.localStorage ベースの開発用フォールバック */
export function browserSettingsStore(): SettingsStore {
  return {
    async get(key) {
      return globalThis.localStorage?.getItem(key) ?? null
    },
    async set(key, value) {
      globalThis.localStorage?.setItem(key, value)
    },
  }
}

/**
 * Even App 内なら SDK localStorage、それ以外(ブラウザ/シミュレータ開発)は window.localStorage。
 *
 * トレードオフ(既知): bridge 検出は 2.5 秒でタイムアウトし browser localStorage に
 * フォールバックする。Even App の bridge 注入が 2.5 秒を超えた場合、保存済み設定が
 * 見えず VITE_TRANSPORT 既定で起動する(次回起動で復帰)。タイムアウトを伸ばすと
 * bridge 無し環境(通常ブラウザ dev)の初期表示が遅くなるため 2.5 秒で妥協している。
 * 実機で bridge 注入がこれより遅い事例が観測されたら再検討すること。
 */
export async function detectSettingsStore(): Promise<SettingsStore> {
  try {
    const bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500)),
    ])
    if (bridge && typeof bridge.setLocalStorage === 'function') {
      log('settings: Even Hub SDK localStorage を使用')
      return {
        get: async (key) => {
          const value = await bridge.getLocalStorage(key)
          return typeof value === 'string' ? value : null
        },
        set: async (key, value) => {
          await bridge.setLocalStorage(key, value)
        },
      }
    }
  } catch {
    // fall through
  }
  log('settings: browser localStorage を使用(開発フォールバック)')
  return browserSettingsStore()
}
