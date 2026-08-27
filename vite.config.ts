import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// GramJS(telegram トランスポート)のブラウザ実行に必要な polyfill 構成。
// 詳細は src/buffer-global.ts のコメント参照:
// - Buffer はプラグインの shim ではなく `buffer` パッケージ単一クラスに固定
//   (globals.Buffer: false + resolve.dedupe + pnpm overrides)
// - vm は eval() を含む vm-browserify を空スタブに差し替え(審査対策。未使用パスのみ)
const vmStub = fileURLToPath(new URL('./src/stubs/vm-empty.ts', import.meta.url))

export default defineConfig({
  plugins: [
    // vitest は Node 環境で実行され child_process 等の本物が必要なため、
    // ブラウザ向け polyfill はテスト時に適用しない
    ...(process.env.VITEST
      ? []
      : [
          nodePolyfills({
            globals: { Buffer: false, global: true, process: true },
            overrides: { vm: vmStub },
          }),
        ]),
  ],
  resolve: { dedupe: ['buffer'] },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        mirror: fileURLToPath(new URL('./mirror.html', import.meta.url)),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // tailscale serve (https://<machine>.<tailnet>.ts.net) からのアクセスを許可
    allowedHosts: ['.ts.net'],
    // mirror.html ビューアは同一 origin の /api だけを叩く（HTTPS 化時の mixed content
    // 対策。Hub へは Vite dev server が中継する）。
    // メインアプリ（WebView）の Hub 直叩き（VITE_HUB_URL / :8787）には影響しない。
    proxy: {
      '/api': `http://127.0.0.1:${process.env.HUB_PORT || 8787}`,
    },
  },
})
