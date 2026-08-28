// grammY の transformer で outgoing API 呼び出しを記録し canned response を返すスタブ。
// incoming は makeCallbackUpdate / makeTextUpdate で Update を組み bot.handleUpdate に流す。
import type { Bot } from 'grammy'
import type { Update, UserFromGetMe } from 'grammy/types'

export const BOT_INFO: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: 'fixture-bot',
  username: 'fixture_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

export interface ApiCall {
  method: string
  payload: Record<string, unknown>
}

export interface StubFile {
  /** getFile が返す file_path。download はこのパスで突合する */
  filePath: string
  bytes: Buffer
  /** getFile が申告する file_size(省略時は bytes.length) */
  fileSize?: number
}

export class TelegramStub {
  readonly calls: ApiCall[] = []
  /** downloadFile が叩いた URL の記録(呼ばれていないことの検証用) */
  readonly fileDownloadUrls: string[] = []
  private readonly files = new Map<string, StubFile>()
  private messageSeq = 1_000
  private updateSeq = 1

  /** file_id に対する getFile 応答とダウンロード内容を登録する */
  setFile(fileId: string, file: StubFile): void {
    this.files.set(fileId, file)
  }

  /** createGrammySender の fetchFn に注入する file download スタブ */
  readonly fetchFile: typeof fetch = async (input) => {
    const url = String(input)
    this.fileDownloadUrls.push(url)
    const match = url.match(/\/file\/bot[^/]+\/(.+)$/)
    const file = match
      ? [...this.files.values()].find((f) => f.filePath === match[1])
      : undefined
    if (!file) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(file.bytes))
  }

  install(bot: Bot): void {
    bot.api.config.use(async (_prev, method, payload) => {
      this.calls.push({ method, payload: payload as Record<string, unknown> })
      return {
        ok: true,
        result: this.resultFor(method, payload as Record<string, unknown>),
      } as Awaited<ReturnType<typeof _prev>>
    })
  }

  private resultFor(method: string, payload: Record<string, unknown>): unknown {
    if (method === 'sendMessage' || method === 'sendPhoto') {
      this.messageSeq += 1
      return {
        message_id: this.messageSeq,
        date: 0,
        chat: { id: payload.chat_id, type: 'private' },
        text: typeof payload.text === 'string' ? payload.text : '',
      }
    }
    if (method === 'getMe') return BOT_INFO
    if (method === 'getFile') {
      const fileId = String(payload.file_id)
      const file = this.files.get(fileId)
      return {
        file_id: fileId,
        file_unique_id: `${fileId}-uniq`,
        file_size: file ? (file.fileSize ?? file.bytes.length) : undefined,
        file_path: file?.filePath,
      }
    }
    return true
  }

  callsOf(method: string): ApiCall[] {
    return this.calls.filter((call) => call.method === method)
  }

  /** 直近に送信された message_id(sendMessage/sendPhoto の canned 応答) */
  lastMessageId(): number {
    return this.messageSeq
  }

  makeCallbackUpdate(options: {
    fromId: number
    chatId: number
    messageId: number
    data: string
  }): Update {
    this.updateSeq += 1
    return {
      update_id: this.updateSeq,
      callback_query: {
        id: `cb-${this.updateSeq}`,
        from: { id: options.fromId, is_bot: false, first_name: 'user' },
        chat_instance: 'ci',
        message: {
          message_id: options.messageId,
          date: 0,
          chat: { id: options.chatId, type: 'private', first_name: 'user' },
          from: BOT_INFO,
          text: 'approval message',
        },
        data: options.data,
      },
    } as unknown as Update
  }

  makeTextUpdate(options: {
    fromId: number
    chatId: number
    text: string
    replyTo?: number
  }): Update {
    this.updateSeq += 1
    return {
      update_id: this.updateSeq,
      message: {
        message_id: 100_000 + this.updateSeq,
        date: 0,
        chat: { id: options.chatId, type: 'private', first_name: 'user' },
        from: { id: options.fromId, is_bot: false, first_name: 'user' },
        text: options.text,
        reply_to_message: this.replyToStub(options.chatId, options.replyTo),
      },
    } as unknown as Update
  }

  makePhotoUpdate(options: {
    fromId: number
    chatId: number
    fileId: string
    fileSize?: number
    caption?: string
    replyTo?: number
  }): Update {
    this.updateSeq += 1
    return {
      update_id: this.updateSeq,
      message: {
        message_id: 100_000 + this.updateSeq,
        date: 0,
        chat: { id: options.chatId, type: 'private', first_name: 'user' },
        from: { id: options.fromId, is_bot: false, first_name: 'user' },
        // Bot API 実物と同じ昇順サイズ配列(末尾が最大解像度)
        photo: [
          {
            file_id: `${options.fileId}-thumb`,
            file_unique_id: `${options.fileId}-thumb-uniq`,
            width: 90,
            height: 60,
            file_size: 1_000,
          },
          {
            file_id: options.fileId,
            file_unique_id: `${options.fileId}-uniq`,
            width: 1_280,
            height: 960,
            file_size: options.fileSize,
          },
        ],
        caption: options.caption,
        reply_to_message: this.replyToStub(options.chatId, options.replyTo),
      },
    } as unknown as Update
  }

  makeDocumentUpdate(options: {
    fromId: number
    chatId: number
    fileId: string
    mimeType?: string
    fileName?: string
    fileSize?: number
    caption?: string
    replyTo?: number
  }): Update {
    this.updateSeq += 1
    return {
      update_id: this.updateSeq,
      message: {
        message_id: 100_000 + this.updateSeq,
        date: 0,
        chat: { id: options.chatId, type: 'private', first_name: 'user' },
        from: { id: options.fromId, is_bot: false, first_name: 'user' },
        document: {
          file_id: options.fileId,
          file_unique_id: `${options.fileId}-uniq`,
          file_name: options.fileName,
          mime_type: options.mimeType,
          file_size: options.fileSize,
        },
        caption: options.caption,
        reply_to_message: this.replyToStub(options.chatId, options.replyTo),
      },
    } as unknown as Update
  }

  makeVoiceUpdate(options: {
    fromId: number
    chatId: number
    fileId: string
    mimeType?: string
    fileSize?: number
    caption?: string
    replyTo?: number
  }): Update {
    this.updateSeq += 1
    return {
      update_id: this.updateSeq,
      message: {
        message_id: 100_000 + this.updateSeq,
        date: 0,
        chat: { id: options.chatId, type: 'private', first_name: 'user' },
        from: { id: options.fromId, is_bot: false, first_name: 'user' },
        voice: {
          file_id: options.fileId,
          file_unique_id: `${options.fileId}-uniq`,
          duration: 3,
          mime_type: options.mimeType ?? 'audio/ogg',
          file_size: options.fileSize,
        },
        caption: options.caption,
        reply_to_message: this.replyToStub(options.chatId, options.replyTo),
      },
    } as unknown as Update
  }

  makeAudioUpdate(options: {
    fromId: number
    chatId: number
    fileId: string
    mimeType?: string
    fileName?: string
    fileSize?: number
    caption?: string
    replyTo?: number
  }): Update {
    this.updateSeq += 1
    return {
      update_id: this.updateSeq,
      message: {
        message_id: 100_000 + this.updateSeq,
        date: 0,
        chat: { id: options.chatId, type: 'private', first_name: 'user' },
        from: { id: options.fromId, is_bot: false, first_name: 'user' },
        audio: {
          file_id: options.fileId,
          file_unique_id: `${options.fileId}-uniq`,
          duration: 60,
          file_name: options.fileName,
          mime_type: options.mimeType,
          file_size: options.fileSize,
        },
        caption: options.caption,
        reply_to_message: this.replyToStub(options.chatId, options.replyTo),
      },
    } as unknown as Update
  }

  makeVideoUpdate(options: {
    fromId: number
    chatId: number
    fileId: string
    mimeType?: string
    fileName?: string
    fileSize?: number
    caption?: string
    replyTo?: number
  }): Update {
    this.updateSeq += 1
    return {
      update_id: this.updateSeq,
      message: {
        message_id: 100_000 + this.updateSeq,
        date: 0,
        chat: { id: options.chatId, type: 'private', first_name: 'user' },
        from: { id: options.fromId, is_bot: false, first_name: 'user' },
        video: {
          file_id: options.fileId,
          file_unique_id: `${options.fileId}-uniq`,
          width: 1_280,
          height: 720,
          duration: 10,
          file_name: options.fileName,
          mime_type: options.mimeType,
          file_size: options.fileSize,
        },
        caption: options.caption,
        reply_to_message: this.replyToStub(options.chatId, options.replyTo),
      },
    } as unknown as Update
  }

  makeVideoNoteUpdate(options: {
    fromId: number
    chatId: number
    fileId: string
    fileSize?: number
    replyTo?: number
  }): Update {
    this.updateSeq += 1
    return {
      update_id: this.updateSeq,
      message: {
        message_id: 100_000 + this.updateSeq,
        date: 0,
        chat: { id: options.chatId, type: 'private', first_name: 'user' },
        from: { id: options.fromId, is_bot: false, first_name: 'user' },
        video_note: {
          file_id: options.fileId,
          file_unique_id: `${options.fileId}-uniq`,
          length: 240,
          duration: 5,
          file_size: options.fileSize,
        },
        reply_to_message: this.replyToStub(options.chatId, options.replyTo),
      },
    } as unknown as Update
  }

  private replyToStub(chatId: number, replyTo?: number): unknown {
    if (replyTo === undefined) return undefined
    return {
      message_id: replyTo,
      date: 0,
      chat: { id: chatId, type: 'private', first_name: 'user' },
      from: BOT_INFO,
      text: '',
    }
  }
}
