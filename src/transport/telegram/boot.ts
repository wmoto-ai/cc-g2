/**
 * telegram モードの起動ファサード。
 *
 * main.ts は同期的に AppContext を組み立てるため、非同期初期化(設定ロード →
 * セッション resume)を裏で進めるファサード Transport を先に渡し、準備完了後に
 * 実体(createTelegramTransport)へ委譲する。未接続の間の操作は分かりやすい
 * エラーメッセージで失敗させる(G2 には送信失敗として表示される)。
 */
import { log } from '../../log'
import { t } from '../../i18n'
import type { AppContext } from '../../app/context'
import type { SettingsStore } from '../../app/settings-store'
import type { RealtimeStt, Transport } from '../types'
// GramJS(重い)を hub モードのバンドルに入れないため、client/transport は動的 import
import type { TgClient, LoginPrompts } from './client'
import {
  hasTelegramCredentials,
  loadTelegramSettings,
  saveTelegramSettings,
  type TelegramSettings,
} from './settings'

// i18n 初期化前に評価されないよう遅延取得(main.ts が initI18n 後に createTelegramBoot する)
const notReady = () => t('tg_not_ready')

export interface TelegramBootStatus {
  state: 'loading' | 'need-login' | 'connecting' | 'connected' | 'error'
  detail?: string
}

export interface TelegramBoot {
  transport: Transport
  /** 設定 UI 用のコントローラ */
  getSettings(): TelegramSettings
  saveSettings(next: TelegramSettings): Promise<void>
  login(prompts: LoginPrompts): Promise<void>
  logout(): Promise<void>
  onStatus(cb: (status: TelegramBootStatus) => void): void
}

export function createTelegramBoot(settingsStore: SettingsStore): TelegramBoot {
  let inner: Transport | null = null
  let client: TgClient | null = null
  const store: SettingsStore = settingsStore
  let settings: TelegramSettings = {
    apiId: null,
    apiHash: '',
    session: '',
    sonioxKey: '',
    chat: '',
  }
  let pendingCtx: AppContext | null = null
  let statusCb: ((s: TelegramBootStatus) => void) | null = null
  let status: TelegramBootStatus = { state: 'loading' }

  function setStatus(next: TelegramBootStatus): void {
    status = next
    statusCb?.(next)
  }

  function activate(transport: Transport): void {
    inner = transport
    setStatus({ state: 'connected' })
    if (pendingCtx) {
      transport.connectEvents(pendingCtx)
      pendingCtx = null
    }
  }

  /** 資格情報が揃っていれば resume して transport を有効化する */
  async function tryResume(): Promise<void> {
    if (!hasTelegramCredentials(settings) || !settings.chat) {
      setStatus({ state: 'need-login' })
      return
    }
    setStatus({ state: 'connecting' })
    try {
      const [{ TgClient }, { createTelegramTransport }] = await Promise.all([
        import('./client'),
        import('./transport'),
      ])
      client = new TgClient(settings.apiId!, settings.apiHash, settings.session)
      const authorized = await client.resume()
      if (!authorized) {
        setStatus({ state: 'need-login', detail: t('tg_session_invalid') })
        return
      }
      activate(createTelegramTransport(client, settings))
      log('telegram boot: resume 成功')
    } catch (err) {
      setStatus({ state: 'error', detail: String(err) })
      log(`telegram boot: resume 失敗: ${String(err)}`)
    }
  }

  const init = (async () => {
    settings = await loadTelegramSettings(store)
    await tryResume()
  })()

  const facade: Transport = {
    mode: 'telegram',
    notifications: {
      async list(limit?: number) {
        if (!inner) throw new Error(notReady())
        return inner.notifications.list(limit)
      },
      async detail(id: string) {
        if (!inner) throw new Error(notReady())
        return inner.notifications.detail(id)
      },
      async reply(id: string, reply) {
        if (!inner) return { ok: false, reply: { id, status: 'failed', error: notReady() } }
        return inner.notifications.reply(id, reply)
      },
    },
    async fetchImageBlob(imageId: string) {
      if (!inner) throw new Error(notReady())
      return inner.fetchImageBlob(imageId)
    },
    connectEvents(ctx: AppContext) {
      if (inner) inner.connectEvents(ctx)
      else pendingCtx = ctx
    },
    createRealtimeStt(): RealtimeStt | null {
      return inner ? inner.createRealtimeStt() : null
    },
    async transcribeBatch(chunks) {
      if (!inner) return { text: '', provider: 'mock' as const }
      return inner.transcribeBatch(chunks)
    },
  }

  return {
    transport: facade,

    getSettings() {
      return { ...settings }
    },

    async saveSettings(next: TelegramSettings) {
      await init
      settings = next
      await saveTelegramSettings(store, settings)
      // 接続済みで chat / soniox キーが変わった場合は作り直しが必要(単純化のため再 resume)
      if (inner && client) {
        inner = null
        await client.disconnect().catch(() => {})
        client = null
        await tryResume()
      } else if (!inner) {
        await tryResume()
      }
    },

    async login(prompts: LoginPrompts) {
      await init
      if (settings.apiId == null || !settings.apiHash) throw new Error(t('tg_need_api'))
      setStatus({ state: 'connecting' })
      const [{ TgClient }, { createTelegramTransport }] = await Promise.all([
        import('./client'),
        import('./transport'),
      ])
      // クライアントは使い捨て(ERGram 方式): 旧クライアントを破棄して新規ログイン
      if (client) await client.disconnect().catch(() => {})
      client = new TgClient(settings.apiId, settings.apiHash, '')
      await client.login(settings.apiId, settings.apiHash, prompts)
      settings.session = client.saveSession()
      await saveTelegramSettings(store, settings)
      activate(createTelegramTransport(client, settings))
      log('telegram boot: ログイン成功(セッション保存済み)')
    },

    async logout() {
      await init
      try {
        if (client) await client.revokeSession()
      } catch (err) {
        log(`telegram boot: revoke 失敗(ローカルは消去します): ${String(err)}`)
      } finally {
        // revoke の成否に関わらずローカルの session は必ず消す(ERGram と同方針)
        settings.session = ''
        await saveTelegramSettings(store, settings)
        client = null
        inner = null
        setStatus({ state: 'need-login' })
      }
    },

    onStatus(cb) {
      statusCb = cb
      cb(status)
    },
  }
}
