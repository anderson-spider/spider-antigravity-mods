// Filesystem helpers for directory resolution, cwd autocomplete, and @file workspace search.
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'coverage',
  '.turbo',
])

export type DirectorySuggestion = {
  path: string
  name: string
}

export type WorkspaceFileMatch = {
  path: string
  absPath: string
  size: number
}

export function expandHome(rawPath: string, home = homedir()): string {
  if (rawPath === '~') return home
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return join(home, rawPath.slice(2))
  }
  return rawPath
}

export async function resolveDirectory(
  rawCwd: unknown,
  fallbackCwd: string,
  home = homedir(),
): Promise<{ cwd: string; error?: undefined } | { cwd?: undefined; error: string }> {
  const input = typeof rawCwd === 'string' && rawCwd.trim() ? expandHome(rawCwd.trim(), home) : fallbackCwd
  const candidate = isAbsolute(input) ? resolve(input) : resolve(fallbackCwd, input)
  try {
    const st = await stat(candidate)
    if (!st.isDirectory()) {
      return { error: `Path is not a directory: ${candidate}` }
    }
    return { cwd: candidate }
  } catch {
    return { error: `Directory does not exist: ${candidate}` }
  }
}

export async function listDirectories(
  rawQuery: string,
  opts: { baseCwd?: string; home?: string; limit?: number } = {},
): Promise<DirectorySuggestion[]> {
  const home = opts.home ?? homedir()
  const baseCwd = opts.baseCwd ?? home
  const limit = opts.limit ?? 25
  const trimmed = rawQuery.trim()
  const expanded = trimmed ? expandHome(trimmed, home) : baseCwd

  let parentDir: string
  let prefix: string
  if (!trimmed) {
    parentDir = baseCwd
    prefix = ''
  } else if (expanded.endsWith('/') || expanded.endsWith('\\')) {
    parentDir = resolve(expanded)
    prefix = ''
  } else {
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(baseCwd, expanded)
    try {
      const st = await stat(abs)
      if (st.isDirectory()) {
        // Return the exact directory itself plus its subdirectories.
        parentDir = abs
        prefix = ''
      } else {
        parentDir = dirname(abs)
        prefix = basename(abs).toLowerCase()
      }
    } catch {
      parentDir = dirname(abs)
      prefix = basename(abs).toLowerCase()
    }
  }

  try {
    const entries = await readdir(parentDir, { withFileTypes: true })
    const includeHidden = prefix.startsWith('.')
    const dirs = entries
      .filter(entry => entry.isDirectory())
      .filter(entry => includeHidden || !entry.name.startsWith('.'))
      .filter(entry => !prefix || entry.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map(entry => ({
        name: entry.name,
        path: join(parentDir, entry.name),
      }))
    return dirs
  } catch {
    return []
  }
}

export async function searchWorkspaceFiles(
  cwd: string,
  query: string,
  opts: { maxVisited?: number; limit?: number } = {},
): Promise<WorkspaceFileMatch[]> {
  const maxVisited = opts.maxVisited ?? 1_000
  const limit = opts.limit ?? 30
  const needle = query.trim().toLowerCase()

  const queue: string[] = [cwd]
  const matches: { match: WorkspaceFileMatch; score: number }[] = []
  let visited = 0

  while (queue.length > 0 && visited < maxVisited) {
    const current = queue.shift()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (visited >= maxVisited) break
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        queue.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      visited++
      const relPath = relative(cwd, fullPath)
      const lowerRel = relPath.toLowerCase()
      const lowerName = entry.name.toLowerCase()

      let score = 0
      if (!needle) {
        score = 1
      } else if (lowerName === needle) {
        score = 100
      } else if (lowerName.startsWith(needle)) {
        score = 80
      } else if (lowerName.includes(needle)) {
        score = 60
      } else if (lowerRel.includes(needle)) {
        score = 40
      } else {
        continue
      }

      let size = 0
      try {
        size = (await stat(fullPath)).size
      } catch {}
      matches.push({
        match: { path: relPath, absPath: fullPath, size },
        score,
      })
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.match.path.length - b.match.path.length || a.match.path.localeCompare(b.match.path))
    .slice(0, limit)
    .map(entry => entry.match)
}
