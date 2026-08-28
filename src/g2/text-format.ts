/**
 * G2 表示用テキスト整形の純粋関数群
 *
 * SDK・DOM・モジュール状態に依存しない関数のみを置く（リファクタ Phase 2 で
 * glasses-ui.ts から無編集移動）。バイト計算はすべて UTF-8 基準。
 */
import type { NotificationItem } from '../notifications'
import { t } from '../i18n'

// ListContainer アイテムの公式上限（hub.evenrealities.com/docs/guides/display:
// 最大20件・1件あたり最大「64文字」）。超過はページ全体が Invalid parameters で拒否される。
// 注意: §5（公称1,000文字の実体がUTF-8 999バイトだった）と同じく、この「64文字」も
// UTF-8 バイト基準とみられる。実測 (2026-06-10): 64文字だが66バイトのアイテム
// （ASCII 63字+「…」3バイト）で rebuild/createStartUp が code=1 で失敗し続けた。
// 安全側の63バイトを上限とする。
export const LIST_ITEM_MAX_BYTES = 63

/**
 * G2表示用: fullTextをチャンク分割する（UTF-8バイト数基準）。
 * ファームウェアがコンテナ内テキストの自動スクロールを処理するため、
 * 1チャンクを maxBytes UTF-8バイト以内に収める。
 * SDKの文字数制限はUTF-8バイト基準（日本語3bytes/文字のため
 * コードポイント数では正確に制御できない）。
 * SCROLL_TOP/SCROLL_BOTTOM イベントはチャンク境界でのみ発火される。
 *
 * コードポイント単位で走査しサロゲートペア安全。
 * 本文のインデントや空白は保持する（全体のtrimのみ）。
 */
const textEncoder = new TextEncoder()

export function paginateText(text: string, maxBytes = 999): string[] {
  const normalized = text?.replace(/\r\n/g, '\n').trim() ?? ''
  if (!normalized) return [t('body_none')]

  const chars = Array.from(normalized)
  const pages: string[] = []
  let pos = 0

  while (pos < chars.length) {
    let end = pos
    let byteCount = 0
    while (end < chars.length) {
      const charBytes = textEncoder.encode(chars[end]).length
      if (byteCount + charBytes > maxBytes) break
      byteCount += charBytes
      end++
    }
    if (end === pos) end = pos + 1 // 1文字がmaxBytesを超える場合は最低1文字進める

    // 改行位置でチャンクを切る（改行なしの場合はバイト上限で強制カット）
    if (end < chars.length) {
      for (let i = end - 1; i > pos; i--) {
        if (chars[i] === '\n') {
          end = i + 1
          break
        }
      }
    }
    pages.push(chars.slice(pos, end).join(''))
    pos = end
  }

  return pages.length > 0 ? pages : [t('body_none')]
}

/** metadata.cwdからプロジェクト名を抽出（短縮） */
function extractProjectSlug(cwd: string): string {
  const name = cwd.split('/').filter(Boolean).pop() || ''
  return name.length > 10 ? name.slice(0, 9) + '…' : name
}

/**
 * tmux ターゲット名からセッションラベル（#1, #2 …）を導出する。
 * セッション名: g2-<slug>-<hash4>[-codex|-copilot][-N]。末尾 -N を剥がしてから
 * hash(+エージェント種別)終端を判定する。エージェント種別はラベルに含めない。
 * 注意: server/notification-hub/notification-utils.mjs と scripts/lib/common.sh
 * (derive_session_label) に同一ロジックの実装がある（ビルド境界が異なるため統合
 * 不可）。変更時は 3 実装を揃えること。同一性は
 * test/derive-session-label-cross.test.ts が監視している。
 */
export function deriveSessionLabel(tmuxTarget: string): string {
  const session = tmuxTarget.split(':')[0] || ''
  const numbered = session.match(/-(\d+)$/)
  if (numbered) {
    const prefix = session.slice(0, -numbered[0].length)
    if (/-[0-9a-f]{4}(?:-codex|-copilot)?$/.test(prefix)) return `#${numbered[1]}`
  }
  if (/-[0-9a-f]{4}(?:-codex|-copilot)?$/.test(session)) return '#1'
  return ''
}

export function getNotificationPrefix(item: NotificationItem): string {
  const meta = item.metadata ?? {}
  const sessionLabelFromMeta = typeof meta.sessionLabel === 'string' ? meta.sessionLabel.trim() : ''
  const tmuxTarget = typeof meta.tmuxTarget === 'string' ? meta.tmuxTarget.trim() : ''
  const sessionLabel = sessionLabelFromMeta || (tmuxTarget && tmuxTarget !== '[REDACTED]' ? deriveSessionLabel(tmuxTarget) : '')
  const cwd = typeof meta.cwd === 'string' ? meta.cwd.trim() : ''
  const projectMeta = typeof meta.project === 'string' ? meta.project.trim() : ''
  const safeProject = projectMeta || (cwd && cwd !== '[REDACTED]' ? extractProjectSlug(cwd) : '')
  const moshi = item.source !== 'claude-code' ? 'M:' : ''
  if (moshi) return moshi
  if (safeProject && sessionLabel) return `${safeProject}${sessionLabel}:`
  if (safeProject) return `${safeProject}:`
  if (sessionLabel) return `${sessionLabel}:`
  return ''
}

