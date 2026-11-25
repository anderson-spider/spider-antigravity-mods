// Persistent local UI state for the GitLab MR Dashboard (preferences, saved filter views, and files-viewed marks).
// Stored in ${PLUGIN_DATA}/dashboard-state.json when a dataDir is configured; falls back to in-memory when omitted.
// Never stores credentials or MR contents.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type MrStateFilter = 'opened' | 'merged' | 'closed' | 'all'
export type InvolvementFilter = 'all' | 'waiting' | 'reviewing' | 'authored' | 'others'
export type SortOrder = 'ready' | 'updated' | 'newest' | 'oldest' | 'largest'
export type DiffMode = 'unified' | 'split'

export type RegisteredRepo = {
  path: string
  host: string
  project: string
}

export type DashboardPreferences = {
  state: MrStateFilter
  involvement: InvolvementFilter
  sort: SortOrder
  hostOrProject: string
  diffMode: DiffMode
  autoRefresh: boolean
  showFileIndex: boolean
  listWidthPct: number
}

export type SavedViewFilters = {
  q: string
  state: MrStateFilter
  involvement: InvolvementFilter
  sort: SortOrder
  hostOrProject: string
}

export type SavedView = {
  id: string
  name: string
  filters: SavedViewFilters
}

export type ViewedRecord = {
  sha: string
  paths: string[]
}

export type DashboardState = {
  version: 1
  preferences: DashboardPreferences
  savedViews: SavedView[]
  filesViewed: Record<string, ViewedRecord>
  repos: RegisteredRepo[]
}

export type Store = {
  load: () => Promise<DashboardState>
  savePreferences: (patch: Partial<DashboardPreferences>) => Promise<DashboardState>
  saveView: (input: { id?: string; name: string; filters: Partial<SavedViewFilters> }) => Promise<DashboardState>
  deleteView: (id: string) => Promise<DashboardState>
  setFileViewed: (mrKey: string, sha: string, path: string, viewed: boolean) => Promise<DashboardState>
  addRepo: (repo: RegisteredRepo) => Promise<DashboardState>
  removeRepo: (target: string) => Promise<DashboardState>
}

const MAX_VIEWS = 50
const MAX_REPOS = 50
const MAX_VIEWED_MRS = 500
const MAX_VIEWED_PATHS = 1_000
const STATES = new Set<MrStateFilter>(['opened', 'merged', 'closed', 'all'])
const INVOLVEMENTS = new Set<InvolvementFilter>(['all', 'waiting', 'reviewing', 'authored', 'others'])
const SORTS = new Set<SortOrder>(['ready', 'updated', 'newest', 'oldest', 'largest'])
const DIFF_MODES = new Set<DiffMode>(['unified', 'split'])

export const DEFAULT_PREFERENCES: DashboardPreferences = {
  state: 'opened',
  involvement: 'all',
  sort: 'ready',
  hostOrProject: 'all',
  diffMode: 'unified',
  autoRefresh: true,
  showFileIndex: true,
  listWidthPct: 40,
}

export function defaultState(): DashboardState {
  return {
    version: 1,
    preferences: { ...DEFAULT_PREFERENCES },
    savedViews: [],
    filesViewed: {},
    repos: [],
  }
}

function clampWidth(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(70, Math.max(22, Math.round(value)))
}

function cleanStr(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLen) : undefined
}

function sanitizePreferences(raw: unknown, base: DashboardPreferences = DEFAULT_PREFERENCES): DashboardPreferences {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    state: STATES.has(obj.state as MrStateFilter) ? (obj.state as MrStateFilter) : base.state,
    involvement: INVOLVEMENTS.has(obj.involvement as InvolvementFilter) ? (obj.involvement as InvolvementFilter) : base.involvement,
    sort: SORTS.has(obj.sort as SortOrder) ? (obj.sort as SortOrder) : base.sort,
    hostOrProject: cleanStr(obj.hostOrProject, 256) ?? base.hostOrProject,
    diffMode: DIFF_MODES.has(obj.diffMode as DiffMode) ? (obj.diffMode as DiffMode) : base.diffMode,
    autoRefresh: typeof obj.autoRefresh === 'boolean' ? obj.autoRefresh : base.autoRefresh,
    showFileIndex: typeof obj.showFileIndex === 'boolean' ? obj.showFileIndex : base.showFileIndex,
    listWidthPct: clampWidth(obj.listWidthPct, base.listWidthPct),
  }
}

