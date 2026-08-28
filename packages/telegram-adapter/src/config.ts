// 環境変数の読込と検証。不正な設定は起動時に ConfigError で fail-fast する。
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Config {
  telegramBotToken: string
  /** 承認・返信を受け付ける user id(message.from.id / callback_query.from.id) */
  allowedUserIds: Set<number>
  /** 通知の投稿先 chat。この chat 以外からの update は fail-closed で無視する */
  chatId: number
  hubBaseUrl: string
  hubAuthToken: string
  reconcileIntervalMs: number
  /** 既投稿 pending のボタン無効化閾値(Hub hook の HOOK_POLL_TIMEOUT_MS と一致させる) */
  approvalStaleMs: number
  /** 新規投稿の打ち切り閾値。staleMs より短くして境界レースを避ける */
  approvalPostCutoffMs: number
  /**
   * decide 操作の安全マージン。hook の decide 監視は 2 秒間隔ポーリングのため、
   * staleMs ちょうどまで受け付けると「Hub は decided だが hook は観測前にタイムアウト」の
   * 境界レースが残る。ガードは staleMs - このマージン で遮断する
   */
  approvalDecideMarginMs: number
  dataDir: string
  /** 受信ファイルの保存先(既定 <dataDir>/inbox。本番は start-prod.sh が ~/.local/share/cc-tg-adapter/inbox を指定) */
  inboxDir: string
  /** 受信ファイルのサイズ上限。Bot API getFile 自体の上限が 20MB のためそれ以下で運用する */
  inboxMaxBytes: number
  /** Stop 通知への返信を受け付ける期限。超過した返信先は「追跡外」として扱う */
  stopReplyTtlMs: number
  /** ピン留めステータスメッセージの更新間隔。0 で無効化 */
  statusIntervalMs: number
  logLevel: LogLevel
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

function parseIntVar(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = (env[name] ?? '').trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`)
  }
  return value
}

function parseUserId(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(`${name} contains an invalid id: ${JSON.stringify(raw)}`)
  }
  return value
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const telegramBotToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim()
  if (!telegramBotToken) throw new ConfigError('TELEGRAM_BOT_TOKEN is required')

  const idsRaw = (env.TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (idsRaw.length === 0) {
    throw new ConfigError('TELEGRAM_ALLOWED_USER_IDS must contain at least one user id (fail-closed)')
  }
  const allowedUserIds = new Set(idsRaw.map((s) => parseUserId(s, 'TELEGRAM_ALLOWED_USER_IDS')))

  const chatIdRaw = (env.TELEGRAM_CHAT_ID ?? '').trim()
  const chatId = chatIdRaw ? parseUserId(chatIdRaw, 'TELEGRAM_CHAT_ID') : idsRaw.map((s) => parseUserId(s, 'TELEGRAM_ALLOWED_USER_IDS'))[0]!

  const hubBaseUrlRaw = (env.HUB_BASE_URL ?? 'http://127.0.0.1:8787').trim()
  let hubBaseUrl: string
  try {
    const url = new URL(hubBaseUrlRaw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
    hubBaseUrl = hubBaseUrlRaw.replace(/\/+$/, '')
  } catch {
    throw new ConfigError(`HUB_BASE_URL is not a valid http(s) URL: ${JSON.stringify(hubBaseUrlRaw)}`)
  }

  const approvalStaleMs = parseIntVar(env, 'APPROVAL_STALE_MS', 600_000, 1_000)
  const approvalPostCutoffMs = parseIntVar(env, 'APPROVAL_POST_CUTOFF_MS', 540_000, 1_000)
  if (approvalPostCutoffMs > approvalStaleMs) {
    throw new ConfigError(
      `APPROVAL_POST_CUTOFF_MS (${approvalPostCutoffMs}) must be <= APPROVAL_STALE_MS (${approvalStaleMs})`,
    )
  }
  const approvalDecideMarginMs = parseIntVar(env, 'APPROVAL_DECIDE_MARGIN_MS', 30_000, 0)
  if (approvalDecideMarginMs >= approvalStaleMs) {
    throw new ConfigError(
      `APPROVAL_DECIDE_MARGIN_MS (${approvalDecideMarginMs}) must be < APPROVAL_STALE_MS (${approvalStaleMs})`,
    )
  }

  const dataDir = (env.DATA_DIR ?? './data').trim() || './data'

  // 0 = 無効。有効時は Bot API レート制限(同一メッセージ編集)に配慮して 10 秒以上
  const statusIntervalMs = parseIntVar(env, 'STATUS_INTERVAL_MS', 30_000, 0)
  if (statusIntervalMs !== 0 && statusIntervalMs < 10_000) {
    throw new ConfigError(`STATUS_INTERVAL_MS must be 0 (disabled) or >= 10000 (got ${statusIntervalMs})`)
  }

  const logLevel = ((env.LOG_LEVEL ?? 'info').trim() || 'info') as LogLevel
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`)
  }

  return {
    telegramBotToken,
    allowedUserIds,
    chatId,
    hubBaseUrl,
    hubAuthToken: (env.HUB_AUTH_TOKEN ?? '').trim(),
    reconcileIntervalMs: parseIntVar(env, 'RECONCILE_INTERVAL_MS', 30_000, 1_000),
    approvalStaleMs,
    approvalPostCutoffMs,
    approvalDecideMarginMs,
    dataDir,
    inboxDir: (env.INBOX_DIR ?? '').trim() || `${dataDir.replace(/\/+$/, '')}/inbox`,
    inboxMaxBytes: parseIntVar(env, 'INBOX_MAX_BYTES', 10 * 1024 * 1024, 1),
    stopReplyTtlMs: parseIntVar(env, 'STOP_REPLY_TTL_MS', 24 * 60 * 60 * 1000, 1_000),
    statusIntervalMs,
    logLevel,
  }
}
