// Hardened parallel multi-query batch_search with ripgrep + pure-Node fallback,
// strict PolicyGuard enforcement, secret denylist protection, and water-filled
// <= 8,800 UTF-8 byte inline output budgeting.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AuditLog } from './audit.ts'
import {
  clampInt as clampIntStrict,
  computeWaterFillBudgets,
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  fitSectionsToByteBudget,
  sliceSafeChars,
  utf8ByteLength,
} from './budget.ts'
import { DEFAULT_IGNORE_DIRS, isLikelyBinary, toPosixPath, walkFiles } from './fs.ts'
import { globToRegExp, rankFuzzyPaths } from './fuzzy.ts'
import type { PolicyGuard } from './policy.ts'
import { redactSecrets } from './redact.ts'
import { execBinaryAsync, isRipgrepAvailable, type ExecResult } from './rg.ts'

export type SearchQueryType = 'text' | 'regex' | 'glob' | 'fuzzy'
export type SearchOutputMode = 'content' | 'files_with_matches' | 'count'
export type SearchSortBy = 'path' | 'mtime'

export interface SearchQuery {
  type: SearchQueryType
  pattern: string
  path?: string
  glob?: string
  fileType?: string
  multiline?: boolean
  outputMode?: SearchOutputMode
  sortBy?: SearchSortBy
  caseSensitive?: boolean
  contextLines?: number
  maxResults?: number
}

export interface BatchSearchInput {
  cwd?: string
  queries: SearchQuery[] | string
  maxChars?: number
}

export interface BatchSearchOptions {
  policy: PolicyGuard
  audit?: AuditLog
  /** Force the pure-Node search fallback instead of spawning `rg`. */
  forceNodeFallback?: boolean
  /** Wall-clock soft budget for the entire batch_search call (default 60_000 ms). */
  callTimeoutMs?: number
  /** Soft wall-clock budget for each walkFiles scan (default 12_000 ms). */
  walkTimeoutMs?: number
  /** Max directories visited per walkFiles scan (default 20_000). */
  walkMaxDirs?: number
}

export type BatchSearchRuntimeOptions = BatchSearchOptions

export interface BatchSearchResult {
  text: string
  isError: boolean
  structuredContent?: {
    engine: 'ripgrep' | 'node' | 'mixed' | 'none'
    queryCount: number
    errorCount: number
    truncated: boolean
  }
}

export const MAX_QUERIES = 20
export const MAX_CONTEXT_LINES = 10
export const DEFAULT_CALL_TIMEOUT_MS = 60_000

const DEFAULT_WALK_TIMEOUT_MS = 12_000
const DEFAULT_WALK_MAX_DIRS = 20_000
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024 // 2 MiB
const MAX_SEARCH_LINE_CHARS = 240

const RG_DEFAULT_IGNORE_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'coverage',
  '__pycache__',
  '.venv',
  '.next',
]

const FILE_TYPE_GLOBS: Record<string, readonly string[]> = {
  ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  typescript: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
  javascript: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
  py: ['*.py', '*.pyi'],
  python: ['*.py', '*.pyi'],
  go: ['*.go'],
  gd: ['*.gd'],
  gdscript: ['*.gd'],
  rust: ['*.rs'],
  rs: ['*.rs'],
  java: ['*.java'],
  kt: ['*.kt', '*.kts'],
  kotlin: ['*.kt', '*.kts'],
  c: ['*.c', '*.h'],
  cpp: ['*.cc', '*.cpp', '*.cxx', '*.hpp', '*.hh', '*.hxx', '*.h'],
  cs: ['*.cs'],
  csharp: ['*.cs'],
  swift: ['*.swift'],
  rb: ['*.rb'],
  ruby: ['*.rb'],
  php: ['*.php'],
  css: ['*.css', '*.scss', '*.sass', '*.less'],
  html: ['*.html', '*.htm'],
  vue: ['*.vue'],
  svelte: ['*.svelte'],
  md: ['*.md', '*.mdx', '*.markdown'],
  markdown: ['*.md', '*.mdx', '*.markdown'],
  json: ['*.json', '*.jsonc'],
  yaml: ['*.yml', '*.yaml'],
  yml: ['*.yml', '*.yaml'],
  toml: ['*.toml'],
  xml: ['*.xml'],
  sql: ['*.sql'],
  sh: ['*.sh', '*.bash', '*.zsh'],
  shell: ['*.sh', '*.bash', '*.zsh'],
}

interface QueryBudgetContext {
  callDeadline: number
  walkTimeoutMs: number
  walkMaxDirs: number
}

interface SearchLine {
  lineNumber: number
  text: string
  isMatch: boolean
  matchStart?: number
  matchEnd?: number
}

interface MatchedLineInfo {
  lineIndex: number
  matchStart?: number
  matchEnd?: number
}

interface FileMatches {
  file: string
  lines: SearchLine[]
  count?: number
}

interface TextSearchOutput {
  files: FileMatches[]
  totalMatches: number
  truncated: boolean
  budgetExceeded?: boolean
  engine: 'ripgrep' | 'node'
}

interface ExecutedQuerySection {
  text: string
  header: string
  errored: boolean
  blocked?: boolean
  engine?: 'ripgrep' | 'node'
  contentResult?: {
    files: FileMatches[]
    totalMatches: number
    truncated: boolean
    contextLines: number
  }
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const numeric =
    typeof val === 'string' && val.trim() !== '' ? Number(val) : val
  return clampIntStrict(numeric, min, max, fallback)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function parseMaybeJsonArray(
  raw: unknown,
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (Array.isArray(raw)) {
    return { ok: true, value: raw }
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) {
      return { ok: false, error: "Error: 'queries' must be a non-empty array of search queries." }
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return { ok: true, value: parsed }
      }
      return {
        ok: false,
        error: "Error: 'queries' JSON string must decode to an array of query objects.",
      }
    } catch {
      return {
        ok: false,
        error: "Error: 'queries' must be an array of query objects (or a valid JSON array string).",
      }
    }
  }
  return {
    ok: false,
    error: "Error: 'queries' must be a non-empty array of search queries.",
  }
}

function getRemainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

function getEffectiveWalkTimeoutMs(budget: QueryBudgetContext): number {
  return Math.min(budget.walkTimeoutMs, getRemainingMs(budget.callDeadline))
}

