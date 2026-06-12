#!/usr/bin/env node
// Notification Hub の履歴 JSONL を間引くメンテナンススクリプト（リファクタ Phase 7）
//
// 対象: notifications.jsonl / replies.jsonl / approvals.jsonl（起動時に全件ロードされる）
//       client-events.jsonl / reply-relay-events.jsonl（追記専用の診断ログ）
//
// 使い方（必ず Hub を止めてから）:
//   cc-g2 stop
//   node scripts/prune-hub-history.mjs --dry-run          # 何が消えるか確認
//   node scripts/prune-hub-history.mjs                    # 実行（デフォルト14日保持）
//   node scripts/prune-hub-history.mjs --keep-days 30
//   cc-g2
//
// 安全設計:
// - Hub が :8787 で応答中なら中断する（稼働中の書き換えはデータ破損のもと）
// - 書き換え前に <data-dir>/backup-prune-<時刻>/ へ元ファイルをコピー
// - approvals は _event:'decided' 差分レコードをマージして1レコードに圧縮
//   （bootstrap は _event なしレコードを通常レコードとして読むため互換）
// - 保持期間より古くても、保持する approval/reply から参照される通知は残す
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const getFlag = (name) => args.includes(name)
const getOpt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback
}

const DRY_RUN = getFlag('--dry-run')
const KEEP_DAYS = Number(getOpt('--keep-days', '14'))
const DATA_DIR = path.resolve(getOpt('--data-dir', 'tmp/notification-hub'))
const HUB_PORT = Number(process.env.HUB_PORT || 8787)

if (!Number.isFinite(KEEP_DAYS) || KEEP_DAYS <= 0) {
  console.error('--keep-days は正の数で指定してください')
  process.exit(1)
}

async function hubIsRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${HUB_PORT}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function loadJsonl(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l))
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

async function writeJsonlAtomic(filePath, records) {
  const tmpPath = `${filePath}.prune-tmp`
  await writeFile(tmpPath, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
  await rename(tmpPath, filePath)
}

function isFresh(record, cutoffIso) {
  return typeof record?.createdAt === 'string' && record.createdAt >= cutoffIso
}

const main = async () => {
  // デフォルトの data dir を触るときだけ稼働チェック（テスト用コピーは対象外）
  if (DATA_DIR === path.resolve('tmp/notification-hub') && (await hubIsRunning())) {
    console.error(`Hub が :${HUB_PORT} で稼働中です。先に \`cc-g2 stop\` で停止してください。`)
    process.exit(1)
  }
  if (!existsSync(DATA_DIR)) {
    console.error(`data dir が見つかりません: ${DATA_DIR}`)
    process.exit(1)
  }

  const cutoffIso = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString()
  console.log(`data dir: ${DATA_DIR}`)
  console.log(`保持期間: ${KEEP_DAYS}日（${cutoffIso} 以降を保持）${DRY_RUN ? ' [dry-run]' : ''}`)

  const files = {
    notifications: path.join(DATA_DIR, 'notifications.jsonl'),
    replies: path.join(DATA_DIR, 'replies.jsonl'),
    approvals: path.join(DATA_DIR, 'approvals.jsonl'),
    clientEvents: path.join(DATA_DIR, 'client-events.jsonl'),
    replyRelayEvents: path.join(DATA_DIR, 'reply-relay-events.jsonl'),
  }

  const notifications = (await loadJsonl(files.notifications)) ?? []
  const replies = (await loadJsonl(files.replies)) ?? []
  const approvalRows = (await loadJsonl(files.approvals)) ?? []
  const clientEvents = await loadJsonl(files.clientEvents)
  const relayEvents = await loadJsonl(files.replyRelayEvents)

  // approvals: bootstrap と同じ順序で _event:'decided' をマージして最終状態に圧縮
  const approvalsById = new Map()
  for (const a of approvalRows) {
    if (a && a.id && !a._event) {
      approvalsById.set(a.id, { ...a })
    } else if (a && a._event === 'decided' && a.id) {
      const existing = approvalsById.get(a.id)
      if (existing) {
        existing.status = a.status
        existing.decision = a.decision
        existing.resolution = a.resolution
        existing.comment = a.comment
        existing.decidedBy = a.decidedBy
        existing.decidedAt = a.decidedAt
        if (a.deliveredAt) existing.deliveredAt = a.deliveredAt
      }
    }
  }
  const approvalsMerged = [...approvalsById.values()]

  const keptApprovals = approvalsMerged.filter((a) => isFresh(a, cutoffIso))
  const keptReplies = replies.filter((r) => isFresh(r, cutoffIso))

  // 保持する approval / reply が参照する通知は期間外でも残す（参照整合性）
  const referencedNotifIds = new Set(
    [...keptApprovals, ...keptReplies].map((r) => r.notificationId).filter(Boolean),
  )
  const keptNotifications = notifications.filter(
    (n) => isFresh(n, cutoffIso) || referencedNotifIds.has(n.id),
  )

  const report = [
    ['notifications', notifications.length, keptNotifications.length],
    ['replies', replies.length, keptReplies.length],
    ['approvals(rows)', approvalRows.length, keptApprovals.length],
  ]
  if (clientEvents) {
    report.push(['client-events', clientEvents.length, clientEvents.filter((e) => isFresh(e, cutoffIso)).length])
  }
  if (relayEvents) {
    // reply-relay-events は {reply:{createdAt,...},...} 形式
    report.push(['reply-relay-events', relayEvents.length, relayEvents.filter((e) => isFresh(e?.reply ?? e, cutoffIso)).length])
  }

  const stalePending = approvalsMerged.filter((a) => a.status === 'pending' && !isFresh(a, cutoffIso)).length
  for (const [name, before, after] of report) {
    console.log(`${name}: ${before} -> ${after} (-${before - after})`)
  }
  console.log(`(うち期限切れの放置 pending 承認: ${stalePending} 件を削除対象に含む)`)

  if (DRY_RUN) {
    console.log('dry-run のため書き換えなし')
    return
  }

  const backupDir = path.join(DATA_DIR, `backup-prune-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(backupDir, { recursive: true })
  for (const f of Object.values(files)) {
    if (existsSync(f)) await copyFile(f, path.join(backupDir, path.basename(f)))
  }
  console.log(`バックアップ: ${backupDir}`)

  await writeJsonlAtomic(files.notifications, keptNotifications)
  await writeJsonlAtomic(files.replies, keptReplies)
  await writeJsonlAtomic(files.approvals, keptApprovals)
  if (clientEvents) await writeJsonlAtomic(files.clientEvents, clientEvents.filter((e) => isFresh(e, cutoffIso)))
  if (relayEvents) await writeJsonlAtomic(files.replyRelayEvents, relayEvents.filter((e) => isFresh(e?.reply ?? e, cutoffIso)))
  console.log('完了。Hub を再起動してください（cc-g2）')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
