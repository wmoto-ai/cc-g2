// GramJS のブラウザ実行に必要な Buffer グローバル注入。
// vite-plugin-node-polyfills の Buffer shim は `buffer` パッケージと別クラスになり、
// GramJS 内部の instanceof Buffer が cross-fail する(2FA で "Bytes or str expected,
// not Buffer")ため、プラグイン側は globals.Buffer: false にしてここで自前注入する。
// GramJS を import するモジュールの先頭で最初に import すること(MUST be first)。
import { Buffer } from 'buffer'
;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