function patternTargetsHidden(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return /(?:^|[/,{])\.[^./]/.test(normalized)
}

function relativeFile(baseCwd: string, file: string): string {
  return toPosixPath(path.relative(baseCwd, path.resolve(baseCwd, file))) || path.basename(file)
}

function resolveFileTypeGlobs(fileType?: string): readonly string[] | null {
  if (fileType === undefined) return null
  if (typeof fileType !== 'string') throw new Error('fileType must be a string')
  const key = fileType.trim().toLowerCase().replace(/^\./, '')
  if (!key) return null
  if (Object.hasOwn(FILE_TYPE_GLOBS, key)) {
    return FILE_TYPE_GLOBS[key]!
  }
  if (/^[a-z0-9]+$/i.test(key)) return [`*.${key}`]
  throw new Error(`Unsupported fileType '${fileType}'`)
}

function fileTypeMatcher(fileType?: string): (file: string) => boolean {
  const globs = resolveFileTypeGlobs(fileType)
  if (!globs || globs.length === 0) return () => true
  const matchers = globs.map((g) => globToRegExp(g))
  return (file) => matchers.some((matcher) => matcher.test(path.basename(file)))
}

function createOutputPathChecker(
  policy: PolicyGuard,
  baseCwd: string,
): (filePath: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>()
  return (filePath: string): Promise<boolean> => {
    const abs = path.resolve(baseCwd, filePath)
    let pending = cache.get(abs)
    if (!pending) {
      pending = policy.isAllowedOutputPath(abs, baseCwd)
      cache.set(abs, pending)
    }
    return pending
  }
}

async function runTextOrRegexWithRg(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
  policy: PolicyGuard,
  budget: QueryBudgetContext,
): Promise<TextSearchOutput> {
  const maxResults = clampInt(query.maxResults, 1, 200, 40)
  const contextLines = clampInt(query.contextLines, 0, MAX_CONTEXT_LINES, 0)
  const summary = query.outputMode === 'count' || query.outputMode === 'files_with_matches'
  const typeGlobs = resolveFileTypeGlobs(query.fileType)
  const matchesType = fileTypeMatcher(query.fileType)
  const isAllowed = createOutputPathChecker(policy, baseCwd)

  const fileStat = await fs.stat(searchRoot)
  const isFileTarget = fileStat.isFile()
  if (isFileTarget) {
    if (!(await isAllowed(searchRoot))) {
      return { files: [], totalMatches: 0, truncated: false, engine: 'ripgrep' }
    }
    if (typeGlobs && !matchesType(searchRoot)) {
      return { files: [], totalMatches: 0, truncated: false, engine: 'ripgrep' }
    }
    if (fileStat.size > MAX_SEARCH_FILE_BYTES) {
      return { files: [], totalMatches: 0, truncated: false, engine: 'ripgrep' }
    }
    if (query.glob) {
      const negated = query.glob.startsWith('!')
      const rawGlob = negated ? query.glob.slice(1) : query.glob
      const globRe = globToRegExp(rawGlob)
      const relPosix = relativeFile(baseCwd, searchRoot)
      const matched = globRe.test(relPosix) || globRe.test(path.basename(searchRoot))
      if (negated ? matched : !matched) {
        return { files: [], totalMatches: 0, truncated: false, engine: 'ripgrep' }
      }
    }
    const fh = await fs.open(searchRoot, 'r')
    try {
      const head = Buffer.alloc(Math.min(fileStat.size, 8192))
      const { bytesRead } = await fh.read(head, 0, head.length, 0)
      if (isLikelyBinary(head.subarray(0, bytesRead))) {
        return { files: [], totalMatches: 0, truncated: false, engine: 'ripgrep' }
      }
    } finally {
      await fh.close()
    }
  }

  const perFileCap = isFileTarget ? maxResults : Math.min(maxResults, 50)

  const args: string[] = [
    '--no-config',
    '--no-messages',
    '--no-follow',
    '--max-filesize',
    '2M',
    '--crlf',
  ]
  if (query.multiline) {
    args.push('--multiline', '--multiline-dotall')
  }
  if (typeGlobs) {
    for (const glob of typeGlobs) {
      args.push('--type-add', `btfilter:${glob}`)
    }
    args.push('--type', 'btfilter')
  }
  if (query.type === 'text') {
    args.push('--fixed-strings')
  }
  if (query.caseSensitive === false) {
    args.push('--ignore-case')
  }
  if (query.glob) {
    args.push(`--glob=${query.glob}`)
  }

  const relNative = path.relative(baseCwd, searchRoot)
  const relRoot = toPosixPath(relNative)
  const isInsideBaseCwd =
    relRoot === '' ||
    (relRoot !== '..' && !relRoot.startsWith('../') && !path.isAbsolute(relRoot))
  const rgSearchTarget = isInsideBaseCwd
    ? !relNative
      ? '.'
      : relNative === '-'
        ? `.${path.sep}-`
        : relNative
    : searchRoot

  const rootSegments = isInsideBaseCwd
    ? relRoot
      ? relRoot.split('/')
      : []
    : toPosixPath(searchRoot).split('/').filter(Boolean)

  // Always emit default ignore-dir exclusions after user --glob (skipping only
  // non-.git dirs explicitly targeted by query.path).
  for (const dir of RG_DEFAULT_IGNORE_DIRS) {
    if (dir === '.git' || !rootSegments.includes(dir)) {
      args.push(`--glob=!**/${dir}/**`)
    }
  }

  // MANDATORY: emit policy secret deny globs AFTER user --glob so no user glob
  // (e.g. `*.env` or `**/*`) can ever override secret exclusions under rg's
  // last-match-wins precedence.
  args.push(...policy.getRgDenyGlobs())

  let rgTimedOut = false
  const runRg = async (
    runArgs: string[],
    opts?: { allowPartialError?: boolean },
  ): Promise<ExecResult> => {
    const remainingMs = getRemainingMs(budget.callDeadline)
    if (remainingMs <= 0) {
      rgTimedOut = true
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        durationMs: 0,
        stdout: '',
        stderr: '',
        truncated: false,
      }
    }
    const res = await execBinaryAsync('rg', runArgs, {
      cwd: baseCwd,
      timeoutMs: Math.max(250, Math.min(15_000, remainingMs)),
      maxOutputBytes: MAX_SEARCH_FILE_BYTES,
    })
    if (res.timedOut) {
      rgTimedOut = true
    }
    if (res.error) {
      throw new Error(`rg spawn error: ${res.error}`)
    }
    if (res.exitCode === 2 && !(opts?.allowPartialError && !res.stderr.trim())) {
      throw new Error(res.stderr.trim() || `rg failed for pattern: ${query.pattern}`)
    }
    return res
  }

  const cutShort = (res: ExecResult): boolean =>
    res.truncated || res.timedOut || res.exitCode === null

  if (summary) {
    const res = await runRg([
      ...args,
      ...(query.outputMode === 'count'
        ? [query.multiline ? '--count-matches' : '--count', '--with-filename', '--null']
        : ['--files-with-matches', '--null']),
      '--',
      query.pattern,
      rgSearchTarget,
    ])
    const candidates: Array<{ rawFile: string; relFile: string; count: number }> = []
    const out = res.stdout
    let pos = 0
    while (pos < out.length) {
      const nul = out.indexOf('\0', pos)
      if (nul === -1) break
      const rawFile = out.slice(pos, nul)
      let count = 0
      if (query.outputMode === 'count') {
        const nl = out.indexOf('\n', nul + 1)
        if (nl === -1) break
        const rawCount = out.slice(nul + 1, nl).trim()
        count = Number(rawCount)
        pos = nl + 1
      } else {
        pos = nul + 1
      }
      if (!rawFile || !matchesType(rawFile)) continue
      candidates.push({
        rawFile,
        relFile: relativeFile(baseCwd, rawFile),
        count: Number.isFinite(count) ? count : 0,
      })
    }

    const allowedFlags = await Promise.all(candidates.map((c) => isAllowed(c.rawFile)))
    const files: FileMatches[] = []
    for (let i = 0; i < candidates.length; i++) {
      if (!allowedFlags[i]) continue
      const item = candidates[i]!
      files.push({ file: item.relFile, lines: [], count: item.count })
    }
    files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    return {
      files: files.slice(0, maxResults),
      totalMatches: 0,
      truncated: files.length > maxResults || cutShort(res),
      ...(rgTimedOut ? { budgetExceeded: true } : {}),
      engine: 'ripgrep',
    }
  }

  const maxCountArgs = query.multiline ? [] : ['--max-count', String(perFileCap + 1)]
  let chosen: Array<{ rawFile: string; relFile: string; count: number }>
  let truncated = false

  if (isFileTarget) {
    chosen = [
      {
        rawFile: searchRoot,
        relFile: relativeFile(baseCwd, searchRoot),
        count: Number.POSITIVE_INFINITY,
      },
    ]
  } else {
    const counts = await runRg([
      ...args,
      ...maxCountArgs,
      '--count',
      '--with-filename',
      '--null',
      '--',
      query.pattern,
      rgSearchTarget,
    ])
    const rawCounted: Array<{ rawFile: string; relFile: string; count: number }> = []
    for (const record of counts.stdout.split('\n').slice(0, -1)) {
      const sep = record.lastIndexOf('\0')
      const count = Number(record.slice(sep + 1))
      if (sep <= 0 || !Number.isInteger(count) || count <= 0) continue
      const rawFile = record.slice(0, sep)
      if (!matchesType(rawFile)) continue
      rawCounted.push({ rawFile, relFile: relativeFile(baseCwd, rawFile), count })
    }

    const allowedFlags = await Promise.all(rawCounted.map((c) => isAllowed(c.rawFile)))
    const counted = rawCounted.filter((_, idx) => allowedFlags[idx])
    counted.sort((a, b) => (a.relFile < b.relFile ? -1 : a.relFile > b.relFile ? 1 : 0))

    chosen = []
    let coveredMatches = 0
    for (const item of counted) {
      if (coveredMatches >= maxResults) break
      chosen.push(item)
      coveredMatches += query.multiline ? item.count : Math.min(item.count, perFileCap)
    }
    truncated = cutShort(counts) || chosen.length < counted.length
    if (chosen.length === 0) {
      return {
        files: [],
        totalMatches: 0,
        truncated,
        ...(rgTimedOut ? { budgetExceeded: true } : {}),
        engine: 'ripgrep',
      }
    }
  }

  const toRgArgPath = (rawFile: string): string => {
    const rel = path.relative(baseCwd, path.resolve(baseCwd, rawFile))
    const chosenPath =
      rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
        ? rel
        : rawFile
    return chosenPath === '-' ? `.${path.sep}-` : chosenPath
  }

  const rgChunks: string[][] = []
  let currentChunk: string[] = []
  let currentChunkChars = 0
  const maxArgChars = 20_000
  for (const item of chosen) {
    const argPath = toRgArgPath(item.rawFile)
    const est = argPath.length + 3
    if (currentChunk.length > 0 && currentChunkChars + est > maxArgChars) {
      rgChunks.push(currentChunk)
      currentChunk = []
      currentChunkChars = 0
    }
    currentChunk.push(argPath)
    currentChunkChars += est
  }
  if (currentChunk.length > 0) rgChunks.push(currentChunk)

  const byFile = new Map<string, Map<number, SearchLine>>()
  for (const chunk of rgChunks) {
    const res = await runRg(
      [
        ...args,
        ...maxCountArgs,
        '--json',
        ...(contextLines > 0 ? ['-C', String(contextLines)] : []),
        '--',
        query.pattern,
        ...chunk,
      ],
      { allowPartialError: !isFileTarget },
    )
    if (cutShort(res)) truncated = true

    for (const rawLine of res.stdout.split('\n')) {
      if (!rawLine.trim()) continue
      let ev: {
        type?: string
        data?: {
          path?: { text?: string; bytes?: string }
          line_number?: number
          lines?: { text?: string; bytes?: string }
          submatches?: Array<{ start?: number; end?: number }>
        }
      }
      try {
        ev = JSON.parse(rawLine) as typeof ev
      } catch {
        continue
      }
      if (ev.type !== 'match' && ev.type !== 'context') continue
      const rawFile =
        ev.data?.path?.text ??
        (ev.data?.path?.bytes
          ? Buffer.from(ev.data.path.bytes, 'base64').toString('utf8')
          : undefined)
      const lineNumber = ev.data?.line_number
      const rawBuf = ev.data?.lines?.bytes
        ? Buffer.from(ev.data.lines.bytes, 'base64')
        : null
      const rawText = ev.data?.lines?.text ?? (rawBuf ? rawBuf.toString('utf8') : '')
      if (!rawFile || typeof lineNumber !== 'number') continue
      if (!(await isAllowed(rawFile))) continue

      const relFile = relativeFile(baseCwd, rawFile)
      let lineMap = byFile.get(relFile)
      if (!lineMap) {
        lineMap = new Map<number, SearchLine>()
        byFile.set(relFile, lineMap)
      }
      const isMatch = ev.type === 'match'
      const submatchRanges: Array<{ start: number; end: number }> = []
      if (isMatch && Array.isArray(ev.data?.submatches) && ev.data.submatches.length > 0) {
        let utf8Buf = rawBuf
        const isAsciiOnly = !utf8Buf && utf8ByteLength(rawText) === rawText.length
        const byteToChar = (byteOffset: number): number => {
          if (byteOffset <= 0) return 0
          if (isAsciiOnly) return Math.min(byteOffset, rawText.length)
          if (!utf8Buf) utf8Buf = Buffer.from(rawText, 'utf8')
          const clamped = Math.min(byteOffset, utf8Buf.length)
          return utf8Buf.subarray(0, clamped).toString('utf8').length
        }
        for (const sm of ev.data.submatches) {
          if (typeof sm?.start !== 'number') continue
          const start = byteToChar(sm.start)
          const end = typeof sm.end === 'number' ? Math.max(start, byteToChar(sm.end)) : start
          submatchRanges.push({ start, end })
        }
      }

      const lineText = rawText.replace(/\r?\n$/, '')
      const segments = isMatch && query.multiline ? lineText.split(/\r?\n/) : [lineText]
      let segStart = 0
      for (const [offset, text] of segments.entries()) {
        const segEnd = segStart + text.length
        const line = lineNumber + offset
        if (!lineMap.get(line)?.isMatch) {
          let matchStart: number | undefined
          let matchEnd: number | undefined
          if (isMatch && submatchRanges.length > 0) {
            const hit = submatchRanges.find((r) =>
              r.start === r.end
                ? r.start >= segStart && r.start <= segEnd
                : r.start <= segEnd && r.end > segStart,
            )
            if (hit) {
              matchStart = Math.max(0, Math.min(hit.start - segStart, text.length))
              matchEnd = Math.max(matchStart, Math.min(hit.end - segStart, text.length))
            }
          }
          lineMap.set(line, {
            lineNumber: line,
            text,
            isMatch,
            ...(matchStart !== undefined ? { matchStart, matchEnd } : {}),
          })
        }
        segStart = segEnd
        if (rawText[segStart] === '\r' && rawText[segStart + 1] === '\n') {
          segStart += 2
        } else if (rawText[segStart] === '\n') {
          segStart += 1
        }
      }
    }
  }

  const files: FileMatches[] = []
  let totalMatches = 0
  for (const { relFile, count } of chosen) {
    if (totalMatches >= maxResults) {
      truncated = true
      break
    }
    const fileCap = query.multiline ? maxResults : Math.min(count, perFileCap)
    const fileBudget = Math.min(fileCap, maxResults - totalMatches)
    const sorted = [...(byFile.get(relFile)?.values() ?? [])].sort(
      (a, b) => a.lineNumber - b.lineNumber,
    )
    const lines: SearchLine[] = []
    let kept = 0
    let lastKeptMatchLine = -1
    for (const line of sorted) {
      if (line.isMatch) {
        if (kept === fileBudget) {
          truncated = true
          if (
            lastKeptMatchLine !== -1 &&
            line.lineNumber <= lastKeptMatchLine + contextLines
          ) {
            lines.push({ lineNumber: line.lineNumber, text: line.text, isMatch: false })
          }
          continue
        }
        kept += 1
        lastKeptMatchLine = line.lineNumber
        lines.push(line)
      } else if (kept < fileBudget || line.lineNumber <= lastKeptMatchLine + contextLines) {
        lines.push(line)
      }
    }
    if (kept === 0) continue
    files.push({ file: relFile, lines })
    totalMatches += kept
  }

  return {
    files,
    totalMatches,
    truncated,
    ...(rgTimedOut ? { budgetExceeded: true } : {}),
    engine: 'ripgrep',
  }
}

