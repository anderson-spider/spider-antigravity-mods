// Hardened all-or-nothing multi-file atomic editor (`apply_edits`).
// Zero shell execution, zero `verify`, zero `bestEffort`, strict workspace jail,
// symlink rejection, hard file/batch caps, unified-diff dry-run, and atomic
// temp-file (`wx`) + rename commit with Phase 2 freshness checks and full rollback.
import { isUtf8 } from 'node:buffer'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AuditLog } from './audit.ts'
import {
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  fitSectionsToByteBudget,
  sliceSafeChars,
  truncateWithByteNotice,
  utf8ByteLength,
} from './budget.ts'
import {
  detectUtf16Bom,
  hasUtf8Bom,
  isLikelyBinary,
  readTextFile,
} from './fs.ts'
import type { ToolReply, ToolSpec } from './mcp.ts'
import { isPathInsideRoot, type PolicyGuard } from './policy.ts'
import { redactSecrets } from './redact.ts'

export const MAX_EDIT_FILES = 25
export const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024
export const MAX_EDIT_TOTAL_BYTES = 10 * 1024 * 1024

const MAX_NEARBY_LINES = 26
const MAX_DIFF_HUNK_LINES = 200
const MAX_LCS_CELLS = 200_000
const UNSUPPORTED_VERIFY_KEYS = ['verify', 'verifyTimeoutSec', 'maxVerifyChars'] as const

export interface EditHunk {
  target: string
  replacement: string
  startLine?: number
  endLine?: number
  replaceAll?: boolean
}

export interface FileEdit {
  path: string
  hunks?: EditHunk[] | string
  create?: string
  overwrite?: boolean
}

export interface ApplyEditsInput {
  cwd?: string
  /** A native array of file edits or a JSON-stringified array of file edits. */
  edits: string | FileEdit[]
  dryRun?: boolean
}

export interface ApplyEditsBeforeWriteContext {
  relPath: string
  canonicalPath: string
  index: number
  created: boolean
}

export interface ApplyEditsDeps {
  policy: PolicyGuard
  audit?: AuditLog
  /** Optional lifecycle hook invoked immediately before each Phase 2 file commit. */
  beforeWriteHook?: (ctx: ApplyEditsBeforeWriteContext) => Promise<void> | void
}

export interface UnifiedDiffOptions {
  contextLines?: number
  maxHunkLines?: number
}

export const APPLY_EDITS_TOOL_SPEC: ToolSpec = {
  name: 'apply_edits',
  title: 'Apply Atomic Edits',
  description:
    'Atomically apply exact-target hunks or create/overwrite files across up to 25 workspace files in one all-or-nothing batch (<= 2 MiB/file, <= 10 MiB total). Supports dryRun unified-diff preview. Never runs shell commands.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Optional working directory inside the allowed workspace root.',
      },
      edits: {
        description:
          'Non-empty array (or JSON-stringified array) of up to 25 file edit objects.',
        oneOf: [
          {
            type: 'array',
            minItems: 1,
            maxItems: MAX_EDIT_FILES,
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                hunks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      target: { type: 'string' },
                      replacement: { type: 'string' },
                      startLine: { type: 'integer', minimum: 1 },
                      endLine: { type: 'integer', minimum: 1 },
                      replaceAll: { type: 'boolean' },
                    },
                    required: ['target', 'replacement'],
                    additionalProperties: false,
                  },
                },
                create: { type: 'string' },
                overwrite: { type: 'boolean' },
              },
              required: ['path'],
              additionalProperties: false,
            },
          },
          { type: 'string' },
        ],
      },
      dryRun: {
        type: 'boolean',
        description:
          'When true, validate all edits and return a compact unified-diff preview without writing to disk.',
      },
    },
    required: ['edits'],
    additionalProperties: false,
  },
}

interface MatchSpan {
  start: number
  end: number
  replacement: string
  hunkIndex: number
}

interface NormalizedFileEdit {
  path: string
  hunks?: EditHunk[]
  create?: string
  overwrite?: boolean
}

interface AuthorizedFileEdit {
  absPath: string
  canonicalPath: string
  root: string
  relPath: string
  hunks?: EditHunk[]
  create?: string
  overwrite?: boolean
}

interface PlannedWrite {
  absPath: string
  canonicalPath: string
  root: string
  relPath: string
  existed: boolean
  originalBuffer: Buffer | null
  originalMode: number | null
  originalMtimeMs: number | null
  originalSize: number | null
  originalNormalized: string | null
  newNormalized: string
  plannedBuffer: Buffer
  hunkCount: number
  lineDelta: number
  created: boolean
  isNoOp: boolean
}

type ParsedArrayResult =
  | { ok: true; value: unknown[] }
  | { ok: false; kind: 'missing' | 'invalid_json' | 'wrong_type'; detail: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `array (len=${value.length})`
  if (typeof value === 'boolean') return `boolean (${String(value)})`
  if (typeof value === 'number') return `number (${String(value)})`
  if (typeof value === 'string') return `string (len=${value.length})`
  return typeof value
}

function parseMaybeJsonArray(value: unknown): ParsedArrayResult {
  if (value === undefined) {
    return { ok: false, kind: 'missing', detail: 'undefined' }
  }
  if (Array.isArray(value)) {
    return { ok: true, value }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return { ok: false, kind: 'wrong_type', detail: 'empty string' }
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return { ok: true, value: parsed }
      }
      return {
        ok: false,
        kind: 'invalid_json',
        detail: `decoded to ${describeValueType(parsed)} instead of a JSON array`,
      }
    } catch (err) {
      return {
        ok: false,
        kind: 'invalid_json',
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }
  return {
    ok: false,
    kind: 'wrong_type',
    detail: describeValueType(value),
  }
}

function resolveHunkFieldWithAliases(
  rawHunk: Record<string, unknown>,
  canonicalKey: 'target' | 'replacement',
  aliasKeys: readonly string[],
): { ok: true; value: unknown } | { ok: false; error: string } {
  const hasCanonical = rawHunk[canonicalKey] !== undefined
  const presentAliases = aliasKeys.filter((key) => rawHunk[key] !== undefined)

  if (hasCanonical) {
    const canonicalVal = rawHunk[canonicalKey]
    for (const aliasKey of presentAliases) {
      if (rawHunk[aliasKey] !== canonicalVal) {
        return {
          ok: false,
          error: `conflicting '${canonicalKey}' and alias '${aliasKey}' (values differ; omit the alias or make them identical)`,
        }
      }
    }
    return { ok: true, value: canonicalVal }
  }

  if (presentAliases.length === 0) {
    return { ok: true, value: undefined }
  }

  const firstKey = presentAliases[0]!
  const firstVal = rawHunk[firstKey]
  for (let k = 1; k < presentAliases.length; k++) {
    const otherKey = presentAliases[k]!
    if (rawHunk[otherKey] !== firstVal) {
      return {
        ok: false,
        error: `conflicting aliases '${firstKey}' and '${otherKey}' (values differ; use '${canonicalKey}')`,
      }
    }
  }
  return { ok: true, value: firstVal }
}

