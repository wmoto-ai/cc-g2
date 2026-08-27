/**
 * Telegram メッセージ → 通知モデル(NotificationItem/Detail)の純変換。
 * GramJS に依存しない(テスト容易性のため TgMessageLike に正規化してから渡す)。
 *
 * 分類はアダプタが付与する安定マーカー行のみに依存する
 * （本文・フッタ文言のパースは禁止）。
 * マーカー定数はアダプタ側 packages/telegram-adapter/src/telegram/format.ts の
 * G2_MARKER と一致していること(test/telegram-model.test.ts で相互検証)。
 */
import type { NotificationDetail, NotificationItem } from '../../notifications'

export const TG_MARKER = {
  stop: '· cc-g2:stop',
  generic: '· cc-g2:generic',
  image: '· cc-g2:image',
  approval: '· cc-g2:approval',
  status: '· cc-g2:status',
} as const

/**
 * 任意のセッションタグ meta 行。マーカー行の直後に付き、セッション別絞り込みに使う。
 * 分類(classify)には影響させず、本文(bodyOf)からは除去する。後方互換: meta 行が
 * 無い旧メッセージも従来どおり動く。アダプタ側 G2_META(packages/telegram-adapter/
 * src/telegram/format.ts)と一致していること(test/telegram-model.test.ts で相互検証)。
 */
export const TG_META = {
  sessPrefix: '· cc-g2:meta sess=',
} as const

/** meta 行(`· cc-g2:meta sess=<slug>`)からセッションスラグを取り出す(無ければ undefined) */
function sessionLabelOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(TG_META.sessPrefix)) {
      const slug = trimmed.slice(TG_META.sessPrefix.length).trim()
      if (slug) return slug
    }
  }
  return undefined
}

/** status はピン留めステータス(通知ではない — transport が ctx へ反映し、一覧には出さない) */
export type TgMessageKind = 'approval' | 'stop' | 'generic' | 'image' | 'status' | 'other'

/** GramJS の Message から正規化した最小形(transport 層で詰め替える) */
export interface TgMessageLike {
  id: number
  /** unix 秒(Telegram の message.date) */
  dateSec: number
  /** プレーンテキスト(photo は caption) */
  text: string
  /** 自分(userbot)発のメッセージか */
  out: boolean
  hasPhoto: boolean
  /** inline keyboard の callback_data(無ければ空配列) */
  buttonData: string[]
}

/**
 * bot 発メッセージ中のマーカー行を探す。decide 後の editMessageText は
 * 「投稿時テキスト + 空行 + 決着フッタ」なのでマーカーは最終行とは限らない。
 * ユーザー発メッセージは out=true で先に弾くため、行スキャンで安全。
 */
function findMarkerLine(text: string): string | null {
  const markers = new Set<string>(Object.values(TG_MARKER))
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (markers.has(trimmed)) return trimmed
  }
  return null
}

/** アダプタの承認 callback_data(apr|/dny|/cmt|)を持つか */
function hasApprovalButtons(msg: TgMessageLike): boolean {
  return msg.buttonData.some((d) => /^(apr|dny|cmt)\|/.test(d))
}

export function classifyTgMessage(msg: TgMessageLike): TgMessageKind {
  if (msg.out) return 'other'
  const marker = findMarkerLine(msg.text)
  if (marker === TG_MARKER.approval) return 'approval'
  if (marker === TG_MARKER.stop) return 'stop'
  if (marker === TG_MARKER.image && msg.hasPhoto) return 'image'
  if (marker === TG_MARKER.generic) return 'generic'
  if (marker === TG_MARKER.status) return 'status'
  // マーカー導入(2026-07-11)以前に投稿された承認へのフォールバック
  if (hasApprovalButtons(msg)) return 'approval'
  return 'other'
}

// --- ピン留めステータス(アダプタ StatusFlow が定期 edit)のペイロード ---
// 形式はアダプタ側 packages/telegram-adapter/src/telegram/format.ts の StatusPayload と
// 相互検証テストで同期する。JSON 1 行(バージョン v 付き)のみに依存し、サマリ行は読まない。

export interface TgStatusPayload {
  /** 生成時刻(unix 秒)。古いペイロード(アダプタ停止中のピン)は捨てる用 */
  ts: number
  /** null = アダプタが取得失敗(前回値を維持)。[] = 取得できて 0 件(クリアする) */
  contextSessions: { sessionId: string; cwd: string; usedPercentage: number; model: string }[] | null
  /** null = アダプタが取得失敗(前回値を維持)。[] = 取得できて 0 件(クリアする) */
  sessionActivities: { tmuxTarget: string; label: string; state: 'active' | 'idle' | 'error' | 'dead' }[] | null
}