function* multilineMatches(content: string, regex: RegExp): Generator<RegExpMatchArray> {
  let previousEnd = -1
  for (const match of content.matchAll(regex)) {
    const start = match.index!
    if (start === content.length && (content.length === 0 || content.endsWith('\n'))) break
    if (match[0] === '') {
      if (start === previousEnd || (content[start - 1] === '\r' && content[start] === '\n')) {
        continue
      }
    }
    previousEnd = start + match[0].length
    yield match
  }
}

function multilineMatchLines(
  content: string,
  regex: RegExp,
  limit: number,
): MatchedLineInfo[] {
  const results: MatchedLineInfo[] = []
  let line = 0
  let lineStart = 0
  let nextBreak = content.indexOf('\n')

  for (const match of multilineMatches(content, regex)) {
    const start = match.index!
    const rawEnd = start + match[0].length
    const end = start + Math.max(0, match[0].length - 1)
    while (nextBreak !== -1 && nextBreak < start) {
      line++
      lineStart = nextBreak + 1
      nextBreak = content.indexOf('\n', lineStart)
    }
    while (true) {
      if (results.at(-1)?.lineIndex !== line) {
        const rawLineEnd = nextBreak === -1 ? content.length : nextBreak
        const lineEnd =
          rawLineEnd > lineStart && content[rawLineEnd - 1] === '\r'
            ? rawLineEnd - 1
            : rawLineEnd
        const lineLen = lineEnd - lineStart
        const matchStart = Math.max(0, Math.min(start - lineStart, lineLen))
        const matchEnd = Math.max(matchStart, Math.min(rawEnd - lineStart, lineLen))
        results.push({ lineIndex: line, matchStart, matchEnd })
      }
      if (results.length >= limit) return results
      if (nextBreak === -1 || nextBreak >= end) break
      line++
      lineStart = nextBreak + 1
      nextBreak = content.indexOf('\n', lineStart)
    }
  }
  return results
}

