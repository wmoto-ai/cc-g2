/**
 * Notification Hub — G2 ミラー表示状態 API のテスト（plan/g2-mirror.md M2）
 *
 * - POST /api/g2-display は要トークン、最新状態を保持し SSE `g2-display`（{seq} のみ）を配信
 * - GET /api/g2-display はビューア（mirror.html）向けにトークンなしで取得できる
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TEST_HUB_TOKEN, postJson, startHub, stopHub } from './helpers/hub-harness.mjs'

const SAMPLE_STATE = {
  seq: 7,
  updatedAt: 1765500000000,
  containers: [
    { kind: 'text', id: 1, name: 'hdr', x: 8, y: 4, w: 560, h: 28, content: 'ヘッダー' },
    { kind: 'image', id: 3, name: 'img-0', x: 0, y: 0, w: 288, h: 144, pngBase64: 'AQID' },
  ],
}

/** SSE ストリームから指定イベントを 1 回読む（タイムアウト付き） */
async function waitForSseEvent(base, eventName, trigger, timeoutMs = 5000) {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/events`, { signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await trigger()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return null
      buffer += decoder.decode(value, { stream: true })
      const match = buffer.match(new RegExp(`event: ${eventName}\\ndata: (.*)\\n`))
      if (match) return JSON.parse(match[1])
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

describe('Notification Hub — G2 display API', () => {
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    ;({ proc: hubProc, hubBase, tmpDataDir } = await startHub())
  }, 15000)

  afterAll(async () => {
    await stopHub(hubProc, tmpDataDir)
  })

  it('GET /api/g2-display — 状態未受信なら 404', async () => {
    const res = await fetch(`${hubBase}/api/g2-display`)
    expect(res.status).toBe(404)
  })

  it('POST /api/g2-display — トークンなしは拒否される', async () => {
    const res = await fetch(`${hubBase}/api/g2-display`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE_STATE),
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/g2-display — containers 配列がないと 400', async () => {
    const { status } = await postJson(hubBase, '/api/g2-display', { seq: 1 })
    expect(status).toBe(400)
  })

  it('POST /api/g2-display — 不正な container 要素があると 400', async () => {
    const { status } = await postJson(hubBase, '/api/g2-display', {
      seq: 1,
      containers: [{ kind: 'script', id: 'x' }],
    })
    expect(status).toBe(400)
  })

  it('POST → GET — 最新状態がトークンなしで取得できる（ビューア向け公開 GET）', async () => {
    const { status } = await postJson(hubBase, '/api/g2-display', SAMPLE_STATE)
    expect(status).toBe(200)

    const res = await fetch(`${hubBase}/api/g2-display`) // トークンなし
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.display.seq).toBe(7)
    expect(data.display.containers).toEqual(SAMPLE_STATE.containers)
    expect(data.display.receivedAt).toEqual(expect.any(String))
  })

  it('POST すると SSE g2-display イベントが {seq} のみで配信される', async () => {
    const payload = await waitForSseEvent(hubBase, 'g2-display', async () => {
      const { status } = await postJson(hubBase, '/api/g2-display', { ...SAMPLE_STATE, seq: 8 })
      expect(status).toBe(200)
    })
    expect(payload).toEqual({ seq: 8 }) // フル状態は配信しない（WebView への反射負荷防止）
  })

  it('POST するたびに最新状態へ置き換わる', async () => {
    await postJson(hubBase, '/api/g2-display', { seq: 9, updatedAt: 1, containers: [] })
    const res = await fetch(`${hubBase}/api/g2-display`)
    const data = await res.json()
    expect(data.display.seq).toBe(9)
    expect(data.display.containers).toEqual([])
  })

  it('TEST_HUB_TOKEN がデフォルト export と一致（harness 健全性）', () => {
    expect(TEST_HUB_TOKEN).toBeTruthy()
  })
})