function normalizeEditHunk(
  rawHunk: Record<string, unknown>,
): { ok: true; hunk: EditHunk } | { ok: false; errors: string[] } {
  const targetRes = resolveHunkFieldWithAliases(rawHunk, 'target', [
    'oldText',
    'old_string',
  ])
  const replacementRes = resolveHunkFieldWithAliases(rawHunk, 'replacement', [
    'newText',
    'new_string',
  ])
  const errors: string[] = []
  if (!targetRes.ok) errors.push(targetRes.error)
  if (!replacementRes.ok) errors.push(replacementRes.error)
  if (rawHunk.replaceAll !== undefined && typeof rawHunk.replaceAll !== 'boolean') {
    errors.push("'replaceAll' must be a boolean")
  }
  if (errors.length > 0) {
    return { ok: false, errors }
  }
  const hunk: EditHunk = {
    target: (targetRes as { ok: true; value: unknown }).value as string,
    replacement: (replacementRes as { ok: true; value: unknown }).value as string,
    ...(rawHunk.startLine !== undefined ? { startLine: rawHunk.startLine as number } : {}),
    ...(rawHunk.endLine !== undefined ? { endLine: rawHunk.endLine as number } : {}),
    ...(rawHunk.replaceAll !== undefined ? { replaceAll: rawHunk.replaceAll as boolean } : {}),
  }
  return { ok: true, hunk }
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1)
    }
  }
  return starts
}

function offsetToLine(lineStarts: readonly number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lineStarts[mid]! <= offset) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return Math.max(1, hi + 1)
}

function formatMatchLineRange(
  lineStarts: readonly number[],
  offset: number,
  length: number,
  prefix = 'L',
): string {
  const startLine = offsetToLine(lineStarts, offset)
  const endOffset = length > 0 ? offset + length - 1 : offset
  const endLine = offsetToLine(lineStarts, endOffset)
  return startLine === endLine
    ? `${prefix}${startLine}`
    : `${prefix}${startLine}-${prefix}${endLine}`
}

function getLineWindowOffsets(
  text: string,
  lineStarts: readonly number[],
  startLine?: number,
  endLine?: number,
): { windowStart: number; windowEnd: number } {
  if (
    startLine !== undefined &&
    (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1)
  ) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`)
  }
  if (
    endLine !== undefined &&
    (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1)
  ) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`)
  }

  const totalLines = lineStarts.length
  const sLine = startLine !== undefined ? startLine : 1
  const eLine = endLine !== undefined ? Math.min(totalLines, endLine) : totalLines

  if (endLine !== undefined && startLine !== undefined && endLine < startLine) {
    throw new Error(`Invalid line range: startLine (${startLine}) > endLine (${endLine})`)
  }
  if (sLine > totalLines) {
    return { windowStart: text.length, windowEnd: text.length }
  }
  if (eLine < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${eLine})`)
  }

  const windowStart = lineStarts[sLine - 1]!
  const windowEnd = eLine < totalLines ? lineStarts[eLine]! : text.length
  return { windowStart, windowEnd }
}

function formatNearbyLines(
  text: string,
  startLine?: number,
  endLine?: number,
): string {
  const lines = text.split('\n')
  if (startLine === undefined && endLine === undefined) return ''
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2)
  const rawTo = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2)
  const truncated = rawTo - from + 1 > MAX_NEARBY_LINES
  const to = truncated ? from + MAX_NEARBY_LINES - 1 : rawTo
  const snippet: string[] = []
  for (let ln = from; ln <= to; ln++) {
    const lineText = lines[ln - 1] ?? ''
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`,
    )
  }
  const extra = truncated ? `\n    ... (${rawTo - to} more lines in range omitted)` : ''
  return `\n  Nearby lines (${from}-${to}):\n${snippet.join('\n')}${extra}`
}

function extractLineTokens(trimmedLine: string): string[] {
  const tokens = trimmedLine.match(/[A-Za-z0-9_$]{3,}|[\u4e00-\u9fff]{2,}/g)
  if (tokens && tokens.length > 0) return tokens
  return trimmedLine
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
}

