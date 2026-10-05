// herdr socket API の最小クライアント（NDJSON over Unix socket）。
// RPC は 1 リクエスト 1 接続（herdr が応答後に閉じる）。events.subscribe だけ接続を張り続け、
// 1 行目が ack、以降の行がイベント。
import { connect } from 'node:net'
import { homedir } from 'node:os'

const RPC_TIMEOUT_MS = 5000

function herdrSocketPath() {
  return process.env.HERDR_SOCKET_PATH || `${homedir()}/.config/herdr/herdr.sock`
}

// チャンク境界で UTF-8 が割れても化けないよう TextDecoder の stream モードで行に分ける
function createLineReader(onLine) {
  const decoder = new TextDecoder()
  let buf = ''
  return (chunk) => {
    buf += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
    }
  }
}

let reqCounter = 0

function herdrRpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(herdrSocketPath())
    let settled = false
    const settle = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      sock.destroy()
      settle(() => reject(new Error(`herdr rpc timeout: ${method}`)))
    }, RPC_TIMEOUT_MS)
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ id: `cc-g2_${++reqCounter}`, method, params })}\n`)
    })
    sock.on('data', createLineReader((line) => {
      sock.end()
      try {
        const msg = JSON.parse(line)
        if (msg.error) settle(() => reject(new Error(`herdr ${method}: ${msg.error.message || msg.error.code}`)))
        else settle(() => resolve(msg.result))
      } catch (err) {
        settle(() => reject(err))
      }
    }))
    sock.on('error', (err) => settle(() => reject(err)))
    sock.on('close', () => settle(() => reject(new Error(`herdr connection closed: ${method}`))))
  })
}

/**
 * events.subscribe。onClose は切断・購読拒否のどちらでも 1 回だけ呼ぶ。
 * onReady は ack 受信時。戻り値は購読解除関数。
 */
function herdrSubscribe(subscriptions, { onEvent, onReady, onClose }) {
  const sock = connect(herdrSocketPath())
  let acked = false
  let closed = false
  const emitClose = () => {
    if (closed) return
    closed = true
    onClose?.()
  }
  sock.on('connect', () => {
    sock.write(`${JSON.stringify({ id: 'cc-g2_sub', method: 'events.subscribe', params: { subscriptions } })}\n`)
  })
  sock.on('data', createLineReader((line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (!acked) {
      acked = true
      if (msg.error) {
        sock.destroy()
        emitClose()
        return
      }
      onReady?.()
      return
    }
    onEvent(msg)
  }))
  sock.on('close', emitClose)
  sock.on('error', emitClose)
  return () => {
    closed = true
    sock.destroy()
  }
}

async function herdrAgentList() {
  const result = await herdrRpc('agent.list')
  return Array.isArray(result?.agents) ? result.agents : []
}

async function herdrPaneRead(paneId, lines = 60) {
  const result = await herdrRpc('pane.read', { pane_id: paneId, source: 'visible', lines })
  return result?.read?.text || ''
}

export { herdrRpc, herdrSubscribe, herdrAgentList, herdrPaneRead, createLineReader }
