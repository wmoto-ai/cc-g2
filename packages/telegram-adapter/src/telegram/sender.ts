// 送信系の薄いインターフェース。フロー層を grammY から切り離し、テストではスタブを注入する。
// 本番実装は grammY の bot.api を包む(auto-retry transformer は bot 側に装着済みの前提)。
import { InputFile, type Api } from 'grammy'
import type { ForceReply, InlineKeyboardMarkup } from 'grammy/types'

export interface SendMessageOptions {
  replyMarkup?: InlineKeyboardMarkup | ForceReply
  replyToMessageId?: number
  /** プッシュ通知なしで投稿する(ステータスメッセージ等の非通知系) */
  disableNotification?: boolean
}

export interface TelegramSender {
  sendMessage(
    chatId: number,
    html: string,
    options?: SendMessageOptions,
  ): Promise<{ messageId: number }>
  /** reply_markup を渡さずに本文を差し替える = inline keyboard の除去を兼ねる */
  editMessageText(chatId: number, messageId: number, html: string): Promise<void>
  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert?: boolean): Promise<void>
  sendPhoto(
    chatId: number,
    image: { data: Buffer; filename: string },
    caption?: string,
  ): Promise<{ messageId: number }>
  /** メッセージをピン留めする(通知なし)。ステータスメッセージ用 */
  pinChatMessage(chatId: number, messageId: number): Promise<void>
}

export function createGrammySender(api: Api): TelegramSender {
  return {
    async sendMessage(chatId, html, options = {}) {
      const message = await api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: options.replyMarkup,
        reply_parameters:
          options.replyToMessageId !== undefined
            ? { message_id: options.replyToMessageId }
            : undefined,
        disable_notification: options.disableNotification,
      })
      return { messageId: message.message_id }
    },
    async editMessageText(chatId, messageId, html) {
      await api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' })
    },
    async answerCallbackQuery(callbackQueryId, text, showAlert) {
      await api.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert })
    },
    async sendPhoto(chatId, image, caption) {
      const message = await api.sendPhoto(chatId, new InputFile(image.data, image.filename), {
        caption,
      })
      return { messageId: message.message_id }
    },
    async pinChatMessage(chatId, messageId) {
      await api.pinChatMessage(chatId, messageId, { disable_notification: true })
    },
  }
}
