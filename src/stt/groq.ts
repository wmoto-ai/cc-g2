import { appConfig, canUseGroqStt, createHubHeaders } from '../config'
import { concatChunks, encodePcm16kMonoS16leToWav } from '../audio/wav'

export type SttResult = {
  text: string
  provider: 'groq' | 'openai-realtime' | 'mock'
  model?: string
}

export async function transcribePcmChunks(chunks: Uint8Array[]): Promise<SttResult> {
  if (appConfig.sttForceError) {
    throw new Error('Forced STT error (VITE_STT_FORCE_ERROR=true)')
  }

  const pcm = concatChunks(chunks)
  if (pcm.byteLength === 0) {
    return {
      text: '',
      provider: 'mock',
    }
  }

  if (!canUseGroqStt()) {
    const durationSec = ((pcm.byteLength / 2) / 16_000).toFixed(1)
    return {
      text: `（STTモック）録音 ${durationSec}秒 / ${pcm.byteLength} bytes`,
      provider: 'mock',
    }
  }

  const wav = encodePcm16kMonoS16leToWav(pcm)
  return transcribeWavWithGroq(wav)
}

async function transcribeWavWithGroq(wavBytes: Uint8Array): Promise<SttResult> {
  const audioBase64 = bytesToBase64(wavBytes)
  const res = await fetch(`${appConfig.notificationHubUrl}/api/stt/transcriptions`, {
    method: 'POST',
    headers: createHubHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      audioBase64,
      mimeType: 'audio/wav',
      model: appConfig.groqModel,
      language: 'ja',
      response_format: 'verbose_json',
    }),
  })

  if (!res.ok) {
    const text = await safeReadText(res)
    throw new Error(`Hub STT failed: ${res.status} ${res.statusText} ${text}`.trim())
  }

  const json = (await res.json()) as { text?: string; provider?: 'groq' | 'mock'; model?: string }
  return {
    text: (json.text ?? '').trim(),
    provider: json.provider ?? 'groq',
    model: json.model ?? appConfig.groqModel,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}
