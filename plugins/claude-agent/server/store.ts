// Atomic local persistence for Claude Agent sessions, recent workspaces, and UI preferences in ${PLUGIN_DATA}.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type UiPreferences = {
  sidebarWidthPct: number
  lastCwd?: string
  defaultModeId?: string
  defaultModelId?: string
  defaultEffort?: string
}

export type PersistedUsage = {
  used: number
  size: number
  costAmount?: number
  costCurrency?: string
}

export type PersistedTimelineItem = {
  id: string
  kind: 'user' | 'assistant' | 'thought' | 'tool_call' | 'status' | 'error'
  text?: string
  toolCallId?: string
  title?: string
  toolKind?: string
  status?: string
  locations?: { path: string; line?: number }[]
  diffs?: { path: string; oldText?: string; newText: string }[]
  rawInput?: string
  rawOutput?: string
  timestamp: string
}

export type PersistedSession = {
  sessionId: string
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
  modeId?: string
  modelId?: string
  effort?: string
  usage?: PersistedUsage
  touchedFiles: string[]
  items: PersistedTimelineItem[]
}

export type StoreData = {
  version: 1
  preferences: UiPreferences
  recentCwds: string[]
  sessions: PersistedSession[]
}

export type Store = {
  load: () => Promise<StoreData>
  savePreferences: (patch: Partial<UiPreferences>) => Promise<StoreData>
  recordCwd: (cwd: string) => Promise<StoreData>
  upsertSession: (session: PersistedSession) => Promise<StoreData>
  deleteSession: (sessionId: string) => Promise<StoreData>
}

const MAX_RECENT_CWDS = 30
const MAX_SESSIONS = 100
const MAX_ITEMS_PER_SESSION = 300
const MAX_TEXT_CHARS = 32_000

const ALLOWED_DEFAULT_MODES = new Set(['auto'])

const DEFAULT_PREFERENCES: UiPreferences = {
  sidebarWidthPct: 28,
  defaultModeId: 'auto',
  defaultModelId: 'opus',
  defaultEffort: 'high',
}

export function defaultStoreData(): StoreData {
  return {
    version: 1,
    preferences: { ...DEFAULT_PREFERENCES },
    recentCwds: [],
    sessions: [],
  }
}

function clampWidth(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(50, Math.max(18, Math.round(value)))
}

function clipText(value: unknown, maxLen = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length <= maxLen) return value
  return `${value.slice(0, maxLen)}\n… [truncated]`
}

function sanitizePreferences(raw: unknown, base: UiPreferences = DEFAULT_PREFERENCES): UiPreferences {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const rawMode = typeof obj.defaultModeId === 'string' ? obj.defaultModeId.trim() : ''
  const defaultModeId = ALLOWED_DEFAULT_MODES.has(rawMode)
    ? rawMode
    : base.defaultModeId && ALLOWED_DEFAULT_MODES.has(base.defaultModeId)
      ? base.defaultModeId
      : DEFAULT_PREFERENCES.defaultModeId
  return {
    sidebarWidthPct: clampWidth(obj.sidebarWidthPct, base.sidebarWidthPct),
    ...(typeof obj.lastCwd === 'string' && obj.lastCwd.trim() ? { lastCwd: obj.lastCwd.trim() } : base.lastCwd ? { lastCwd: base.lastCwd } : {}),
    ...(defaultModeId ? { defaultModeId } : {}),
    ...(typeof obj.defaultModelId === 'string' && obj.defaultModelId.trim()
      ? { defaultModelId: obj.defaultModelId.trim() }
      : base.defaultModelId
        ? { defaultModelId: base.defaultModelId }
        : {}),
    ...(typeof obj.defaultEffort === 'string' && obj.defaultEffort.trim()
      ? { defaultEffort: obj.defaultEffort.trim() }
      : base.defaultEffort
        ? { defaultEffort: base.defaultEffort }
        : {}),
  }
}

function sanitizeItem(raw: unknown): PersistedTimelineItem | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || typeof obj.kind !== 'string' || typeof obj.timestamp !== 'string') return undefined
  const kind = obj.kind
  if (kind !== 'user' && kind !== 'assistant' && kind !== 'thought' && kind !== 'tool_call' && kind !== 'status' && kind !== 'error') {
    return undefined
  }
  const locations = Array.isArray(obj.locations)
    ? obj.locations
        .filter((l): l is { path: string; line?: number } => Boolean(l && typeof l === 'object' && typeof (l as { path?: unknown }).path === 'string'))
        .slice(0, 50)
    : undefined
  const diffs = Array.isArray(obj.diffs)
    ? obj.diffs
        .filter(
          (d): d is { path: string; oldText?: string; newText: string } =>
            Boolean(
              d &&
                typeof d === 'object' &&
                typeof (d as { path?: unknown }).path === 'string' &&
                typeof (d as { newText?: unknown }).newText === 'string',
            ),
        )
        .slice(0, 10)
        .map(d => ({
          path: d.path,
          ...(typeof d.oldText === 'string' ? { oldText: clipText(d.oldText, 12_000) } : {}),
          newText: clipText(d.newText, 12_000) ?? '',
        }))
    : undefined

  return {
    id: obj.id,
    kind,
    ...(typeof obj.text === 'string' ? { text: clipText(obj.text) } : {}),
    ...(typeof obj.toolCallId === 'string' ? { toolCallId: obj.toolCallId } : {}),
    ...(typeof obj.title === 'string' ? { title: obj.title.slice(0, 300) } : {}),
    ...(typeof obj.toolKind === 'string' ? { toolKind: obj.toolKind.slice(0, 40) } : {}),
    ...(typeof obj.status === 'string' ? { status: obj.status.slice(0, 40) } : {}),
    ...(locations && locations.length ? { locations } : {}),
    ...(diffs && diffs.length ? { diffs } : {}),
    ...(typeof obj.rawInput === 'string' ? { rawInput: clipText(obj.rawInput, 8_000) } : {}),
    ...(typeof obj.rawOutput === 'string' ? { rawOutput: clipText(obj.rawOutput, 8_000) } : {}),
    timestamp: obj.timestamp,
  }
}

