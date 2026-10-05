/**
 * herdr socket クライアント（server/notification-hub/herdr-client.mjs）のテスト
 *
 * 実 herdr には繋がず、Unix socket の偽サーバで NDJSON の往復を確かめる:
 * - RPC は 1 行送って 1 行受け取る（result / error）
 * - events.subscribe は 1 行目が ack、以降がイベント。拒否・切断は onClose
 * - マルチバイト文字がチャンク境界で割れても化けない
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'herdr-client-'))
const sockPath = path.join(dir, 'herdr.sock')
process.env.HERDR_SOCKET_PATH = sockPath
const { herdrRpc, herdrSubscribe, herdrAgentList, herdrPaneRead, createLineReader } = await import(
  '../server/notification-hub/herdr-client.mjs'
)

let server
async function serve(onRequest) {
  server = createServer((sock) => {
    let buf = ''
    sock.on('data', (c) => {
      buf += c
      const nl = buf.indexOf('\n')
      if (nl >= 0) onRequest(JSON.parse(buf.slice(0, nl)), sock)
    })
  })
  await new Promise((r) => server.listen(sockPath, r))
}

afterEach(async () => {
  await new Promise((r) => server.close(r))
})

const reply = (sock, obj) => sock.end(`${JSON.stringify(obj)}\n`)

describe('herdrRpc', () => {
  it('agent.list / pane.read の result を返す', async () => {
    await serve((req, sock) => {
      if (req.method === 'agent.list') reply(sock, { id: req.id, result: { agents: [{ pane_id: 'w1:p1' }] } })
      else reply(sock, { id: req.id, result: { read: { text: `read ${req.params.pane_id} ${req.params.source}` } } })
    })
    expect(await herdrAgentList()).toEqual([{ pane_id: 'w1:p1' }])
    expect(await herdrPaneRead('w1:p2')).toBe('read w1:p2 visible')
  })

  it('error 応答は reject する', async () => {
    await serve((req, sock) => reply(sock, { id: req.id, error: { code: 'nope', message: 'bad' } }))
    await expect(herdrRpc('pane.read', {})).rejects.toThrow('bad')
  })
})

describe('herdrSubscribe', () => {
  it('ack 後のイベントを渡し、切断で onClose を 1 回呼ぶ', async () => {
    let peer
    await serve((req, sock) => {
      peer = sock
      expect(req.method).toBe('events.subscribe')
      sock.write(`${JSON.stringify({ id: req.id, result: { type: 'subscription_started' } })}\n`)
      sock.write(`${JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'working' } })}\n`)
    })
    const events = []
    let closed = 0
    await new Promise((resolve) => {
      herdrSubscribe([{ type: 'pane.created' }], {
        onReady: () => {},
        onEvent: (ev) => { events.push(ev); peer.destroy() },
        onClose: () => { closed++; resolve() },
      })
    })
    expect(events).toEqual([{ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'working' } }])
    expect(closed).toBe(1)
  })

  it('購読拒否は onReady を呼ばずに onClose', async () => {
    await serve((req, sock) => sock.write(`${JSON.stringify({ id: req.id, error: { message: 'unknown variant' } })}\n`))
    let ready = false
    await new Promise((resolve) => {
      herdrSubscribe([{ type: 'bogus' }], { onReady: () => { ready = true }, onEvent: () => {}, onClose: resolve })
    })
    expect(ready).toBe(false)
  })
})

describe('createLineReader', () => {
  it('チャンク境界で割れた UTF-8 を復元する', () => {
    const lines = []
    const read = createLineReader((l) => lines.push(l))
    const bytes = Buffer.from('完了\n次の行\n')
    read(bytes.subarray(0, 4))
    read(bytes.subarray(4))
    expect(lines).toEqual(['完了', '次の行'])
  })
})
