// Hub SSE (GET /api/events) の購読。replay がないため、(再)接続成功のたびに onConnect で
// reconciliation を起動して切断中の取りこぼしを埋める(plan §5.2)。
import type { Logger } from '../logger'
import { errorMessage } from '../logger'
import { createBackoff, type Backoff } from '../util/backoff'

export interface SseEvent {
  event: string
  data: string
}

export interface SseParser {
  push(chunk: string): void
}

/**
 * 最小 SSE パーサ。Hub の出力(event/data/コメント行/retry)だけを扱う。
 * data を持たないブロックは無視、コメント行(: ping)はハートビートとして呼び出し側が
 * チャンク受信で検知するためここでは読み捨てる。
 */
export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = ''
  let eventType = ''
  let dataLines: string[] = []
  return {
    push(chunk: string): void {
      buffer += chunk
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          if (dataLines.length > 0) {
            onEvent({ event: eventType || 'message', data: dataLines.join('\n') })
          }
          eventType = ''
          dataLines = []
          continue
        }
        if (line.startsWith(':')) continue
        const colonIndex = line.indexOf(':')
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
        let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') eventType = value
        else if (field === 'data') dataLines.push(value)
        // id / retry は使わない(Hub に replay がなく、再接続間隔は自前バックオフで制御)
      }
    },
  }
}

export interface SseSubscriberOptions {
  url: string
  onEvent: (event: SseEvent) => void
  /** (再)接続成功ごとに呼ばれる。reconciliation のトリガー */
  onConnect?: () => void
  logger: Logger
  headers?: Record<string, string>
  /** ping(15s 間隔)がこの時間途絶えたら接続を破棄して再接続(ハーフオープン対策) */
  heartbeatTimeoutMs?: number
  backoff?: Backoff
  fetchFn?: typeof fetch
}

export class SseSubscriber {
  private readonly url: string
  private readonly onEvent: (event: SseEvent) => void
  private readonly onConnect: (() => void) | undefined
  private readonly logger: Logger
  private readonly headers: Record<string, string>
  private readonly heartbeatTimeoutMs: number
  private readonly backoff: Backoff
  private readonly fetchFn: typeof fetch

  private started = false
  private stopped = false
  private abortController: AbortController | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private cancelSleep: (() => void) | null = null

  constructor(options: SseSubscriberOptions) {
    this.url = options.url
    this.onEvent = options.onEvent
    this.onConnect = options.onConnect
    this.logger = options.logger
    this.headers = options.headers ?? {}
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000
    this.backoff = options.backoff ?? createBackoff({ baseMs: 1_000, maxMs: 30_000 })
    this.fetchFn = options.fetchFn ?? fetch
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.clearHeartbeat()
    this.abortController?.abort()
    this.cancelSleep?.()
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.abortController = new AbortController()
      try {
        const res = await this.fetchFn(this.url, {
          headers: { accept: 'text/event-stream', ...this.headers },
          signal: this.abortController.signal,
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        this.backoff.reset()
        this.logger.info('SSE connected')
        this.onConnect?.()
        const parser = createSseParser(this.onEvent)
        const decoder = new TextDecoder()
        this.resetHeartbeat()
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          this.resetHeartbeat()
          parser.push(decoder.decode(chunk, { stream: true }))
        }
        throw new Error('stream ended')
      } catch (err) {
        this.clearHeartbeat()
        if (this.stopped) return
        const delayMs = this.backoff.next()
        this.logger.warn(`SSE disconnected (${errorMessage(err)}); reconnecting in ${delayMs}ms`)
        await this.sleep(delayMs)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancelSleep = null
        resolve()
      }, ms)
      this.cancelSleep = () => {
        clearTimeout(timer)
        this.cancelSleep = null
        resolve()
      }
    })
  }

  private resetHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setTimeout(() => {
      this.logger.warn(`SSE heartbeat missing for ${this.heartbeatTimeoutMs}ms; forcing reconnect`)
      this.abortController?.abort()
    }, this.heartbeatTimeoutMs)
    this.heartbeatTimer.unref?.()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
