// herdr ペインの画面から承認・完了を拾う経路（hook を持たないエージェント用）。
// dsh-tui は herdr に idle/working/blocked/done を報告するので、その遷移を契機に
// herdr socket の pane.read で画面を読み、承認依頼・入力待ち・完了の通知を作る。
// 承認の決定は既存の nonblocking 経路（approvals.mjs → reply-relay-herdr.sh のキー注入）で届ける。
import { store, log } from './store.mjs'
import { herdrPaneRead } from './herdr-client.mjs'
import { createApproval, markApprovalCleanup } from './approvals.mjs'
import { addNotification } from './notifications.mjs'
import { sseBroadcastNotificationAdded } from './sse.mjs'

const { approvals, notificationsById } = store

// 画面経由で扱うエージェント（herdr の agent 名）。hook を持つ claude/codex/copilot は含めない。
const SCREEN_AGENTS = new Set(
  (process.env.CC_G2_HERDR_SCREEN_AGENTS || 'dsh-tui').split(',').map((s) => s.trim()).filter(Boolean),
)
const SCREEN_SOURCE = 'herdr-screen'

function isScreenAgent(agent) {
  return SCREEN_AGENTS.has(agent)
}

/**
 * dsh-tui の承認パネルを解析する。
 *   ── Awaiting approval · bash ──
 *     <command>
 *     <reason...>
 *     Allow this operation?
 *     ❯1. Yes, allow once
 *      2. No
 * 解析できなければ null。
 */
function parseDshApproval(screen) {
  const lines = String(screen || '').split('\n')
  const head = lines.findIndex((l) => /Awaiting approval\s*·/.test(l))
  if (head < 0) return null
  const toolName = (lines[head].match(/Awaiting approval\s*·\s*([^\s─]+)/) || [])[1] || 'tool'
  const end = lines.findIndex((l, i) => i > head && /Allow this operation\?/.test(l))
  if (end < 0) return null
  const body = lines.slice(head + 1, end).map((l) => l.trim()).filter(Boolean)
  if (body.length === 0) return null
  return { toolName, command: body[0], detail: body.slice(1).join('\n') }
}

// 入力欄（╭ で始まる枠）より上の本文。最後の回答（⏺ で始まる段落）があればそこから、
// 無ければ空行・罫線・1 文字だけの行（折り返しの断片）を除いた末尾 maxLines 行。
function extractTail(screen, maxLines = 15) {
  const lines = String(screen || '').split('\n')
  const box = lines.findIndex((l) => l.trim().startsWith('╭'))
  let upper = box >= 0 ? lines.slice(0, box) : lines
  const answer = upper.findLastIndex((l) => l.trim().startsWith('⏺'))
  if (answer >= 0) upper = upper.slice(answer)
  return upper
    .filter((l) => l.trim().length > 1)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^[\s─━]+$/.test(l))
    .slice(-maxLines)
    .map((l) => l.trim())
    .join('\n')
}

async function readPane(paneId, read) {
  try {
    return await read(paneId, 60)
  } catch (err) {
    log(`herdr-screen read failed pane=${paneId} ${err?.message || err}`)
    return ''
  }
}

function pendingScreenApprovals(key) {
  return approvals.filter((a) => {
    if (a.status !== 'pending' || a.source !== SCREEN_SOURCE) return false
    return notificationsById.get(a.notificationId)?.metadata?.tmuxTarget === key
  })
}

async function notify({ title, body, hookType, agent, key, label, cwd }) {
  const { item } = await addNotification({
    title,
    body,
    hookType,
    metadata: { hookType, agentName: agent, tmuxTarget: key, sessionLabel: label || undefined, cwd: cwd || undefined },
  }, SCREEN_SOURCE)
  sseBroadcastNotificationAdded(item)
}

/**
 * herdr の状態遷移 1 件を処理する。prevStatus は直前に観測した herdr 生ステータス。
 * 初回観測（prevStatus 未定義）では通知しない（Hub 再起動直後の重複防止）。
 * read は (paneId, lines) → 画面テキスト。テストから差し替えられるよう引数化している。
 */
async function handleHerdrTransition({ key, paneId, agent, label, cwd, status, prevStatus }, read = herdrPaneRead) {
  if (!isScreenAgent(agent) || !prevStatus || prevStatus === status) return

  // blocked を抜けた = ターミナル側で決着した。残っている承認は掃除する。
  if (prevStatus === 'blocked') {
    for (const rec of pendingScreenApprovals(key)) {
      markApprovalCleanup(rec, 'terminal-disconnect', 'terminal')
    }
  }

  if (status === 'blocked') {
    if (pendingScreenApprovals(key).length > 0) return
    const screen = await readPane(paneId, read)
    const parsed = parseDshApproval(screen)
    if (parsed) {
      await createApproval({
        source: SCREEN_SOURCE,
        toolName: parsed.toolName,
        toolInput: { command: parsed.command },
        toolId: '',
        cwd,
        agentName: agent,
        title: parsed.toolName,
        body: [parsed.command, parsed.detail].filter(Boolean).join('\n\n'),
        metadata: { tmuxTarget: key, sessionLabel: label || undefined, agentName: agent, approvalMode: 'nonblocking' },
      })
      return
    }
    // 承認パネル以外（質問など）は入力待ち通知。返信はテキストとしてペインへ送られる。
    await notify({ title: `入力待ち: ${label}`, body: extractTail(screen) || '(画面を取得できませんでした)', hookType: 'notification', agent, key, label, cwd })
    return
  }

  // herdr の done は「見ていないペインで完了」。ペインを見ていると working→idle になるので両方を完了とする。
  if ((status === 'done' || status === 'idle') && (prevStatus === 'working' || prevStatus === 'blocked')) {
    const screen = await readPane(paneId, read)
    await notify({ title: `完了: ${label}`, body: extractTail(screen) || '(no output)', hookType: 'stop', agent, key, label, cwd })
  }
}

export { parseDshApproval, extractTail, handleHerdrTransition }
