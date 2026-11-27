import type { PersistedUsage } from '../types.ts'

export type TriggerMatch = {
  kind: 'slash' | 'mention'
  query: string
  start: number
  end: number
}

/** Detects an active `/` slash command (at start of composer) or `@file` mention at cursor. */
export function detectInputTrigger(text: string, cursor: number): TriggerMatch | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  const before = text.slice(0, safeCursor)

  // Slash command only when leading (ignoring leading whitespace) and no whitespace after command name yet.
  const slashMatch = before.match(/^\s*(\/[^\s]*)$/)
  if (slashMatch && slashMatch[1]) {
    const start = before.lastIndexOf(slashMatch[1])
    return {
      kind: 'slash',
      query: slashMatch[1].slice(1),
      start,
      end: safeCursor,
    }
  }

  // @file mention after start of text or whitespace.
  const mentionMatch = before.match(/(?:^|\s)(@[^\s@]*)$/)
  if (mentionMatch && mentionMatch[1]) {
    const token = mentionMatch[1]
    const start = before.length - token.length
    return {
      kind: 'mention',
      query: token.slice(1),
      start,
      end: safeCursor,
    }
  }

  return null
}

export function applyTriggerReplacement(
  text: string,
  trigger: TriggerMatch,
  replacement: string,
): { nextText: string; nextCursor: number } {
  const prefix = text.slice(0, trigger.start)
  const suffix = text.slice(trigger.end)
  const needsSpace = suffix.length === 0 || !/^\s/.test(suffix)
  const inserted = needsSpace ? `${replacement} ` : replacement
  const nextText = `${prefix}${inserted}${suffix}`
  return {
    nextText,
    nextCursor: prefix.length + inserted.length,
  }
}

export function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

export function pathToFileUri(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`
  }
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withLeadingSlash)}`
}

export function basenameOf(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? filePath
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatUsage(usage: PersistedUsage | undefined): string | null {
  if (!usage) return null
  const parts: string[] = []
  if (usage.size > 0) {
    const pct = Math.min(100, Math.round((usage.used / usage.size) * 100))
    parts.push(`${compactTokens(usage.used)} / ${compactTokens(usage.size)} (${pct}%)`)
  } else if (usage.used > 0) {
    parts.push(`${compactTokens(usage.used)} tok`)
  }
  if (typeof usage.costAmount === 'number') {
    const cur = usage.costCurrency || 'USD'
    const symbol = cur === 'USD' ? '$' : `${cur} `
    parts.push(`${symbol}${usage.costAmount.toFixed(usage.costAmount < 0.01 ? 4 : 2)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export function parseFenceOpening(line: string): { fenceLen: number; lang: string } | null {
  const match = line.match(/^(`{3,})(.*)$/)
  if (!match || !match[1]) return null
  const info = (match[2] ?? '').trim()
  // CommonMark: backtick fence info strings cannot contain backticks
  if (info.includes('`')) return null
  const lang = info.split(/\s+/)[0] ?? ''
  return { fenceLen: match[1].length, lang }
}

export function isFenceClosing(line: string, minLen: number): boolean {
  const match = line.match(/^(`{3,})\s*$/)
  return Boolean(match && match[1] && match[1].length >= minLen)
}

export function formatPromptPreview(text: string, maxChars = 280, maxLines = 4): { isLong: boolean; preview: string; lineCount: number } {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const lines = normalized.split('\n')
  const lineCount = lines.length
  const isLong = lineCount > maxLines || normalized.length > maxChars
  if (!isLong) {
    return { isLong: false, preview: normalized, lineCount }
  }
  const clippedLines = lines.slice(0, maxLines).join('\n')
  const preview = clippedLines.length > maxChars ? `${clippedLines.slice(0, maxChars).trimEnd()}…` : `${clippedLines}…`
  return { isLong: true, preview, lineCount }
}

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000))
  if (diffSec < 45) return 'now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`
  return `${Math.floor(diffSec / 86400)}d`
}
