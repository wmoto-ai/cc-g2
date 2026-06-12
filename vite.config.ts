import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    // tailscale serve (https://<machine>.<tailnet>.ts.net) からのアクセスを許可
    allowedHosts: ['.ts.net'],
    // mirror.html ビューアは同一 origin の /api だけを叩く（HTTPS 化時の mixed content
    // 対策。Hub へは Vite dev server が中継する。plan/g2-mirror.md 参照）。
    // メインアプリ（WebView）の Hub 直叩き（VITE_HUB_URL / :8787）には影響しない。
    proxy: {
      '/api': `http://127.0.0.1:${process.env.HUB_PORT || 8787}`,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        mirror: fileURLToPath(new URL('./mirror.html', import.meta.url)),
      },
    },
  },
})
