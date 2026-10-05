// Host ヘッダ検証（DNS rebinding 対策）。
// v0.4.0 までは Vite dev server の allowedHosts（vite.config.ts）が担っていた防御を、
// dist/ を自前配信してトークンを index.html に差し込む統合サーバでも維持する。
// 許可: IP リテラル / localhost / *.localhost / *.ts.net（tailscale serve）/
// HUB_ALLOWED_HOSTS（カンマ区切り。先頭 "." はサフィックス一致）。
import { isIP } from 'node:net'
import { hubAllowedHosts } from './config.mjs'

function hostnameOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname
  } catch {
    return ''
  }
}

/** Host ヘッダが許可されたものなら true。Host が無い（HTTP/1.0 等）場合は通す。 */
function isAllowedHost(hostHeader, allowed = hubAllowedHosts) {
  const raw = String(hostHeader || '').trim()
  if (!raw) return true
  const hostname = hostnameOf(raw).toLowerCase()
  if (!hostname) return false
  // IPv6 は URL.hostname が "[::1]" の形で返るので括弧を外して判定する
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (isIP(bare)) return true
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname.endsWith('.ts.net')) return true
  for (const entry of allowed) {
    if (entry.startsWith('.')) {
      if (hostname === entry.slice(1) || hostname.endsWith(entry)) return true
    } else if (hostname === entry) {
      return true
    }
  }
  return false
}

export { isAllowedHost }
