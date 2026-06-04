import type { SttResult } from './groq'
import { log } from '../log'

export type TranscriptCallback = (text: string, isFinal: boolean) => void

/**
 * Resample 16 kHz PCM16-LE mono to 24 kHz using linear interpolation.
 * Input/output are Uint8Array wrapping little-endian Int16 samples.
 */
function resample16kTo24k(pcm16k: Uint8Array): Uint8Array {
  const srcView = new DataView(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength)
  const srcSamples = pcm16k.byteLength / 2
  if (srcSamples === 0) return new Uint8Array(0)

  // ratio 16000 -> 24000 = 2 -> 3
  const dstSamples = Math.ceil((srcSamples * 3) / 2)
  const dst = new DataView(new ArrayBuffer(dstSamples * 2))

  for (let i = 0; i < dstSamples; i++) {
    // Map destination index back to source position
    const srcPos = (i * 2) / 3
    const srcIdx = Math.floor(srcPos)
    const frac = srcPos - srcIdx

    const s0 = srcIdx < srcSamples ? srcView.getInt16(srcIdx * 2, true) : 0
    const s1 = srcIdx + 1 < srcSamples ? srcView.getInt16((srcIdx + 1) * 2, true) : s0
    const interpolated = Math.round(s0 + frac * (s1 - s0))
    // clamp to Int16 range
    const clamped = Math.max(-32768, Math.min(32767, interpolated))
    dst.setInt16(i * 2, clamped, true)
  }

  return new Uint8Array(dst.buffer)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * OpenAI Realtime API streaming STT client.
 *
 * Connects via WebSocket to OpenAI's realtime transcription endpoint
 * using an ephemeral token obtained from the Hub server.
 */
export class OpenAIRealtimeSTT {
  private hubUrl: string
  private hubHeaders: HeadersInit
  private ws: WebSocket | null = null
  private onTranscript: TranscriptCallback | null = null
  private transcriptParts: string[] = []
  private sessionReady = false
  private stopped = false
  private aborted = false
  /** OpenAI Realtime API requires 24 kHz PCM16 input; G2 sends 16 kHz */
  private needsResample = true
  /** Pending resolve for start() waiting on session.created */
  private startResolve: (() => void) | null = null
  private startTimeout: ReturnType<typeof setTimeout> | null = null
  /** Pending resolve for stop() waiting on final transcript */
  private stopResolve: ((result: SttResult) => void) | null = null
  private stopTimeout: ReturnType<typeof setTimeout> | null = null
  /** Buffer audio chunks received before session is ready */
  private pendingAudio: Uint8Array[] = []

  constructor(hubUrl: string, hubHeaders: HeadersInit) {
    this.hubUrl = hubUrl
    this.hubHeaders = hubHeaders
  }

  /**
   * Start the realtime session:
   * 1. Fetch ephemeral token from Hub
   * 2. Open WebSocket to OpenAI
   * 3. Configure transcription session
   */
  async start(onTranscript: TranscriptCallback): Promise<void> {
    this.onTranscript = onTranscript
    this.transcriptParts = []
    this.sessionReady = false
    this.stopped = false
    this.aborted = false
    this.pendingAudio = []

    // 1. Get ephemeral token
    const token = await this.fetchEphemeralToken()

    // 2. Open WebSocket
    const url = 'wss://api.openai.com/v1/realtime'
    this.ws = new WebSocket(url, [
      'realtime',
      `openai-insecure-api-key.${token}`,
    ])

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!

      this.startResolve = resolve
      this.startTimeout = setTimeout(() => {
        this.startResolve = null
        this.startTimeout = null
        reject(new Error('OpenAI Realtime: session.created timeout (10s)'))
        ws.close()
      }, 10_000)

      ws.addEventListener('open', () => {
        log('OpenAI Realtime: WebSocket connected, waiting for session.created...')
      })

      ws.addEventListener('error', () => {
        if (this.startTimeout) clearTimeout(this.startTimeout)
        this.startTimeout = null
        this.startResolve = null
        log('OpenAI Realtime: WebSocket error')
        reject(new Error('OpenAI Realtime: WebSocket error'))
      })

      ws.addEventListener('close', (ev) => {
        log(`OpenAI Realtime: WebSocket closed (code=${ev.code}, reason=${ev.reason})`)
        if (this.startResolve) {
          if (this.startTimeout) clearTimeout(this.startTimeout)
          this.startTimeout = null
          this.startResolve = null
          reject(new Error(`OpenAI Realtime: WebSocket closed before session ready (code=${ev.code})`))
        }
        this.handleClose()
      })

      ws.addEventListener('message', (ev) => {
        this.handleMessage(ev.data)
      })
    })
  }

  /**
   * Send a PCM audio chunk to the realtime session.
   * Safe to call before session is ready (chunks are buffered)
   * or after stop/abort (silently ignored).
   */
  sendAudio(pcm: Uint8Array): void {
    if (this.stopped || this.aborted) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Buffer if not yet connected
      this.pendingAudio.push(pcm)
      return
    }
    if (!this.sessionReady) {
      this.pendingAudio.push(pcm)
      return
    }
    this.sendAudioChunk(pcm)
  }

  /**
   * Stop the session: commit remaining audio, wait for final transcript, close.
   */
  async stop(): Promise<SttResult> {
    if (this.aborted || !this.ws) {
      return this.buildResult()
    }

    this.stopped = true

    // Flush any pending buffered audio
    this.flushPendingAudio()

    // Commit remaining audio buffer
    if (this.ws.readyState === WebSocket.OPEN) {
      this.wsSend({ type: 'input_audio_buffer.commit' })
    }

    // Wait for final transcription with timeout
    const result = await new Promise<SttResult>((resolve) => {
      this.stopResolve = resolve

      this.stopTimeout = setTimeout(() => {
        log('OpenAI Realtime: stop() timeout waiting for final transcript (5s)')
        this.stopResolve = null
        resolve(this.buildResult())
      }, 5_000)
    })

    this.cleanup()
    return result
  }

  /**
   * Abort the session immediately, discarding any pending data.
   */
  abort(): void {
    this.aborted = true
    this.stopped = true
    this.pendingAudio = []
    this.cleanup()
  }

  // --- Private ---

  private async fetchEphemeralToken(): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // Merge hub headers
    if (this.hubHeaders) {
      if (this.hubHeaders instanceof Headers) {
        this.hubHeaders.forEach((v, k) => { headers[k] = v })
      } else if (Array.isArray(this.hubHeaders)) {
        for (const [k, v] of this.hubHeaders) headers[k] = v
      } else {
        Object.assign(headers, this.hubHeaders)
      }
    }

    const res = await fetch(`${this.hubUrl}/api/stt/realtime-token`, {
      method: 'POST',
      headers,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Failed to get realtime token: ${res.status} ${res.statusText} ${body}`.trim())
    }

    const json = (await res.json()) as { token: string; expiresAt?: string }
    if (!json.token) {
      throw new Error('Realtime token response missing "token" field')
    }

    log(`OpenAI Realtime: ephemeral token obtained (expires: ${json.expiresAt ?? 'unknown'})`)
    return json.token
  }

  private handleMessage(data: string | ArrayBuffer | Blob): void {
    if (typeof data !== 'string') return

    let msg: { type: string; [key: string]: unknown }
    try {
      msg = JSON.parse(data)
    } catch {
      log(`OpenAI Realtime: failed to parse message`)
      return
    }

    switch (msg.type) {
      case 'session.created':
      case 'session.updated':
        log(`OpenAI Realtime: ${msg.type}`)
        if (!this.sessionReady) {
          this.sessionReady = true
          this.flushPendingAudio()
          if (this.startResolve) {
            clearTimeout(this.startTimeout!)
            this.startTimeout = null
            this.startResolve()
            this.startResolve = null
          }
        }
        break

      case 'conversation.item.input_audio_transcription.delta': {
        const delta = (msg as { delta?: string }).delta ?? ''
        if (delta && this.onTranscript) {
          this.onTranscript(delta, false)
        }
        break
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = (msg as { transcript?: string }).transcript ?? ''
        if (transcript) {
          this.transcriptParts.push(transcript)
          if (this.onTranscript) {
            this.onTranscript(transcript, true)
          }
        }
        this.resolveStopIfWaiting()
        break
      }

      case 'error': {
        const errorMsg = (msg as { error?: { message?: string } }).error?.message ?? JSON.stringify(msg)
        log(`OpenAI Realtime: error: ${errorMsg}`)
        this.resolveStopIfWaiting()
        break
      }

      default:
        log(`OpenAI Realtime: event ${msg.type}`)
        break
    }
  }

  private resolveStopIfWaiting(): void {
    if (this.stopped && this.stopResolve) {
      if (this.stopTimeout) clearTimeout(this.stopTimeout)
      this.stopTimeout = null
      const resolve = this.stopResolve
      this.stopResolve = null
      resolve(this.buildResult())
    }
  }

  private handleClose(): void {
    // If stop() is waiting, resolve with what we have
    if (this.stopResolve) {
      if (this.stopTimeout) clearTimeout(this.stopTimeout)
      this.stopTimeout = null
      const resolve = this.stopResolve
      this.stopResolve = null
      resolve(this.buildResult())
    }
    this.ws = null
  }

  private sendAudioChunk(pcm: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const audioData = this.needsResample ? resample16kTo24k(pcm) : pcm
    const base64 = bytesToBase64(audioData)
    this.wsSend({
      type: 'input_audio_buffer.append',
      audio: base64,
    })
  }

  private flushPendingAudio(): void {
    if (!this.sessionReady || this.pendingAudio.length === 0) return
    const pending = this.pendingAudio
    this.pendingAudio = []
    for (const chunk of pending) {
      this.sendAudioChunk(chunk)
    }
  }

  private wsSend(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  private buildResult(): SttResult {
    return {
      text: this.transcriptParts.join(''),
      provider: 'openai-realtime',
      model: 'gpt-realtime-whisper',
    }
  }

  private cleanup(): void {
    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout)
      this.stopTimeout = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.sessionReady = false
    this.pendingAudio = []
  }
}
