// ジッタ付き指数バックオフ。SSE 再接続で使用(reconciliation は固定間隔なので不使用)。
export interface Backoff {
  /** 次の待機時間 (ms) を返し、内部の試行回数を進める */
  next(): number
  reset(): void
}

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  factor?: number
  /** 0〜1。raw * (1 ± jitter) の範囲で揺らす */
  jitter?: number
  random?: () => number
}

export function createBackoff(options: BackoffOptions = {}): Backoff {
  const { baseMs = 1_000, maxMs = 30_000, factor = 2, jitter = 0.3, random = Math.random } = options
  let attempt = 0
  return {
    next(): number {
      const raw = Math.min(maxMs, baseMs * Math.pow(factor, attempt))
      attempt += 1
      const delta = raw * jitter
      return Math.max(0, Math.round(raw - delta + random() * 2 * delta))
    },
    reset(): void {
      attempt = 0
    },
  }
}
