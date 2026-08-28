// 統合テスト用ハーネス: fixture Hub + 実 HubClient + 実フロー + grammY スタブを本番同様に配線する。
// SSE は startSse() を呼んだテストだけ有効化。reconciler は interval を回さず runOnce() を手動で叩く。
import { mkdtemp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Bot } from 'grammy'
import { HubClient } from '../../src/hub/client'
import { Reconciler } from '../../src/hub/reconciler'
import { SseSubscriber } from '../../src/hub/sse'
import { ApprovalFlow } from '../../src/core/approval-flow'
import { MediaFlow } from '../../src/core/media-flow'
import { NotifyFlow } from '../../src/core/notify-flow'
import { Router } from '../../src/core/router'
import { StateStore } from '../../src/core/state'
import { StopReplyRelay } from '../../src/core/stop-reply'
import { registerHandlers } from '../../src/telegram/bot'
import { CommentPromptStore } from '../../src/telegram/comment-prompt'
import { createTelegramDownloader } from '../../src/telegram/media-downloader'
import { createGrammySender } from '../../src/telegram/sender'
import { createBackoff } from '../../src/util/backoff'
import type { Update } from 'grammy/types'
import { startFixtureHub, type FixtureHub } from './hub-server'
import { BOT_INFO, TelegramStub } from './telegram-api'
import { silentLogger } from './util'

export const USER_ID = 111
export const CHAT_ID = 111
export const OTHER_USER_ID = 999
export const OTHER_CHAT_ID = -100_555

const TMP_ROOT = path.resolve('tmp')

export interface Harness {
  hub: FixtureHub
  stub: TelegramStub
  bot: Bot
  state: StateStore
  hubClient: HubClient
  approvalFlow: ApprovalFlow
  notifyFlow: NotifyFlow
  mediaFlow: MediaFlow
  router: Router
  reconciler: Reconciler
  prompts: CommentPromptStore
  statePath: string
  inboxDir: string
  startSse(): Promise<void>
  dispatch(update: Update): Promise<void>
  close(): Promise<void>
}

export interface HarnessOptions {
  /** 既存 fixture Hub を共有する(アダプタ再起動シナリオ用)。渡した場合 close() は Hub を閉じない */
  hub?: FixtureHub
  /** 既存 state ファイルを引き継ぐ(再起動シナリオ用) */
  statePath?: string
  postCutoffMs?: number
  staleMs?: number
  decideMarginMs?: number
  inboxMaxBytes?: number
  stopReplyTtlMs?: number
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const hub = options.hub ?? (await startFixtureHub())
  await mkdir(TMP_ROOT, { recursive: true })
  const statePath =
    options.statePath ?? path.join(await mkdtemp(path.join(TMP_ROOT, 'state-')), 'state.json')
  const state = await StateStore.load(statePath, silentLogger)
  const hubClient = new HubClient({ baseUrl: hub.url, authToken: hub.authToken })
  const stub = new TelegramStub()
  const bot = new Bot('42:TEST', { botInfo: BOT_INFO })
  stub.install(bot)
  const sender = createGrammySender(bot.api)
  // inbox は MediaFlow 自身が(0700 で)作成するため、存在しないサブディレクトリを渡す
  const inboxDir = path.join(await mkdtemp(path.join(TMP_ROOT, 'inbox-')), 'inbox')
  const prompts = new CommentPromptStore()
  const postCutoffMs = options.postCutoffMs ?? 540_000
  const staleMs = options.staleMs ?? 600_000
  const decideMarginMs = options.decideMarginMs ?? 30_000

  const approvalFlow = new ApprovalFlow({
    hub: hubClient,
    sender,
    state,
    prompts,
    chatId: CHAT_ID,
    postCutoffMs,
    staleMs,
    decideMarginMs,
    logger: silentLogger,
  })
  const stopReply = new StopReplyRelay({
    hub: hubClient,
    state,
    ttlMs: options.stopReplyTtlMs ?? 24 * 60 * 60 * 1000,
    logger: silentLogger,
  })
  const notifyFlow = new NotifyFlow({
    hub: hubClient,
    sender,
    state,
    stopReply,
    chatId: CHAT_ID,
    logger: silentLogger,
  })
  const downloader = createTelegramDownloader(bot.api, {
    token: '42:TEST',
    maxBytes: options.inboxMaxBytes ?? 10 * 1024 * 1024,
    fetchFn: stub.fetchFile,
  })
  const mediaFlow = new MediaFlow({ stopReply, downloader, inboxDir, logger: silentLogger })
  const router = new Router({ hub: hubClient, approvalFlow, notifyFlow, logger: silentLogger })
  const reconciler = new Reconciler({
    hub: hubClient,
    flow: approvalFlow,
    state,
    intervalMs: 3_600_000, // テストでは interval を使わず runOnce() を手動で叩く
    postCutoffMs,
    staleMs,
    logger: silentLogger,
  })
  registerHandlers(bot, {
    allowedUserIds: new Set([USER_ID]),
    chatId: CHAT_ID,
    logger: silentLogger,
    approvalFlow,
    notifyFlow,
    mediaFlow,
    prompts,
    state,
    sender,
  })

  let sse: SseSubscriber | null = null

  return {
    hub,
    stub,
    bot,
    state,
    hubClient,
    approvalFlow,
    notifyFlow,
    mediaFlow,
    router,
    reconciler,
    prompts,
    statePath,
    inboxDir,
    async startSse() {
      sse = new SseSubscriber({
        url: `${hub.url}/api/events`,
        onEvent: (event) => router.handleSseEvent(event),
        onConnect: () => void reconciler.runOnce(),
        logger: silentLogger,
        backoff: createBackoff({ baseMs: 20, maxMs: 50, jitter: 0 }),
      })
      sse.start()
      await hub.waitForSseClient()
    },
    async dispatch(update) {
      await bot.handleUpdate(update)
    },
    async close() {
      sse?.stop()
      reconciler.stop()
      await state.flushNow()
      if (!options.hub) await hub.close()
    },
  }
}
