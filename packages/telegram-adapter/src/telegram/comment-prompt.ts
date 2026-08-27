// コメント付き Deny の ForceReply プロンプト管理。
// message_id は chat 単位でしか一意でないため、キーは常に `chatId:messageId` の複合。
// in-memory のみ(再起動で失われるが、承認メッセージ本体への直接返信経路が残るため許容)。
export class CommentPromptStore {
  private readonly prompts = new Map<string, { approvalId: string; expiresAt: number }>()

  constructor(
    private readonly ttlMs = 600_000,
    private readonly now: () => number = Date.now,
  ) {}

  private key(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`
  }

  register(chatId: number, messageId: number, approvalId: string): void {
    this.prune()
    this.prompts.set(this.key(chatId, messageId), {
      approvalId,
      expiresAt: this.now() + this.ttlMs,
    })
  }

  /** 該当プロンプトがあれば approvalId を返して消費する。TTL 失効分は null */
  take(chatId: number, messageId: number): string | null {
    const key = this.key(chatId, messageId)
    const entry = this.prompts.get(key)
    if (!entry) return null
    this.prompts.delete(key)
    return entry.expiresAt > this.now() ? entry.approvalId : null
  }

  prune(): void {
    const nowMs = this.now()
    for (const [key, entry] of this.prompts) {
      if (entry.expiresAt <= nowMs) this.prompts.delete(key)
    }
  }

  size(): number {
    return this.prompts.size
  }
}
