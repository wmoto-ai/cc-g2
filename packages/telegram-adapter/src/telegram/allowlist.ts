// fail-closed アクセス制御(plan §5.6)。
// (1) from.id が allowlist に含まれ、かつ (2) chat.id が設定 chat と一致する update のみ通す。
// 不許可は無応答で破棄(bot の存在を教えない)+ warn ログ。
import type { Context, MiddlewareFn } from 'grammy'
import type { Logger } from '../logger'

export interface AccessControlOptions {
  allowedUserIds: Set<number>
  chatId: number
  logger: Logger
}

export function accessControl(options: AccessControlOptions): MiddlewareFn<Context> {
  const { allowedUserIds, chatId, logger } = options
  return async (ctx, next) => {
    const fromId = ctx.from?.id
    if (fromId === undefined || !allowedUserIds.has(fromId)) {
      logger.warn(`access denied (user): from=${fromId ?? 'unknown'} update=${ctx.update.update_id}`)
      return
    }
    // inline 由来の callback など chat が取れない update も拒否(fail-closed)
    const updateChatId = ctx.chat?.id
    if (updateChatId !== chatId) {
      logger.warn(
        `access denied (chat): chat=${updateChatId ?? 'none'} expected=${chatId} from=${fromId}`,
      )
      return
    }
    await next()
  }
}
