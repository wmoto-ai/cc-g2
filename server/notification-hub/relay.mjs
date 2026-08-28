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

// reply-relay コマンドを spawn し、payload を stdin に流して結果を返す共通処理。
// env は呼び出し側が指定する（承認注入時のみ RELAY_APPROVAL_PRECHECK を足す）。
function runRelayProcess(payload, env) {
  return new Promise((resolve) => {
    const child = spawn(hubReplyRelayCmd, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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

async function relayReplyIfConfigured(payload) {
  if (!hubReplyRelayCmd) return { status: 'stubbed' }
  const source = payload?.reply?.source || ''
  if (hubReplyRelaySources.size > 0 && source && !hubReplyRelaySources.has(source)) {
    return { status: 'stubbed' }
  }
  return runRelayProcess(payload, process.env)
}

// 承認決定のキー注入（ノンブロッキングモード専用）。
// これは Hub 内部起点であり、認証済みの decide / reply エンドポイント経由でのみ到達する
// resolveApproval からしか呼ばれない。そのため通常の reply source allowlist
// （HUB_REPLY_RELAY_SOURCES）は適用せず、代わりに RELAY_APPROVAL_PRECHECK=1 を子へ渡して
// reply-relay 側で「承認ダイアログが実在するときだけ注入」する fail-closed を有効化する
// （ローカル先勝ち時の stray キー誤爆を防ぐ）。新しい外部攻撃面は作らない。
async function relayApprovalInjection(payload) {
  if (!hubReplyRelayCmd) return { status: 'stubbed' }
  return runRelayProcess(payload, { ...process.env, RELAY_APPROVAL_PRECHECK: '1' })
}

export { forwardReplyIfConfigured, relayReplyIfConfigured, relayApprovalInjection }