function findClosestRegionSnippet(
  normalizedContent: string,
  normTarget: string,
  rangeStartLine?: number,
  rangeEndLine?: number,
): string {
  const fileLines = normalizedContent.split('\n')
  if (fileLines.length === 0) return ''

  const targetLines = normTarget
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (targetLines.length === 0) return ''

  interface HunkAnchor {
    text: string
    idx: number
    tokens: Set<string>
  }

  let firstAnchorIdx = 0
  for (let idx = 0; idx < targetLines.length; idx++) {
    if (targetLines[idx]!.length >= 6) {
      firstAnchorIdx = idx
      break
    }
  }
  let longestAnchorIdx = 0
  for (let idx = 1; idx < targetLines.length; idx++) {
    if (targetLines[idx]!.length > targetLines[longestAnchorIdx]!.length) {
      longestAnchorIdx = idx
    }
  }
  const lastAnchorIdx = targetLines.length - 1

  const anchorIndices = new Set<number>([firstAnchorIdx, longestAnchorIdx])
  if (targetLines[lastAnchorIdx]!.length >= 8) {
    anchorIndices.add(lastAnchorIdx)
  }
  const anchors: HunkAnchor[] = [...anchorIndices].map((idx) => ({
    text: targetLines[idx]!,
    idx,
    tokens: new Set(extractLineTokens(targetLines[idx]!)),
  }))
  const targetTokenSets = targetLines.map((tl) => new Set(extractLineTokens(tl)))
  const trimmedFileLines = fileLines.map((l) => l.trim())

  const scanStart = Math.max(0, (rangeStartLine ?? 1) - 1)
  const scanEnd = Math.min(
    trimmedFileLines.length - 1,
    (rangeEndLine ?? trimmedFileLines.length) - 1,
  )
  if (scanStart > scanEnd) return ''

  const evaluatedStarts = new Set<number>()
  let bestStart = -1
  let bestScore = 0

  const scoreIndices: number[] = []
  const windowLen = Math.min(targetLines.length, 10)
  for (let k = 0; k < windowLen; k++) {
    scoreIndices.push(k)
  }
  for (const idx of anchorIndices) {
    if (idx >= windowLen) {
      scoreIndices.push(idx)
    }
  }

  const scoreCandidateStart = (candStart: number): number => {
    let total = 0
    for (const k of scoreIndices) {
      const fIdx = candStart + k
      if (fIdx > scanEnd || fIdx >= trimmedFileLines.length) continue
      const fLine = trimmedFileLines[fIdx]!
      const tLine = targetLines[k]!
      if (!fLine || !tLine) continue
      const tTokens = targetTokenSets[k]!
      const isHighEntropy = tLine.length >= 12 && tTokens.size >= 2
      if (fLine === tLine) {
        total += isHighEntropy ? 8 + Math.min(6, tLine.length / 14) : 4
      } else if (
        tLine.length >= 8 &&
        (fLine.includes(tLine) || tLine.includes(fLine))
      ) {
        total += isHighEntropy ? 6 : 3.5
      } else if (tTokens.size > 0) {
        const lineTokens = extractLineTokens(fLine)
        let hits = 0
        for (const tok of lineTokens) {
          if (tTokens.has(tok)) hits += 1
        }
        if (
          hits >= 2 ||
          (hits >= 1 && tTokens.size <= 2 && hits === tTokens.size)
        ) {
          total += (isHighEntropy ? 4.5 : 3) * (hits / tTokens.size)
        }
      }
    }
    return total
  }

  for (let i = scanStart; i <= scanEnd; i++) {
    const line = trimmedFileLines[i]!
    if (!line) continue

    for (const anchor of anchors) {
      let matchedAnchor = false
      if (
        line === anchor.text ||
        (anchor.text.length >= 8 &&
          (line.includes(anchor.text) || anchor.text.includes(line)))
      ) {
        matchedAnchor = true
      } else if (anchor.tokens.size > 0) {
        const lineTokens = extractLineTokens(line)
        let hits = 0
        for (const tok of lineTokens) {
          if (anchor.tokens.has(tok)) hits += 1
        }
        if (
          hits >= 2 ||
          (hits >= 1 && anchor.tokens.size <= 2 && hits === anchor.tokens.size)
        ) {
          matchedAnchor = true
        }
      }
      if (!matchedAnchor) continue

      const candStart = Math.max(scanStart, Math.min(scanEnd, i - anchor.idx))
      if (evaluatedStarts.has(candStart)) continue
      evaluatedStarts.add(candStart)

      const score = scoreCandidateStart(candStart)
      if (score > bestScore) {
        bestScore = score
        bestStart = candStart
      }
    }
  }

  if (bestStart < 0 || bestScore < 2.5) return ''

  const span = Math.min(Math.max(targetLines.length, 4), 8)
  const from = Math.max(1, bestStart + 1 - 2)
  const to = Math.min(fileLines.length, Math.min(from + 13, bestStart + 1 + span + 2))
  const snippet: string[] = []
  for (let ln = from; ln <= to; ln++) {
    const lineText = fileLines[ln - 1] ?? ''
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`,
    )
  }
  return `\n  Closest match near line ${bestStart + 1} (lines ${from}-${to}):\n${snippet.join('\n')}`
}

function planHunksForContent(
  normalizedContent: string,
  hunks: readonly EditHunk[],
  displayPath: string,
): { newNormalized: string; appliedMatches: number; spans: MatchSpan[]; errors: string[] } {
  const lineStarts = computeLineStarts(normalizedContent)
  const spans: MatchSpan[] = []
  const errors: string[] = []

  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx]!
    if (typeof hunk.target !== 'string' || hunk.target.length === 0) {
      errors.push(`${displayPath} hunk #${idx + 1}: 'target' must be a non-empty string`)
      continue
    }
    if (typeof hunk.replacement !== 'string') {
      errors.push(`${displayPath} hunk #${idx + 1}: 'replacement' must be a string`)
      continue
    }

    const normTarget = hunk.target.replace(/\r\n/g, '\n')
    const normReplacement = hunk.replacement.replace(/\r\n/g, '\n')

    let windowStart = 0
    let windowEnd = normalizedContent.length
    try {
      const win = getLineWindowOffsets(
        normalizedContent,
        lineStarts,
        hunk.startLine,
        hunk.endLine,
      )
      windowStart = win.windowStart
      windowEnd = win.windowEnd
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }

    const foundOffsets: number[] = []
    let pos = windowStart
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos)
      if (found === -1 || found + normTarget.length > windowEnd) break
      foundOffsets.push(found)
      pos = found + Math.max(1, normTarget.length)
    }

    if (foundOffsets.length === 0) {
      const hasRange = hunk.startLine !== undefined || hunk.endLine !== undefined
      const rangeNote = hasRange
        ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}`
        : ''
      let hint = ''
      if (hasRange) {
        const globalOffsets: number[] = []
        let gPos = 0
        while (
          gPos <= normalizedContent.length - normTarget.length &&
          globalOffsets.length < 5
        ) {
          const found = normalizedContent.indexOf(normTarget, gPos)
          if (found === -1) break
          globalOffsets.push(found)
          gPos = found + Math.max(1, normTarget.length)
        }
        if (globalOffsets.length > 0) {
          const hitLines = globalOffsets
            .map((o) => formatMatchLineRange(lineStarts, o, normTarget.length))
            .join(', ')
          hint = ` Exact match found outside range at ${hitLines} — adjust startLine/endLine or omit them.`
        } else {
          const effStart = hunk.startLine ?? 1
          const effEnd = hunk.endLine ?? lineStarts.length
          if (effEnd - effStart + 1 > MAX_NEARBY_LINES - 4) {
            hint =
              findClosestRegionSnippet(normalizedContent, normTarget, effStart, effEnd) ||
              findClosestRegionSnippet(normalizedContent, normTarget) ||
              formatNearbyLines(normalizedContent, effStart, effEnd)
          } else {
            hint = formatNearbyLines(normalizedContent, hunk.startLine, hunk.endLine)
          }
        }
      } else {
        hint = findClosestRegionSnippet(normalizedContent, normTarget)
      }
      errors.push(`${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${hint}`)
      continue
    }

    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets
        .slice(0, 10)
        .map((o) => formatMatchLineRange(lineStarts, o, normTarget.length, ''))
        .join(', ')
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Provide startLine/endLine, more surrounding context, or set replaceAll: true.`,
      )
      continue
    }

    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx,
      })
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, spans: [], errors }
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!
    const curr = spans[i]!
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start)
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}.`,
      )
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, spans: [], errors }
  }

  const pieces: string[] = []
  let cursor = 0
  for (const span of spans) {
    pieces.push(normalizedContent.slice(cursor, span.start))
    pieces.push(span.replacement)
    cursor = span.end
  }
  pieces.push(normalizedContent.slice(cursor))

  return {
    newNormalized: pieces.join(''),
    appliedMatches: spans.length,
    spans,
    errors: [],
  }
}

function buildNormToRawOffsetMap(rawContent: string, normLength: number): Int32Array {
  const map = new Int32Array(normLength + 1)
  let normIdx = 0
  for (let rawIdx = 0; rawIdx < rawContent.length; rawIdx++) {
    if (rawContent[rawIdx] === '\r' && rawContent[rawIdx + 1] === '\n') {
      map[normIdx++] = rawIdx
      rawIdx++
    } else {
      map[normIdx++] = rawIdx
    }
  }
  map[normIdx] = rawContent.length
  return map
}

function detectLocalSpanEol(
  rawContent: string,
  rawStart: number,
  rawEnd: number,
  fallbackEol: '\r\n' | '\n',
): '\r\n' | '\n' {
  let crlfCount = 0
  let lfOnlyCount = 0
  for (let i = rawStart; i < rawEnd; i++) {
    if (rawContent[i] === '\n') {
      if (i > rawStart && rawContent[i - 1] === '\r') crlfCount++
      else lfOnlyCount++
    }
  }
  if (crlfCount > lfOnlyCount) return '\r\n'
  if (lfOnlyCount > crlfCount) return '\n'

  for (let i = rawEnd; i < rawContent.length; i++) {
    if (rawContent[i] === '\n') {
      return i > 0 && rawContent[i - 1] === '\r' ? '\r\n' : '\n'
    }
  }

  for (let i = rawStart - 1; i >= 0; i--) {
    if (rawContent[i] === '\n') {
      return i > 0 && rawContent[i - 1] === '\r' ? '\r\n' : '\n'
    }
  }

  return fallbackEol
}

function applySpansPreservingMixedEol(
  rawContent: string,
  normLength: number,
  spans: readonly MatchSpan[],
  fallbackEol: '\r\n' | '\n',
): string {
  const normToRaw = buildNormToRawOffsetMap(rawContent, normLength)
  const pieces: string[] = []
  let rawCursor = 0
  for (const span of spans) {
    const rawStart = normToRaw[span.start]!
    const rawEnd = normToRaw[span.end]!
    pieces.push(rawContent.slice(rawCursor, rawStart))
    const localEol = detectLocalSpanEol(rawContent, rawStart, rawEnd, fallbackEol)
    pieces.push(
      localEol === '\r\n'
        ? span.replacement.replace(/\n/g, '\r\n')
        : span.replacement,
    )
    rawCursor = rawEnd
  }
  pieces.push(rawContent.slice(rawCursor))
  return pieces.join('')
}

function countLines(text: string): number {
  if (!text) return 0
  const end = text.endsWith('\n') ? text.length - 1 : text.length
  if (end === 0) return 1
  let count = 1
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') count++
  }
  return count
}

function splitLinesForDiff(text: string): string[] {
  if (!text) return []
  const normalized = text.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop()
  }
  return parts
}

type DiffOp =
  | { kind: 'equal'; oldLine: number; newLine: number; text: string }
  | { kind: 'delete'; oldLine: number; text: string }
  | { kind: 'insert'; newLine: number; text: string }

function computeMiddleOps(
  oldMid: readonly string[],
  newMid: readonly string[],
  oldBase: number,
  newBase: number,
): DiffOp[] {
  const m = oldMid.length
  const n = newMid.length
  if (m === 0) {
    return newMid.map((text, idx) => ({ kind: 'insert', newLine: newBase + idx, text }))
  }
  if (n === 0) {
    return oldMid.map((text, idx) => ({ kind: 'delete', oldLine: oldBase + idx, text }))
  }

  // Exact LCS diff for bounded regions; linear replacement fallback for huge rewrites.
  if (m * n > MAX_LCS_CELLS) {
    const ops: DiffOp[] = []
    for (let i = 0; i < m; i++) {
      ops.push({ kind: 'delete', oldLine: oldBase + i, text: oldMid[i]! })
    }
    for (let j = 0; j < n; j++) {
      ops.push({ kind: 'insert', newLine: newBase + j, text: newMid[j]! })
    }
    return ops
  }

  const width = n + 1
  const dp = new Int32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i--) {
    const rowOffset = i * width
    const nextRowOffset = (i + 1) * width
    const a = oldMid[i]!
    for (let j = n - 1; j >= 0; j--) {
      if (a === newMid[j]!) {
        dp[rowOffset + j] = dp[nextRowOffset + j + 1]! + 1
      } else {
        const down = dp[nextRowOffset + j]!
        const right = dp[rowOffset + j + 1]!
        dp[rowOffset + j] = down >= right ? down : right
      }
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldMid[i]! === newMid[j]!) {
      ops.push({
        kind: 'equal',
        oldLine: oldBase + i,
        newLine: newBase + j,
        text: oldMid[i]!,
      })
      i++
      j++
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      ops.push({ kind: 'delete', oldLine: oldBase + i, text: oldMid[i]! })
      i++
    } else {
      ops.push({ kind: 'insert', newLine: newBase + j, text: newMid[j]! })
      j++
    }
  }
  while (i < m) {
    ops.push({ kind: 'delete', oldLine: oldBase + i, text: oldMid[i]! })
    i++
  }
  while (j < n) {
    ops.push({ kind: 'insert', newLine: newBase + j, text: newMid[j]! })
    j++
  }
  return ops
}

/**
 * Generates a compact unified diff between `originalText` (or `null` for new
 * files) and `newText` without spawning external diff binaries.
 */
export function buildUnifiedDiff(
  relPath: string,
  originalText: string | null,
  newText: string,
  options: UnifiedDiffOptions = {},
): string {
  const contextLines = Math.max(0, Math.trunc(options.contextLines ?? 3))
  const maxHunkLines = Math.max(20, Math.trunc(options.maxHunkLines ?? MAX_DIFF_HUNK_LINES))

  if (originalText === null) {
    const newLines = splitLinesForDiff(newText)
    const header = `--- /dev/null\n+++ b/${relPath}`
    if (newLines.length === 0) {
      return `${header}\n@@ -0,0 +0,0 @@`
    }
    const shown = newLines.slice(0, maxHunkLines)
    const body = shown.map((line) => `+${line}`)
    if (newLines.length > shown.length) {
      body.push(`... (+${newLines.length - shown.length} more added lines omitted)`)
    }
    return `${header}\n@@ -0,0 +1,${newLines.length} @@\n${body.join('\n')}`
  }

  const oldLines = splitLinesForDiff(originalText)
  const newLines = splitLinesForDiff(newText)

  if (
    oldLines.length === newLines.length &&
    oldLines.every((line, idx) => line === newLines[idx])
  ) {
    return `--- a/${relPath}\n+++ b/${relPath}\n(no changes)`
  }

  let prefixLen = 0
  const minLen = Math.min(oldLines.length, newLines.length)
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const ops: DiffOp[] = []
  const preStart = Math.max(0, prefixLen - contextLines)
  for (let i = preStart; i < prefixLen; i++) {
    ops.push({ kind: 'equal', oldLine: i + 1, newLine: i + 1, text: oldLines[i]! })
  }

  const midOps = computeMiddleOps(
    oldLines.slice(prefixLen, oldLines.length - suffixLen),
    newLines.slice(prefixLen, newLines.length - suffixLen),
    prefixLen + 1,
    prefixLen + 1,
  )
  ops.push(...midOps)

  const sufCount = Math.min(suffixLen, contextLines)
  const oldSufBase = oldLines.length - suffixLen
  const newSufBase = newLines.length - suffixLen
  for (let i = 0; i < sufCount; i++) {
    ops.push({
      kind: 'equal',
      oldLine: oldSufBase + i + 1,
      newLine: newSufBase + i + 1,
      text: oldLines[oldSufBase + i]!,
    })
  }

  // Group change operations into unified diff hunks separated by > 2 * contextLines equal lines.
  const changeIndices: number[] = []
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== 'equal') changeIndices.push(i)
  }
  if (changeIndices.length === 0) {
    return `--- a/${relPath}\n+++ b/${relPath}\n(no changes)`
  }

  const groups: Array<{ start: number; end: number }> = []
  let gStart = Math.max(0, changeIndices[0]! - contextLines)
  let gEnd = Math.min(ops.length - 1, changeIndices[0]! + contextLines)
  for (let k = 1; k < changeIndices.length; k++) {
    const idx = changeIndices[k]!
    const nextStart = Math.max(0, idx - contextLines)
    const nextEnd = Math.min(ops.length - 1, idx + contextLines)
    if (nextStart <= gEnd + 1) {
      gEnd = Math.max(gEnd, nextEnd)
    } else {
      groups.push({ start: gStart, end: gEnd })
      gStart = nextStart
      gEnd = nextEnd
    }
  }
  groups.push({ start: gStart, end: gEnd })

  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`]
  for (const group of groups) {
    const slice = ops.slice(group.start, group.end + 1)
    let oldCount = 0
    let newCount = 0
    let oldStart = 0
    let newStart = 0

    for (const op of slice) {
      if (op.kind === 'equal') {
        if (oldStart === 0) oldStart = op.oldLine
        if (newStart === 0) newStart = op.newLine
        oldCount++
        newCount++
      } else if (op.kind === 'delete') {
        if (oldStart === 0) oldStart = op.oldLine
        oldCount++
      } else {
        if (newStart === 0) newStart = op.newLine
        newCount++
      }
    }

    if (oldStart === 0) {
      const prevOp = group.start > 0 ? ops[group.start - 1] : undefined
      oldStart =
        prevOp && prevOp.kind !== 'insert'
          ? prevOp.oldLine
          : Math.max(0, prefixLen)
    }
    if (newStart === 0) {
      const prevOp = group.start > 0 ? ops[group.start - 1] : undefined
      newStart =
        prevOp && prevOp.kind !== 'delete'
          ? prevOp.newLine
          : Math.max(0, prefixLen)
    }

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    const limit = Math.min(slice.length, maxHunkLines)
    for (let i = 0; i < limit; i++) {
      const op = slice[i]!
      if (op.kind === 'equal') out.push(` ${op.text}`)
      else if (op.kind === 'delete') out.push(`-${op.text}`)
      else out.push(`+${op.text}`)
    }
    if (slice.length > limit) {
      out.push(`... (+${slice.length - limit} more diff lines omitted)`)
    }
  }

  return out.join('\n')
}

