// Strictly in-memory bounded audit ring buffer (never persisted to disk).
import { redactSecrets } from './redact.ts'

export const MAX_AUDIT_ENTRIES = 50
export const MAX_AUDIT_DIFF_BYTES = 32 * 1024

export type AuditStatus = 'ok' | 'blocked' | 'error'

export interface AuditEntry {
  ts: string
  tool: string
  status: AuditStatus
  summary?: string
  reason?: string
  sanitizedPath?: string
  diffPreview?: string
}

export type AuditRecordInput = Omit<AuditEntry, 'ts'> & { ts?: string }

export interface AuditLogOptions {
  maxEntries?: number
  maxDiffBytes?: number
}

export interface AuditLog {
  record(entry: AuditRecordInput): AuditEntry
  list(): readonly AuditEntry[]
  clear(): void
  size(): number
}

function sliceUtf8Safe(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return ''
  const limit = Math.trunc(maxBytes)
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let bytes = 0
  let end = 0
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!
    const unitLen = cp > 0xffff ? 2 : 1
    const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4
    if (bytes + chBytes > limit) break
    bytes += chBytes
    i += unitLen
    end = i
  }
  return text.slice(0, end)
}

function capDiffPreview(raw: string, maxBytes: number): string {
  const redacted = redactSecrets(raw)
  if (Buffer.byteLength(redacted, 'utf8') <= maxBytes) return redacted
  const suffix = '\n... [truncated]'
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  if (maxBytes <= suffixBytes) return sliceUtf8Safe(redacted, maxBytes)
  return `${sliceUtf8Safe(redacted, maxBytes - suffixBytes)}${suffix}`
}

/**
 * Creates a bounded in-memory ring buffer for recent tool operations,
 * policy blocks, and redacted diff previews.
 */
export function createAuditLog(options: AuditLogOptions = {}): AuditLog {
  const maxEntries =
    options.maxEntries !== undefined &&
    Number.isFinite(options.maxEntries) &&
    options.maxEntries > 0
      ? Math.trunc(options.maxEntries)
      : MAX_AUDIT_ENTRIES
  const maxDiffBytes =
    options.maxDiffBytes !== undefined &&
    Number.isFinite(options.maxDiffBytes) &&
    options.maxDiffBytes > 0
      ? Math.trunc(options.maxDiffBytes)
      : MAX_AUDIT_DIFF_BYTES

  const entries: AuditEntry[] = []

  return {
    record(input) {
      const entry: AuditEntry = {
        ts: input.ts ?? new Date().toISOString(),
        tool: input.tool,
        status: input.status,
        ...(input.summary !== undefined ? { summary: redactSecrets(input.summary) } : {}),
        ...(input.reason !== undefined ? { reason: redactSecrets(input.reason) } : {}),
        ...(input.sanitizedPath !== undefined
          ? { sanitizedPath: redactSecrets(input.sanitizedPath) }
          : {}),
        ...(input.diffPreview !== undefined
          ? { diffPreview: capDiffPreview(input.diffPreview, maxDiffBytes) }
          : {}),
      }
      entries.push(entry)
      while (entries.length > maxEntries) {
        entries.shift()
      }
      return entry
    },
    list() {
      return [...entries]
    },
    clear() {
      entries.length = 0
    },
    size() {
      return entries.length
    },
  }
}
