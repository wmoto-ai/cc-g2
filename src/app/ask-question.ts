/**
 * AskUserQuestion 通知の metadata 解析（純粋関数）
 *
 * リファクタ Phase 2 で main.ts から無編集移動。
 */
import type { AskQuestionData } from '../glasses-ui'
import type { NotificationDetail } from '../notifications'

export function isAskUserQuestionNotification(detail: NotificationDetail): boolean {
  const meta = detail.metadata
  return !!(meta && (meta.hookType === 'ask-user-question' || meta.toolName === 'AskUserQuestion'))
}

export function extractAskQuestions(detail: NotificationDetail): AskQuestionData[] {
  const meta = detail.metadata
  if (!meta) return []
  const questions = meta.questions
  if (!Array.isArray(questions)) return []
  return questions.filter(
    (q: unknown): q is AskQuestionData =>
      !!q && typeof q === 'object' && 'question' in q && 'options' in q && Array.isArray((q as AskQuestionData).options),
  )
}
