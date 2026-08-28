// grammY bot の組み立てとハンドラ登録。accessControl(fail-closed)を最前段に置く。
import { Bot } from 'grammy'
import { autoRetry } from '@grammyjs/auto-retry'
import type { UserFromGetMe } from 'grammy/types'
import type { ApprovalFlow } from '../core/approval-flow'
import type { IncomingMedia, MediaFlow } from '../core/media-flow'
import type { NotifyFlow } from '../core/notify-flow'
import type { StateStore } from '../core/state'
import type { Logger } from '../logger'
import { errorMessage } from '../logger'
import { accessControl } from './allowlist'
import { decodeCallback } from './callback-data'
import type { CommentPromptStore } from './comment-prompt'
import type { TelegramSender } from './sender'

/** photo / document / voice / audio に共通する取得用フィールド */
interface FileSource {
  file_id: string
  file_unique_id: string
  file_size?: number
  mime_type?: string
  file_name?: string
}

export function createBot(token: string, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(token, botInfo ? { botInfo } : undefined)
  // 429(retry_after)・一時エラーの自動リトライは transformer に委譲(plan §6)
  bot.api.config.use(autoRetry())
  return bot
}

export interface BotDeps {
  allowedUserIds: Set<number>
  chatId: number
  logger: Logger
  approvalFlow: ApprovalFlow
  notifyFlow: NotifyFlow
  mediaFlow: MediaFlow
  prompts: CommentPromptStore
  state: StateStore
  sender: TelegramSender
}

export function registerHandlers(bot: Bot, deps: BotDeps): void {
  bot.use(
    accessControl({
      allowedUserIds: deps.allowedUserIds,
      chatId: deps.chatId,
      logger: deps.logger,
    }),
  )

  bot.on('callback_query:data', async (ctx) => {
    const decoded = decodeCallback(ctx.callbackQuery.data)
    if (!decoded) {
      await ctx.answerCallbackQuery({ text: '不明な操作です' }).catch(() => {})
      return
    }
    if (decoded.action === 'comment') {
      await deps.approvalFlow.startCommentPrompt({
        approvalId: decoded.approvalId,
        callbackQueryId: ctx.callbackQuery.id,
        replyToMessageId: ctx.callbackQuery.message?.message_id,
      })
      return
    }
    await deps.approvalFlow.handleCallback({
      approvalId: decoded.approvalId,
      action: decoded.action,
      callbackQueryId: ctx.callbackQuery.id,
    })
  })

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const text = ctx.message.text
    const repliedTo = ctx.message.reply_to_message?.message_id
    const notify = async (html: string): Promise<void> => {
      await deps.sender.sendMessage(chatId, html, { replyToMessageId: messageId })
    }

    if (repliedTo !== undefined) {
      // 1) コメントプロンプト(ForceReply)への返信
      const promptApprovalId = deps.prompts.take(chatId, repliedTo)
      if (promptApprovalId) {
        await deps.approvalFlow.handleCommentDeny(promptApprovalId, text, notify)
        return
      }
      // 2) 承認メッセージ本体への直接返信 = コメント付き Deny
      const approvalId = deps.state.findApprovalByMessage(chatId, repliedTo)
      if (approvalId) {
        await deps.approvalFlow.handleCommentDeny(approvalId, text, notify)
        return
      }
      // 3) Stop 通知への返信 = セッションへの中継
      const handled = await deps.notifyFlow.handleStopReply(chatId, repliedTo, text, notify)
      if (handled) return
      await notify('返信先を特定できませんでした(追跡外の古いメッセージの可能性)')
      return
    }

    // reply を付けられないクライアント(ERGram 等の Even Hub ミニアプリ)向けフォールバック:
    // 平文は「最新の Stop 通知への返信」とみなしてセッションへ中継する。
    // 承認の決裁は inline keyboard(callback)経路のみ — テキストから decide は行わない。
    //    (TTL 超過は handleStopReply 内の resolve が弾き false で戻る)
    const latestStop = deps.state.findLatestStopMessage(chatId)
    if (latestStop) {
      const handled = await deps.notifyFlow.handleStopReply(chatId, latestStop.messageId, text, notify)
      if (handled) return
    }

    // Phase 1 は承認/通知への応答のみ。自由会話(秘書)は Phase 2
    await notify('Phase 1 では承認ボタン、承認・Stop 通知への返信のみ対応しています')
  })

  // 受信ファイル(photo / voice / audio / video / video_note / 対応 MIME の document)
  // → inbox 保存 + reply relay でパス注入
  bot.on(
    ['message:photo', 'message:document', 'message:voice', 'message:audio', 'message:video', 'message:video_note'],
    async (ctx) => {
      const message = ctx.message
      const notify = async (html: string): Promise<void> => {
        await deps.sender.sendMessage(ctx.chat.id, html, { replyToMessageId: message.message_id })
      }
      // photo は昇順サイズ配列なので末尾が最大解像度
      const photo = message.photo?.at(-1)
      const source: { kind: IncomingMedia['kind']; file: FileSource } | null = photo
        ? { kind: 'photo', file: photo }
        : message.document
          ? { kind: 'document', file: message.document }
          : message.voice
            ? { kind: 'voice', file: message.voice }
            : message.audio
              ? { kind: 'audio', file: message.audio }
              : message.video
                ? { kind: 'video', file: message.video }
                : message.video_note
                  ? { kind: 'video_note', file: message.video_note }
                  : null
      if (!source) return
      await deps.mediaFlow.handleIncomingMedia({
        chatId: ctx.chat.id,
        repliedMessageId: message.reply_to_message?.message_id,
        media: {
          kind: source.kind,
          fileId: source.file.file_id,
          fileUniqueId: source.file.file_unique_id,
          fileSize: source.file.file_size,
          mimeType: source.file.mime_type,
          fileName: source.file.file_name,
          caption: message.caption,
        },
        notify,
      })
    },
  )

  bot.catch((err) => {
    deps.logger.error(`bot error: ${errorMessage(err.error)}`)
  })
}
