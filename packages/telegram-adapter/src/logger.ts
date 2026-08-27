// 構造化ログ。secret 値と Telegram Bot API URL 中の token を出力前に必ず redact する。
import type { LogLevel } from './config'

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * secret 値の直接出現と `bot<token>` URL パターンをマスクする。
 * grammY のエラーメッセージは API URL(/bot<token>/method)を含むことがあるため
 * パターンマスクは secret リストと独立に常時かける。
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[REDACTED]')
  }
  return out.replace(/bot\d+:[\w-]+/g, 'bot[REDACTED]')
}

export function createLogger(
  level: LogLevel,
  secrets: readonly string[] = [],
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const threshold = LEVEL_ORDER[level]
  const log = (msgLevel: LogLevel, message: string): void => {
    if (LEVEL_ORDER[msgLevel] < threshold) return
    const line = `${now().toISOString()} [${msgLevel}] ${redactSecrets(message, secrets)}`
    write(line)
  }
  return {
    debug: (m) => log('debug', m),
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
    error: (m) => log('error', m),
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
