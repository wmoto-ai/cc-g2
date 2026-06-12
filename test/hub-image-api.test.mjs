import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TEST_HUB_TOKEN, getJson, startHub, stopHub } from './helpers/hub-harness.mjs'

/** 最小の有効 PNG (1x1, 黒) */
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a49444154789c63600000000200015d7d8cb20000000049454e44ae426082',
  'hex',
)

/** JPEG マジックバイトのみの擬似データ */
const TINY_JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

async function postImage(base, body, { query = '', headers = {} } = {}) {
  const res = await fetch(`${base}/api/images${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-CC-G2-Token': TEST_HUB_TOKEN, ...headers },
    body,
  })
  return { status: res.status, data: await res.json() }
}

describe('Notification Hub — Image API', () => {
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    ;({ proc: hubProc, hubBase, tmpDataDir } = await startHub({ HUB_MAX_IMAGES: '3' }))
  }, 15000)

  afterAll(async () => {
    await stopHub(hubProc, tmpDataDir)
  })

  it('POST /api/images — PNG を保存し imageId 付き通知を作る', async () => {
    const { status, data } = await postImage(hubBase, TINY_PNG, { query: '?title=Build%20result' })
    expect(status).toBe(201)
    expect(data.ok).toBe(true)
    expect(data.imageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(data.notificationId).toEqual(expect.any(String))

    const { status: ns, data: notif } = await getJson(hubBase, `/api/notifications/${data.notificationId}`)
    expect(ns).toBe(200)
    expect(notif.item.title).toBe('Build result')
    expect(notif.item.metadata.imageId).toBe(data.imageId)
  })

  it('GET /api/images/:id — 保存した画像がバイト一致で返る', async () => {
    const { data } = await postImage(hubBase, TINY_PNG)
    const res = await fetch(`${hubBase}/api/images/${data.imageId}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(TINY_PNG)).toBe(true)
  })

  it('GET /api/images/:id — 認証ヘッダなしでも取得できる（通知詳細GETと同等の公開扱い）', async () => {
    const { data } = await postImage(hubBase, TINY_PNG)
    const res = await fetch(`${hubBase}/api/images/${data.imageId}`)
    expect(res.status).toBe(200)
  })

  it('POST /api/images — 認証トークンなしは拒否される', async () => {
    const res = await fetch(`${hubBase}/api/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: TINY_PNG,
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/images — JPEG マジックバイトを受け付ける', async () => {
    const { status, data } = await postImage(hubBase, TINY_JPEG_HEADER)
    expect(status).toBe(201)
    const res = await fetch(`${hubBase}/api/images/${data.imageId}`)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
  })

  it('POST /api/images — 画像以外のバイナリは 415', async () => {
    const { status, data } = await postImage(hubBase, Buffer.from('not an image'))
    expect(status).toBe(415)
    expect(data.ok).toBe(false)
  })

  it('GET /api/images/:id — 不正な id 形式は拒否される（パストラバーサル防止）', async () => {
    for (const bad of ['..%2F..%2F.env.local', 'abc', '00000000-0000-0000-0000-00000000000Z']) {
      const res = await fetch(`${hubBase}/api/images/${bad}`)
      // UUID 形式にマッチしない id は画像ルートとして扱われない。
      // 公開ルート判定から外れて 401、または 404 になる（どちらもファイルへ到達しない）
      expect([401, 404]).toContain(res.status)
    }
  })

  it('GET /api/images/:id — 存在しない UUID は 404', async () => {
    const res = await fetch(`${hubBase}/api/images/00000000-0000-0000-0000-000000000000`)
    expect(res.status).toBe(404)
  })

  it('保存数上限 (HUB_MAX_IMAGES=3) を超えると古い画像が削除される', async () => {
    const ids = []
    for (let i = 0; i < 4; i++) {
      const { data } = await postImage(hubBase, TINY_PNG)
      ids.push(data.imageId)
      await new Promise((r) => setTimeout(r, 30)) // createdAt の順序を安定させる
    }
    const oldest = await fetch(`${hubBase}/api/images/${ids[0]}`)
    expect(oldest.status).toBe(404)
    const newest = await fetch(`${hubBase}/api/images/${ids[3]}`)
    expect(newest.status).toBe(200)
  })

  it('SSE notification-added に imageId 付き通知が流れる', async () => {
    const res = await fetch(`${hubBase}/api/events`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()

    const { data: posted } = await postImage(hubBase, TINY_PNG, { query: '?title=SSE%20test' })

    let buffer = ''
    const deadline = Date.now() + 5000
    let found = null
    while (Date.now() < deadline && !found) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 500)),
      ])
      if (done) break
      if (value) buffer += decoder.decode(value, { stream: true })
      for (const block of buffer.split('\n\n')) {
        if (block.includes('notification-added') && block.includes(posted.imageId)) {
          found = block
          break
        }
      }
    }
    await reader.cancel().catch(() => {})
    expect(found, 'SSE notification-added with imageId should arrive').toBeTruthy()
  })
})
