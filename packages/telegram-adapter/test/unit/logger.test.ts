import { describe, expect, it } from 'vitest'
import { createLogger, redactSecrets } from '../../src/logger'

describe('redactSecrets', () => {
  it('secret 値の出現をすべてマスクする', () => {
    const out = redactSecrets('token=abc123 again abc123', ['abc123'])
    expect(out).toBe('token=[REDACTED] again [REDACTED]')
  })

  it('Telegram Bot API URL の token をパターンでマスクする', () => {
    const out = redactSecrets(
      'Call to https://api.telegram.org/bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage failed',
      [],
    )
    expect(out).toContain('bot[REDACTED]/sendMessage')
    expect(out).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')
  })

  it('空 secret は無視する', () => {
    expect(redactSecrets('hello', [''])).toBe('hello')
  })
})

describe('createLogger', () => {
  it('レベル閾値未満は出力しない', () => {
    const lines: string[] = []
    const logger = createLogger('warn', [], (l) => lines.push(l))
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[warn] w')
    expect(lines[1]).toContain('[error] e')
  })

  it('出力に secret が含まれない', () => {
    const lines: string[] = []
    const logger = createLogger('info', ['sekrit'], (l) => lines.push(l))
    logger.info('value=sekrit')
    expect(lines[0]).not.toContain('sekrit')
    expect(lines[0]).toContain('[REDACTED]')
  })
})