async function runTextOrRegexWithNode(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
  policy: PolicyGuard,
  budget: QueryBudgetContext,
): Promise<TextSearchOutput> {
  const maxResults = clampInt(query.maxResults, 1, 200, 40)
  const contextLines = clampInt(query.contextLines, 0, MAX_CONTEXT_LINES, 0)
  const flags = (query.caseSensitive === false ? 'i' : '') + (query.multiline ? 'gmsu' : '')
  const isAllowed = createOutputPathChecker(policy, baseCwd)

  let regex: RegExp
  if (query.type === 'regex') {
    try {
      regex = new RegExp(query.pattern, flags)
    } catch (err) {
      if (flags.includes('u')) {
        try {
          regex = new RegExp(query.pattern, flags.replace('u', ''))
        } catch {
          throw new Error(
            `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      } else {
        throw new Error(
          `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  } else {
    const escaped = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    regex = new RegExp(escaped, flags)
  }

  const summary = query.outputMode === 'count' || query.outputMode === 'files_with_matches'
  const matchesType = fileTypeMatcher(query.fileType)
  let discoveryTruncated = false
  const globNegated = Boolean(query.glob && query.glob.startsWith('!'))
  const rawGlob = query.glob ? (globNegated ? query.glob.slice(1) : query.glob) : null
  const globRegex = rawGlob ? globToRegExp(rawGlob) : null
  const globMatchesFile = (relPosix: string): boolean => {
    if (!matchesType(relPosix)) return false
    if (!globRegex) return true
    let matched = globRegex.test(relPosix)
    if (!matched && !rawGlob!.includes('/')) {
      const base = relPosix.split('/').pop() ?? relPosix
      matched = globRegex.test(base)
    }
    return globNegated ? !matched : matched
  }

  const stat = await fs.stat(searchRoot)
  const perFileCap = stat.isFile() ? maxResults : Math.min(maxResults, 50)
  let targetFiles: Array<{ abs: string; rel: string }>
  let discoveryBudgetExceeded = false

  if (stat.isFile()) {
    const allowed = await isAllowed(searchRoot)
    const relPosix =
      toPosixPath(path.relative(baseCwd, searchRoot)) || path.basename(searchRoot)
    targetFiles =
      allowed && globMatchesFile(relPosix)
        ? [{ abs: searchRoot, rel: relativeFile(baseCwd, searchRoot) }]
        : []
  } else {
    const includeHidden = Boolean(
      rawGlob && !globNegated && patternTargetsHidden(rawGlob),
    )
    const walkRemainingMs = getEffectiveWalkTimeoutMs(budget)
    if (walkRemainingMs <= 0) {
      return {
        files: [],
        totalMatches: 0,
        truncated: true,
        budgetExceeded: true,
        engine: 'node',
      }
    }
    const walked = await walkFiles(searchRoot, {
      maxFiles: 8000,
      includeHidden,
      ignoreDirs: DEFAULT_IGNORE_DIRS,
      fileFilter: globMatchesFile,
      timeoutMs: walkRemainingMs,
      maxDirs: budget.walkMaxDirs,
      policy,
    })
    discoveryTruncated = walked.truncated
    if (walked.timedOut || walked.dirsTruncated) {
      discoveryBudgetExceeded = true
    }

    const rootRel = toPosixPath(path.relative(baseCwd, searchRoot))
    const useFastPrefix = Boolean(
      rootRel === '' || (!rootRel.startsWith('..') && !path.isAbsolute(rootRel)),
    )
    const rawTargets = walked.files.map((rel) => {
      const abs = path.join(searchRoot, rel)
      const displayRel = useFastPrefix
        ? rootRel
          ? `${rootRel}/${rel}`
          : rel
        : relativeFile(baseCwd, abs)
      return { abs, rel: displayRel }
    })
    const allowedFlags = await Promise.all(rawTargets.map((t) => isAllowed(t.abs)))
    targetFiles = rawTargets.filter((_, idx) => allowedFlags[idx])
    targetFiles.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  }

  const canBufPrecheck =
    query.type === 'text' &&
    query.caseSensitive !== false &&
    !query.multiline &&
    query.pattern.length > 0 &&
    !query.pattern.includes('\uFFFD')
  const patternBuf = canBufPrecheck ? Buffer.from(query.pattern, 'utf8') : null
  const canTextCaseInsensitivePrecheck =
    query.type === 'text' &&
    query.caseSensitive === false &&
    !query.multiline &&
    query.pattern.length > 0
  let wholeFileRegex: RegExp | null = null
  const regexHasDollar = query.type === 'regex' && query.pattern.includes('$')
  const regexUnsafeForWholeFile =
    query.type === 'regex' && /\(\?<?[=!]|\(\?[a-z]*-[a-z]*m/.test(query.pattern)
  if (query.type === 'regex' && !query.multiline && !regexUnsafeForWholeFile) {
    try {
      wholeFileRegex = new RegExp(
        regex.source,
        `${query.caseSensitive === false ? 'i' : ''}m`,
      )
    } catch {
      wholeFileRegex = null
    }
  }

  const files: FileMatches[] = []
  let totalMatches = 0
  let truncated = false

  const buildFileMatches = (
    relFile: string,
    allLines: string[],
    keptMatches: MatchedLineInfo[],
  ): FileMatches => {
    const lineMap = new Map<number, SearchLine>()
    for (const match of keptMatches) {
      const mIdx = match.lineIndex
      const from = Math.max(0, mIdx - contextLines)
      const to = Math.min(allLines.length - 1, mIdx + contextLines)
      for (let j = from; j <= to; j++) {
        const ln = j + 1
        const prev = lineMap.get(ln)
        if (j === mIdx) {
          if (!prev?.isMatch) {
            lineMap.set(ln, {
              lineNumber: ln,
              text: allLines[j]!,
              isMatch: true,
              ...(match.matchStart !== undefined
                ? { matchStart: match.matchStart, matchEnd: match.matchEnd }
                : {}),
            })
          }
        } else if (!prev) {
          lineMap.set(ln, {
            lineNumber: ln,
            text: allLines[j]!,
            isMatch: false,
          })
        }
      }
    }
    return {
      file: relFile,
      lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber),
    }
  }

  const batchSize = 16
  let anyFileTruncated = false
  let scanTimedOut = false
  for (let i = 0; i < targetFiles.length && !truncated; i += batchSize) {
    if (Date.now() >= budget.callDeadline) {
      scanTimedOut = true
      truncated = true
      break
    }
    const batch = targetFiles.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map(async ({ abs: absFile, rel: relFile }) => {
        try {
          const st = await fs.stat(absFile)
          if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) return null
          const buf = await fs.readFile(absFile)
          if (isLikelyBinary(buf)) return null
          if (patternBuf && buf.indexOf(patternBuf) === -1) return null

          const content = buf.toString('utf8')
          if (canTextCaseInsensitivePrecheck && !regex.test(content)) return null
          if (wholeFileRegex && (!regexHasDollar || buf.indexOf(0x0d) === -1)) {
            if (!wholeFileRegex.test(content)) return null
          }

          let lines: string[] = []
          let matchedLines: MatchedLineInfo[] = []
          let count = 0
          let fileTruncated = false
          if (query.multiline && summary) {
            for (const _match of multilineMatches(content, regex)) {
              count++
              if (query.outputMode === 'files_with_matches') break
            }
          } else if (query.multiline) {
            matchedLines = multilineMatchLines(content, regex, maxResults + 1)
            count = matchedLines.length
            if (count > 0) {
              lines = content.split(/\r?\n/)
              if (lines.length > 0 && lines.at(-1) === '') lines.pop()
            }
          } else {
            lines = content.split(/\r?\n/)
            if (lines.length > 0 && lines.at(-1) === '') lines.pop()
            for (let idx = 0; idx < lines.length; idx++) {
              const line = lines[idx]!
              const hit = summary
                ? regex.test(line)
                  ? { index: 0, length: 0 }
                  : null
                : (() => {
                    const m = regex.exec(line)
                    return m ? { index: m.index, length: m[0].length } : null
                  })()
              if (hit) {
                if (!summary && matchedLines.length >= perFileCap) {
                  fileTruncated = true
                  break
                }
                matchedLines.push({
                  lineIndex: idx,
                  matchStart: hit.index,
                  matchEnd: hit.index + hit.length,
                })
                if (query.outputMode === 'files_with_matches') break
              }
            }
            count = matchedLines.length
          }
          if (!count) return null
          return {
            relFile,
            lines: summary ? [] : lines,
            matchedLines,
            count,
            fileTruncated,
          }
        } catch {
          return null
        }
      }),
    )

    for (const item of results) {
      if (!item) continue
      if (summary) {
        if (files.length === maxResults) {
          truncated = true
          break
        }
        files.push({ file: item.relFile, lines: [], count: item.count })
        continue
      }
      if (item.fileTruncated) {
        anyFileTruncated = true
      }
      if (totalMatches + item.matchedLines.length > maxResults) {
        const remaining = maxResults - totalMatches
        if (remaining > 0) {
          const kept = item.matchedLines.slice(0, remaining)
          files.push(buildFileMatches(item.relFile, item.lines, kept))
          totalMatches += kept.length
        }
        truncated = true
        break
      }
      files.push(buildFileMatches(item.relFile, item.lines, item.matchedLines))
      totalMatches += item.matchedLines.length
    }
  }

  return {
    files,
    totalMatches,
    truncated: truncated || anyFileTruncated || discoveryTruncated,
    ...(discoveryBudgetExceeded || scanTimedOut ? { budgetExceeded: true } : {}),
    engine: 'node',
  }
}

interface GlobFallbackPlan {
  match: (relPosix: string, base: string) => boolean
  matchedNote: string
  emptyMessage: string
}

function buildGlobFallbackPlan(pattern: string): GlobFallbackPlan | null {
  if (!pattern.includes('{') && pattern.includes('|')) {
    const terms = pattern
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean)
    if (terms.length >= 2) {
      const termMatchers = terms.map((term) => {
        const hasGlobMeta = /[*?[\]{}]/.test(term)
        if (hasGlobMeta) {
          try {
            const re = globToRegExp(term)
            const matchBase = !term.includes('/')
            return (relPosix: string, base: string) =>
              re.test(relPosix) || (matchBase && re.test(base))
          } catch {
            // Fall through to case-insensitive substring matching.
          }
        }
        const needle = term.toLowerCase()
        return (relPosix: string) => relPosix.toLowerCase().includes(needle)
      })
      const allBare = terms.every((t) => !/[*?[\]{}/]/.test(t))
      const label = allBare ? `**/*{${terms.join(',')}}*` : `{${terms.join(',')}}`
      return {
        match: (relPosix, base) => termMatchers.some((fn) => fn(relPosix, base)),
        matchedNote: `[note: exact glob matched 0 files; auto-expanded regex '|' to "${label}" (glob uses * and {a,b}, not |)]`,
        emptyMessage: '(no files matched; hint: glob uses * and {a,b}, not regex |)',
      }
    }
  }

  if (/^[A-Za-z0-9_-]+$/.test(pattern)) {
    const needle = pattern.toLowerCase()
    return {
      match: (relPosix) => relPosix.toLowerCase().includes(needle),
      matchedNote: `[note: exact glob "${pattern}" matched 0 files; showing case-insensitive path matches for "*${pattern}*"]`,
      emptyMessage: '(no files matched)',
    }
  }

  return null
}

async function formatGlobWalkResult(
  walked: {
    files: string[]
    truncated: boolean
    timedOut?: boolean
    dirsTruncated?: boolean
  },
  searchRoot: string,
  baseCwd: string,
  policy: PolicyGuard,
  maxResults: number,
  sortBy: SearchQuery['sortBy'],
  notePrefix?: string,
): Promise<string> {
  const isAllowed = createOutputPathChecker(policy, baseCwd)
  const allowedFlags = await Promise.all(
    walked.files.map((rel) => isAllowed(path.join(searchRoot, rel))),
  )
  const allowedFiles = walked.files.filter((_, idx) => allowedFlags[idx])
  if (allowedFiles.length === 0) {
    return '(no files matched)'
  }

  const relPrefix = toPosixPath(path.relative(baseCwd, searchRoot))
  const sortedFiles = [...allowedFiles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (sortBy === 'mtime') {
    const mtimes = new Map<string, number>()
    for (let i = 0; i < sortedFiles.length; i += 32) {
      await Promise.all(
        sortedFiles.slice(i, i + 32).map(async (file) => {
          const stat = await fs.lstat(path.join(searchRoot, file)).catch(() => undefined)
          mtimes.set(file, stat?.mtimeMs ?? -Infinity)
        }),
      )
    }
    sortedFiles.sort(
      (a, b) => (mtimes.get(b) ?? -Infinity) - (mtimes.get(a) ?? -Infinity) || (a < b ? -1 : a > b ? 1 : 0),
    )
  }

  const items = sortedFiles.slice(0, maxResults).map((f) => {
    if (!relPrefix || relPrefix === '.') return f
    return `${relPrefix}/${f}`
  })
  const truncated = walked.truncated || sortedFiles.length > maxResults
  const header = notePrefix ? `${notePrefix}\n` : ''

  if (!truncated) {
    return `${header}${items.join('\n')}`
  }

  const omitted = sortedFiles.slice(maxResults)
  const dirCounts = new Map<string, number>()
  for (const f of omitted) {
    const slash = f.indexOf('/')
    const bucket = slash === -1 ? '(root)' : `${f.slice(0, slash)}/`
    dirCounts.set(bucket, (dirCounts.get(bucket) ?? 0) + 1)
  }
  const topDirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 6)
    .map(([dir, cnt]) => `${dir} (${cnt})`)
  const totalLabel = walked.truncated ? `${allowedFiles.length}+` : String(allowedFiles.length)
  const dirSummary = topDirs.length > 0 ? `; omitted dirs: ${topDirs.join(', ')}` : ''
  const budgetNote =
    walked.timedOut || walked.dirsTruncated
      ? "; scan budget reached — narrow 'path' or 'glob'"
      : ''
  const suffix = `\n... [truncated at ${maxResults} of ${totalLabel} files${dirSummary}${budgetNote}]`
  return `${header}${items.join('\n')}${suffix}`
}

async function runGlobQuery(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
  isFileTarget: boolean,
  policy: PolicyGuard,
  budget: QueryBudgetContext,
): Promise<string> {
  const maxResults = clampInt(query.maxResults, 1, 300, 80)
  const pattern = query.pattern.trim() || '**/*'
  const matcher = globToRegExp(pattern, query.caseSensitive !== false)
  const matchBasename = !pattern.includes('/')
  const includeHidden = patternTargetsHidden(pattern)
  const matchesType = fileTypeMatcher(query.fileType)

  if (isFileTarget) {
    if (!(await policy.isAllowedOutputPath(searchRoot, baseCwd))) {
      return '(no files matched)'
    }
    const rel = toPosixPath(path.relative(baseCwd, searchRoot)) || path.basename(searchRoot)
    const base = path.basename(searchRoot)
    if (!matchesType(rel)) return '(no files matched)'
    const matched = matcher.test(rel) || (matchBasename && matcher.test(base))
    if (matched) return rel
    const fallback = buildGlobFallbackPlan(pattern)
    if (fallback) {
      return fallback.match(rel, base)
        ? `${fallback.matchedNote}\n${rel}`
        : fallback.emptyMessage
    }
    return '(no files matched)'
  }

  const walkRemainingMs = getEffectiveWalkTimeoutMs(budget)
  if (walkRemainingMs <= 0) {
    return "(no files matched before scan budget reached — narrow 'path' or 'glob')"
  }

  const scanLimit = Math.max(maxResults + 1, 2000)
  const walked = await walkFiles(searchRoot, {
    maxFiles: scanLimit,
    includeHidden,
    timeoutMs: walkRemainingMs,
    maxDirs: budget.walkMaxDirs,
    policy,
    fileFilter: (relPosix) => {
      if (!matchesType(relPosix)) return false
      if (matcher.test(relPosix)) return true
      if (matchBasename) {
        const base = relPosix.split('/').pop() ?? relPosix
        return matcher.test(base)
      }
      return false
    },
  })

  if (walked.files.length > 0) {
    return formatGlobWalkResult(walked, searchRoot, baseCwd, policy, maxResults, query.sortBy)
  }

  if (walked.timedOut || walked.dirsTruncated) {
    return "(no files matched before scan budget reached — narrow 'path' or 'glob')"
  }

  const fallback = buildGlobFallbackPlan(pattern)
  if (fallback) {
    const fallbackRemainingMs = getEffectiveWalkTimeoutMs(budget)
    if (fallbackRemainingMs <= 0) {
      return "(no files matched before scan budget reached — narrow 'path' or 'glob')"
    }
    const fallbackWalked = await walkFiles(searchRoot, {
      maxFiles: scanLimit,
      includeHidden,
      timeoutMs: fallbackRemainingMs,
      maxDirs: budget.walkMaxDirs,
      policy,
      fileFilter: (relPosix) => {
        if (!matchesType(relPosix)) return false
        const base = relPosix.split('/').pop() ?? relPosix
        return fallback.match(relPosix, base)
      },
    })
    if (fallbackWalked.files.length > 0) {
      return formatGlobWalkResult(
        fallbackWalked,
        searchRoot,
        baseCwd,
        policy,
        maxResults,
        query.sortBy,
        fallback.matchedNote,
      )
    }
    if (fallbackWalked.timedOut || fallbackWalked.dirsTruncated) {
      return "(no files matched before scan budget reached — narrow 'path' or 'glob')"
    }
    return fallback.emptyMessage
  }

  return '(no files matched)'
}

async function runFuzzyQuery(
  query: SearchQuery,
  searchRoot: string,
  baseCwd: string,
  isFileTarget: boolean,
  policy: PolicyGuard,
  budget: QueryBudgetContext,
): Promise<string> {
  const pattern = query.pattern.trim()
  if (!pattern) throw new Error('Fuzzy pattern must not be blank')
  const matchesType = fileTypeMatcher(query.fileType)
  const maxResults = clampInt(query.maxResults, 1, 200, 30)
  const isAllowed = createOutputPathChecker(policy, baseCwd)
  const walkRemainingMs = getEffectiveWalkTimeoutMs(budget)

  if (!isFileTarget && walkRemainingMs <= 0) {
    return "(no files matched before scan budget reached — narrow 'path')"
  }

  const walked = isFileTarget
    ? { files: [searchRoot], truncated: false, timedOut: false, dirsTruncated: false }
    : await walkFiles(searchRoot, {
        maxFiles: 8000,
        fileFilter: matchesType,
        timeoutMs: walkRemainingMs,
        maxDirs: budget.walkMaxDirs,
        policy,
      })

  const rawPaths = walked.files
    .filter(matchesType)
    .map((file) => path.resolve(searchRoot, file))
  const allowedFlags = await Promise.all(rawPaths.map((abs) => isAllowed(abs)))
  const candidates = rawPaths
    .filter((_, idx) => allowedFlags[idx])
    .map((abs) => relativeFile(baseCwd, abs))

  const ranked = rankFuzzyPaths(candidates, pattern, maxResults + 1)
  const hasMore = ranked.length > maxResults
  const matches = hasMore ? ranked.slice(0, maxResults) : ranked
  const budgetHit = Boolean(walked.timedOut || walked.dirsTruncated)

  if (matches.length === 0) {
    return budgetHit
      ? "(no files matched before scan budget reached — narrow 'path')"
      : '(no files matched)'
  }

  const body = matches.map((m) => m.path).join('\n')
  const budgetNote = budgetHit ? "; scan budget reached — narrow 'path'" : ''
  const footer =
    walked.truncated || hasMore
      ? `\n... [truncated; showing ${matches.length} files${budgetNote}]`
      : ''
  return body + footer
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function formatLineSnippet(line: SearchLine, maxChars = MAX_SEARCH_LINE_CHARS): string {
  const text = line.text
  if (text.length <= maxChars) return text
  if (!line.isMatch || line.matchStart === undefined) {
    return `${sliceSafeChars(text, maxChars)}...`
  }

  const len = text.length
  const mStart = clampInt(line.matchStart, 0, len, 0)
  const mEnd =
    line.matchEnd !== undefined ? clampInt(line.matchEnd, mStart, len, mStart) : mStart

  const prefix = sliceSafeChars(text, maxChars)
  if (mStart < prefix.length && mEnd <= prefix.length) {
    return `${prefix}...`
  }

  const matchLen = mEnd - mStart
  const lead =
    matchLen >= maxChars
      ? Math.min(Math.floor(maxChars * 0.1), mStart)
      : Math.min(
          Math.min(80, Math.floor(maxChars * 0.35)),
          Math.floor((maxChars - matchLen) / 2),
        )

  let winStart = Math.max(0, mStart - lead)
  let winEnd = Math.min(len, winStart + maxChars)
  if (winEnd === len) {
    winStart = Math.max(0, winEnd - maxChars)
  }

  if (winStart > 0 && winStart < len && isLowSurrogate(text.charCodeAt(winStart))) {
    if (winStart === mStart && isHighSurrogate(text.charCodeAt(winStart - 1))) {
      winStart -= 1
    } else {
      winStart += 1
    }
  }
  if (winEnd < len && winEnd > winStart && isHighSurrogate(text.charCodeAt(winEnd - 1))) {
    winEnd -= 1
  }
  if (winEnd < winStart) winEnd = winStart

  const leadEllipsis = winStart > 0 ? '...' : ''
  const trailEllipsis = winEnd < len ? '...' : ''
  return `${leadEllipsis}${text.slice(winStart, winEnd)}${trailEllipsis}`
}

function formatFileMatches(
  files: FileMatches[],
  totalMatches: number,
  truncated: boolean,
): string {
  if (files.length === 0) {
    return '(no matches)'
  }
  const blocks: string[] = []
  for (const fm of files) {
    const lines = fm.lines.map((l) => {
      const sep = l.isMatch ? ':' : '-'
      return `  ${l.lineNumber}${sep} ${formatLineSnippet(l)}`
    })
    blocks.push(`${fm.file}\n${lines.join('\n')}`)
  }
  const footer = truncated ? `\n... [truncated at ${totalMatches} matches]` : ''
  return `${blocks.join('\n')}${footer}`
}

interface TextCost {
  chars: number
  bytes: number
}

function measureCost(text: string): TextCost {
  return { chars: text.length, bytes: utf8ByteLength(text) }
}

interface BudgetedLineEntry {
  lineNumber: number
  isMatch: boolean
  formatted: string
  cost: TextCost
}

interface BudgetedFileState {
  file: string
  headerCost: TextCost
  matchEntries: BudgetedLineEntry[]
  contextEntries: BudgetedLineEntry[]
  firstMatchLine: SearchLine
  shownMatches: number
  selectedContexts: BudgetedLineEntry[]
  selectedLineNums: Set<number>
}

function fileOmissionMarker(omitted: number): string {
  if (omitted <= 0) return ''
  return `\n  ... (+${omitted} more ${omitted === 1 ? 'match' : 'matches'})`
}

function buildTruncatedNotice(
  shownMatches: number,
  totalMatches: number,
  shownFiles: number,
  totalFiles: number,
  maxResultsTruncated: boolean,
  omittedContextOnly: boolean,
): string {
  const totalLabel = maxResultsTruncated ? `${totalMatches}+` : `${totalMatches}`
  const filesLabel =
    shownFiles < totalFiles
      ? `across ${shownFiles} of ${totalFiles} files`
      : totalFiles === 1
        ? 'in 1 file'
        : `across ${totalFiles} files`
  if (omittedContextOnly) {
    return `\n... [truncated: showed all ${shownMatches} ${shownMatches === 1 ? 'match' : 'matches'} ${filesLabel}; omitted context lines${maxResultsTruncated ? `; capped at ${totalMatches} matches` : ''}]`
  }
  return `\n... [truncated: showed ${shownMatches} of ${totalLabel} matches ${filesLabel}]`
}

function fitShrunkMatchLine(
  line: SearchLine,
  maxChars: number,
  maxBytes: number,
): string | null {
  const prefix = `  ${line.lineNumber}: `
  const prefixBytes = utf8ByteLength(prefix)
  const availChars = maxChars - prefix.length
  const availBytes = maxBytes - prefixBytes
  if (availChars < 24 || availBytes < 24) return null

  let winBudget = Math.min(
    MAX_SEARCH_LINE_CHARS,
    Math.max(16, Math.min(availChars, availBytes) - 6),
  )
  for (let attempt = 0; attempt < 6; attempt++) {
    const snippet = formatLineSnippet(line, winBudget)
    const full = `${prefix}${snippet}`
    const fullBytes = utf8ByteLength(full)
    if (full.length <= maxChars && fullBytes <= maxBytes) {
      return full
    }
    const ratio = Math.min(
      availChars / Math.max(1, snippet.length),
      availBytes / Math.max(1, fullBytes - prefixBytes),
    )
    const nextWin = Math.floor(Math.min(winBudget, snippet.length) * ratio) - 4
    if (nextWin < 16 || nextWin >= winBudget) break
    winBudget = nextWin
  }
  return null
}

function formatBudgetedContentSection(params: {
  header: string
  files: FileMatches[]
  totalMatches: number
  maxResultsTruncated: boolean
  contextLines: number
  charBudget: number
  byteBudget: number
}): string | null {
  const {
    header,
    files,
    totalMatches,
    maxResultsTruncated,
    contextLines,
    charBudget,
    byteBudget,
  } = params

  const headerCost = measureCost(header)
  if (charBudget <= headerCost.chars + 40 || byteBudget <= headerCost.bytes + 40) {
    return null
  }

  const states: BudgetedFileState[] = []
  let totalContextCount = 0
  for (const fm of files) {
    const matchEntries: BudgetedLineEntry[] = []
    const contextEntries: BudgetedLineEntry[] = []
    let firstMatchLine: SearchLine | undefined
    for (const l of fm.lines) {
      const sep = l.isMatch ? ':' : '-'
      const formatted = `  ${l.lineNumber}${sep} ${formatLineSnippet(l)}`
      const entry: BudgetedLineEntry = {
        lineNumber: l.lineNumber,
        isMatch: l.isMatch,
        formatted,
        cost: {
          chars: 1 + formatted.length,
          bytes: 1 + utf8ByteLength(formatted),
        },
      }
      if (l.isMatch) {
        if (!firstMatchLine) firstMatchLine = l
        matchEntries.push(entry)
      } else {
        contextEntries.push(entry)
        totalContextCount += 1
      }
    }
    if (matchEntries.length === 0 || !firstMatchLine) continue
    states.push({
      file: fm.file,
      headerCost: {
        chars: 1 + fm.file.length,
        bytes: 1 + utf8ByteLength(fm.file),
      },
      matchEntries,
      contextEntries,
      firstMatchLine,
      shownMatches: 0,
      selectedContexts: [],
      selectedLineNums: new Set<number>(),
    })
  }

  if (states.length === 0) return null

  const totalFiles = states.length
  const effectiveTotalMatches = states.reduce((acc, s) => acc + s.matchEntries.length, 0)
  const actualTotalMatches = Math.max(totalMatches, effectiveTotalMatches)

  let usedChars = headerCost.chars
  let usedBytes = headerCost.bytes
  let shownMatches = 0
  let shownContexts = 0
  let shownFiles = 0

  let allFilesFirstChars = headerCost.chars
  let allFilesFirstBytes = headerCost.bytes
  for (const st of states) {
    const first = st.matchEntries[0]!
    const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1))
    allFilesFirstChars += st.headerCost.chars + first.cost.chars + markerCost.chars
    allFilesFirstBytes += st.headerCost.bytes + first.cost.bytes + markerCost.bytes
  }
  const allShownInitialNotice = measureCost(
    buildTruncatedNotice(
      totalFiles,
      actualTotalMatches,
      totalFiles,
      totalFiles,
      maxResultsTruncated,
      totalFiles === actualTotalMatches,
    ),
  )

  if (
    allFilesFirstChars + allShownInitialNotice.chars <= charBudget &&
    allFilesFirstBytes + allShownInitialNotice.bytes <= byteBudget
  ) {
    for (const st of states) {
      const first = st.matchEntries[0]!
      const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1))
      st.shownMatches = 1
      st.selectedLineNums.add(first.lineNumber)
      usedChars += st.headerCost.chars + first.cost.chars + markerCost.chars
      usedBytes += st.headerCost.bytes + first.cost.bytes + markerCost.bytes
      shownMatches += 1
      shownFiles += 1
    }
  } else {
    const worstTruncNotice = measureCost(
      buildTruncatedNotice(
        actualTotalMatches,
        actualTotalMatches,
        totalFiles,
        totalFiles,
        maxResultsTruncated,
        false,
      ),
    )
    const minOmittedNotice =
      totalFiles > 1
        ? measureCost(
            `\n... [+${totalFiles} more files; use outputMode: "files_with_matches"]`,
          )
        : { chars: 0, bytes: 0 }
    const bodyChars = Math.max(0, charBudget - headerCost.chars - worstTruncNotice.chars)
    const bodyBytes = Math.max(0, byteBudget - headerCost.bytes - worstTruncNotice.bytes)
    const targetOmittedChars =
      totalFiles > 1
        ? Math.max(minOmittedNotice.chars, Math.min(220, Math.floor(bodyChars * 0.25)))
        : 0
    const targetOmittedBytes =
      totalFiles > 1
        ? Math.max(minOmittedNotice.bytes, Math.min(220, Math.floor(bodyBytes * 0.25)))
        : 0

    const tryAddFirstMatch = (
      st: BudgetedFileState,
      reserveChars: number,
      reserveBytes: number,
    ): boolean => {
      const first = st.matchEntries[0]!
      const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1))
      const addChars = st.headerCost.chars + first.cost.chars + markerCost.chars
      const addBytes = st.headerCost.bytes + first.cost.bytes + markerCost.bytes
      if (
        usedChars + addChars + worstTruncNotice.chars + reserveChars <= charBudget &&
        usedBytes + addBytes + worstTruncNotice.bytes + reserveBytes <= byteBudget
      ) {
        st.shownMatches = 1
        st.selectedLineNums.add(first.lineNumber)
        usedChars += addChars
        usedBytes += addBytes
        shownMatches += 1
        shownFiles += 1
        return true
      }
      return false
    }

    for (const st of states) {
      if (tryAddFirstMatch(st, targetOmittedChars, targetOmittedBytes)) {
        continue
      }
      if (shownFiles === 0) {
        if (tryAddFirstMatch(st, minOmittedNotice.chars, minOmittedNotice.bytes)) {
          break
        }
        const markerCost = measureCost(fileOmissionMarker(st.matchEntries.length - 1))
        const availLineChars =
          charBudget -
          usedChars -
          st.headerCost.chars -
          markerCost.chars -
          worstTruncNotice.chars -
          minOmittedNotice.chars -
          1
        const availLineBytes =
          byteBudget -
          usedBytes -
          st.headerCost.bytes -
          markerCost.bytes -
          worstTruncNotice.bytes -
          minOmittedNotice.bytes -
          1
        const shrunk = fitShrunkMatchLine(st.firstMatchLine, availLineChars, availLineBytes)
        if (shrunk) {
          const shrunkCost: TextCost = {
            chars: 1 + shrunk.length,
            bytes: 1 + utf8ByteLength(shrunk),
          }
          st.matchEntries[0] = {
            ...st.matchEntries[0]!,
            formatted: shrunk,
            cost: shrunkCost,
          }
          st.shownMatches = 1
          st.selectedLineNums.add(st.matchEntries[0]!.lineNumber)
          usedChars += st.headerCost.chars + shrunkCost.chars + markerCost.chars
          usedBytes += st.headerCost.bytes + shrunkCost.bytes + markerCost.bytes
          shownMatches += 1
          shownFiles += 1
        }
      }
      break
    }

    if (shownFiles === 0) {
      return null
    }
  }

  if (shownFiles === totalFiles) {
    const matchExhausted = new Array<boolean>(totalFiles).fill(false)
    let progressed = true
    while (progressed) {
      progressed = false
      for (let f = 0; f < totalFiles; f++) {
        if (matchExhausted[f]) continue
        const st = states[f]!
        if (st.shownMatches >= st.matchEntries.length) {
          matchExhausted[f] = true
          continue
        }
        const entry = st.matchEntries[st.shownMatches]!
        const prevMarkerCost = measureCost(
          fileOmissionMarker(st.matchEntries.length - st.shownMatches),
        )
        const nextMarkerCost = measureCost(
          fileOmissionMarker(st.matchEntries.length - (st.shownMatches + 1)),
        )
        const deltaChars = entry.cost.chars + nextMarkerCost.chars - prevMarkerCost.chars
        const deltaBytes = entry.cost.bytes + nextMarkerCost.bytes - prevMarkerCost.bytes
        const nextShownMatches = shownMatches + 1
        const nextNoticeCost = measureCost(
          buildTruncatedNotice(
            nextShownMatches,
            actualTotalMatches,
            shownFiles,
            totalFiles,
            maxResultsTruncated,
            nextShownMatches === actualTotalMatches,
          ),
        )
        if (
          usedChars + deltaChars + nextNoticeCost.chars <= charBudget &&
          usedBytes + deltaBytes + nextNoticeCost.bytes <= byteBudget
        ) {
          st.shownMatches += 1
          st.selectedLineNums.add(entry.lineNumber)
          usedChars += deltaChars
          usedBytes += deltaBytes
          shownMatches = nextShownMatches
          progressed = true
        } else {
          matchExhausted[f] = true
        }
      }
    }

    if (contextLines > 0 && totalContextCount > 0) {
      const eligibleByFile: BudgetedLineEntry[][] = states.map((st) => {
        if (st.contextEntries.length === 0) return []
        const renderedMatches = st.matchEntries
          .slice(0, st.shownMatches)
          .map((m) => m.lineNumber)
        const unrenderedSet = new Set(
          st.matchEntries.slice(st.shownMatches).map((m) => m.lineNumber),
        )
        const eligible: Array<{ entry: BudgetedLineEntry; dist: number }> = []
        for (const ctx of st.contextEntries) {
          let bestDist = Number.POSITIVE_INFINITY
          for (const mLn of renderedMatches) {
            const dist = Math.abs(ctx.lineNumber - mLn)
            if (dist > contextLines || dist >= bestDist) continue
            const lo = Math.min(ctx.lineNumber, mLn)
            const hi = Math.max(ctx.lineNumber, mLn)
            let blocked = false
            for (let ln = lo + 1; ln < hi; ln++) {
              if (unrenderedSet.has(ln)) {
                blocked = true
                break
              }
            }
            if (!blocked) {
              bestDist = dist
            }
          }
          if (bestDist <= contextLines) {
            eligible.push({ entry: ctx, dist: bestDist })
          }
        }
        eligible.sort((a, b) => a.dist - b.dist || a.entry.lineNumber - b.entry.lineNumber)
        return eligible.map((e) => e.entry)
      })

      const noticeCost = measureCost(
        buildTruncatedNotice(
          shownMatches,
          actualTotalMatches,
          shownFiles,
          totalFiles,
          maxResultsTruncated,
          shownMatches === actualTotalMatches,
        ),
      )
      const pickedCtxIdx = states.map(() => new Set<number>())
      let ctxProgressed = true
      while (ctxProgressed) {
        ctxProgressed = false
        for (let f = 0; f < totalFiles; f++) {
          const candidates = eligibleByFile[f]!
          if (candidates.length === 0) continue
          const st = states[f]!
          const picked = pickedCtxIdx[f]!
          for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
            if (picked.has(cIdx)) continue
            const ctx = candidates[cIdx]!
            if (
              !st.selectedLineNums.has(ctx.lineNumber - 1) &&
              !st.selectedLineNums.has(ctx.lineNumber + 1)
            ) {
              continue
            }
            if (
              usedChars + ctx.cost.chars + noticeCost.chars <= charBudget &&
              usedBytes + ctx.cost.bytes + noticeCost.bytes <= byteBudget
            ) {
              picked.add(cIdx)
              st.selectedContexts.push(ctx)
              st.selectedLineNums.add(ctx.lineNumber)
              usedChars += ctx.cost.chars
              usedBytes += ctx.cost.bytes
              shownContexts += 1
              ctxProgressed = true
              break
            }
          }
        }
      }
    }
  }

  const parts: string[] = [header]
  for (let f = 0; f < shownFiles; f++) {
    const st = states[f]!
    parts.push(`\n${st.file}`)
    const chosenLines = [
      ...st.matchEntries.slice(0, st.shownMatches),
      ...st.selectedContexts,
    ].sort((a, b) => a.lineNumber - b.lineNumber)
    for (const line of chosenLines) {
      parts.push(`\n${line.formatted}`)
    }
    const omittedInFile = st.matchEntries.length - st.shownMatches
    if (omittedInFile > 0) {
      parts.push(fileOmissionMarker(omittedInFile))
    }
  }

  const omittedContextOnly =
    shownFiles === totalFiles &&
    shownMatches === actualTotalMatches &&
    shownContexts < totalContextCount
  const truncLine =
    shownFiles < totalFiles ||
    shownMatches < actualTotalMatches ||
    shownContexts < totalContextCount
      ? buildTruncatedNotice(
          shownMatches,
          actualTotalMatches,
          shownFiles,
          totalFiles,
          maxResultsTruncated,
          omittedContextOnly,
        )
      : maxResultsTruncated
        ? `\n... [truncated at ${totalMatches} matches]`
        : ''

  let omittedFilesLine = ''
  if (shownFiles < totalFiles) {
    const bodySoFar = parts.join('')
    const truncCost = measureCost(truncLine)
    const remChars = charBudget - bodySoFar.length - truncCost.chars
    const remBytes = byteBudget - utf8ByteLength(bodySoFar) - truncCost.bytes
    const unshown = states.slice(shownFiles)

    const allItems = unshown.map((st) => `${st.file} (${st.matchEntries.length})`)
    const allLine = `\n... [more files: ${allItems.join(', ')}]`
    if (allLine.length <= remChars && utf8ByteLength(allLine) <= remBytes) {
      omittedFilesLine = allLine
    } else {
      const named: string[] = []
      let bestLine = ''
      for (let i = 0; i < unshown.length; i++) {
        const item = allItems[i]!
        const leftAfter = unshown.length - (i + 1)
        const list = named.length === 0 ? item : `${named.join(', ')}, ${item}`
        const suffix =
          leftAfter > 0
            ? `, +${leftAfter} more ${leftAfter === 1 ? 'file' : 'files'}; use outputMode: "files_with_matches"]`
            : ']'
        const candidate = `\n... [more files: ${list}${suffix}`
        if (candidate.length <= remChars && utf8ByteLength(candidate) <= remBytes) {
          named.push(item)
          bestLine = candidate
        } else {
          break
        }
      }
      if (bestLine) {
        omittedFilesLine = bestLine
      } else {
        const fallback = `\n... [+${unshown.length} more ${unshown.length === 1 ? 'file' : 'files'}; use outputMode: "files_with_matches"]`
        const shortFallback = `\n... [+${unshown.length} more ${unshown.length === 1 ? 'file' : 'files'}]`
        if (fallback.length <= remChars && utf8ByteLength(fallback) <= remBytes) {
          omittedFilesLine = fallback
        } else if (
          shortFallback.length <= remChars &&
          utf8ByteLength(shortFallback) <= remBytes
        ) {
          omittedFilesLine = shortFallback
        }
      }
    }
  }

  const result = `${parts.join('')}${omittedFilesLine}${truncLine}`
  if (result.length <= charBudget && utf8ByteLength(result) <= byteBudget) {
    return result
  }
  return null
}

