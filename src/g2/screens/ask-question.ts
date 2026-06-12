/**
 * G2 画面: AskUserQuestion（質問＋選択肢リスト）
 *
 * リファクタ Phase 5 で src/glasses-ui.ts から無編集移動。
 * core（描画ロック・レイアウト状態を内包）は createGlassesUI() が1回だけ生成し、
 * ここへは関数引数で渡す（モジュールレベル import でロックを共有しない。
 * src/g2/render-core.ts の凍結ヘッダ参照）。
 */
import type { BridgeConnection } from '../../bridge'
import { log } from '../../log'
import { byteLen, truncateByBytes } from '../text-format'
import type { RenderCore } from '../render-core'

// ヘッダー（52px, isEventCapture=0で非スクロール）に収まるバイト上限。
// 超える質問は先にページネーション付き詳細画面で全文を表示する。
const ASK_QUESTION_SHORT_THRESHOLD = 150

/** AskUserQuestion の質問データ（Hub metadata から取得） */
export type AskQuestionData = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

export function createAskQuestionScreens(core: RenderCore) {
  const { renderHeaderListPage } = core

  return {
    /**
     * AskUserQuestion の質問本文が短いかを判定（[i/n]プレフィックスは含まない）。
     * 短い場合は質問+選択肢の複合画面、長い場合は先にページネーション付き詳細表示。
     */
    isAskQuestionShort(questionData: AskQuestionData): boolean {
      return byteLen(questionData.question) <= ASK_QUESTION_SHORT_THRESHOLD
    },

    /**
     * AskUserQuestion の質問テキスト全文を詳細表示用に組み立てる。
     * 質問本文＋選択肢ラベル・説明を含む。
     */
    buildAskQuestionFullText(questionData: AskQuestionData, questionIndex: number, totalQuestions: number): string {
      const parts: string[] = []
      const qNum = totalQuestions > 1 ? `[${questionIndex + 1}/${totalQuestions}] ` : ''
      parts.push(`${qNum}${questionData.question}`)
      if (questionData.options.length > 0) {
        parts.push('')
        parts.push('--- 選択肢 ---')
        for (const opt of questionData.options) {
          const desc = opt.description ? `: ${opt.description}` : ''
          parts.push(`• ${opt.label}${desc}`)
        }
      }
      return parts.join('\n')
    },

    /**
     * AskUserQuestion の選択肢をG2に表示する
     * 質問テキスト + 選択肢リスト（ListContainer）
     */
    async showAskUserQuestion(
      conn: BridgeConnection,
      questionData: AskQuestionData,
      questionIndex: number,
      totalQuestions: number,
    ): Promise<void> {
      if (!conn.bridge) {
        log(`[Mock] G2 AskUserQuestion: "${questionData.question}"`)
        return
      }

      const qNum = totalQuestions > 1 ? `[${questionIndex + 1}/${totalQuestions}] ` : ''

      const optionLabels = questionData.options.map((o) => o.label)
      optionLabels.push('その他（音声）', '◀ 戻る')

      // SDK上限: TextContainer + ListContainer 各コンテンツが 999 bytes 以内
      // ヘッダーテキストが長すぎるとファームウェアがページ全体を破棄するため切り詰める
      const headerBudget = 999 - byteLen(qNum)
      const headerText = `${qNum}${truncateByBytes(questionData.question, headerBudget)}`

      await renderHeaderListPage(conn, {
        headerContainerName: 'ask-q-hdr',
        headerYPosition: 4,
        headerHeight: 52,
        headerContent: headerText,
        listContainerName: 'ask-q-lst',
        listYPosition: 58,
        listHeight: 210,
        listItems: optionLabels,
        targetLayout: 'ask-question',
        layoutSet: 'ask-question',
      })
      log(`G2に AskUserQuestion 表示: "${questionData.question}" options=${optionLabels.length}`)
    },
  }
}
