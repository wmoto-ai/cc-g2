// 返信の外部転送: MOSHI webhook への forward と HUB_REPLY_RELAY_CMD への relay。
// 可変状態は持たない。
import { spawn } from 'node:child_process'
import { hubReplyRelayCmd, hubReplyRelaySources, hubReplyRelayTimeoutMs } from './config.mjs'

async function forwardReplyIfConfigured(record) {
  const url = process.env.MOSHI_REPLY_WEBHOOK_URL
  if (!url) {
    return { status: 'stubbed' }
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    })
    if (!resp.ok) {
      return { status: 'failed', error: `HTTP ${resp.status}` }
    }
    return { status: 'forwarded' }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

async function relayReplyIfConfigured(payload) {
  if (!hubReplyRelayCmd) return { status: 'stubbed' }
  const source = payload?.reply?.source || ''
  if (hubReplyRelaySources.size > 0 && source && !hubReplyRelaySources.has(source)) {
    return { status: 'stubbed' }
  }

  return new Promise((resolve) => {
    const child = spawn(hubReplyRelayCmd, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    const maxCapture = 2000
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ status: 'failed', error: `relay timeout ${hubReplyRelayTimeoutMs}ms` })
    }, hubReplyRelayTimeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
    })

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxCapture) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxCapture) stderr += String(chunk)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        return finish({ status: 'forwarded' })
      }
      const msg = (stderr || stdout || '').trim()
      return finish({ status: 'failed', error: `relay exit=${code}${msg ? ` ${msg}` : ''}` })
    })

    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

export { forwardReplyIfConfigured, relayReplyIfConfigured }
