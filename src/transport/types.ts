/**
 * G2 UI と外部トランスポートを分離する抽象。
 *
 * G2 UI 層(src/g2/**)が触ってよい「外界」はこのインターフェースのみ。
 * hub モード(現行、Hub HTTP/SSE)と telegram モード(GramJS userbot)を
 * 起動時に選択し、AppContext.transport として注入する。
 */
import type { createNotificationClient } from '../notifications'
import type { SttResult } from '../stt/groq'
import type { AppContext } from '../app/context'

/** 通知 API(list / detail / reply)。hub モードは既存クライアントそのもの */
export type NotificationApi = ReturnType<typeof createNotificationClient>

/** リアルタイム STT セッション(Soniox / OpenAI Realtime 互換の最小面) */
export interface RealtimeStt {
  start(onTranscript: (text: string, isFinal: boolean) => void): Promise<void>
  sendAudio(pcm: Uint8Array): void
  stop(): Promise<SttResult>
  /** 結果を破棄して即時中断(キャンセル操作用) */
  abort(): void
}

export interface Transport {
  readonly mode: 'hub' | 'telegram'
  readonly notifications: NotificationApi
  /** 通知添付画像の取得(呼び出し側でタイル変換する) */
  fetchImageBlob(imageId: string): Promise<Blob>
  /** 新着・更新イベントの購読開始(hub: SSE / telegram: MTProto updates)。冪等であること */
  connectEvents(ctx: AppContext): void
  /** リアルタイム STT を構成できなければ null(バッチ STT へフォールバック) */
  createRealtimeStt(): RealtimeStt | null
  /** バッチ STT(録音停止後に一括変換)。構成がなければモック結果を返す */
  transcribeBatch(chunks: Uint8Array[]): Promise<SttResult>
}
