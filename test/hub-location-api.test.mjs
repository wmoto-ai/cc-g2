import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { postJson, getJson, startHub, stopHub } from './helpers/hub-harness.mjs'

/** POST JSON without the auth header — used for location ingestion (no auth required). */
async function postJsonNoAuth(base, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

/** GET JSON without the auth header — used for verifying 401 responses. */
async function getJsonNoAuth(base, pathname) {
  const res = await fetch(`${base}${pathname}`)
  return { status: res.status, data: await res.json() }
}

describe('Notification Hub — Location API', () => {
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    ;({ proc: hubProc, hubBase, tmpDataDir } = await startHub())
  }, 15000)

  afterAll(async () => {
    await stopHub(hubProc, tmpDataDir)
  })

  it('GET /api/location returns null initially (requires auth)', async () => {
    const { status, data } = await getJson(hubBase, '/api/location')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.location).toBeNull()
  })

  it('GET /api/location without auth returns 401', async () => {
    const { status } = await getJsonNoAuth(hubBase, '/api/location')
    expect(status).toBe(401)
  })

  it('POST /api/location stores Overland payload (no auth required)', async () => {
    const payload = {
      locations: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.7671, 35.6812, 15.3] },
        properties: { timestamp: '2026-03-20T10:00:00Z', speed: 1.2, battery_level: 0.85 },
      }],
    }
    const { status, data } = await postJsonNoAuth(hubBase, '/api/location', payload)
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
  })

  it('GET /api/location returns stored location', async () => {
    const { status, data } = await getJson(hubBase, '/api/location')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.location.lat).toBe(35.6812)
    expect(data.location.lng).toBe(139.7671)
    expect(data.location.altitude).toBe(15.3)
    expect(data.location.speed).toBe(1.2)
    expect(data.location.battery).toBe(0.85)
    expect(data.location.timestamp).toBe('2026-03-20T10:00:00Z')
    expect(data.location.receivedAt).toBeTruthy()
  })

  it('POST /api/location rejects invalid JSON body', async () => {
    const res = await fetch(`${hubBase}/api/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.ok).toBe(false)
  })

  it('POST /api/location rejects out-of-range coordinates', async () => {
    const payload = {
      locations: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [999, 999] },
        properties: {},
      }],
    }
    const { status, data } = await postJsonNoAuth(hubBase, '/api/location', payload)
    expect(status).toBe(400)
    expect(data.error).toContain('latitude/longitude')
  })

  it('POST /api/location accepts empty locations array', async () => {
    const { status, data } = await postJsonNoAuth(hubBase, '/api/location', { locations: [] })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
  })
})