function sanitizeFilters(raw: unknown): SavedViewFilters {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    q: typeof obj.q === 'string' ? obj.q.slice(0, 300) : '',
    state: STATES.has(obj.state as MrStateFilter) ? (obj.state as MrStateFilter) : 'opened',
    involvement: INVOLVEMENTS.has(obj.involvement as InvolvementFilter) ? (obj.involvement as InvolvementFilter) : 'all',
    sort: SORTS.has(obj.sort as SortOrder) ? (obj.sort as SortOrder) : 'ready',
    hostOrProject: cleanStr(obj.hostOrProject, 256) ?? 'all',
  }
}

function sanitizeViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return []
  const out: SavedView[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const id = cleanStr(rec.id, 64)
    const name = cleanStr(rec.name, 80)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, filters: sanitizeFilters(rec.filters) })
    if (out.length >= MAX_VIEWS) break
  }
  return out
}

function sanitizeViewed(raw: unknown): Record<string, ViewedRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries = Object.entries(raw as Record<string, unknown>).slice(-MAX_VIEWED_MRS)
  const out: Record<string, ViewedRecord> = {}
  for (const [key, val] of entries) {
    if (!key || key.length > 300 || !val || typeof val !== 'object' || Array.isArray(val)) continue
    const rec = val as Record<string, unknown>
    const sha = cleanStr(rec.sha, 80)
    if (!sha || !Array.isArray(rec.paths)) continue
    const paths = [...new Set(rec.paths.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 512))].slice(0, MAX_VIEWED_PATHS)
    if (paths.length > 0) out[key] = { sha, paths }
  }
  return out
}

function normalizeRepoPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '/' || trimmed === '\\') return trimmed
  return trimmed.replace(/[\\/]+$/, '')
}

function repoProjectKey(host: string, project: string): string {
  return `${host.toLowerCase()}|${project.toLowerCase()}`
}

function sanitizeRepos(raw: unknown): RegisteredRepo[] {
  if (!Array.isArray(raw)) return []
  const out: RegisteredRepo[] = []
  const seenKeys = new Set<string>()
  const seenPaths = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const rawPath = cleanStr(rec.path, 1024)
    const host = cleanStr(rec.host, 256)?.toLowerCase()
    const project = cleanStr(rec.project, 512)
    if (!rawPath || !host || !project) continue
    const normPath = normalizeRepoPath(rawPath)
    const key = repoProjectKey(host, project)
    if (seenKeys.has(key) || seenPaths.has(normPath)) continue
    seenKeys.add(key)
    seenPaths.add(normPath)
    out.push({ path: normPath, host, project })
    if (out.length >= MAX_REPOS) break
  }
  return out
}

export function sanitizeState(raw: unknown): DashboardState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultState()
  const obj = raw as Record<string, unknown>
  return {
    version: 1,
    preferences: sanitizePreferences(obj.preferences),
    savedViews: sanitizeViews(obj.savedViews),
    filesViewed: sanitizeViewed(obj.filesViewed),
    repos: sanitizeRepos(obj.repos),
  }
}

