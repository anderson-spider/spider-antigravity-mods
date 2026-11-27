// Safe filesystem helpers integrated with PolicyGuard: text reader (binary/UTF-16/size caps)
// and bounded directory walker that never follows symlinks and skips denied paths.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PolicyGuard } from './policy.ts'

export const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
  '.idea',
  'vendor',
])

export const DEFAULT_MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024

export interface TextFileContent {
  content: string
  /** UTF-8 BOM-stripped text retaining original line endings. */
  rawContent: string
  eol: '\r\n' | '\n'
  mixedEol: boolean
  hasBom: boolean
  size: number
  mtimeMs: number
  mode: number
  rawBuffer: Buffer
}

export interface ReadTextFileOptions {
  maxBytes?: number
  policy?: PolicyGuard
  baseCwd?: string
  toolName?: string
}

export interface WalkOptions {
  maxFiles?: number
  maxDepth?: number
  includeHidden?: boolean
  ignoreDirs?: ReadonlySet<string>
  fileFilter?: (relPosixPath: string) => boolean
  timeoutMs?: number
  maxDirs?: number
  policy?: PolicyGuard
}

export interface WalkResult {
  files: string[]
  truncated: boolean
  timedOut?: boolean
  dirsTruncated?: boolean
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

export function isLikelyBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

export function detectUtf16Bom(buf: Buffer): 'UTF-16 LE' | 'UTF-16 BE' | null {
  if (buf.length < 2) return null
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    // Distinguish UTF-32 LE BOM (FF FE 00 00) from UTF-16 LE.
    if (buf.length >= 4 && buf[2] === 0x00 && buf[3] === 0x00) {
      return null
    }
    return 'UTF-16 LE'
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return 'UTF-16 BE'
  }
  return null
}

