// エントリポイント: 配線 → 起動順(bot init → reconciliation/SSE → long-polling)→ graceful shutdown。
import path from 'node:path'
import { loadConfig } from './config'
import { createLogger, errorMessage, redactSecrets } from './logger'
import { HubClient } from './hub/client'
import { Reconciler } from './hub/reconciler'
import { SseSubscriber } from './hub/sse'
import { StateStore } from './core/state'
import { ApprovalFlow } from './core/approval-flow'
import { MediaFlow } from './core/media-flow'
import { NotifyFlow } from './core/notify-flow'
import { Router } from './core/router'
import { StatusFlow } from './core/status-flow'
import { StopReplyRelay } from './core/stop-reply'
import { CommentPromptStore } from './telegram/comment-prompt'
import { createTelegramDownloader } from './telegram/media-downloader'
import { createGrammySender } from './telegram/sender'
import { createBot, registerHandlers } from './telegram/bot'

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const logger = createLogger(
    config.logLevel,
    [config.telegramBotToken, config.hubAuthToken].filter(Boolean),
  )

  const state = await StateStore.load(path.join(config.dataDir, 'state.json'), logger)
  const hub = new HubClient({ baseUrl: config.hubBaseUrl, authToken: config.hubAuthToken })
  const bot = createBot(config.telegramBotToken)
  const sender = createGrammySender(bot.api)
  const prompts = new CommentPromptStore()

  const approvalFlow = new ApprovalFlow({
    hub,
    sender,
    state,
    prompts,
    chatId: config.chatId,
    postCutoffMs: config.approvalPostCutoffMs,
    staleMs: config.approvalStaleMs,
    decideMarginMs: config.approvalDecideMarginMs,
    logger,
  })
  const stopReply = new StopReplyRelay({ hub, state, ttlMs: config.stopReplyTtlMs, logger })
  const notifyFlow = new NotifyFlow({ hub, sender, state, stopReply, chatId: config.chatId, logger })
  const downloader = createTelegramDownloader(bot.api, {
    token: config.telegramBotToken,
    maxBytes: config.inboxMaxBytes,
  })
  const mediaFlow = new MediaFlow({ stopReply, downloader, inboxDir: config.inboxDir, logger })
  const router = new Router({ hub, approvalFlow, notifyFlow, logger })
  const reconciler = new Reconciler({
    hub,
    flow: approvalFlow,
    state,
    intervalMs: config.reconcileIntervalMs,
    postCutoffMs: config.approvalPostCutoffMs,
    staleMs: config.approvalStaleMs,
    logger,
  })
  const sse = new SseSubscriber({
    url: `${config.hubBaseUrl}/api/events`,
    onEvent: (event) => router.handleSseEvent(event),
    onConnect: () => void reconciler.runOnce(),
    logger,
  })
  const statusFlow = new StatusFlow({
    hub,
    sender,
    state,
    chatId: config.chatId,
    intervalMs: config.statusIntervalMs,
    logger,
  })

  registerHandlers(bot, {
    allowedUserIds: config.allowedUserIds,
    chatId: config.chatId,
    logger,
    approvalFlow,
    notifyFlow,
    mediaFlow,
    prompts,
    state,
    sender,
  })

  // bot token の検証を fail-fast で(getMe)
  await bot.init()
  logger.info(
    `bot @${bot.botInfo.username} initialized (chat=${config.chatId}, allowlist=${config.allowedUserIds.size} users, hub=${config.hubBaseUrl})`,
  )

  let shuttingDown = false
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${reason}; shutting down`)
    try {
      sse.stop()
      reconciler.stop()
      statusFlow.stop()
      await bot.stop()
      await state.flushNow()
    } catch (err) {
      logger.error(`shutdown error: ${errorMessage(err)}`)
    }
    process.exit(exitCode)
  }
  process.once('SIGINT', () => void shutdown('SIGINT received'))
  process.once('SIGTERM', () => void shutdown('SIGTERM received'))

  // 初回 reconciliation を await してから long-polling を開始する:
  // アダプタ停止中に Telegram 側へ queue された callback が、stale 承認の expire 反映前に
  // 流れ込む窓を塞ぐ(decide 前の preDecideGuard と二段構え)
  await reconciler.runOnce()
  reconciler.start() // 定期実行。SSE onConnect でも都度実行される
  sse.start()
  statusFlow.start() // ピン留めステータス(STATUS_INTERVAL_MS=0 で無効)
  // 409 Conflict(bot token を別プロセスが polling)等で polling が落ちたら明示終了する
  void bot
    .start({
      drop_pending_updates: false,
      onStart: () => logger.info('long-polling started'),
    })
    .catch((err) => {
      logger.error(
        `long-polling stopped: ${errorMessage(err)} — 409 の場合は同じ bot token を polling している別プロセス(公式 telegram plugin 等)を停止すること`,
      )
      void shutdown('polling error', 1)
    })
}

main().catch((err) => {
  // ここに来るのは設定不備・token 不正など起動時失敗のみ。念のため token をマスクして出す
  const secrets = [process.env.TELEGRAM_BOT_TOKEN ?? '', process.env.HUB_AUTH_TOKEN ?? '']
  console.error(`fatal: ${redactSecrets(errorMessage(err), secrets)}`)
  process.exit(1)
})
