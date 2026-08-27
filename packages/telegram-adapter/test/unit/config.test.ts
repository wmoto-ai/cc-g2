import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config'

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '123456:ABC-def',
  TELEGRAM_ALLOWED_USER_IDS: '111,222',
}

describe('loadConfig', () => {
  it('最小構成で既定値が入る', () => {
    const config = loadConfig({ ...baseEnv })
    expect(config.telegramBotToken).toBe('123456:ABC-def')
    expect([...config.allowedUserIds]).toEqual([111, 222])
    expect(config.chatId).toBe(111) // allowlist 先頭
    expect(config.hubBaseUrl).toBe('http://127.0.0.1:8787')
    expect(config.hubAuthToken).toBe('')
    expect(config.reconcileIntervalMs).toBe(30_000)
    expect(config.approvalStaleMs).toBe(600_000)
    expect(config.approvalPostCutoffMs).toBe(540_000)
    expect(config.logLevel).toBe('info')
  })

  it('TELEGRAM_CHAT_ID を明示すると優先される', () => {
    const config = loadConfig({ ...baseEnv, TELEGRAM_CHAT_ID: '999' })
    expect(config.chatId).toBe(999)
  })

  it('bot token 必須', () => {
    expect(() => loadConfig({ TELEGRAM_ALLOWED_USER_IDS: '1' })).toThrow(ConfigError)
  })

  it('allowlist 空は起動拒否(fail-closed)', () => {
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: ' , ' })).toThrow(
      /ALLOWED_USER_IDS/,
    )
  })

  it('allowlist に数値でない id があれば拒否', () => {
    expect(() => loadConfig({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: '111,abc' })).toThrow(ConfigError)
  })

  it('HUB_BASE_URL の末尾スラッシュは除去される', () => {
    const config = loadConfig({ ...baseEnv, HUB_BASE_URL: 'http://localhost:8788/' })
    expect(config.hubBaseUrl).toBe('http://localhost:8788')
  })

  it('不正な HUB_BASE_URL は拒否', () => {
    expect(() => loadConfig({ ...baseEnv, HUB_BASE_URL: 'not a url' })).toThrow(ConfigError)
    expect(() => loadConfig({ ...baseEnv, HUB_BASE_URL: 'ftp://x' })).toThrow(ConfigError)
  })

  it('POST_CUTOFF > STALE は矛盾として拒否', () => {
    expect(() =>
      loadConfig({ ...baseEnv, APPROVAL_STALE_MS: '10000', APPROVAL_POST_CUTOFF_MS: '20000' }),
    ).toThrow(/POST_CUTOFF/)
  })

  it('DECIDE_MARGIN は既定 30s、STALE 以上は拒否', () => {
    expect(loadConfig({ ...baseEnv }).approvalDecideMarginMs).toBe(30_000)
    expect(
      loadConfig({ ...baseEnv, APPROVAL_DECIDE_MARGIN_MS: '5000' }).approvalDecideMarginMs,
    ).toBe(5_000)
    expect(() =>
      loadConfig({
        ...baseEnv,
        APPROVAL_STALE_MS: '10000',
        APPROVAL_POST_CUTOFF_MS: '10000',
        APPROVAL_DECIDE_MARGIN_MS: '10000',
      }),
    ).toThrow(/DECIDE_MARGIN/)
  })

  it('不正な LOG_LEVEL は拒否', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(ConfigError)
  })

  it('数値 env の不正値は名前入りで拒否', () => {
    expect(() => loadConfig({ ...baseEnv, RECONCILE_INTERVAL_MS: 'abc' })).toThrow(
      /RECONCILE_INTERVAL_MS/,
    )
  })
})