async function executeSingleQuery(
  query: SearchQuery,
  index: number,
  baseCwd: string,
  useRg: boolean,
  policy: PolicyGuard,
  budget: QueryBudgetContext,
): Promise<ExecutedQuerySection> {
  const safeType = typeof query.type === 'string' ? query.type : String(query.type)
  const safePattern = typeof query.pattern === 'string' ? query.pattern : ''
  const header = `## Query ${index + 1} [${safeType}] ${safePattern}${typeof query.path === 'string' && query.path ? ` (in ${query.path})` : ''}`

  try {
    if (safeType === 'git') {
      throw new Error(
        "Unsupported query type 'git': batch_search only supports 'text', 'regex', 'glob', and 'fuzzy'.",
      )
    }
    if (
      safeType !== 'text' &&
      safeType !== 'regex' &&
      safeType !== 'glob' &&
      safeType !== 'fuzzy'
    ) {
      throw new Error(
        `Unsupported query type '${safeType}': expected 'text', 'regex', 'glob', or 'fuzzy'.`,
      )
    }
    if (!query.pattern || typeof query.pattern !== 'string') {
      throw new Error("Query 'pattern' must be a non-empty string.")
    }
    if (query.multiline !== undefined && typeof query.multiline !== 'boolean') {
      throw new Error("'multiline' must be a boolean.")
    }
    if (query.caseSensitive !== undefined && typeof query.caseSensitive !== 'boolean') {
      throw new Error("'caseSensitive' must be a boolean.")
    }
    if (query.glob !== undefined && typeof query.glob !== 'string') {
      throw new Error("'glob' must be a string.")
    }
    if (
      query.outputMode !== undefined &&
      query.outputMode !== 'content' &&
      query.outputMode !== 'files_with_matches' &&
      query.outputMode !== 'count'
    ) {
      throw new Error(
        "Invalid outputMode: expected 'content', 'files_with_matches', or 'count'.",
      )
    }
    if (query.sortBy !== undefined && query.sortBy !== 'path' && query.sortBy !== 'mtime') {
      throw new Error("Invalid sortBy: expected 'path' or 'mtime'.")
    }

    let searchRoot = baseCwd
    if (query.path !== undefined && query.path !== '') {
      const decision = await policy.authorizeRead(query.path, baseCwd, 'batch_search')
      if (!decision.ok) {
        const safeHeader = redactSecrets(header)
        return {
          header: safeHeader,
          text: `${safeHeader}\nERROR: ${redactSecrets(decision.error)}`,
          errored: true,
          blocked: true,
        }
      }
      searchRoot = decision.value.canonicalPath
    }

    let targetStat
    try {
      targetStat = await fs.stat(searchRoot)
    } catch {
      throw new Error(`Path does not exist: ${query.path || '.'}`)
    }

    if (query.type === 'glob') {
      const out = await runGlobQuery(
        query,
        searchRoot,
        baseCwd,
        targetStat.isFile(),
        policy,
        budget,
      )
      return { header, text: `${header}\n${out}`, errored: false }
    }

    if (query.type === 'fuzzy') {
      const out = await runFuzzyQuery(
        query,
        searchRoot,
        baseCwd,
        targetStat.isFile(),
        policy,
        budget,
      )
      return { header, text: `${header}\n${out}`, errored: false }
    }

    let res: TextSearchOutput
    if (useRg) {
      try {
        res = await runTextOrRegexWithRg(query, searchRoot, baseCwd, policy, budget)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('rg spawn error:')) {
          res = await runTextOrRegexWithNode(query, searchRoot, baseCwd, policy, budget)
        } else {
          throw err
        }
      }
    } else {
      res = await runTextOrRegexWithNode(query, searchRoot, baseCwd, policy, budget)
    }

    const budgetNote = res.budgetExceeded
      ? "; scan budget reached — narrow 'path' or 'glob'"
      : ''
    if (query.outputMode === 'count' || query.outputMode === 'files_with_matches') {
      const body =
        res.files
          .map(({ file, count }) =>
            query.outputMode === 'count'
              ? `${file}: ${count} ${query.multiline ? 'matches' : 'matching lines'}`
              : file,
          )
          .join('\n') ||
        (res.budgetExceeded
          ? "(no matches before scan budget reached — narrow 'path' or 'glob')"
          : '(no matches)')
      const footer =
        res.truncated && res.files.length > 0
          ? `\n... [truncated; showing ${res.files.length} files${budgetNote}]`
          : ''
      return {
        header,
        text: `${header}\n${body}${footer}`,
        errored: false,
        engine: res.engine,
      }
    }

    const formattedBody =
      res.files.length === 0 && res.budgetExceeded
        ? "(no matches before scan budget reached — narrow 'path' or 'glob')"
        : formatFileMatches(res.files, res.totalMatches, res.truncated) +
          (res.budgetExceeded && res.files.length > 0
            ? "\n... [scan budget reached — narrow 'path' or 'glob']"
            : '')
    const text = `${header}\n${formattedBody}`
    return {
      header,
      text,
      errored: false,
      engine: res.engine,
      ...(res.files.length > 0
        ? {
            contentResult: {
              files: res.files,
              totalMatches: res.totalMatches,
              truncated: res.truncated,
              contextLines: clampInt(query.contextLines, 0, MAX_CONTEXT_LINES, 0),
            },
          }
        : {}),
    }
  } catch (err) {
    const safeHeader = redactSecrets(header)
    const msg = redactSecrets(err instanceof Error ? err.message : String(err))
    return { header: safeHeader, text: `${safeHeader}\nERROR: ${msg}`, errored: true }
  }
}