export async function readTextFile(
  filePath: string,
  options: ReadTextFileOptions | number = {},
): Promise<TextFileContent> {
  const opts: ReadTextFileOptions =
    typeof options === 'number' ? { maxBytes: options } : options
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_TEXT_FILE_BYTES

  let targetPath = filePath
  if (opts.policy) {
    const decision = await opts.policy.authorizeRead(filePath, opts.baseCwd, opts.toolName)
    if (!decision.ok) {
      throw new Error(decision.error)
    }
    targetPath = decision.value.canonicalPath
  }

  const stat = await fs.stat(targetPath)
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`)
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `File exceeds maximum size (${stat.size} bytes > ${maxBytes} bytes): ${filePath}`,
    )
  }

  const buf = await fs.readFile(targetPath)
  const utf16Bom = detectUtf16Bom(buf)
  if (utf16Bom) {
    throw new Error(
      `UTF-16 encoded file is not supported (convert to UTF-8 first): ${filePath} [${utf16Bom}]`,
    )
  }
  if (isLikelyBinary(buf)) {
    throw new Error(`Binary file cannot be read as text: ${filePath}`)
  }

  const hasBom = hasUtf8Bom(buf)
  const rawContent = (hasBom ? buf.subarray(3) : buf).toString('utf8')
  let crlfCount = 0
  let lfOnlyCount = 0
  for (let i = 0; i < rawContent.length; i++) {
    if (rawContent[i] === '\n') {
      if (i > 0 && rawContent[i - 1] === '\r') crlfCount++
      else lfOnlyCount++
    }
  }
  const eol: '\r\n' | '\n' = crlfCount > lfOnlyCount ? '\r\n' : '\n'
  const mixedEol = crlfCount > 0 && lfOnlyCount > 0

  return {
    content: rawContent,
    rawContent,
    eol,
    mixedEol,
    hasBom,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o7777,
    rawBuffer: buf,
  }
}

export async function walkFiles(
  rootDir: string,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const maxFiles = Math.max(0, Math.trunc(options.maxFiles ?? 5000))
  const maxDepth = options.maxDepth ?? 32
  const includeHidden = options.includeHidden ?? false
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS
  const fileFilter = options.fileFilter
  const policy = options.policy
  const timeoutMs =
    options.timeoutMs !== undefined &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.max(1, Math.trunc(options.timeoutMs))
      : null
  const deadline = timeoutMs !== null ? Date.now() + timeoutMs : null
  const maxDirs =
    options.maxDirs !== undefined &&
    Number.isFinite(options.maxDirs) &&
    options.maxDirs > 0
      ? Math.max(1, Math.trunc(options.maxDirs))
      : null

  let effectiveRoot = rootDir
  if (policy) {
    const decision = await policy.resolveCwd(rootDir)
    if (!decision.ok) {
      throw new Error(decision.error)
    }
    effectiveRoot = decision.value.cwd
  }

  const files: string[] = []
  let truncated = false
  let timedOut = false
  let dirsTruncated = false
  let visitedDirs = 0

  const MAX_CONCURRENT_READDIRS = 16
  let activeReaddirs = 0
  const waitQueue: Array<() => void> = []

  const drainWaiters = (): void => {
    while (waitQueue.length > 0) {
      waitQueue.shift()!()
    }
  }

  const markTruncated = (): void => {
    if (truncated) return
    truncated = true
    drainWaiters()
  }

  const withinBudget = (): boolean => {
    if (truncated) return false
    if (deadline !== null && Date.now() >= deadline) {
      timedOut = true
      markTruncated()
      return false
    }
    return true
  }

  const timeoutTimer =
    timeoutMs !== null
      ? setTimeout(() => {
          timedOut = true
          markTruncated()
        }, timeoutMs)
      : null
  timeoutTimer?.unref()

  const readDirBounded = async (dir: string) => {
    if (!withinBudget()) return null
    while (activeReaddirs >= MAX_CONCURRENT_READDIRS) {
      await new Promise<void>((resolve) => waitQueue.push(resolve))
      if (!withinBudget()) return null
    }
    if (!withinBudget()) return null
    if (maxDirs !== null && visitedDirs >= maxDirs) {
      dirsTruncated = true
      markTruncated()
      return null
    }
    visitedDirs++
    activeReaddirs++
    try {
      return await fs.readdir(dir, { withFileTypes: true })
    } finally {
      activeReaddirs--
      if (truncated) {
        drainWaiters()
      } else {
        const next = waitQueue.shift()
        if (next) next()
      }
    }
  }

  interface DirScanResult {
    localFiles: string[]
    subdirs: Array<{ abs: string; rel: string }>
  }

  const scanDir = async (dir: string, relDir: string): Promise<DirScanResult> => {
    if (!withinBudget()) return { localFiles: [], subdirs: [] }
    let entries
    try {
      entries = await readDirBounded(dir)
    } catch {
      return { localFiles: [], subdirs: [] }
    }
    if (!entries || !withinBudget()) return { localFiles: [], subdirs: [] }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const localFiles: string[] = []
    const subdirs: Array<{ abs: string; rel: string }> = []
    for (const entry of entries) {
      // Never follow symlinks during directory walks.
      if (entry.isSymbolicLink()) continue

      const name = entry.name
      if (!includeHidden && name.startsWith('.')) {
        continue
      }
      const relPosix = relDir ? `${relDir}/${name}` : name
      if (policy && policy.isSecretPath(relPosix)) {
        continue
      }
      if (entry.isDirectory()) {
        if (ignoreDirs.has(name)) continue
        subdirs.push({ abs: path.join(dir, name), rel: relPosix })
      } else if (entry.isFile()) {
        if (fileFilter && !fileFilter(relPosix)) continue
        localFiles.push(relPosix)
      }
    }
    return { localFiles, subdirs }
  }

  async function visit(
    dir: string,
    relDir: string,
    depth: number,
    prefetched?: Promise<DirScanResult>,
  ): Promise<void> {
    if (!withinBudget() || depth > maxDepth) return
    const { localFiles, subdirs } = await (prefetched ?? scanDir(dir, relDir))
    if (!withinBudget()) return

    for (const relPosix of localFiles) {
      if (files.length >= maxFiles) {
        markTruncated()
        return
      }
      files.push(relPosix)
    }

    if (depth >= maxDepth || subdirs.length === 0) return

    const batchSize = 8
    for (let i = 0; i < subdirs.length && withinBudget(); i += batchSize) {
      const slice = subdirs.slice(i, i + batchSize)
      const prefetches = slice.map((sub) => scanDir(sub.abs, sub.rel))
      try {
        for (let j = 0; j < slice.length && withinBudget(); j++) {
          await visit(slice[j]!.abs, slice[j]!.rel, depth + 1, prefetches[j])
        }
      } finally {
        if (truncated) {
          await Promise.allSettled(prefetches)
        }
      }
    }
  }

  try {
    await visit(effectiveRoot, '', 0)
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }

  return {
    files,
    truncated,
    ...(timedOut ? { timedOut: true } : {}),
    ...(dirsTruncated ? { dirsTruncated: true } : {}),
  }
}
