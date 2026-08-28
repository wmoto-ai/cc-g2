/**
 * Notification Hub — 不正パーセントエンコードのパスで Hub が落ちないことのテスト
 *
 * 再現バグ（docs/hub-token-401-and-trust-gate.md と同時期に発見）:
 * isPublicApiRequest() が try ブロックの外で matchNotificationDetail/matchImagePath を
 * 呼び、その中の decodeURIComponent('%') が URIError を投げると async ハンドラの
 * unhandledRejection となり Node 既定でプロセスが即死していた。
 * 公開ルート判定内のためトークンなしの 1 リクエストで再現する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TEST_HUB_TOKEN, getJson, startHub, stopHub } from './helpers/hub-harness.mjs'

describe('hub malformed path handling', () => {
  let hub
  let exited = false

  beforeAll(async () => {
    hub = await startHub()
    hub.proc.on('exit', () => {
      exited = true
    })
  })

  afterAll(async () => {
    await stopHub(hub.proc, hub.tmpDataDir)
  })

  async function fetchStatus(pathname, headers = {}) {
    const res = await fetch(`${hub.hubBase}${pathname}`, {
      headers,
      signal: AbortSignal.timeout(3000),
    }).catch((err) => err)
    expect(res, `request to ${pathname} should get a response (hub crashed?)`).not.toBeInstanceOf(Error)
    return res.status
  }

  it('GET /api/notifications/%（トークンなし・公開ルート判定経由）で Hub が生存する', async () => {
    // 不正エンコードは公開ルート（通知詳細）に該当しない → 非公開 /api/* として 401
    const status = await fetchStatus('/api/notifications/%')
    expect(status).toBe(401)

    const health = await getJson(hub.hubBase, '/api/health')
    expect(health.status).toBe(200)
    expect(exited).toBe(false)
  })

  it('GET /api/images/%zz（トークンなし）で Hub が生存する', async () => {
    const status = await fetchStatus('/api/images/%zz')
    expect(status).toBe(401)

    const health = await getJson(hub.hubBase, '/api/health')
    expect(health.status).toBe(200)
    expect(exited).toBe(false)
  })

  it('トークン付きの不正 id（GET /api/notifications/%）は 404 で Hub が生存する', async () => {
    const status = await fetchStatus('/api/notifications/%', {
      'X-CC-G2-Token': TEST_HUB_TOKEN,
    })
    expect(status).toBe(404)

    const health = await getJson(hub.hubBase, '/api/health')
    expect(health.status).toBe(200)
    expect(exited).toBe(false)
  })

  it('認証付きルートの不正 id（GET /api/notifications/%/reply 相当）でも生存する', async () => {
    const status = await fetchStatus('/api/notifications/%25%/reply', {
      'X-CC-G2-Token': TEST_HUB_TOKEN,
    })
    // 不正エンコードは no-match 扱いで 404（500 でもプロセス生存なら仕様上許容だが現状 404）
    expect(status).toBe(404)

    const health = await getJson(hub.hubBase, '/api/health')
    expect(health.status).toBe(200)
    expect(exited).toBe(false)
  })
})
