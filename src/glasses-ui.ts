/**
 * Even G2 グラス側のUI操作
 *
 * テキスト表示、承認リクエスト（リスト選択）を提供。
 * G2ディスプレイ仕様: 576x288px, 4bitグレースケール（緑）, 最大4コンテナ
 *
 * 注意: G2実機ではリストのスクロール方向がファームウェア制御で物理操作と逆になる。
 * 現時点ではSDK標準ListContainerをそのまま使用し、方向反転は許容する。
 */
import type { NotificationItem, NotificationDetail } from './notifications'
import { paginateText } from './g2/text-format'
import { createRenderCore } from './g2/render-core'
import { createMiscScreens } from './g2/screens/misc'
import { buildNotificationActions, createNotificationScreens } from './g2/screens/notification'
import type { NotificationAction } from './g2/screens/notification'
import { createAskQuestionScreens } from './g2/screens/ask-question'
import type { AskQuestionData } from './g2/screens/ask-question'
import { createReplyScreens } from './g2/screens/reply'
import { createImageScreens } from './g2/screens/image'

// 後方互換: paginateText は従来 glasses-ui の export だった（テスト等が参照）
export { paginateText }

// 後方互換: 通知アクション・セッションアクティビティ型は従来 glasses-ui の export だった
// （main.ts / event-router / flows / context 等が参照）
export { buildNotificationActions }
export type { NotificationAction, SessionActivityState } from './g2/screens/notification'
export type { AskQuestionData } from './g2/screens/ask-question'

/** G2ディスプレイ上の通知UIの状態 */
export type NotificationUIState = {
  screen: 'idle' | 'list' | 'detail' | 'detail-actions' | 'image-detail' | 'ask-question' | 'ask-question-detail' | 'reply-recording' | 'reply-confirm' | 'reply-confirm-actions' | 'reply-sending'
  items: NotificationItem[]
  /** detail-actions のメニュー項目（表示時に組み立て、イベント処理で id 参照） */
  detailActions: NotificationAction[]
  selectedIndex: number
  /** detail画面のページ送り用（fullTextを複数ページに分割） */
  detailPages: string[]
  detailPageIndex: number
  detailItem: NotificationDetail | null
  /** 返信用STT結果テキスト */
  replyText: string
  /** AskUserQuestion: 現在表示中の質問データ */
  askQuestions: AskQuestionData[]
  /** AskUserQuestion: 現在の質問インデックス（複数質問対応） */
  askQuestionIndex: number
  /** AskUserQuestion: 回答の蓄積 { "質問テキスト": "選択ラベル" } */
  askAnswers: Record<string, string>
}

export function createGlassesUI() {
  // 描画基盤（ロック・レイアウト状態・描画関数一式）。生成はここで1回のみ。
  // 各画面の実装は core のメソッド経由で描画する（src/g2/render-core.ts の凍結ヘッダ参照）。
  const core = createRenderCore()

  // 画面モジュール（core を引数で受け取り、core 経由で描画する）
  const misc = createMiscScreens(core)
  const notification = createNotificationScreens(core, misc.showText)
  const askQuestion = createAskQuestionScreens(core)
  const reply = createReplyScreens(core)
  const image = createImageScreens(core)

  return {
    setSessionActivities: notification.setSessionActivities,

    /** 描画中かどうか（ポーリング等で衝突を避けるために使用） */
    isRendering(): boolean {
      return core.isRendering()
    },

    hasRenderedPage: misc.hasRenderedPage,
    ensureBasePage: misc.ensureBasePage,
    showText: misc.showText,
    showIdleLauncher: misc.showIdleLauncher,

    showNotificationList: notification.showNotificationList,
    showNotificationDetail: notification.showNotificationDetail,
    updateDetailHeaderBadge: notification.updateDetailHeaderBadge,
    getDetailPageCount: notification.getDetailPageCount,

    isAskQuestionShort: askQuestion.isAskQuestionShort,
    buildAskQuestionFullText: askQuestion.buildAskQuestionFullText,

    showNotificationActions: notification.showNotificationActions,

    showImage: image.showImage,

    showAskUserQuestion: askQuestion.showAskUserQuestion,

    showReplyRecording: reply.showReplyRecording,
    updateReplyRecordingBody: reply.updateReplyRecordingBody,
    showReplySttProcessing: reply.showReplySttProcessing,
    showReplyConfirmActions: reply.showReplyConfirmActions,
    showReplyResult: reply.showReplyResult,

    requestApproval: misc.requestApproval,
  }
}
