// SSE 配信。sseClients は store が所有し、ここでは参照のみ。
import { store, log } from './store.mjs'
import { notificationToListItem } from './notifications.mjs'

const { sseClients } = store

function sseBroadcast(eventType, data) {
  if (sseClients.size === 0) return
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try { client.write(payload) } catch { sseClients.delete(client) }
  }
}

function sseBroadcastNotificationAdded(item) {
  // notification-added は追加された1件のみ配信する。
  // かつて同セッション通知の notification-updated をまとめて撒いていたが
  // （履歴約200件時代は1追加につき約200連発、直近20件に絞っても最大約20連発）、
  // SSE バーストとして実機 WebView 過負荷・クラッシュの温床だったため撤去。
  // 他の通知のステータス鮮度は、クライアントが G2 描画前に一覧 API を取り直すことで担保する
  // （src/main.ts flushPendingNotificationUi 参照）。
  sseBroadcast('notification-added', notificationToListItem(item))
}

/** GET /api/events (SSE stream) */
function handleSseEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')
  sseClients.add(res)
  log(`SSE client connected (total=${sseClients.size})`)
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n') } catch { /* cleanup below */ }
  }, 15000)
  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.delete(res)
    log(`SSE client disconnected (total=${sseClients.size})`)
  })
  return
}

export { sseBroadcast, sseBroadcastNotificationAdded, handleSseEvents }