function formatErrorBulletsWithinBytes(
  heading: string,
  errors: readonly string[],
  maxBytes: number,
): string {
  const redactedErrors = errors.map((e) => redactSecrets(e))
  const full = `${heading}\n- ${redactedErrors.join('\n- ')}`
  if (utf8ByteLength(full) <= maxBytes) {
    return full
  }
  const headingPrefix = `${heading}\n`
  const availBytes = maxBytes - utf8ByteLength(headingPrefix)
  if (availBytes <= 64 || redactedErrors.length <= 1) {
    return truncateWithByteNotice(full, DEFAULT_MAX_CHARS, maxBytes).text
  }
  const fitted = fitSectionsToByteBudget(
    redactedErrors.map((e) => `- ${e}`),
    { maxChars: availBytes, maxBytes: availBytes, separator: '\n' },
  )
  const assembled = `${headingPrefix}${fitted.text}`
  return utf8ByteLength(assembled) <= maxBytes
    ? assembled
    : truncateWithByteNotice(assembled, DEFAULT_MAX_CHARS, maxBytes).text
}

function makeTempFilePath(dir: string, prefix: string): string {
  return path.join(dir, `.${prefix}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
}

async function writeTempExclusiveAndRename(
  targetPath: string,
  buffer: Buffer,
  mode: number | null,
  tmpPrefix: string,
): Promise<void> {
  const dir = path.dirname(targetPath)
  const tmpPath = makeTempFilePath(dir, tmpPrefix)
  const openMode = mode !== null ? mode : 0o644

  let fh: fs.FileHandle | null = null
  try {
    fh = await fs.open(tmpPath, 'wx', openMode)
    await fh.writeFile(buffer)
    if (mode !== null && process.platform !== 'win32') {
      await fh.chmod(mode)
    }
    await fh.close()
    fh = null
  } catch (writeErr) {
    if (fh) {
      await fh.close().catch(() => {})
    }
    await fs.unlink(tmpPath).catch(() => {})
    throw writeErr
  }

  try {
    await fs.rename(tmpPath, targetPath)
  } catch (renameErr) {
    // Never fall back to non-atomic fs.writeFile on rename failure.
    await fs.unlink(tmpPath).catch(() => {})
    throw renameErr
  }
}

async function ensureSafeParentDirs(
  plan: PlannedWrite,
  policy: PolicyGuard,
  createdDirs: string[],
  createdDirSet: Set<string>,
): Promise<void> {
  const targetDir = path.dirname(plan.canonicalPath)
  if (!isPathInsideRoot(targetDir, plan.root)) {
    throw new Error(
      `Write aborted: parent directory for '${plan.relPath}' escapes workspace root.`,
    )
  }

  const relDir = path.relative(plan.root, targetDir)
  if (!relDir || relDir === '.') return

  const segments = relDir.split(/[\\/]+/).filter(Boolean)
  let current = plan.root
  let relPosix = ''

  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error(`Write aborted: unsafe parent directory segment in '${plan.relPath}'.`)
    }
    current = path.join(current, seg)
    relPosix = relPosix ? `${relPosix}/${seg}` : seg

    if (!isPathInsideRoot(current, plan.root)) {
      throw new Error(
        `Write aborted: parent directory '${relPosix}' escapes workspace root.`,
      )
    }
    if (policy.isGitInternalPath(relPosix) || policy.isGitInternalPath(current)) {
      throw new Error(
        `Write aborted: refusing to create or traverse Git internal directory '${relPosix}'.`,
      )
    }
    if (policy.isSecretPath(relPosix)) {
      throw new Error(
        `Write aborted: refusing to create or traverse secret directory '${relPosix}'.`,
      )
    }

    try {
      const lst = await fs.lstat(current)
      if (lst.isSymbolicLink()) {
        throw new Error(
          `Write aborted: parent directory '${relPosix}' is a symlink.`,
        )
      }
      if (!lst.isDirectory()) {
        throw new Error(
          `Write aborted: parent path '${relPosix}' exists and is not a directory.`,
        )
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err
      }
      try {
        await fs.mkdir(current)
        if (!createdDirSet.has(current)) {
          createdDirSet.add(current)
          createdDirs.push(current)
        }
      } catch (mkdirErr) {
        if ((mkdirErr as NodeJS.ErrnoException)?.code === 'EEXIST') {
          const lst = await fs.lstat(current)
          if (lst.isSymbolicLink() || !lst.isDirectory()) {
            throw new Error(
              `Write aborted: parent path '${relPosix}' became a non-directory or symlink.`,
            )
          }
        } else {
          throw mkdirErr
        }
      }
    }
  }
}

async function verifyTargetFreshBeforeWrite(plan: PlannedWrite): Promise<void> {
  const target = plan.canonicalPath
  if (plan.existed) {
    let lst
    try {
      lst = await fs.lstat(target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        throw new Error(
          `Concurrent modification detected for ${plan.relPath}: file was removed between planning and commit.`,
        )
      }
      throw new Error(
        `Write aborted for ${plan.relPath}: unable to verify target (${err instanceof Error ? err.message : String(err)}).`,
      )
    }
    if (lst.isSymbolicLink()) {
      throw new Error(
        `Write aborted for ${plan.relPath}: target became a symlink before commit.`,
      )
    }
    if (!lst.isFile()) {
      throw new Error(
        `Write aborted for ${plan.relPath}: target is no longer a regular file.`,
      )
    }
    if (lst.mtimeMs !== plan.originalMtimeMs || lst.size !== plan.originalSize) {
      throw new Error(
        `Concurrent modification detected for ${plan.relPath} (file changed on disk between planning and commit; aborting and rolling back).`,
      )
    }
  } else {
    try {
      const lst = await fs.lstat(target)
      if (lst.isSymbolicLink()) {
        throw new Error(
          `Write aborted for ${plan.relPath}: symlink appeared at target path before commit.`,
        )
      }
      throw new Error(
        `Concurrent modification detected for ${plan.relPath}: file was created on disk between planning and commit.`,
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err
      }
    }
  }
}

async function commitPlannedWrites(
  plans: readonly PlannedWrite[],
  deps: ApplyEditsDeps,
): Promise<void> {
  const written: PlannedWrite[] = []
  const createdDirs: string[] = []
  const createdDirSet = new Set<string>()

  try {
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!
      if (plan.isNoOp) continue

      if (deps.beforeWriteHook) {
        await deps.beforeWriteHook({
          relPath: plan.relPath,
          canonicalPath: plan.canonicalPath,
          index: i,
          created: plan.created,
        })
      }

      await ensureSafeParentDirs(plan, deps.policy, createdDirs, createdDirSet)
      await verifyTargetFreshBeforeWrite(plan)
      await writeTempExclusiveAndRename(
        plan.canonicalPath,
        plan.plannedBuffer,
        plan.originalMode,
        'batch-tools-tmp',
      )
      written.push(plan)
    }
  } catch (commitErr) {
    const rollbackErrors: string[] = []
    for (let i = written.length - 1; i >= 0; i--) {
      const item = written[i]!
      try {
        try {
          const lst = await fs.lstat(item.canonicalPath)
          if (lst.isSymbolicLink()) {
            rollbackErrors.push(`${item.relPath}: target is now a symlink; skipped restore`)
            continue
          }
        } catch (statErr) {
          if ((statErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw statErr
          }
        }

        if (item.existed && item.originalBuffer !== null) {
          await writeTempExclusiveAndRename(
            item.canonicalPath,
            item.originalBuffer,
            item.originalMode,
            'batch-tools-rb',
          )
        } else if (!item.existed) {
          await fs.unlink(item.canonicalPath)
        }
      } catch (rbErr) {
        rollbackErrors.push(
          `${item.relPath}: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`,
        )
      }
    }

    for (let i = createdDirs.length - 1; i >= 0; i--) {
      try {
        await fs.rmdir(createdDirs[i]!)
      } catch {
        // Ignore ENOENT / ENOTEMPTY / permission errors; rmdir never deletes non-empty dirs.
      }
    }

    const baseMsg = commitErr instanceof Error ? commitErr.message : String(commitErr)
    if (rollbackErrors.length > 0) {
      throw new Error(
        `${baseMsg} (rollback completed with warnings: ${rollbackErrors.join('; ')})`,
      )
    }
    throw commitErr
  }
}

function classifyNonTextBuffer(buf: Buffer, relPath: string): string | null {
  const utf16Bom = detectUtf16Bom(buf)
  if (utf16Bom) {
    return `${relPath}: UTF-16 encoded file is not supported (convert to UTF-8 first) [${utf16Bom}]`
  }
  if (isLikelyBinary(buf)) {
    return `${relPath}: cannot overwrite binary file with text content`
  }
  return null
}

function sanitizeFileError(err: unknown, canonicalPath: string, relPath: string): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') {
    return `${relPath}: file not found (use 'create' to create a new file)`
  }
  const raw = err instanceof Error ? err.message : String(err)
  const sanitized = canonicalPath ? raw.split(canonicalPath).join(relPath) : raw
  return sanitized.startsWith(`${relPath}:`) ? sanitized : `${relPath}: ${sanitized}`
}

function formatSummaryLine(plan: PlannedWrite): string {
  if (plan.isNoOp) {
    return `- ${plan.relPath}: unchanged (no-op: planned content matches existing file)`
  }
  const deltaStr = plan.lineDelta >= 0 ? `+${plan.lineDelta}` : `${plan.lineDelta}`
  const action = plan.created
    ? 'created'
    : plan.hunkCount === 0
      ? 'overwritten'
      : `updated (${plan.hunkCount} match${plan.hunkCount === 1 ? '' : 'es'})`
  return `- ${plan.relPath}: ${action}, lines ${deltaStr}`
}

export async function runApplyEdits(
  input: ApplyEditsInput | Record<string, unknown>,
  deps: ApplyEditsDeps,
): Promise<ToolReply> {
  const { policy, audit } = deps

  // 1. Respect BATCH_TOOLS_ALLOW_EDITS kill-switch upfront before inspecting files.
  if (!policy.isEditAllowed()) {
    const msg = 'Write access denied: edits are disabled by BATCH_TOOLS_ALLOW_EDITS=false.'
    audit?.record({
      tool: 'apply_edits',
      status: 'blocked',
      reason: 'edits_disabled',
      summary: msg,
    })
    return { text: msg, isError: true }
  }

  if (!isPlainObject(input)) {
    const msg = "Validation failed (0 files modified):\n- Input must be an object with an 'edits' array."
    audit?.record({ tool: 'apply_edits', status: 'error', reason: 'invalid_input', summary: msg })
    return { text: msg, isError: true }
  }

  // 2. Explicitly reject unsupported `verify` / `bestEffort` parameters (zero shell, all-or-nothing only).
  const unsupportedErrors: string[] = []
  const hasVerify = UNSUPPORTED_VERIFY_KEYS.some(
    (key) => key in input && input[key] !== undefined,
  )
  if (hasVerify) {
    unsupportedErrors.push(
      "'verify' (and shell command execution) is intentionally unsupported in apply_edits for security reasons; run verification commands separately via the terminal tool.",
    )
  }
  if ('bestEffort' in input && input.bestEffort !== undefined) {
    unsupportedErrors.push(
      "'bestEffort' is intentionally unsupported in apply_edits; all batches enforce strict all-or-nothing atomic semantics only.",
    )
  }
  if (unsupportedErrors.length > 0) {
    const text = formatErrorBulletsWithinBytes(
      'Validation failed (0 files modified):',
      unsupportedErrors,
      DEFAULT_INLINE_MAX_BYTES,
    )
    audit?.record({
      tool: 'apply_edits',
      status: 'blocked',
      reason: hasVerify ? 'unsupported_verify' : 'unsupported_best_effort',
      summary: unsupportedErrors.join(' '),
    })
    return { text, isError: true }
  }

  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    const msg = "Validation failed (0 files modified):\n- 'dryRun' must be a boolean."
    audit?.record({ tool: 'apply_edits', status: 'error', reason: 'invalid_input', summary: msg })
    return { text: msg, isError: true }
  }
  const dryRun = input.dryRun === true

  if (input.cwd !== undefined && typeof input.cwd !== 'string') {
    const msg = "Validation failed (0 files modified):\n- 'cwd' must be a string."
    audit?.record({ tool: 'apply_edits', status: 'error', reason: 'invalid_input', summary: msg })
    return { text: msg, isError: true }
  }

  // 3. Parse `edits` (native array or JSON-stringified array) and enforce file-count cap.
  const parsedEdits = parseMaybeJsonArray(input.edits)
  if (!parsedEdits.ok) {
    const detail =
      parsedEdits.kind === 'invalid_json'
        ? `'edits' is not a valid JSON array: ${parsedEdits.detail}`
        : "'edits' must be a non-empty array (or JSON-stringified array) of file edit objects."
    const text = redactSecrets(`Validation failed (0 files modified):\n- ${detail}`)
    audit?.record({ tool: 'apply_edits', status: 'error', reason: 'invalid_edits', summary: detail })
    return { text, isError: true }
  }

  const rawEdits = parsedEdits.value
  if (rawEdits.length === 0) {
    const msg = "Validation failed (0 files modified):\n- 'edits' must contain at least 1 file edit entry."
    audit?.record({ tool: 'apply_edits', status: 'error', reason: 'empty_edits', summary: msg })
    return { text: msg, isError: true }
  }
  if (rawEdits.length > MAX_EDIT_FILES) {
    const msg = `Validation failed (0 files modified):\n- 'edits' supports at most ${MAX_EDIT_FILES} file entries per call (received ${rawEdits.length}).`
    audit?.record({
      tool: 'apply_edits',
      status: 'error',
      reason: 'batch_cap_exceeded',
      summary: `Rejected ${rawEdits.length} files (limit ${MAX_EDIT_FILES})`,
    })
    return { text: msg, isError: true }
  }

  // 4. Validate shape of entries and nested `hunks` (accepts native or JSON-stringified hunks).
  const validationErrors: string[] = []
  const normalizedEdits: NormalizedFileEdit[] = []

  for (let i = 0; i < rawEdits.length; i++) {
    const rawEntry = rawEdits[i]
    if (!isPlainObject(rawEntry)) {
      validationErrors.push(
        `edits[${i}]: expected an edit object, received ${describeValueType(rawEntry)}`,
      )
      continue
    }
    if (typeof rawEntry.path !== 'string' || !rawEntry.path.trim()) {
      validationErrors.push(`edits[${i}]: 'path' must be a non-empty string`)
      continue
    }
    if (rawEntry.overwrite !== undefined && typeof rawEntry.overwrite !== 'boolean') {
      validationErrors.push(`edits[${i}]: 'overwrite' must be a boolean`)
      continue
    }
    if (rawEntry.create !== undefined && typeof rawEntry.create !== 'string') {
      validationErrors.push(`edits[${i}]: 'create' must be a string`)
      continue
    }

    let normalizedHunks: EditHunk[] | undefined
    if (rawEntry.hunks !== undefined) {
      const parsedHunks = parseMaybeJsonArray(rawEntry.hunks)
      if (!parsedHunks.ok) {
        validationErrors.push(
          `edits[${i}].hunks: must be an array (or JSON-stringified array) of hunk objects (${parsedHunks.detail})`,
        )
        continue
      }
      const resolvedHunks: EditHunk[] = []
      let hunkEntryFailed = false
      for (let j = 0; j < parsedHunks.value.length; j++) {
        const rawHunk = parsedHunks.value[j]
        if (!isPlainObject(rawHunk)) {
          validationErrors.push(
            `edits[${i}].hunks[${j}]: expected a hunk object, received ${describeValueType(rawHunk)}`,
          )
          hunkEntryFailed = true
          continue
        }
        const normRes = normalizeEditHunk(rawHunk)
        if (!normRes.ok) {
          for (const errMsg of normRes.errors) {
            validationErrors.push(`edits[${i}].hunks[${j}]: ${errMsg}`)
          }
          hunkEntryFailed = true
        } else {
          resolvedHunks.push(normRes.hunk)
        }
      }
      if (hunkEntryFailed) continue
      normalizedHunks = resolvedHunks
    }

    const hasCreate = typeof rawEntry.create === 'string'
    const hasHunks = Array.isArray(normalizedHunks) && normalizedHunks.length > 0
    if (!hasCreate && !hasHunks) {
      validationErrors.push(
        `edits[${i}] (${rawEntry.path.trim()}): must specify either non-empty 'hunks' or 'create'`,
      )
      continue
    }
    if (hasCreate && hasHunks) {
      validationErrors.push(
        `edits[${i}] (${rawEntry.path.trim()}): cannot specify both 'create' and 'hunks' on the same entry`,
      )
      continue
    }

    normalizedEdits.push({
      path: rawEntry.path.trim(),
      ...(hasHunks ? { hunks: normalizedHunks } : {}),
      ...(hasCreate ? { create: rawEntry.create as string } : {}),
      ...(rawEntry.overwrite !== undefined ? { overwrite: rawEntry.overwrite } : {}),
    })
  }

  if (validationErrors.length > 0) {
    const text = formatErrorBulletsWithinBytes(
      'Validation failed (0 files modified):',
      validationErrors,
      DEFAULT_INLINE_MAX_BYTES,
    )
    audit?.record({
      tool: 'apply_edits',
      status: 'error',
      reason: 'validation_failed',
      summary: `Validation failed (${validationErrors.length} error(s), 0 files modified)`,
    })
    return { text, isError: true }
  }

  // 5. Resolve cwd and authorize every target path through PolicyGuard; reject duplicates.
  const lastAuditBeforeCwd = audit?.list().at(-1)
  const cwdRes = await policy.resolveCwd(input.cwd, 'apply_edits')
  if (!cwdRes.ok) {
    if (audit && audit.list().at(-1) === lastAuditBeforeCwd) {
      audit.record({
        tool: 'apply_edits',
        status: 'blocked',
        reason: cwdRes.reason,
        summary: cwdRes.error,
      })
    }
    const text = formatErrorBulletsWithinBytes(
      'Atomic edit aborted (0 files modified):',
      [cwdRes.error],
      DEFAULT_INLINE_MAX_BYTES,
    )
    return { text, isError: true }
  }
  const baseCwd = cwdRes.value.cwd

  const authorizedEntries: AuthorizedFileEdit[] = []
  const seenCanonical = new Set<string>()
  const authErrors: string[] = []
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'

  for (const entry of normalizedEdits) {
    const lastAuditBefore = audit?.list().at(-1)
    const authRes = await policy.authorizeWrite(entry.path, baseCwd, 'apply_edits')
    if (!authRes.ok) {
      if (audit && audit.list().at(-1) === lastAuditBefore) {
        audit.record({
          tool: 'apply_edits',
          status: 'blocked',
          reason: authRes.reason,
          sanitizedPath: policy.sanitizePathForAudit(entry.path),
          summary: authRes.error,
        })
      }
      authErrors.push(authRes.error)
      continue
    }

    const { absPath, canonicalPath, root, relPath } = authRes.value
    const dedupKey = caseInsensitive ? canonicalPath.toLowerCase() : canonicalPath
    if (seenCanonical.has(dedupKey)) {
      authErrors.push(
        `${relPath}: duplicate path in batch (combine all hunks for the same file into a single edit entry)`,
      )
      continue
    }
    seenCanonical.add(dedupKey)
    authorizedEntries.push({
      absPath,
      canonicalPath,
      root,
      relPath,
      ...(entry.hunks ? { hunks: entry.hunks } : {}),
      ...(entry.create !== undefined ? { create: entry.create } : {}),
      ...(entry.overwrite !== undefined ? { overwrite: entry.overwrite } : {}),
    })
  }

  if (authErrors.length > 0) {
    const text = formatErrorBulletsWithinBytes(
      'Atomic edit aborted (0 files modified):',
      authErrors,
      DEFAULT_INLINE_MAX_BYTES,
    )
    return { text, isError: true }
  }

  // 6. Phase 1: plan every edit in memory and enforce file & total byte caps.
  const plans: PlannedWrite[] = []
  const planErrors: string[] = []
  let totalPlannedBytes = 0

  for (const item of authorizedEntries) {
    if (item.create !== undefined) {
      let existed = false
      let originalBuffer: Buffer | null = null
      let originalMode: number | null = null
      let originalMtimeMs: number | null = null
      let originalSize: number | null = null

      try {
        const lst = await fs.lstat(item.canonicalPath)
        if (lst.isSymbolicLink()) {
          planErrors.push(
            `Write access denied: '${item.relPath}' is a symlink.`,
          )
          continue
        }
        if (lst.isDirectory()) {
          planErrors.push(`${item.relPath}: target path is a directory`)
          continue
        }
        if (!lst.isFile()) {
          planErrors.push(`${item.relPath}: target path is not a regular file`)
          continue
        }
        existed = true
        if (!item.overwrite) {
          planErrors.push(
            `${item.relPath}: file already exists (set overwrite: true to replace it)`,
          )
          continue
        }
        if (lst.size > MAX_EDIT_FILE_BYTES) {
          planErrors.push(
            `${item.relPath}: existing file exceeds maximum size (${lst.size} bytes > ${MAX_EDIT_FILE_BYTES} bytes)`,
          )
          continue
        }
        const buf = await fs.readFile(item.canonicalPath)
        const nonTextErr = classifyNonTextBuffer(buf, item.relPath)
        if (nonTextErr) {
          planErrors.push(nonTextErr)
          continue
        }
        originalBuffer = buf
        originalMode = lst.mode & 0o7777
        originalMtimeMs = lst.mtimeMs
        originalSize = lst.size
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          existed = false
        } else {
          planErrors.push(sanitizeFileError(err, item.canonicalPath, item.relPath))
          continue
        }
      }

      const originalHadBom = originalBuffer ? hasUtf8Bom(originalBuffer) : false
      const originalNormalized = originalBuffer
        ? (originalHadBom ? originalBuffer.subarray(3) : originalBuffer)
            .toString('utf8')
            .replace(/\r\n/g, '\n')
        : null
      const newContent =
        originalHadBom && !item.create.startsWith('\uFEFF')
          ? `\uFEFF${item.create}`
          : item.create
      const plannedBuffer = Buffer.from(newContent, 'utf8')
      if (plannedBuffer.length > MAX_EDIT_FILE_BYTES) {
        planErrors.push(
          `${item.relPath}: planned file size (${plannedBuffer.length} bytes) exceeds 2 MiB limit (${MAX_EDIT_FILE_BYTES} bytes)`,
        )
        continue
      }
      totalPlannedBytes += plannedBuffer.length

      const createBody = item.create.startsWith('\uFEFF') ? item.create.slice(1) : item.create
      const newNormalized = createBody.replace(/\r\n/g, '\n')
      const oldLines = originalNormalized !== null ? countLines(originalNormalized) : 0
      const newLines = countLines(newNormalized)
      const isNoOp = existed && originalBuffer !== null && plannedBuffer.equals(originalBuffer)

      plans.push({
        absPath: item.absPath,
        canonicalPath: item.canonicalPath,
        root: item.root,
        relPath: item.relPath,
        existed,
        originalBuffer,
        originalMode,
        originalMtimeMs,
        originalSize,
        originalNormalized,
        newNormalized,
        plannedBuffer,
        hunkCount: 0,
        lineDelta: newLines - oldLines,
        created: !existed,
        isNoOp,
      })
      continue
    }

    // Existing file hunk edits: verify not a symlink via lstat, then read with 2 MiB cap.
    try {
      const lst = await fs.lstat(item.canonicalPath)
      if (lst.isSymbolicLink()) {
        planErrors.push(`Write access denied: '${item.relPath}' is a symlink.`)
        continue
      }
    } catch (err) {
      planErrors.push(sanitizeFileError(err, item.canonicalPath, item.relPath))
      continue
    }

    let fileData
    try {
      fileData = await readTextFile(item.canonicalPath, { maxBytes: MAX_EDIT_FILE_BYTES })
    } catch (err) {
      planErrors.push(sanitizeFileError(err, item.canonicalPath, item.relPath))
      continue
    }

    if (!isUtf8(fileData.rawBuffer)) {
      planErrors.push(
        `${item.relPath}: file is not valid UTF-8 (hunk edits would corrupt non-UTF-8 bytes; convert to UTF-8 first or rewrite with create + overwrite: true)`,
      )
      continue
    }

    const normalizedOriginal = fileData.rawContent.replace(/\r\n/g, '\n')
    const planned = planHunksForContent(normalizedOriginal, item.hunks!, item.relPath)
    if (planned.errors.length > 0) {
      planErrors.push(...planned.errors)
      continue
    }

    const normalizedUnchanged = planned.newNormalized === normalizedOriginal
    let plannedBuffer: Buffer = fileData.rawBuffer
    let isNoOp = normalizedUnchanged

    if (!normalizedUnchanged) {
      const finalContent = fileData.mixedEol
        ? applySpansPreservingMixedEol(
            fileData.rawContent,
            normalizedOriginal.length,
            planned.spans,
            fileData.eol,
          )
        : fileData.eol === '\r\n'
          ? planned.newNormalized.replace(/\n/g, '\r\n')
          : planned.newNormalized
      const withBom =
        fileData.hasBom && !finalContent.startsWith('\uFEFF')
          ? `\uFEFF${finalContent}`
          : finalContent
      plannedBuffer = Buffer.from(withBom, 'utf8')
      if (plannedBuffer.length > MAX_EDIT_FILE_BYTES) {
        planErrors.push(
          `${item.relPath}: planned file size (${plannedBuffer.length} bytes) exceeds 2 MiB limit (${MAX_EDIT_FILE_BYTES} bytes)`,
        )
        continue
      }
      isNoOp = plannedBuffer.equals(fileData.rawBuffer)
    }

    totalPlannedBytes += plannedBuffer.length
    const lineDelta = normalizedUnchanged
      ? 0
      : countLines(planned.newNormalized) - countLines(normalizedOriginal)

    plans.push({
      absPath: item.absPath,
      canonicalPath: item.canonicalPath,
      root: item.root,
      relPath: item.relPath,
      existed: true,
      originalBuffer: fileData.rawBuffer,
      originalMode: fileData.mode,
      originalMtimeMs: fileData.mtimeMs,
      originalSize: fileData.size,
      originalNormalized: normalizedOriginal,
      newNormalized: planned.newNormalized,
      plannedBuffer,
      hunkCount: planned.appliedMatches,
      lineDelta,
      created: false,
      isNoOp,
    })
  }

  if (planErrors.length === 0 && totalPlannedBytes > MAX_EDIT_TOTAL_BYTES) {
    planErrors.push(
      `Batch planned size (${totalPlannedBytes} bytes) exceeds 10 MiB limit (${MAX_EDIT_TOTAL_BYTES} bytes).`,
    )
  }

  if (planErrors.length > 0) {
    const text = formatErrorBulletsWithinBytes(
      'Atomic edit aborted (0 files modified):',
      planErrors,
      DEFAULT_INLINE_MAX_BYTES,
    )
    audit?.record({
      tool: 'apply_edits',
      status: 'error',
      reason: 'plan_failed',
      summary: `Atomic edit aborted (${planErrors.length} error(s), 0 files modified)`,
    })
    return { text, isError: true }
  }

  // 7. Build unified diff previews for audit log and dry-run output.
  const perFileDiffs = plans.map((plan) =>
    buildUnifiedDiff(plan.relPath, plan.originalNormalized, plan.newNormalized),
  )
  const combinedDiff = perFileDiffs.join('\n\n')
  const summaryLines = plans.map(formatSummaryLine)
  const noOpCount = plans.filter((p) => p.isNoOp).length
  const changedCount = plans.length - noOpCount

  // 8. Dry run: return unified-diff preview within DEFAULT_INLINE_MAX_BYTES without touching disk.
  if (dryRun) {
    const header =
      noOpCount > 0
        ? `Dry run: ${plans.length} file(s) validated (${changedCount} would change, ${noOpCount} unchanged; 0 files written):`
        : `Dry run: ${plans.length} file(s) validated (${changedCount} would change; 0 files written):`

    audit?.record({
      tool: 'apply_edits',
      status: 'ok',
      summary: `dryRun: ${changedCount} file(s) would change, ${noOpCount} unchanged`,
      diffPreview: combinedDiff,
    })

    const summaryBlock = `${header}\n${summaryLines.join('\n')}`
    const sections = [summaryBlock, ...perFileDiffs]
    const fitted = fitSectionsToByteBudget(sections, {
      maxChars: DEFAULT_MAX_CHARS,
      maxBytes: DEFAULT_INLINE_MAX_BYTES,
      separator: '\n\n',
    })
    return { text: fitted.text, isError: false }
  }

  // 9. Phase 2: hardened atomic commit with immediate freshness checks and full rollback.
  try {
    await commitPlannedWrites(plans, deps)
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err)
    const redactedMsg = redactSecrets(rawMsg)
    audit?.record({
      tool: 'apply_edits',
      status: 'error',
      reason: 'commit_rolled_back',
      summary: `Write failed (changes rolled back): ${redactedMsg}`,
    })
    const out = truncateWithByteNotice(
      `Write failed (changes rolled back): ${redactedMsg}`,
      DEFAULT_MAX_CHARS,
      DEFAULT_INLINE_MAX_BYTES,
    )
    return { text: out.text, isError: true }
  }

  const header =
    noOpCount > 0
      ? `Applied edits atomically: ${changedCount} file(s) written, ${noOpCount} unchanged:`
      : `Applied edits atomically: ${changedCount} file(s) written:`

  audit?.record({
    tool: 'apply_edits',
    status: 'ok',
    summary: `Applied edits: ${changedCount} file(s) written, ${noOpCount} unchanged`,
    diffPreview: combinedDiff,
  })

  const fullText = `${header}\n${summaryLines.join('\n')}`
  const fitted = truncateWithByteNotice(
    fullText,
    DEFAULT_MAX_CHARS,
    DEFAULT_INLINE_MAX_BYTES,
  )
  return { text: fitted.text, isError: false }
}