function sanitizeSession(raw: unknown): PersistedSession | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.sessionId !== 'string' || !obj.sessionId.trim()) return undefined
  if (typeof obj.cwd !== 'string' || !obj.cwd.trim()) return undefined
  const items = Array.isArray(obj.items)
    ? obj.items.map(sanitizeItem).filter((item): item is PersistedTimelineItem => Boolean(item)).slice(-MAX_ITEMS_PER_SESSION)
    : []
  const touchedFiles = Array.isArray(obj.touchedFiles)
    ? [...new Set(obj.touchedFiles.filter((f): f is string => typeof f === 'string' && f.trim().length > 0))].slice(0, 200)
    : []
  const usageRaw = obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage) ? (obj.usage as Record<string, unknown>) : undefined
  const usage =
    usageRaw && typeof usageRaw.used === 'number' && typeof usageRaw.size === 'number'
      ? {
          used: usageRaw.used,
          size: usageRaw.size,
          ...(typeof usageRaw.costAmount === 'number' ? { costAmount: usageRaw.costAmount } : {}),
          ...(typeof usageRaw.costCurrency === 'string' ? { costCurrency: usageRaw.costCurrency } : {}),
        }
      : undefined
  return {
    sessionId: obj.sessionId.trim(),
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim().slice(0, 160) : 'Untitled session',
    cwd: obj.cwd.trim(),
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    ...(typeof obj.archivedAt === 'string' && obj.archivedAt.trim() ? { archivedAt: obj.archivedAt.trim() } : {}),
    ...(typeof obj.modeId === 'string' ? { modeId: obj.modeId } : {}),
    ...(typeof obj.modelId === 'string' ? { modelId: obj.modelId } : {}),
    ...(typeof obj.effort === 'string' && obj.effort.trim() ? { effort: obj.effort.trim() } : {}),
    ...(usage ? { usage } : {}),
    touchedFiles,
    items,
  }
}

function sanitizeStore(raw: unknown): StoreData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultStoreData()
  const obj = raw as Record<string, unknown>
  const recentCwds = Array.isArray(obj.recentCwds)
    ? [...new Set(obj.recentCwds.filter((c): c is string => typeof c === 'string' && c.trim().length > 0))].slice(0, MAX_RECENT_CWDS)
    : []
  const sessions = Array.isArray(obj.sessions)
    ? obj.sessions
        .map(sanitizeSession)
        .filter((s): s is PersistedSession => Boolean(s))
        .slice(0, MAX_SESSIONS)
    : []
  return {
    version: 1,
    preferences: sanitizePreferences(obj.preferences),
    recentCwds,
    sessions,
  }
}

export function createStore(dataDir?: string): Store {
  const filePath = dataDir ? join(dataDir, 'claude-agent-state.json') : undefined
  let memory: StoreData | undefined
  let queue: Promise<void> = Promise.resolve()

  async function readDisk(): Promise<StoreData> {
    if (!filePath) {
      if (!memory) memory = defaultStoreData()
      return memory
    }
    try {
      const raw = await readFile(filePath, 'utf8')
      try {
        memory = sanitizeStore(JSON.parse(raw))
      } catch {
        await rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => undefined)
        memory = defaultStoreData()
      }
    } catch {
      memory = defaultStoreData()
    }
    return memory
  }

  async function writeDisk(data: StoreData): Promise<void> {
    memory = data
    if (!filePath || !dataDir) return
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const tmpPath = join(dataDir, `.claude-agent-state.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmpPath, filePath)
  }

  function enqueue(mutator: (current: StoreData) => StoreData): Promise<StoreData> {
    const task = queue.then(async () => {
      const current = await readDisk()
      const next = sanitizeStore(mutator(current))
      await writeDisk(next)
      return next
    })
    queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  return {
    load: () => queue.then(() => readDisk()),
    savePreferences: patch =>
      enqueue(current => ({
        ...current,
        preferences: sanitizePreferences(patch, current.preferences),
      })),
    recordCwd: cwd =>
      enqueue(current => {
        const cleaned = cwd.trim()
        if (!cleaned) return current
        return {
          ...current,
          preferences: { ...current.preferences, lastCwd: cleaned },
          recentCwds: [cleaned, ...current.recentCwds.filter(item => item !== cleaned)].slice(0, MAX_RECENT_CWDS),
        }
      }),
    upsertSession: session =>
      enqueue(current => {
        const sanitized = sanitizeSession(session)
        if (!sanitized) return current
        const sorted = [sanitized, ...current.sessions.filter(s => s.sessionId !== sanitized.sessionId)].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        )
        const nextSessions = [...sorted.filter(s => !s.archivedAt), ...sorted.filter(s => Boolean(s.archivedAt))].slice(
          0,
          MAX_SESSIONS,
        )
        return {
          ...current,
          sessions: nextSessions,
        }
      }),
    deleteSession: sessionId =>
      enqueue(current => ({
        ...current,
        sessions: current.sessions.filter(s => s.sessionId !== sessionId),
      })),
  }
}
