#!/usr/bin/env node
// Even Hub 提出前のネットワーク whitelist 検査(ERGram scripts/check-network-whitelist.mjs を移植)。
//
// Even Hub ポータルはビルド成果物中の URL リテラルを総なめし、app.json の
// permissions.network.whitelist に無いものを審査で弾く。このスクリプトは同じ走査を
// ローカルで再現し、未登録エンドポイントを提出前(無料・即時)に検出する。
// `pnpm run ehpk` から自動実行される。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist/assets'
const APP_JSON = 'app.json'

// 実行時ネットワーク先ではない URL リテラル(whitelist に載せられない・載せる必要がない)。
//  • `${…}` を含むテンプレートは KNOWN_SAFE_PATTERNS で一括許容(GramJS の DC 接続
//    テンプレートや hub モードの `http://${hostname}:8787` 等。実解決先の DC は
//    whitelist に具体 origin で登録済み。hub モードは Even Hub 配布では使わない)
//  • 依存パッケージ内のドキュメント/作者 URL — fetch/WebSocket に渡らない文字列定数
const KNOWN_SAFE = [
  'http://feross.org>',
  'https://feross.org>',
  'https://feross.org/opensource>',
  'http://github.com/garycourt/murmurhash-js',
  'http://github.com/homebrewing/brauhaus-diff',
  'https://github.com/browserify/crypto-browserify',
  'http://sites.google.com/site/murmurhash/',
  'https://docs.telethon.dev/en/stable/concepts/entities.html',
  // elliptic / WebSocket-Node / sip.js 依存内のドキュメント・作者 URL — fetch されない
  'https://github.com/indutny/elliptic',
  'https://github.com/indutny/elliptic/issues',
  'https://github.com/theturtle32',
  'https://github.com/theturtle32/WebSocket-Node',
  'https://github.com/theturtle32/WebSocket-Node.git',
  'http://dev.sipdoc.net',
  // hub モード専用 STT(src/stt/openai-realtime.ts)。パッケージ版(telegram モード固定)
  // では TelegramTransport が Soniox のみを生成するため到達しないコードパス
  'wss://api.openai.com/v1/realtime',
  // 接続モード設定カード(src/main.ts)の hub URL 入力欄 placeholder。例示文字列で
  // fetch には渡らない(実際の接続先はユーザー入力値)
  'http://100.64.0.1:8787',
]

// minify で変数名が変わるため、実行時テンプレートは正規表現で許容する
const KNOWN_SAFE_PATTERNS = [
  /^(?:https?|wss?):\/\/[^"'`\\ \n]*\$\{/, // scheme://…${…} = 実行時解決テンプレート
]

if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} not found — run \`pnpm build\` before the whitelist check.`)
  process.exit(1)
}

const app = JSON.parse(readFileSync(APP_JSON, 'utf8'))
const net = (app.permissions ?? []).find((p) => p.name === 'network')
const whitelist = net?.whitelist ?? []

const urls = new Set()
for (const f of readdirSync(DIST)) {
  if (!f.endsWith('.js')) continue
  const src = readFileSync(join(DIST, f), 'utf8')
  // 末尾の閉じ括弧・句読点は URL 本体ではなく周辺文言の巻き込み(placeholder の
  // 「(例: …)」等)なので落としてから照合する
  for (const m of src.matchAll(/(?:https?|wss?):\/\/[^"'`\\ \n]*/g)) {
    urls.add(m[0].replace(/[),.;、。]+$/, ''))
  }
}

const isBareScheme = (u) => /^(?:https?|wss?):\/\/$/.test(u)
const isCovered = (u) => whitelist.some((w) => u === w || u.startsWith(w))
const isKnownSafe = (u) => KNOWN_SAFE.includes(u) || KNOWN_SAFE_PATTERNS.some((re) => re.test(u))

const unlisted = [...urls].filter((u) => !isBareScheme(u) && !isCovered(u) && !isKnownSafe(u))

if (unlisted.length) {
  console.error('✗ Bundle references URL(s) not covered by app.json network.whitelist:')
  for (const u of unlisted.sort()) console.error('   ' + u)
  console.error(
    '\nResolve each before submitting:\n' +
      '  • a real endpoint your app calls → add it to app.json network.whitelist\n' +
      '  • a vendored doc/comment string or runtime template → add it to KNOWN_SAFE\n' +
      `    in ${import.meta.url.replace('file://', '')}, with a justification.`,
  )
  process.exit(1)
}

console.log(
  `✓ network whitelist OK — ${urls.size} URL literal(s) scanned; ` +
    'all whitelisted, dynamic, or known-safe.',
)
