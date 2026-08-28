import { describe, expect, it } from 'vitest'
import {
  emptyAppSettings,
  loadAppSettings,
  resolveTransportMode,
  saveAppSettings,
  type AppSettings,
} from '../src/app/app-settings'
import type { SettingsStore } from '../src/app/settings-store'

function memoryStore(initial?: Record<string, string>): SettingsStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}))
  return {
    data,
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
  }
}

describe('resolveTransportMode', () => {
  const saved = (transport: AppSettings['transport']): AppSettings => ({ ...emptyAppSettings(), transport })

  it('URL パラメータが最優先(dev/シミュレータ自動化用)', () => {
    expect(resolveTransportMode('hub', saved('telegram'), 'telegram')).toBe('hub')
    expect(resolveTransportMode('telegram', saved('hub'), 'hub')).toBe('telegram')
  })

  it('URL パラメータなし → 保存済み設定', () => {
    expect(resolveTransportMode(null, saved('telegram'), 'hub')).toBe('telegram')
    expect(resolveTransportMode(null, saved('hub'), 'telegram')).toBe('hub')
  })

  it('保存なし → ビルド時デフォルト(VITE_TRANSPORT) → hub', () => {
    expect(resolveTransportMode(null, saved(''), 'telegram')).toBe('telegram')
    expect(resolveTransportMode(null, saved(''), undefined)).toBe('hub')
  })

  it('不正値はその段をスキップする', () => {
    expect(resolveTransportMode('bogus', saved(''), 'bogus')).toBe('hub')
    expect(resolveTransportMode('bogus', saved('telegram'), 'hub')).toBe('telegram')
  })
})

describe('loadAppSettings / saveAppSettings', () => {
  it('round-trip で保存値が戻る', async () => {
    const store = memoryStore()
    const settings: AppSettings = { transport: 'telegram', hubUrl: 'http://100.64.0.1:8787', hubToken: 'tok', locale: 'en' }
    await saveAppSettings(store, settings)
    expect(await loadAppSettings(store)).toEqual(settings)
  })

  it('未保存・壊れた JSON・不正な transport は空設定に落ちる', async () => {
    expect(await loadAppSettings(memoryStore())).toEqual(emptyAppSettings())
    expect(await loadAppSettings(memoryStore({ 'cc-g2-app-settings-v1': '{oops' }))).toEqual(emptyAppSettings())
    const badTransport = memoryStore({
      'cc-g2-app-settings-v1': JSON.stringify({ transport: 'bogus', hubUrl: ' http://x:1 ', hubToken: 't' }),
    })
    expect(await loadAppSettings(badTransport)).toEqual({ transport: '', hubUrl: 'http://x:1', hubToken: 't', locale: '' })
  })
})
