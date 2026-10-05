/**
 * Host ヘッダ検証（server/notification-hub/host-guard.mjs）のテスト
 *
 * DNS rebinding 対策。v0.4.0 までは Vite dev server の allowedHosts が担っていた
 * 防御を、dist/ を自前配信してトークンを index.html に差し込む統合サーバでも維持する。
 * 許可外の Host には CORS・認証より前に 403 を返し、トークン入り HTML も API も出さない。
 */
import { describe, it, expect, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startHub, stopHub } from './helpers/hub-harness.mjs'

const { isAllowedHost } = await import('../server/notification-hub/host-guard.mjs')

describe('isAllowedHost', () => {
  it('IP リテラル・localhost・*.ts.net は許可', () => {
    const ok = [
      '127.0.0.1:8787',
      '100.64.0.1:5173',
      '192.168.1.20',
      '[::1]:8787',
      'localhost',
      'localhost:5173',
      'app.localhost',
      'mac.tail1234.ts.net',
      'MAC.tail1234.TS.NET:443',
    ]
    for (const h of ok) expect(isAllowedHost(h, []), h).toBe(true)
  })

  it('その他のホスト名は拒否（DNS rebinding）', () => {
    const bad = ['evil.example', 'evil.example:5173', 'localhost.evil.example', 'ts.net.evil.example', 'xts.net']
    for (const h of bad) expect(isAllowedHost(h, []), h).toBe(false)
  })

  it('HUB_ALLOWED_HOSTS は完全一致、先頭 "." はサフィックス一致', () => {
    expect(isAllowedHost('hub.home.arpa', ['hub.home.arpa'])).toBe(true)
    expect(isAllowedHost('HUB.home.arpa:8787', ['hub.home.arpa'])).toBe(true)
    expect(isAllowedHost('a.home.arpa', ['.home.arpa'])).toBe(true)
    expect(isAllowedHost('home.arpa', ['.home.arpa'])).toBe(true)
    expect(isAllowedHost('b.other.arpa', ['.home.arpa'])).toBe(false)
    expect(isAllowedHost('notahub.home.arpa', ['hub.home.arpa'])).toBe(false)
  })

  it('Host 無しは通し、壊れた Host は拒否', () => {
    expect(isAllowedHost('', [])).toBe(true)
    expect(isAllowedHost(undefined, [])).toBe(true)
    expect(isAllowedHost('http://', [])).toBe(false)
  })
})

/** fetch は Host ヘッダを上書きできないので node:http で送る */
function getWithHost(base, pathname, host) {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: pathname, method: 'GET', headers: { Host: host } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('Hub は許可外の Host を 403 にする', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'hub-host-guard-dist-'))
  writeFileSync(path.join(dist, 'index.html'), '<html><head></head><body>app</body></html>')
  let hub

  afterAll(async () => {
    if (hub) await stopHub(hub.proc, hub.tmpDataDir)
  })

  it('API も静的配信も、許可外 Host にはトークンを含む応答を返さない', async () => {
    hub = await startHub({ HUB_STATIC_DIR: dist, HUB_ALLOWED_HOSTS: 'hub.home.arpa' })

    const health = await getWithHost(hub.hubBase, '/api/health', '127.0.0.1')
    expect(health.status).toBe(200)

    const rebound = await getWithHost(hub.hubBase, '/api/health', 'evil.example')
    expect(rebound.status).toBe(403)
    expect(JSON.parse(rebound.body).error).toBe('Host not allowed')

    const app = await getWithHost(hub.hubBase, '/', '127.0.0.1:5173')
    expect(app.status).toBe(200)
    expect(app.body).toContain('__CC_G2_HUB_TOKEN__')

    const appRebound = await getWithHost(hub.hubBase, '/', 'evil.example')
    expect(appRebound.status).toBe(403)
    expect(appRebound.body).not.toContain('__CC_G2_HUB_TOKEN__')

    const custom = await getWithHost(hub.hubBase, '/api/health', 'hub.home.arpa')
    expect(custom.status).toBe(200)
  })
})