/**
 * Executes up to 20 parallel code/file search queries (`text`, `regex`, `glob`,
 * `fuzzy`) under strict workspace confinement and secret-file filtering, using
 * `ripgrep` with automatic pure-Node fallback and water-filled inline output
 * budgeting (`<= 8,800` UTF-8 bytes).
 */
export async function runBatchSearch(
  input: BatchSearchInput | Record<string, unknown>,
  options: BatchSearchOptions,
): Promise<BatchSearchResult> {
  const { policy, audit } = options
  const rawInput = (input ?? {}) as Partial<BatchSearchInput>

  const parsedQueries = parseMaybeJsonArray(rawInput.queries)
  if (!parsedQueries.ok) {
    audit?.record({
      tool: 'batch_search',
      status: 'error',
      reason: 'invalid_queries',
      summary: parsedQueries.error,
    })
    return { text: parsedQueries.error, isError: true }
  }

  const rawQueries = parsedQueries.value
  if (rawQueries.length === 0) {
    const msg = "Error: 'queries' must be a non-empty array of search queries."
    audit?.record({
      tool: 'batch_search',
      status: 'error',
      reason: 'empty_queries',
      summary: msg,
    })
    return { text: msg, isError: true }
  }
  if (rawQueries.length > MAX_QUERIES) {
    const msg = `Error: 'queries' supports at most ${MAX_QUERIES} queries per call.`
    audit?.record({
      tool: 'batch_search',
      status: 'error',
      reason: 'too_many_queries',
      summary: `queries=${rawQueries.length} exceeds cap ${MAX_QUERIES}`,
    })
    return { text: msg, isError: true }
  }

  for (let i = 0; i < rawQueries.length; i++) {
    if (!isPlainObject(rawQueries[i])) {
      const msg = `Error: queries[${i}] must be a query object ({ type, pattern, ... }).`
      audit?.record({
        tool: 'batch_search',
        status: 'error',
        reason: 'invalid_query_item',
        summary: msg,
      })
      return { text: msg, isError: true }
    }
  }
  const queries = rawQueries as unknown as SearchQuery[]

  const cwdDecision = await policy.resolveCwd(
    rawInput.cwd as string | undefined,
    'batch_search',
  )
  if (!cwdDecision.ok) {
    const redactedError = redactSecrets(cwdDecision.error)
    audit?.record({
      tool: 'batch_search',
      status: 'blocked',
      reason: cwdDecision.reason,
      summary: redactedError,
    })
    return { text: redactedError, isError: true }
  }
  const baseCwd = cwdDecision.value.cwd

  const maxChars = clampInt(
    rawInput.maxChars,
    500,
    DEFAULT_INLINE_MAX_BYTES,
    DEFAULT_MAX_CHARS,
  )
  const maxBytes = DEFAULT_INLINE_MAX_BYTES
  const needsTextSearch = queries.some((q) => q.type === 'text' || q.type === 'regex')
  const useRg =
    needsTextSearch && !options.forceNodeFallback && (await isRipgrepAvailable())

  const callTimeoutMs =
    options.callTimeoutMs !== undefined &&
    Number.isFinite(options.callTimeoutMs) &&
    options.callTimeoutMs > 0
      ? Math.max(1, Math.trunc(options.callTimeoutMs))
      : DEFAULT_CALL_TIMEOUT_MS
  const walkTimeoutMs =
    options.walkTimeoutMs !== undefined &&
    Number.isFinite(options.walkTimeoutMs) &&
    options.walkTimeoutMs > 0
      ? Math.max(1, Math.trunc(options.walkTimeoutMs))
      : DEFAULT_WALK_TIMEOUT_MS
  const walkMaxDirs =
    options.walkMaxDirs !== undefined &&
    Number.isFinite(options.walkMaxDirs) &&
    options.walkMaxDirs > 0
      ? Math.max(1, Math.trunc(options.walkMaxDirs))
      : DEFAULT_WALK_MAX_DIRS

  const budget: QueryBudgetContext = {
    callDeadline: Date.now() + callTimeoutMs,
    walkTimeoutMs,
    walkMaxDirs,
  }

  const executed = await Promise.all(
    queries.map((q, idx) => executeSingleQuery(q, idx, baseCwd, useRg, policy, budget)),
  )

  const separator = '\n\n'
  const rawSections = executed.map((e) => e.text)
  const joined = rawSections.join(separator)
  const sepChars = separator.length * Math.max(0, rawSections.length - 1)
  const sepBytes = utf8ByteLength(separator) * Math.max(0, rawSections.length - 1)

  const overChars = joined.length > maxChars
  const overBytes = utf8ByteLength(joined) > maxBytes

  let finalSections = rawSections
  let budgetTruncated = false
  if (overChars || overBytes) {
    budgetTruncated = true
    const rawCharLens = rawSections.map((s) => s.length)
    const rawByteLens = rawSections.map((s) => utf8ByteLength(s))
    const byteBudgets = overBytes
      ? computeWaterFillBudgets(rawByteLens, Math.max(0, maxBytes - sepBytes))
      : rawByteLens.map(() => maxBytes)
    const charBudgets = overChars
      ? computeWaterFillBudgets(rawCharLens, Math.max(0, maxChars - sepChars))
      : computeWaterFillBudgets(
          rawCharLens.map((len, idx) =>
            rawByteLens[idx]! > byteBudgets[idx]! ? maxChars : len,
          ),
          Math.max(0, maxChars - sepChars),
        )

    finalSections = executed.map((ex, idx) => {
      const charBudget = charBudgets[idx] ?? 0
      const byteBudget = byteBudgets[idx] ?? 0
      if (
        !ex.contentResult ||
        (rawCharLens[idx]! <= charBudget && rawByteLens[idx]! <= byteBudget)
      ) {
        return ex.text
      }
      const budgeted = formatBudgetedContentSection({
        header: ex.header,
        files: ex.contentResult.files,
        totalMatches: ex.contentResult.totalMatches,
        maxResultsTruncated: ex.contentResult.truncated,
        contextLines: ex.contentResult.contextLines,
        charBudget,
        byteBudget,
      })
      return budgeted ?? ex.text
    })
  }

  const fitted = fitSectionsToByteBudget(finalSections, {
    maxChars,
    maxBytes,
    separator,
  })

  const engines = new Set<'ripgrep' | 'node'>()
  let errorCount = 0
  let blockedCount = 0
  for (const ex of executed) {
    if (ex.engine) engines.add(ex.engine)
    if (ex.errored) errorCount++
    if (ex.blocked) blockedCount++
  }
  const engine: 'ripgrep' | 'node' | 'mixed' | 'none' =
    engines.size === 0
      ? 'none'
      : engines.size === 1
        ? [...engines][0]!
        : 'mixed'

  const truncated = budgetTruncated || fitted.truncated
  const rootsRes = await policy.getRoots()
  const sanitizedCwd = policy.sanitizePathForAudit(
    baseCwd,
    rootsRes.ok ? rootsRes.value : undefined,
  )

  const allErrored = errorCount === queries.length
  audit?.record({
    tool: 'batch_search',
    status: blockedCount === queries.length ? 'blocked' : allErrored ? 'error' : 'ok',
    sanitizedPath: sanitizedCwd,
    summary: `queries=${queries.length} engine=${engine} errors=${errorCount} blocked=${blockedCount} truncated=${truncated}`,
  })

  return {
    text: fitted.text,
    isError: allErrored,
    structuredContent: {
      engine,
      queryCount: queries.length,
      errorCount,
      truncated,
    },
  }
}
