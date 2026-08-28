// 投稿済み承認・Stop メッセージ対応表・既読通知 id の永続化(data/state.json)。
// 書き込みは tmp + rename のアトミック置換 + 500ms デバウンス。破損・消失時は空で開始し、
// pending は reconciliation が再投稿する(重複投稿は許容 — plan §12)。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../logger'
import { errorMessage } from '../logger'

export type ApprovalEntryStatus = 'posted' | 'closed'

export interface PostedMessage {
  chatId: number
  messageId: number
  /** クローズ時の editMessageText(本文+フッタ)用に投稿時の HTML を保持 */
  text: string
}

export interface ApprovalEntry {
  /** 重複投稿も全部追跡し、クローズ時に best effort で全件のボタンを無効化する */
  messages: PostedMessage[]
  status: ApprovalEntryStatus
  postedAt: string
  closedAt?: string
}

export interface StopMessageEntry {
  notificationId: string
  /** TTL 判定用の投稿時刻(古い返信先への注入を防ぐ — 判定は StopReplyRelay 側) */
  postedAt: string
}

export interface StatusMessageRef {
  chatId: number
  messageId: number
}

interface StateData {
  postedApprovals: Record<string, ApprovalEntry>
  /** `chatId:messageId` → StopMessageEntry(message_id は chat 単位のため複合キー) */
  stopMessages: Record<string, StopMessageEntry>
  seenNotificationIds: string[]
  /** ピン留めステータスメッセージ(StatusFlow が編集し続ける 1 件)。無ければ未投稿 */
  statusMessage?: StatusMessageRef
}

const SEEN_LIMIT = 500
const STOP_MESSAGES_LIMIT = 200
const CLOSED_GC_MS = 24 * 60 * 60 * 1000
const SAVE_DEBOUNCE_MS = 500

function emptyState(): StateData {
  return { postedApprovals: {}, stopMessages: {}, seenNotificationIds: [] }
}

function messageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`
}

/** 旧形式(値が notificationId の string)からの移行。postedAt は load 時刻起点で TTL を効かせる */
function migrateStopMessages(raw: unknown): Record<string, StopMessageEntry> {
  if (!raw || typeof raw !== 'object') return {}
  const now = new Date().toISOString()
  const result: Record<string, StopMessageEntry> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = { notificationId: value, postedAt: now }
    } else if (
      value &&
      typeof value === 'object' &&
      typeof (value as StopMessageEntry).notificationId === 'string' &&
      typeof (value as StopMessageEntry).postedAt === 'string'
    ) {
      result[key] = value as StopMessageEntry
    }
  }
  return result
}

export class StateStore {
  private readonly data: StateData
  private readonly seenSet: Set<string>
  private dirty = false
  private saveTimer: NodeJS.Timeout | null = null
  private saveChain: Promise<void> = Promise.resolve()

  private constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    data: StateData,
  ) {
    this.data = data
    this.seenSet = new Set(data.seenNotificationIds)
  }

  static async load(filePath: string, logger: Logger): Promise<StateStore> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StateData>
      const data: StateData = {
        postedApprovals:
          parsed.postedApprovals && typeof parsed.postedApprovals === 'object'
            ? parsed.postedApprovals
            : {},
        stopMessages: migrateStopMessages(parsed.stopMessages),
        seenNotificationIds: Array.isArray(parsed.seenNotificationIds)
          ? parsed.seenNotificationIds.filter((x): x is string => typeof x === 'string')
          : [],
        statusMessage:
          parsed.statusMessage &&
          typeof parsed.statusMessage.chatId === 'number' &&
          typeof parsed.statusMessage.messageId === 'number'
            ? parsed.statusMessage
            : undefined,
      }
      return new StateStore(filePath, logger, data)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          `state load failed (${errorMessage(err)}); starting empty — pending は reconciliation で再投稿される`,
        )
      }
      return new StateStore(filePath, logger, emptyState())
    }
  }

  getApproval(approvalId: string): ApprovalEntry | undefined {
    return this.data.postedApprovals[approvalId]
  }

  setApproval(approvalId: string, entry: ApprovalEntry): void {
    this.data.postedApprovals[approvalId] = entry
    this.scheduleSave()
  }

  getApprovals(): Readonly<Record<string, ApprovalEntry>> {
    return this.data.postedApprovals
  }

  /** 承認メッセージ本体への直接返信の突合(複合キー相当の走査) */
  findApprovalByMessage(chatId: number, messageId: number): string | null {
    for (const [approvalId, entry] of Object.entries(this.data.postedApprovals)) {
      if (entry.messages.some((m) => m.chatId === chatId && m.messageId === messageId)) {
        return approvalId
      }
    }
    return null
  }

  /** 平文テキスト中継の返信先: 追跡中 Stop 通知のうち最新 postedAt のもの(TTL 判定は呼び出し側) */
  findLatestStopMessage(chatId: number): { messageId: number; entry: StopMessageEntry } | null {
    const prefix = `${chatId}:`
    let latest: { messageId: number; entry: StopMessageEntry } | null = null
    let latestMs = -Infinity
    for (const [key, entry] of Object.entries(this.data.stopMessages)) {
      if (!key.startsWith(prefix)) continue
      const postedMs = Date.parse(entry.postedAt)
      // 同時刻タイは挿入順の後勝ち(Object.entries は挿入順を保つ)
      if (Number.isFinite(postedMs) && postedMs >= latestMs) {
        latestMs = postedMs
        latest = { messageId: Number(key.slice(prefix.length)), entry }
      }
    }
    return latest
  }

  addStopMessage(chatId: number, messageId: number, notificationId: string): void {
    this.data.stopMessages[messageKey(chatId, messageId)] = {
      notificationId,
      postedAt: new Date().toISOString(),
    }
    const keys = Object.keys(this.data.stopMessages)
    for (let i = 0; i < keys.length - STOP_MESSAGES_LIMIT; i += 1) {
      delete this.data.stopMessages[keys[i]!]
    }
    this.scheduleSave()
  }

  getStopMessage(chatId: number, messageId: number): StopMessageEntry | undefined {
    return this.data.stopMessages[messageKey(chatId, messageId)]
  }

  getStatusMessage(): StatusMessageRef | undefined {
    return this.data.statusMessage
  }

  setStatusMessage(ref: StatusMessageRef | undefined): void {
    this.data.statusMessage = ref
    this.scheduleSave()
  }

  hasSeen(notificationId: string): boolean {
    return this.seenSet.has(notificationId)
  }

  markSeen(notificationId: string): void {
    if (this.seenSet.has(notificationId)) return
    this.seenSet.add(notificationId)
    this.data.seenNotificationIds.push(notificationId)
    while (this.data.seenNotificationIds.length > SEEN_LIMIT) {
      const removed = this.data.seenNotificationIds.shift()
      if (removed) this.seenSet.delete(removed)
    }
    this.scheduleSave()
  }

  /** closed から 24h 経過した承認エントリを削除する(reconciliation 周期で呼ぶ) */
  gc(nowMs: number): void {
    let changed = false
    for (const [approvalId, entry] of Object.entries(this.data.postedApprovals)) {
      const closedMs = entry.closedAt ? Date.parse(entry.closedAt) : NaN
      if (entry.status === 'closed' && Number.isFinite(closedMs) && nowMs - closedMs > CLOSED_GC_MS) {
        delete this.data.postedApprovals[approvalId]
        changed = true
      }
    }
    if (changed) this.scheduleSave()
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      void this.flushNow()
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  async flushNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return
    this.dirty = false
    const snapshot = JSON.stringify(this.data, null, 2)
    this.saveChain = this.saveChain
      .then(async () => {
        const tmpPath = `${this.filePath}.tmp`
        await mkdir(path.dirname(this.filePath), { recursive: true })
        await writeFile(tmpPath, snapshot, 'utf8')
        await rename(tmpPath, this.filePath)
      })
      .catch((err) => {
        this.logger.warn(`state save failed: ${errorMessage(err)}`)
      })
    await this.saveChain
  }
}