/** Creates a JSON store backed by `dataDir/dashboard-state.json`, or in-memory when `dataDir` is unset. */
export function createStore(dataDir?: string): Store {
  const filePath = dataDir ? join(dataDir, 'dashboard-state.json') : undefined
  let memory = defaultState()
  let writeChain: Promise<void> = Promise.resolve()

  async function readDisk(): Promise<DashboardState> {
    if (!filePath) return structuredClone(memory)
    try {
      const raw = await readFile(filePath, 'utf8')
      memory = sanitizeState(JSON.parse(raw))
    } catch {
      memory = defaultState()
    }
    return structuredClone(memory)
  }

  async function persist(next: DashboardState): Promise<DashboardState> {
    memory = structuredClone(next)
    if (!filePath || !dataDir) return structuredClone(memory)
    const snapshot = JSON.stringify(memory, null, 2)
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await mkdir(dataDir, { recursive: true })
        const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await writeFile(tmp, snapshot, 'utf8')
        await rename(tmp, filePath)
      })
    await writeChain
    return structuredClone(memory)
  }

  return {
    load: readDisk,

    async savePreferences(patch) {
      const current = await readDisk()
      current.preferences = sanitizePreferences(patch, current.preferences)
      return persist(current)
    },

    async saveView(input) {
      const name = cleanStr(input.name, 80)
      if (!name) throw new Error('View name is required.')
      const current = await readDisk()
      const id = cleanStr(input.id, 64) ?? `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const view: SavedView = { id, name, filters: sanitizeFilters(input.filters) }
      const idx = current.savedViews.findIndex((v) => v.id === id)
      if (idx >= 0) current.savedViews[idx] = view
      else {
        current.savedViews.push(view)
        if (current.savedViews.length > MAX_VIEWS) current.savedViews.shift()
      }
      return persist(current)
    },

    async deleteView(id) {
      const current = await readDisk()
      current.savedViews = current.savedViews.filter((v) => v.id !== id)
      return persist(current)
    },

    async setFileViewed(mrKey, sha, path, viewed) {
      const key = cleanStr(mrKey, 300)
      const headSha = cleanStr(sha, 80)
      const filePathKey = cleanStr(path, 512)
      if (!key || !headSha || !filePathKey) return readDisk()
      const current = await readDisk()
      const existing = current.filesViewed[key]
      // Invalidate previous paths automatically when the MR head SHA changes
      const paths = new Set(existing && existing.sha === headSha ? existing.paths : [])
      if (viewed) paths.add(filePathKey)
      else paths.delete(filePathKey)
      // Re-insert at the end for simple LRU ordering
      delete current.filesViewed[key]
      if (paths.size > 0) {
        current.filesViewed[key] = { sha: headSha, paths: [...paths].slice(0, MAX_VIEWED_PATHS) }
      }
      const keys = Object.keys(current.filesViewed)
      while (keys.length > MAX_VIEWED_MRS) {
        const oldest = keys.shift()
        if (oldest) delete current.filesViewed[oldest]
      }
      return persist(current)
    },

    async addRepo(repo) {
      const rawPath = cleanStr(repo.path, 1024)
      const host = cleanStr(repo.host, 256)?.toLowerCase()
      const project = cleanStr(repo.project, 512)
      if (!rawPath || !host || !project) throw new Error('Repo requires path, host, and project.')
      const normPath = normalizeRepoPath(rawPath)
      const key = repoProjectKey(host, project)
      const current = await readDisk()
      current.repos = current.repos.filter(
        (r) => repoProjectKey(r.host, r.project) !== key && normalizeRepoPath(r.path) !== normPath,
      )
      current.repos.push({ path: normPath, host, project })
      if (current.repos.length > MAX_REPOS) current.repos.shift()
      return persist(current)
    },

    async removeRepo(target) {
      const cleaned = cleanStr(target, 1024)
      if (!cleaned) return readDisk()
      const normPath = normalizeRepoPath(cleaned)
      const lowerTarget = cleaned.toLowerCase()
      const current = await readDisk()
      current.repos = current.repos.filter(
        (r) => normalizeRepoPath(r.path) !== normPath && repoProjectKey(r.host, r.project) !== lowerTarget,
      )
      return persist(current)
    },
  }
}
