// GramJS の import より前に Buffer を差し替える(MUST be first — src/buffer-global.ts 参照)
import '../../buffer-global'
import { Api, TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { NewMessage, type NewMessageEvent } from 'telegram/events'
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage'
import { log } from '../../log'
import type { TgMessageLike } from './model'

/**
 * GramJS userbot の薄いラッパー(ERGram src/telegram/client.ts を参照実装として移植)。
 * - useWSS: true はブラウザ/WebView 必須(生 TCP 不可)
 * - クライアントは使い捨て: ログイン/ログアウトのたびに作り直す(ERGram 落とし穴 §8)
 * - inline ボタン押下(GetBotCallbackAnswer)は ERGram に無い cc-g2 独自分
 */

export interface LoginPrompts {
  phoneNumber: () => Promise<string>
  phoneCode: () => Promise<string>
  password: () => Promise<string>
  onError: (e: unknown) => void
}

/** Api.Message から TgMessageLike へ正規化 */
function normalizeMessage(m: Api.Message): TgMessageLike {
  const buttonData: string[] = []
  const markup = m.replyMarkup
  if (markup instanceof Api.ReplyInlineMarkup) {
    for (const row of markup.rows) {
      for (const button of row.buttons) {
        if (button instanceof Api.KeyboardButtonCallback && button.data) {
          buttonData.push(new TextDecoder().decode(button.data))
        }
      }
    }
  }
  return {
    id: m.id,
    dateSec: m.date ?? 0,
    text: m.message ?? '',
    out: m.out === true,
    hasPhoto: m.photo != null,
    buttonData,
  }
}

export class TgClient {
  private client: TelegramClient
  /** click / downloadMedia 用に生 Message を保持(直近 200 件) */
  private rawMessages = new Map<number, Api.Message>()

  constructor(apiId: number, apiHash: string, session: string) {
    this.client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 3,
      useWSS: true,
    })
  }

  /** 保存済みセッションで再接続。未認可なら false(ログインウィザードへ) */
  async resume(): Promise<boolean> {
    await this.client.connect()
    return this.client.isUserAuthorized()
  }

  /** 対話ログイン(GramJS client.start に丸投げ。2FA 無効なら password は呼ばれない) */
  async login(apiId: number, apiHash: string, prompts: LoginPrompts): Promise<void> {
    void apiId
    void apiHash
    log('TgClient: client.start() 開始(Telegram DC へ WSS 接続 → コード送信)')
    await this.client.start({
      phoneNumber: async () => {
        const phone = await prompts.phoneNumber()
        log(`TgClient: 電話番号送信(${phone.slice(0, 4)}…)`)
        return phone
      },
      phoneCode: async () => {
        log('TgClient: コード送信済み — 入力待ち')
        return prompts.phoneCode()
      },
      password: async () => {
        log('TgClient: 2FA パスワード要求')
        return prompts.password()
      },
      onError: async (e) => {
        log(`TgClient: ログインエラー: ${String(e)}`)
        prompts.onError(e)
        return false
      },
    })
    log('TgClient: ログイン完了')
  }

  saveSession(): string {
    return this.client.session.save() as unknown as string
  }

  /** サーバー側失効 + 切断。失敗しても呼び出し元はローカル session を必ず消すこと */
  async revokeSession(): Promise<void> {
    try {
      await this.client.connect()
      await this.client.invoke(new Api.auth.LogOut())
    } finally {
      try {
        await this.client.disconnect()
      } catch {
        // logOut がキーを無効化済みの場合がある
      }
    }
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect()
  }

  /** WSS が生きているか(Wi-Fi⇔LTE 切替で黙って死ぬため watchdog から確認する) */
  isConnected(): boolean {
    return this.client.connected === true
  }

  /** 再接続(connect は冪等。addEventHandler の購読は client に紐づくため再登録不要) */
  async reconnect(): Promise<void> {
    await this.client.connect()
  }

  private cacheRaw(m: Api.Message): void {
    this.rawMessages.set(m.id, m)
    if (this.rawMessages.size > 200) {
      const first = this.rawMessages.keys().next().value
      if (first != null) this.rawMessages.delete(first)
    }
  }

  /** 対象チャットの直近メッセージ(古い→新しい順) */
  async getRecentMessages(chat: string, limit: number): Promise<TgMessageLike[]> {
    const raw = await this.client.getMessages(chat, { limit })
    const result: TgMessageLike[] = []
    for (const m of [...raw].reverse()) {
      if (!(m instanceof Api.Message)) continue
      this.cacheRaw(m)
      result.push(normalizeMessage(m))
    }
    return result
  }

  /**
   * 対象チャットのピン留めメッセージ群(新しい順)。
   * ステータスメッセージは古参 id のまま edit され続けるため履歴 N 件に入らないことがあり、
   * 初期表示はピンから直接取得する(以後の更新は EditedMessage 購読で届く)。
   * Telegram はピンを複数持てるため、ユーザーが別メッセージをピンしても
   * ステータスを見つけられるよう複数件返す(選別は呼び出し側のマーカー分類)。
   */
  async getPinnedMessages(chat: string, limit = 10): Promise<TgMessageLike[]> {
    const raw = await this.client.getMessages(chat, {
      filter: new Api.InputMessagesFilterPinned(),
      limit,
    })
    const result: TgMessageLike[] = []
    for (const m of raw) {
      if (!(m instanceof Api.Message)) continue
      this.cacheRaw(m)
      result.push(normalizeMessage(m))
    }
    return result
  }

  /**
   * 対象チャットの新着・編集メッセージを購読する。戻り値は購読解除関数。
   * GramJS 側フィルタは使わず、呼び出し側チャット照合(ERGram と同方式)…ではなく
   * chats フィルタが効くため二重で絞る(取りこぼしより誤配信の方が害が大きい)。
   */
  subscribe(chat: string, onMessage: (m: TgMessageLike, edited: boolean) => void): () => void {
    // 対象チャットの entity id は購読開始時に 1 回だけ解決してキャッシュする
    let targetId: string | null = null
    const targetIdPromise = this.client
      .getEntity(chat)
      .then((entity) => {
        targetId = (entity as { id?: { toString(): string } }).id?.toString() ?? null
      })
      .catch((err) => {
        log(`telegram subscribe: chat entity 解決失敗: ${String(err)}`)
      })
    const matchChat = async (msg: Api.Message): Promise<boolean> => {
      if (targetId == null) await targetIdPromise
      const chatId = (msg.chatId as { toString(): string } | undefined)?.toString()
      return targetId != null && chatId != null && chatId === targetId
    }
    const newHandler = async (event: NewMessageEvent) => {
      const m = event.message
      if (!(m instanceof Api.Message) || !(await matchChat(m))) return
      this.cacheRaw(m)
      onMessage(normalizeMessage(m), false)
    }
    const editedHandler = async (event: EditedMessageEvent) => {
      const m = event.message
      if (!(m instanceof Api.Message) || !(await matchChat(m))) return
      this.cacheRaw(m)
      onMessage(normalizeMessage(m), true)
    }
    const newBuilder = new NewMessage({})
    const editedBuilder = new EditedMessage({})
    this.client.addEventHandler(newHandler, newBuilder)
    this.client.addEventHandler(editedHandler, editedBuilder)
    return () => {
      this.client.removeEventHandler(newHandler, newBuilder)
      this.client.removeEventHandler(editedHandler, editedBuilder)
    }
  }

  /**
   * inline ボタンを押す(bot への callback 送信)。
   * dataPrefix に一致する callback_data を持つ最初のボタンを押し、
   * bot の answerCallbackQuery 文言を返す(無ければ null)。
   */
  async clickButton(chat: string, messageId: number, dataPrefix: string): Promise<string | null> {
    const raw = this.rawMessages.get(messageId)
    if (!raw) throw new Error(`message ${messageId} is not cached`)
    const markup = raw.replyMarkup
    if (!(markup instanceof Api.ReplyInlineMarkup)) throw new Error('message has no inline keyboard')
    for (const row of markup.rows) {
      for (const button of row.buttons) {
        if (button instanceof Api.KeyboardButtonCallback && button.data) {
          const data = new TextDecoder().decode(button.data)
          if (data.startsWith(dataPrefix)) {
            const answer = await this.client.invoke(
              new Api.messages.GetBotCallbackAnswer({
                peer: await this.client.getInputEntity(chat),
                msgId: messageId,
                data: button.data,
              }),
            )
            log(`telegram click: msg=${messageId} data=${dataPrefix}… → ${answer.message ?? '(no message)'}`)
            return answer.message ?? null
          }
        }
      }
    }
    throw new Error(`no button matching ${dataPrefix} on message ${messageId}`)
  }

  /** photo メッセージの画像をダウンロードして Blob で返す */
  async downloadPhoto(messageId: number): Promise<Blob> {
    const raw = this.rawMessages.get(messageId)
    if (!raw) throw new Error(`message ${messageId} is not cached`)
    const data = await this.client.downloadMedia(raw)
    if (!data) throw new Error('downloadMedia returned empty')
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
    return new Blob([bytes], { type: 'image/jpeg' })
  }

  /** reply_to 付きテキスト送信 */
  async sendReply(chat: string, text: string, replyToMessageId?: number): Promise<number> {
    const sent = await this.client.sendMessage(chat, {
      message: text,
      ...(replyToMessageId != null ? { replyTo: replyToMessageId } : {}),
    })
    return sent.id
  }
}