const ACTIVITY_STATES = new Set(['active', 'idle', 'error', 'dead'])

export function parseStatusPayload(text: string): TgStatusPayload | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    try {
      const parsed = JSON.parse(trimmed) as {
        v?: unknown
        ts?: unknown
        ctx?: unknown
        activity?: unknown
      }
      if (parsed.v !== 1 || typeof parsed.ts !== 'number') return null
      // フィールド欠落 = アダプタ側の取得失敗 → null(前回値維持)。[] = 0 件(クリア)
      return {
        ts: parsed.ts,
        contextSessions: Array.isArray(parsed.ctx)
          ? parsed.ctx.filter(
              (s): s is { sessionId: string; cwd: string; usedPercentage: number; model: string } =>
                s != null &&
                typeof s.sessionId === 'string' &&
                typeof s.cwd === 'string' &&
                typeof s.usedPercentage === 'number' &&
                typeof s.model === 'string',
            )
          : null,
        sessionActivities: Array.isArray(parsed.activity)
          ? parsed.activity
              .filter(
                (a): a is { tmuxTarget: string; label: string; state: string } =>
                  a != null &&
                  typeof a.tmuxTarget === 'string' &&
                  typeof a.label === 'string' &&
                  typeof a.state === 'string',
              )
              .map((a) => ({
                ...a,
                // 未知の state は安全側(idle)に落とす(アダプタ側の前方互換 string に対応)
                state: (ACTIVITY_STATES.has(a.state) ? a.state : 'idle') as 'active' | 'idle' | 'error' | 'dead',
              }))
          : null,
      }
    } catch {
      return null
    }
  }
  return null
}

/** 表示タイトル: 先頭行から種別絵文字プレフィックスを除去(G2 リストのバイト節約) */
function titleOf(msg: TgMessageLike): string {
  const first = msg.text.split('\n', 1)[0]?.trim() ?? ''
  return first.replace(/^(🏁|📣|🔐|🖼)\s*/u, '') || '(no title)'
}

/** 本文: 末尾のマーカー行だけを除去したテキスト(決着フッタ等は保持) */
function bodyOf(msg: TgMessageLike): string {
  const lines = msg.text.split('\n')
  const kept: string[] = []
  const markers = new Set<string>(Object.values(TG_MARKER))
  for (const line of lines) {
    const trimmed = line.trim()
    if (markers.has(trimmed)) continue
    // meta 行(セッションタグ)も本文には出さない
    if (trimmed.startsWith(TG_META.sessPrefix)) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

function metadataOf(msg: TgMessageLike, kind: TgMessageKind): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  switch (kind) {
    case 'stop':
      meta.hookType = 'stop'
      break
    case 'approval':
      meta.hookType = 'permission-request'
      break
    case 'image':
      meta.imageId = `tg:${msg.id}`
      break
  }
  // 任意の meta 行があればセッションラベルを載せる(セッション別絞り込み用)
  const sessionLabel = sessionLabelOf(msg.text)
  if (sessionLabel) meta.sessionLabel = sessionLabel
  return meta
}

function replyStatusOf(msg: TgMessageLike, kind: TgMessageKind): string | undefined {
  if (kind === 'approval') return msg.buttonData.length > 0 ? 'pending' : 'decided'
  if (kind === 'stop') return 'delivered'
  return undefined
}

export function toNotificationItem(msg: TgMessageLike, kind: TgMessageKind): NotificationItem {
  const body = bodyOf(msg)
  return {
    id: String(msg.id),
    source: 'telegram',
    title: titleOf(msg),
    summary: body.slice(0, 64),
    createdAt: new Date(msg.dateSec * 1000).toISOString(),
    // Hub の意味論に合わせる(notification-utils.mjs:222): permission-request/stop は true、
    // hookType なし(画像・汎用)も true。false にすると詳細→操作メニューへ遷移できず
    // 「画像を見る」に到達できない(event-router.ts の replyCapable ガード)
    replyCapable: true,
    metadata: metadataOf(msg, kind),
    replyStatus: replyStatusOf(msg, kind),
  }
}

export function toNotificationDetail(msg: TgMessageLike, kind: TgMessageKind): NotificationDetail {
  return {
    ...toNotificationItem(msg, kind),
    fullText: bodyOf(msg),
  }
}
