/**
 * HubTransport — 現行の Hub(:8787)HTTP/SSE 経路を Transport 抽象に載せたもの。
 * 挙動は Phase A リファクタ前と同一(移設のみ)。
 */
import { appConfig, canUseOpenaiRealtimeStt, canUseSonioxStt, createHubHeaders } from '../config'
import { createNotificationClient } from '../notifications'
import { transcribePcmChunks } from '../stt/groq'
import { OpenAIRealtimeSTT } from '../stt/openai-realtime'
import { createHubSonioxKeyProvider, SonioxRealtimeSTT } from '../stt/soniox-realtime'
import { connectNotificationSSE } from '../hub/sse-client'
import type { Transport } from './types'

export function createHubTransport(): Transport {
  return {
    mode: 'hub',
    notifications: createNotificationClient(appConfig.notificationHubUrl),

    async fetchImageBlob(imageId: string): Promise<Blob> {
      const res = await fetch(
        `${appConfig.notificationHubUrl}/api/images/${encodeURIComponent(imageId)}`,
        { headers: createHubHeaders() },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    },

    connectEvents(ctx) {
      connectNotificationSSE(ctx)
    },

    createRealtimeStt() {
      if (canUseSonioxStt()) {
        return new SonioxRealtimeSTT(
          createHubSonioxKeyProvider(appConfig.notificationHubUrl, createHubHeaders()),
        )
      }
      if (canUseOpenaiRealtimeStt()) return new OpenAIRealtimeSTT(appConfig.notificationHubUrl, createHubHeaders())
      return null
    },

    transcribeBatch(chunks) {
      return transcribePcmChunks(chunks)
    },
  }
}
