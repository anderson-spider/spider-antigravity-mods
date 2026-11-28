// Stateful retry, exponential backoff, and deduplication tracker for automatic chat reply delivery.

export const AUTO_REPLY_BACKOFF_MS = [2_000, 5_000, 12_000, 25_000] as const
export const MAX_AUTO_REPLY_ATTEMPTS = AUTO_REPLY_BACKOFF_MS.length + 1

export type ReplyFailureState = {
  attempts: number
  nextAttemptAt: number
  lastError?: string
}

export type ReplyFailureOutcome = {
  attempts: number
  exhausted: boolean
  retryInMs: number | null
  lastError?: string
}

export class ReplyDeliveryTracker {
  private readonly delivering = new Set<string>()
  private readonly delivered = new Set<string>()
  private readonly failures = new Map<string, ReplyFailureState>()

  canAttempt(replyId: string, now = Date.now()): boolean {
    if (this.delivering.has(replyId) || this.delivered.has(replyId)) return false
    const failure = this.failures.get(replyId)
    if (!failure) return true
    if (failure.attempts >= MAX_AUTO_REPLY_ATTEMPTS) return false
    return now >= failure.nextAttemptAt
  }

  isDelivered(replyId: string): boolean {
    return this.delivered.has(replyId)
  }

  markStart(replyId: string): void {
    this.delivering.add(replyId)
  }

  markFinish(replyId: string): void {
    this.delivering.delete(replyId)
  }

  markDelivered(replyId: string): void {
    this.delivering.delete(replyId)
    this.failures.delete(replyId)
    this.delivered.add(replyId)
  }

  markFailed(replyId: string, error?: string, now = Date.now()): ReplyFailureOutcome {
    const prev = this.failures.get(replyId)
    const attempts = (prev?.attempts ?? 0) + 1
    const exhausted = attempts >= MAX_AUTO_REPLY_ATTEMPTS
    const retryInMs = exhausted ? null : (AUTO_REPLY_BACKOFF_MS[attempts - 1] ?? AUTO_REPLY_BACKOFF_MS.at(-1)!)
    const nextAttemptAt = retryInMs !== null ? now + retryInMs : Number.POSITIVE_INFINITY
    this.failures.set(replyId, { attempts, nextAttemptAt, ...(error ? { lastError: error } : {}) })
    return { attempts, exhausted, retryInMs, ...(error ? { lastError: error } : {}) }
  }

  getExhaustedFailure(replyId: string): ReplyFailureState | undefined {
    const failure = this.failures.get(replyId)
    if (!failure || failure.attempts < MAX_AUTO_REPLY_ATTEMPTS) return undefined
    return failure
  }

  resetForRetry(replyId?: string): void {
    if (replyId) {
      this.failures.delete(replyId)
      return
    }
    for (const [id, failure] of this.failures.entries()) {
      if (this.delivered.has(id)) continue
      this.failures.set(id, {
        ...failure,
        // Grant one fresh attempt when focus/visibility returns even if previous background attempts exhausted.
        attempts: Math.min(failure.attempts, MAX_AUTO_REPLY_ATTEMPTS - 1),
        nextAttemptAt: 0,
      })
    }
  }
}
