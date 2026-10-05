/**
 * G2 アプリ静的配信（server/notification-hub/static.mjs）のテスト
 *
 * - Vite dev server の代わりに Hub が dist/ を返す
 * - index.html には Hub トークンを差し込む（ビルドに焼き込まない）
 * - dist の外のファイルは返さない
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.HUB_AUTH_TOKEN = 'test-token-123'
const { handleStatic, resolveStaticPath, injectToken } = await import('../server/notification-hub/static.mjs')

const dist = mkdtempSync(path.join(tmpdir(), 'hub-static-'))
mkdirSync(path.join(dist, 'assets'))
writeFileSync(path.join(dist, 'index.html'), '<html><head><title>x</title></head><body></body></html>')
writeFileSync(path.join(dist, 'mirror.html'), '<html><head></head></html>')
writeFileSync(path.join(dist, 'assets', 'main-abc.js'), 'console.log(1)')
// 配信してはいけないもの: ドットファイル / 未知の拡張子 / dist の外を指す symlink
writeFileSync(path.join(dist, '.env.local'), 'SECRET=1')
writeFileSync(path.join(dist, 'assets', 'data.bin'), 'bin')
const outside = mkdtempSync(path.join(tmpdir(), 'hub-static-outside-'))
writeFileSync(path.join(outside, 'leak.html'), '<html>leak</html>')
symlinkSync(path.join(outside, 'leak.html'), path.join(dist, 'leak.html'))

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: undefined }
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
  res.end = (b) => { res.body = b === undefined ? undefined : String(b) }
  return res
}

const get = async (pathname, method = 'GET') => {
  const res = fakeRes()
  const handled = await handleStatic({ method }, res, pathname, dist)
  return { handled, res }
}

describe('handleStatic', () => {
  it('/ は index.html を返し、Hub トークンを差し込む', async () => {
    const { handled, res } = await get('/')
    expect(handled).toBe(true)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('window.__CC_G2_HUB_TOKEN__="test-token-123"</script></head>')
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('assets はそのまま返し、長期キャッシュにする', async () => {
    const { res } = await get('/assets/main-abc.js')
    expect(res.body).toBe('console.log(1)')
    expect(res.headers['content-type']).toContain('text/javascript')
    expect(res.headers['cache-control']).toContain('immutable')
  })

  it('mirror.html にはトークンを入れない', async () => {
    const { res } = await get('/mirror.html')
    expect(res.body).not.toContain('__CC_G2_HUB_TOKEN__')
  })

  it('無いファイル・POST・静的配信無効は false（後段のルーティングに任せる）', async () => {
    expect((await get('/nope.js')).handled).toBe(false)
    expect((await get('/', 'POST')).handled).toBe(false)
    expect(await handleStatic({ method: 'GET' }, fakeRes(), '/', '')).toBe(false)
  })

  it('ドットファイル・未知の拡張子・dist 外への symlink は配信しない', async () => {
    expect((await get('/.env.local')).handled).toBe(false)
    expect((await get('/assets/data.bin')).handled).toBe(false)
    expect((await get('/leak.html')).handled).toBe(false)
  })
})

describe('resolveStaticPath', () => {
  it('dist の外（.. やエンコードした ..）は null', () => {
    expect(resolveStaticPath(dist, '/../etc/passwd')).toBeNull()
    expect(resolveStaticPath(dist, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(resolveStaticPath(dist, '/%E0%A4%A')).toBeNull()
    expect(resolveStaticPath(dist, '/assets/')).toBe(path.join(dist, 'assets', 'index.html'))
  })
})

describe('injectToken', () => {
  it('</head> が無ければ先頭に入れる', () => {
    expect(injectToken('<body></body>')).toMatch(/^<script>window.__CC_G2_HUB_TOKEN__=/)
  })
})