/** summaryからツール操作の要約を抽出（コマンド先頭やファイルパスなど） */
export function extractSnippet(summary: string, toolName: string): string {
  if (!summary) return ''
  // "Tool: Bash CWD: ..." 形式のプレフィックスを除去
  let s = summary.replace(/^Tool:\s*\S+\s*/i, '').replace(/^CWD:\s*\S+\s*/i, '').trim()
  // "$ " プレフィックスを除去
  s = s.replace(/^\$\s*/, '')
  // ファイルパスの場合はbasename
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') {
    const firstLine = s.split('\n')[0]
    const base = firstLine.split('/').pop() || firstLine
    return base.trim()
  }
  // コマンドの場合はそのまま（先頭の不要部分は除去済み）
  return s.split('\n')[0].trim()
}

/** UTF-8 バイト数で文字列を切り詰め。末尾に '…' を付ける。サロゲートペア安全。 */
export function truncateByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const fullBytes = textEncoder.encode(text).length
  if (fullBytes <= maxBytes) return text
  const ellipsis = '…'
  const ellipsisBytes = textEncoder.encode(ellipsis).length
  const budget = Math.max(0, maxBytes - ellipsisBytes)
  const chars = Array.from(text)
  let used = 0
  let out = ''
  for (const ch of chars) {
    const chBytes = textEncoder.encode(ch).length
    if (used + chBytes > budget) break
    out += ch
    used += chBytes
  }
  return out + ellipsis
}

export function byteLen(text: string): number {
  return textEncoder.encode(text).length
}

/**
 * STT結果などの単一テキストをG2スクロール表示用に整形する。
 * 空白を1スペースに正規化し、UTF-8で maxBytes に収まるよう truncateByBytes で切り詰める。
 * （旧 src/g2-format.ts。切り詰めロジックの実装は truncateByBytes と同一だったため一本化。
 *  maxBytes<=0 の場合のみ旧実装は '…' を返したが truncateByBytes は '' を返す。
 *  呼び出し側は常に正のバイト数を渡すため到達しない）
 */
export function formatForG2ScrollableText(text: string, maxBytes = 999): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return t('stt_no_result')
  return truncateByBytes(normalized, maxBytes)
}

/** 通知一覧のリスト項目を生成（G2リスト表示用） */
export function formatListItemName(item: NotificationItem): string {
  const age = formatAge(item.createdAt)
  const s = item.replyStatus
  const mark = s === 'delivered' || s === 'replied' ? '○' : s === 'decided' ? '>' : '●'
  // バイト基準の切り詰め: createStartUp の総バイト上限 (known-limitations §5: 999 bytes) を
  // 必ず下回るよう 1 アイテムあたり 45 bytes を上限とする。
  // 日本語(3byte/char)主体でも 20件 × 45byte = 900 bytes、ヘッダ ~40 bytes、合計 ~940 bytes。
  // 旧実装はコードポイント数で切っていたため日本語が混ざると 45char × 3byte = 135byte/item まで
  // 膨らみ、20件で 2700 bytes に達してファームがページ全体を silently 破棄していた。
  const prefix = mark + getNotificationPrefix(item)
  const suffix = ` (${age})`
  const maxBytes = 45
  const available = Math.max(6, maxBytes - byteLen(prefix) - byteLen(suffix))
  const toolName = item.title
  const snippet = extractSnippet(item.summary, toolName)
  let body: string
  if (snippet) {
    const combined = `${toolName} ${snippet}`
    if (byteLen(combined) <= available) {
      body = combined
    } else {
      // ツール名は最低限残し、残りをスニペットに割り当てる
      const toolBytes = Math.min(byteLen(toolName), Math.max(6, Math.floor(available / 2)))
      const toolPart = truncateByBytes(toolName, toolBytes)
      const snipSpace = available - byteLen(toolPart) - 1
      if (snipSpace >= 4) {
        body = `${toolPart} ${truncateByBytes(snippet, snipSpace)}`
      } else {
        body = truncateByBytes(toolName, available)
      }
    }
  } else {
    body = truncateByBytes(toolName, available)
  }
  return `${prefix}${body}${suffix}`
}

export function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function formatCurrentTime(now = new Date()): string {
  return now.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatCurrentDateTime(now = new Date()): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return `${now.getMonth() + 1}/${now.getDate()} ${weekdays[now.getDay()]} ${formatCurrentTime(now)}`
}
