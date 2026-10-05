// G2 アプリ（vite build 済み dist/）の配信。Vite dev server の代わりに Hub プロセスから返す。
// Hub トークンは index.html 配信時に window.__CC_G2_HUB_TOKEN__ として差し込む（src/config.ts が読む）。
// ビルドに焼き込まないので、トークン更新でビルドし直さなくてよい。
// 配信するのは dist 配下の既知拡張子ファイルだけ（ドットファイル・dist 外への symlink は返さない）。
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { hubAuthToken } from './config.mjs'

const staticDir = process.env.HUB_STATIC_DIR ? path.resolve(process.env.HUB_STATIC_DIR) : ''

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

function injectToken(html) {
  const tag = `<script>window.__CC_G2_HUB_TOKEN__=${JSON.stringify(hubAuthToken)}</script>`
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`
}

// dist 配下のファイルパスに解決する。外に出るパスは null。
function resolveStaticPath(dir, pathname) {
  let rel
  try { rel = decodeURIComponent(pathname) } catch { return null }
  if (rel.endsWith('/')) rel += 'index.html'
  // ドットファイル（.env 等）と "." / ".." セグメントは配信対象外
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return null
  const file = path.resolve(dir, `.${rel}`)
  if (file !== dir && !file.startsWith(`${dir}${path.sep}`)) return null
  return file
}

/** 静的ファイルを返せたら true。対象外・見つからなければ false（呼び出し側のルーティングに任せる）。 */
async function handleStatic(req, res, pathname, dir = staticDir) {
  if (!dir || (req.method !== 'GET' && req.method !== 'HEAD')) return false
  const file = resolveStaticPath(dir, pathname)
  if (!file) return false
  // 既知の拡張子だけ配信する（dist に紛れ込んだ想定外のファイルを出さない）
  const ext = path.extname(file)
  if (!CONTENT_TYPES[ext]) return false
  try {
    if (!(await stat(file)).isFile()) return false
    // symlink が dist の外を指していても配信しない。dir 自体が symlink 経由（macOS の /var 等）でも
    // 比較できるよう realpath 同士で比べる
    const [real, realDir] = await Promise.all([realpath(file), realpath(dir)])
    if (real !== realDir && !real.startsWith(`${realDir}${path.sep}`)) return false
  } catch {
    return false
  }
  let body = await readFile(file)
  if (path.basename(file) === 'index.html') body = injectToken(body.toString('utf8'))
  res.statusCode = 200
  res.setHeader('Content-Type', CONTENT_TYPES[ext])
  // index.html はトークン入りで更新も反映したいので毎回取り直す。ハッシュ付き assets は長期キャッシュ
  res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}

export { handleStatic, resolveStaticPath, injectToken, staticDir }
