import { appConfig, createHubHeaders } from './config'

/**
 * ブラウザ画面上のイベントログ
 */
export function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString('ja-JP')
  const line = `[${timestamp}] ${message}`
  console.log(line)

  const logEl = document.getElementById('event-log')
  if (logEl) {
    logEl.textContent = line + '\n' + (logEl.textContent ?? '')
    // 最大100行
    const lines = logEl.textContent.split('\n')
    if (lines.length > 100) {
      logEl.textContent = lines.slice(0, 100).join('\n')
    }
  }

  // 画面遷移・G2描画・イベントを含む全ログをHubへミラーする（非同期・失敗は無視）。
  // 以前は「通知」始まりのログだけ送っていたため、startup描画失敗(code=1)や
  // 待機/一覧の画面遷移・[event]系がPC側に届かず、原因追跡が不能だった。
  const baseUrl = appConfig.notificationHubUrl
  if (!baseUrl) return
  // vitest 実行時はミラーしない。テストのモック bridge が返す code=1 などが
  // 実機ログ（client-events.jsonl）に混ざり、クラッシュ調査を誤誘導するため。
  // （Node 21+ は navigator.userAgent が "Node.js/NN" を返すので実際に届いていた）
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  if (proc?.env?.VITEST) return
  // code=[1-3] は後ろに数字が続かない場合のみ（WebSocket正常クローズの code=1000 等を誤検知しない）
  const level = /失敗|エラー|error|code=[1-3](?!\d)/.test(message) ? 'error' : 'info'
  // info系（画面遷移・[event]系など待機中に頻発するログ）は診断モード時のみミラーする。
  // error は常にミラーして異常追跡は維持しつつ、平常時の余計な送信を抑える。
  // 例外: 画像表示フロー（G2画像/画像表示/image-detail中のイベント）は頻度が低く
  // 実機診断に必須のため常にミラーする。
  const isImageFlow = /G2画像|画像表示|screen=image-detail/.test(message)
  if (level === 'info' && !appConfig.logMirror && !isImageFlow) return
  void fetch(`${baseUrl}/api/client-events`, {
    method: 'POST',
    headers: createHubHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      source: 'web-client',
      level,
      message: line,
      context: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      },
    }),
  }).catch(() => {})
}
