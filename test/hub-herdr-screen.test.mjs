/**
 * herdr 画面経路（hook を持たない dsh-tui 用）のテスト
 *
 * - dsh-tui の承認パネル（実測 v0.13.0 の画面）を解析できること
 * - herdr の状態遷移で承認・入力待ち・完了の通知が作られ、blocked を抜けたら承認が掃除されること
 * pane read は読み取り関数の注入で差し替える（herdr 非依存）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.CC_G2_SESSION_ACTIVITY_DISABLED = '1'
process.env.HUB_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'hub-herdr-screen-'))
const { parseDshApproval, extractTail, handleHerdrTransition } = await import(
  '../server/notification-hub/herdr-screen.mjs'
)
const { store } = await import('../server/notification-hub/store.mjs')

const APPROVAL_SCREEN = `
  ⏺ The sandbox blocked it — retrying with escalated approval:
    Bash(touch ~/dsh-approval-probe.txt)
  🌕 Running touch ~/dsh-approval-probe.txt · 4s · awaiting your approval
    ───────────── Awaiting approval · bash ─────────────
      touch ~/dsh-approval-probe.txt
    escalate sandbox to danger-full-access: The requested file is outside the session workspace.
    Allow this operation?
    ❯1. Yes, allow once
     2. No
    ↑/↓ select · Enter confirm · Esc reject
`

const DONE_SCREEN = `
  ⏺ Done — the command ran as requested:
      HTTP/2 200
    example.com responded with HTTP/2 status 200.
  ╭──────────────────────────────╮
  ⌸ ❯
  ╰──────────────────────────────╯
   local-main · dsh-test                 ctx 5.1% (10k/197k)
`

const screenExec = (screen) => () => screen
const base = { key: 'herdr:w1:p3', paneId: 'w1:p3', agent: 'dsh-tui', label: 'dsh-test', cwd: '/tmp/dsh-test' }
const pendingFor = (key) =>
  store.approvals.filter((a) => a.status === 'pending' && store.notificationsById.get(a.notificationId)?.metadata?.tmuxTarget === key)

beforeEach(() => {
  store.approvals.length = 0
  store.approvalsById.clear()
  store.notifications.length = 0
  store.notificationsById.clear()
})

describe('parseDshApproval', () => {
  it('ツール名・コマンド・理由を取り出す', () => {
    expect(parseDshApproval(APPROVAL_SCREEN)).toEqual({
      toolName: 'bash',
      command: 'touch ~/dsh-approval-probe.txt',
      detail: 'escalate sandbox to danger-full-access: The requested file is outside the session workspace.',
    })
  })

  it('承認パネルが無ければ null', () => {
    expect(parseDshApproval(DONE_SCREEN)).toBeNull()
    expect(parseDshApproval('')).toBeNull()
  })
})

describe('extractTail', () => {
  it('最後の回答（⏺ 以降）を返し、折り返しの 1 文字行を含めない', () => {
    const screen = ['    t', '    x', '  ⚓ Thinking', '  ⏺ 1st answer', '  ⏺ final answer', '    detail line', '  ╭──╮'].join('\n')
    expect(extractTail(screen)).toBe('⏺ final answer\ndetail line')
  })

  it('入力欄より上の本文だけを返す', () => {
    const tail = extractTail(DONE_SCREEN)
    expect(tail).toContain('example.com responded')
    expect(tail).not.toContain('ctx 5.1%')
  })
})

describe('handleHerdrTransition', () => {
  it('working→blocked で nonblocking の承認を作り、blocked を抜けたら掃除する', async () => {
    await handleHerdrTransition({ ...base, prevStatus: 'working', status: 'blocked' }, screenExec(APPROVAL_SCREEN))
    const [rec] = pendingFor(base.key)
    expect(rec).toMatchObject({ source: 'herdr-screen', toolName: 'bash', agentName: 'dsh-tui' })
    expect(rec.toolInput).toEqual({ command: 'touch ~/dsh-approval-probe.txt' })
    expect(store.notificationsById.get(rec.notificationId).metadata).toMatchObject({
      hookType: 'permission-request',
      approvalMode: 'nonblocking',
      agentName: 'dsh-tui',
    })

    await handleHerdrTransition({ ...base, prevStatus: 'blocked', status: 'working' }, screenExec(''))
    expect(pendingFor(base.key)).toHaveLength(0)
    expect(rec).toMatchObject({ status: 'decided', resolution: 'terminal-disconnect' })
  })

  it('同じペインで承認が pending のままなら重複して作らない', async () => {
    await handleHerdrTransition({ ...base, prevStatus: 'working', status: 'blocked' }, screenExec(APPROVAL_SCREEN))
    await handleHerdrTransition({ ...base, prevStatus: 'done', status: 'blocked' }, screenExec(APPROVAL_SCREEN))
    expect(pendingFor(base.key)).toHaveLength(1)
  })

  it('承認パネル以外の blocked は入力待ち通知にする', async () => {
    await handleHerdrTransition({ ...base, prevStatus: 'working', status: 'blocked' }, screenExec(DONE_SCREEN))
    expect(store.approvals).toHaveLength(0)
    expect(store.notifications.at(-1)).toMatchObject({ title: '入力待ち: dsh-test' })
  })

  it('working→done で完了通知（hookType=stop, 返信先は herdr ペイン）', async () => {
    await handleHerdrTransition({ ...base, prevStatus: 'working', status: 'done' }, screenExec(DONE_SCREEN))
    const n = store.notifications.at(-1)
    expect(n.title).toBe('完了: dsh-test')
    expect(n.metadata).toMatchObject({ hookType: 'stop', tmuxTarget: 'herdr:w1:p3', agentName: 'dsh-tui' })
  })

  it('ペインを見ていた場合の working→idle も完了通知にし、done→idle では重ねない', async () => {
    await handleHerdrTransition({ ...base, prevStatus: 'working', status: 'idle' }, screenExec(DONE_SCREEN))
    await handleHerdrTransition({ ...base, prevStatus: 'done', status: 'idle' }, screenExec(DONE_SCREEN))
    expect(store.notifications.filter((n) => n.title === '完了: dsh-test')).toHaveLength(1)
  })

  it('初回観測・対象外エージェントでは何もしない', async () => {
    await handleHerdrTransition({ ...base, prevStatus: undefined, status: 'blocked' }, screenExec(APPROVAL_SCREEN))
    await handleHerdrTransition({ ...base, agent: 'claude', prevStatus: 'working', status: 'blocked' }, screenExec(APPROVAL_SCREEN))
    expect(store.approvals).toHaveLength(0)
    expect(store.notifications).toHaveLength(0)
  })
})
