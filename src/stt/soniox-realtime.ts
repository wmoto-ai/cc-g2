import type { SttResult } from './groq'
import { log } from '../log'

export type TranscriptCallback = (text: string, isFinal: boolean) => void

/**
 * Soniox Realtime STT client.
 *
 * Connects via WebSocket to Soniox's streaming transcription endpoint
 * using a temporary API key obtained from the Hub server.
 *
 * Audio: PCM 16kHz mono s16le — no resampling needed (unlike OpenAI which requires 24kHz).
 * Protocol: binary frames for audio, JSON for config/results.
 */
export class SonioxRealtimeSTT {
  private hubUrl: string
  private hubHeaders: HeadersInit
  private ws: WebSocket | null = null
  private onTranscript: TranscriptCallback | null = null
  private finalText = ''
  private partialText = ''
  /** Tracks what was last emitted to onTranscript for computing deltas */
  private emittedFinalLen = 0
  private emittedPartial = ''
  private sessionReady = false
  private stopped = false
  private aborted = false
  private startResolve: (() => void) | null = null
  private startTimeout: ReturnType<typeof setTimeout> | null = null
  private stopResolve: ((result: SttResult) => void) | null = null
  private stopTimeout: ReturnType<typeof setTimeout> | null = null
  private pendingAudio: Uint8Array[] = []

  constructor(hubUrl: string, hubHeaders: HeadersInit) {
    this.hubUrl = hubUrl
    this.hubHeaders = hubHeaders
  }

