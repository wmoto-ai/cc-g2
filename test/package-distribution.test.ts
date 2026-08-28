import { describe, expect, it } from 'vitest'
import packageManifest from '../package.json'

describe('GitHub / package distribution', () => {
  it('Telegram adapter の実行ファイルを配布対象に含める', () => {
    expect(packageManifest.files).toEqual(expect.arrayContaining([
      'docs/assets/',
      'packages/telegram-adapter/package.json',
      'packages/telegram-adapter/scripts/',
      'packages/telegram-adapter/src/',
    ]))
  })

  it('Telegram adapter の実行依存をルートでインストールする', () => {
    expect(packageManifest.dependencies).toMatchObject({
      '@grammyjs/auto-retry': expect.any(String),
      grammy: expect.any(String),
      tsx: expect.any(String),
    })
  })
})