  async start(onTranscript: TranscriptCallback): Promise<void> {
    this.onTranscript = onTranscript
    this.finalText = ''
    this.partialText = ''
    this.emittedFinalLen = 0
    this.emittedPartial = ''
    this.sessionReady = false
    this.stopped = false
    this.aborted = false
    this.pendingAudio = []

    const apiKey = await this.fetchTemporaryApiKey()

    const url = 'wss://stt-rt.soniox.com/transcribe-websocket'
    this.ws = new WebSocket(url)

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!

      this.startResolve = resolve
      this.startTimeout = setTimeout(() => {
        this.startResolve = null
        this.startTimeout = null
        reject(new Error('Soniox Realtime: connection timeout (10s)'))
        ws.close()
      }, 10_000)

      ws.binaryType = 'arraybuffer'

      ws.addEventListener('open', () => {
        log('Soniox Realtime: WebSocket connected, sending config...')
        ws.send(JSON.stringify({
          api_key: apiKey,
          model: 'stt-rt-v4',
          audio_format: 'pcm_s16le',
          sample_rate: 16000,
          num_channels: 1,
          language_hints: ['ja'],
          enable_endpoint_detection: true,
        }))
        this.sessionReady = true
        this.flushPendingAudio()
        if (this.startResolve) {
          clearTimeout(this.startTimeout!)
          this.startTimeout = null
          this.startResolve()
          this.startResolve = null
        }
      })

      ws.addEventListener('error', () => {
        if (this.startTimeout) clearTimeout(this.startTimeout)
        this.startTimeout = null
        this.startResolve = null
        log('Soniox Realtime: WebSocket error')
        reject(new Error('Soniox Realtime: WebSocket error'))
      })

      ws.addEventListener('close', (ev) => {
        log(`Soniox Realtime: WebSocket closed (code=${ev.code}, reason=${ev.reason})`)
        if (this.startResolve) {
          if (this.startTimeout) clearTimeout(this.startTimeout)
          this.startTimeout = null
          this.startResolve = null
          reject(new Error(`Soniox Realtime: WebSocket closed before ready (code=${ev.code})`))
        }
        this.handleClose()
      })

      ws.addEventListener('message', (ev) => {
        this.handleMessage(ev.data)
      })
    })
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.stopped || this.aborted) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push(pcm)
      return
    }
    if (!this.sessionReady) {
      this.pendingAudio.push(pcm)
      return
    }
    this.wsSendBinary(pcm)
  }

  async stop(): Promise<SttResult> {
    if (this.aborted || !this.ws) {
      return this.buildResult()
    }

    this.stopped = true
    this.flushPendingAudio()
    const stopRequestedAt = performance.now()

    // Send empty string to signal end of audio (per Soniox WebSocket API)
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send('')
    }

    // Real-time transcript is already available; wait briefly for
    // Soniox to finalize remaining tokens, but don't block long.
    const result = await new Promise<SttResult>((resolve) => {
      this.stopResolve = resolve

      this.stopTimeout = setTimeout(() => {
        const elapsed = (performance.now() - stopRequestedAt).toFixed(0)
        log(`Soniox Realtime: stop() timeout (${elapsed}ms), returning current transcript`)
        this.stopResolve = null
        resolve(this.buildResult())
      }, 1_500)
    })

    const elapsed = (performance.now() - stopRequestedAt).toFixed(0)
    log(`Soniox Realtime: stop() resolved in ${elapsed}ms`)
    this.cleanup()
    return result
  }

  abort(): void {
    this.aborted = true
    this.stopped = true
    this.pendingAudio = []
    this.cleanup()
  }

  // --- Private ---

  private async fetchTemporaryApiKey(): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.hubHeaders) {
      if (this.hubHeaders instanceof Headers) {
        this.hubHeaders.forEach((v, k) => { headers[k] = v })
      } else if (Array.isArray(this.hubHeaders)) {
        for (const [k, v] of this.hubHeaders) headers[k] = v
      } else {
        Object.assign(headers, this.hubHeaders)
      }
    }

    const res = await fetch(`${this.hubUrl}/api/stt/soniox-token`, {
      method: 'POST',
      headers,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Failed to get Soniox token: ${res.status} ${res.statusText} ${body}`.trim())
    }

    const json = (await res.json()) as { token: string; expiresAt?: string }
    if (!json.token) {
      throw new Error('Soniox token response missing "token" field')
    }

    log(`Soniox Realtime: temporary API key obtained (expires: ${json.expiresAt ?? 'unknown'})`)
    return json.token
  }

  private handleMessage(data: string | ArrayBuffer | Blob): void {
    if (typeof data !== 'string') return

    let msg: { tokens?: Array<{ text: string; is_final: boolean }>; finished?: boolean; error?: string; error_code?: string; error_type?: string; error_message?: string }
    try {
      msg = JSON.parse(data)
    } catch {
      log('Soniox Realtime: failed to parse message')
      return
    }

    const errorMsg = msg.error_message || msg.error
    if (errorMsg || msg.error_code) {
      log(`Soniox Realtime: error: ${msg.error_code || 'unknown'} ${msg.error_type || ''} ${errorMsg || ''}`.trim())
      this.resolveStopIfWaiting()
      return
    }

    if (msg.tokens && msg.tokens.length > 0) {
      // Soniox token model: final tokens are confirmed and won't change.
      // Non-final tokens REPLACE previous partials (not accumulate).
      // Replace special tokens like <end> (endpoint markers) with newlines.
      for (const token of msg.tokens) {
        if (token.is_final) {
          this.finalText += token.text.startsWith('<') ? '\n' : token.text
        }
      }
      // Non-final tokens form the current partial (replaces previous partial entirely)
      this.partialText = msg.tokens
        .filter(t => !t.is_final && !t.text.startsWith('<'))
        .map(t => t.text)
        .join('')

      this.emitDeltas()
    }

    if (msg.finished) {
      if (this.partialText) {
        this.finalText += this.partialText
        this.partialText = ''
      }
      this.emitDeltas()
      log('Soniox Realtime: finished')
      this.resolveStopIfWaiting()
    }
  }

  /**
   * Emit OpenAI-compatible incremental deltas to onTranscript.
   *
   * main.ts consumers accumulate text via `+=`, so we must emit only
   * the NEW portion each time, not the full accumulated text.
   *
   * - isFinal=true: newly confirmed text (consumer resets partial accumulator)
   * - isFinal=false: incremental partial growth (consumer appends)
   *
   * When partial text is replaced (correction), we skip emission rather
   * than corrupt the consumer's accumulator. The stale partial is cleared
   * on the next isFinal emission.
   */
  private emitDeltas(): void {
    if (!this.onTranscript) return

    // Emit newly finalized text
    if (this.finalText.length > this.emittedFinalLen) {
      const delta = this.finalText.slice(this.emittedFinalLen)
      this.onTranscript(delta, true)
      this.emittedFinalLen = this.finalText.length
      // Consumer resets its partial accumulator on isFinal=true,
      // so reset our tracking to match
      this.emittedPartial = ''
    }

    // Emit partial text growth (only when it extends monotonically)
    if (this.partialText && this.partialText !== this.emittedPartial) {
      if (this.partialText.startsWith(this.emittedPartial)) {
        const delta = this.partialText.slice(this.emittedPartial.length)
        if (delta) this.onTranscript(delta, false)
      }
      // If partial was replaced (correction), skip emission to avoid
      // corrupting the consumer's accumulator. Text self-corrects
      // when the next final emission clears the partial.
      this.emittedPartial = this.partialText
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
    if (this.stopResolve) {
      if (this.stopTimeout) clearTimeout(this.stopTimeout)
      this.stopTimeout = null
      const resolve = this.stopResolve
      this.stopResolve = null
      resolve(this.buildResult())
    }
    this.ws = null
  }

  private wsSendBinary(pcm: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // Avoid sending the entire underlying ArrayBuffer when the
    // Uint8Array is a view with byteOffset or shorter byteLength.
    const buf = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
      ? pcm.buffer
      : pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
    this.ws.send(buf)
  }

  private flushPendingAudio(): void {
    if (!this.sessionReady || this.pendingAudio.length === 0) return
    const pending = this.pendingAudio
    this.pendingAudio = []
    for (const chunk of pending) {
      this.wsSendBinary(chunk)
    }
  }

  private buildResult(): SttResult {
    const text = this.finalText + this.partialText
    return {
      text,
      provider: 'soniox',
      model: 'stt-rt-v4',
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
