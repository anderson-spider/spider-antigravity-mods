// Session orchestration, ACP lifecycle, long-polling event buffer, and MCP tool handlers.
import { basename, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AcpClient, AcpRpcError, type AcpClientDeps } from './acp-client.ts'
import type {
  AcpAgentCapabilities,
  AcpAgentInfo,
  AcpAuthMethod,
  AcpAvailableCommand,
  AcpConfigOption,
  AcpContentBlock,
  AcpInitializeResult,
  AcpModeOption,
  AcpModelOption,
  AcpPermissionOption,
  AcpPermissionOutcome,
  AcpPlanEntry,
  AcpPromptResult,
  AcpRequestPermissionParams,
  AcpSessionListResult,
  AcpSessionLoadResult,
  AcpSessionNewResult,
  AcpSessionUpdate,
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpUsageCost,
} from './acp-types.ts'
import { resolveAcpBinary, type BinaryDeps, type BinaryResolution } from './binary.ts'
import { listDirectories, resolveDirectory, searchWorkspaceFiles } from './fs-helpers.ts'
import type { ToolInputs } from './inputs.ts'
import { buildAcpEnv, redactSecrets } from './redact.ts'
import type { PersistedSession, PersistedTimelineItem, PersistedUsage, Store, UiPreferences } from './store.ts'

export const APP_URI = 'ui://claude-agent/app.html'
export const APP_MIME = 'text/html;profile=mcp-app'

const MAX_EVENT_BUFFER = 2_000
const COALESCE_MS = 40
const DEFAULT_POLL_WAIT_MS = 12_000
const MAX_POLL_WAIT_MS = 25_000
const DEFAULT_ASK_TIMEOUT_SECONDS = 120
const MIN_ASK_TIMEOUT_MS = 10_000
const MAX_ASK_TIMEOUT_SECONDS = 300
const DEFAULT_WAIT_TIMEOUT_SECONDS = 25
const MIN_WAIT_TIMEOUT_MS = 5_000
const MAX_WAIT_TIMEOUT_SECONDS = 60
const MAX_CHAT_REPLY_CHARS = 24_000
const REPLY_CLAIM_LEASE_MS = 15_000
const MAX_BOOTSTRAP_ITEMS = 80
const DEFAULT_AUTO_ARCHIVE_IDLE_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 5_000
const DEFAULT_MODE_ID = 'auto'
const DEFAULT_MODEL_ID = 'opus'
const ALLOWED_OPEN_MODES = new Set(['default', 'auto', 'acceptEdits', 'plan'])

export type TimelineItem = PersistedTimelineItem & {
  streaming?: boolean
}

export type PermissionRequestState = {
  requestId: string
  sessionId: string
  toolCallId: string
  title: string
  kind?: string
  rawInput?: string
  locations?: { path: string; line?: number }[]
  diffs?: { path: string; oldText?: string; newText: string }[]
  options: AcpPermissionOption[]
  createdAt: string
}

export type PendingChatReplyRef = {
  sessionId: string
  replyId: string
  status: 'completed' | 'error'
}

export type SessionSummary = {
  sessionId: string
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
  status: 'idle' | 'running' | 'error'
  loadedInProcess: boolean
  pendingPermissionCount: number
  touchedFilesCount: number
  modeId?: string
  modelId?: string
  usage?: PersistedUsage
  replyToChat?: boolean
  pendingChatReplyId?: string
}

export type SessionSnapshot = SessionSummary & {
  availableModes: AcpModeOption[]
  availableModels: AcpModelOption[]
  configOptions: AcpConfigOption[]
  availableCommands: AcpAvailableCommand[]
  plan: AcpPlanEntry[]
  touchedFiles: string[]
  pendingPermissions: PermissionRequestState[]
  items: TimelineItem[]
  latestSeq: number
}

export type DiagnosticsInfo = {
  status: 'idle' | 'connecting' | 'ready' | 'auth_required' | 'error'
  binarySource?: BinaryResolution['source']
  binaryDisplay?: string
  agentInfo?: AcpAgentInfo
  agentCapabilities?: AcpAgentCapabilities
  authMethods: AcpAuthMethod[]
  authRequired: boolean
  lastError?: string
  stderrTail: string[]
}

export type PollEvent =
  | { seq: number; type: 'timeline_upsert'; sessionId: string; item: TimelineItem }
  | { seq: number; type: 'plan_update'; sessionId: string; plan: AcpPlanEntry[] }
  | { seq: number; type: 'commands_update'; sessionId: string; commands: AcpAvailableCommand[] }
  | {
      seq: number
      type: 'session_meta'
      sessionId: string
      summary: SessionSummary
      availableModes?: AcpModeOption[]
      availableModels?: AcpModelOption[]
      configOptions?: AcpConfigOption[]
      touchedFiles?: string[]
    }
  | { seq: number; type: 'permission_request'; sessionId: string; permission: PermissionRequestState }
  | { seq: number; type: 'permission_resolved'; sessionId: string; requestId: string; outcome: AcpPermissionOutcome }
  | { seq: number; type: 'turn_finished'; sessionId: string; stopReason: string; error?: string }

type PollEventInput =
  | { type: 'timeline_upsert'; sessionId: string; item: TimelineItem }
  | { type: 'plan_update'; sessionId: string; plan: AcpPlanEntry[] }
  | { type: 'commands_update'; sessionId: string; commands: AcpAvailableCommand[] }
  | {
      type: 'session_meta'
      sessionId: string
      summary: SessionSummary
      availableModes?: AcpModeOption[]
      availableModels?: AcpModelOption[]
      configOptions?: AcpConfigOption[]
      touchedFiles?: string[]
    }
  | { type: 'permission_request'; sessionId: string; permission: PermissionRequestState }
  | { type: 'permission_resolved'; sessionId: string; requestId: string; outcome: AcpPermissionOutcome }
  | { type: 'turn_finished'; sessionId: string; stopReason: string; error?: string }

export type BootstrapPayload = {
  diagnostics: DiagnosticsInfo
  preferences: UiPreferences
  workspaceRoots: string[]
  recentCwds: string[]
  sessions: SessionSummary[]
  catalogVersion: number
  activeSession?: SessionSnapshot
  truncatedItems?: boolean
  pendingReplies?: PendingChatReplyRef[]
}

export type Reply = {
  text: string
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

type InternalPermission = PermissionRequestState & {
  resolve: (outcome: AcpPermissionOutcome) => void
}

type PollWaiter = {
  afterSeq: number
  clientId?: string
  watchCatalog?: boolean
  wake: () => void
  timer?: ReturnType<typeof setTimeout>
  coalesceTimer?: ReturnType<typeof setTimeout>
}

type PendingChatReply = {
  replyId: string
  turnGen: number
  status: 'completed' | 'error'
  createdAt: string
  text: string
  claimedBy?: string
  claimedAt?: number
}

type InternalSession = {
  sessionId: string
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
  archivedAt?: string
  status: 'idle' | 'running' | 'error'
  loadedInProcess: boolean
  modeId?: string
  availableModes: AcpModeOption[]
  modelId?: string
  availableModels: AcpModelOption[]
  configOptions: AcpConfigOption[]
  availableCommands: AcpAvailableCommand[]
  plan: AcpPlanEntry[]
  usage?: PersistedUsage
  touchedFiles: Set<string>
  items: TimelineItem[]
  pendingPermissions: Map<string, InternalPermission>
  readOnlyLock: boolean
  cancelling: boolean
  activeTurnReplyToChat: boolean
  activeTurnStartIndex: number
  pendingChatReply?: PendingChatReply
  activeAssistantId?: string
  activeThoughtId?: string
  events: PollEvent[]
  nextSeq: number
  waiters: Set<PollWaiter>
  activeTurn?: Promise<void>
  turnGen: number
  loadingPromise?: Promise<InternalSession>
  replayingLoad?: boolean
  sawReplayUpdate?: boolean
}

export type SessionManagerDeps = {
  store: Store
  binaryDeps?: BinaryDeps
  spawn?: AcpClientDeps['spawn']
  env?: NodeJS.ProcessEnv
  defaultCwd: string
  log?: (line: string) => void
  autoArchiveIdleMs?: number
  cancelTimeoutMs?: number
  minAskTimeoutMs?: number
  minWaitTimeoutMs?: number
}

function nowIso(): string {
  return new Date().toISOString()
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function extractTextFromBlock(block: AcpContentBlock | undefined): string {
  if (!block) return ''
  if (block.type === 'text') return block.text
  if (block.type === 'resource' && typeof block.resource?.text === 'string') return block.resource.text
  if (block.type === 'resource_link') return `@${block.name}`
  return ''
}

function stringifyCompact(value: unknown, maxLen = 6_000): string | undefined {
  if (value === undefined || value === null) return undefined
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  const masked = redactSecrets(text)
  return masked.length > maxLen ? `${masked.slice(0, maxLen)}\n… [truncated]` : masked
}

function extractToolDetails(
  content: AcpToolCallContent[] | null | undefined,
  locations: AcpToolCallLocation[] | null | undefined,
  cwd: string,
): {
  locs: { path: string; line?: number }[]
  diffs: { path: string; oldText?: string; newText: string }[]
  outputTexts: string[]
} {
  const locs: { path: string; line?: number }[] = []
  const diffs: { path: string; oldText?: string; newText: string }[] = []
  const outputTexts: string[] = []

  if (Array.isArray(locations)) {
    for (const loc of locations) {
      if (loc && typeof loc.path === 'string' && loc.path.trim()) {
        const abs = isAbsolute(loc.path) ? resolve(loc.path) : resolve(cwd, loc.path)
        locs.push({ path: abs, ...(typeof loc.line === 'number' ? { line: loc.line } : {}) })
      }
    }
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'diff' && typeof part.path === 'string' && typeof part.newText === 'string') {
        const abs = isAbsolute(part.path) ? resolve(part.path) : resolve(cwd, part.path)
        diffs.push({
          path: abs,
          ...(typeof part.oldText === 'string' ? { oldText: part.oldText } : {}),
          newText: part.newText,
        })
        if (!locs.some(l => l.path === abs)) locs.push({ path: abs })
      } else if (part.type === 'content' && part.content) {
        const text = extractTextFromBlock(part.content)
        if (text) outputTexts.push(redactSecrets(text))
      } else if (part.type === 'terminal' && typeof part.terminalId === 'string') {
        outputTexts.push(`[terminal: ${part.terminalId}]`)
      }
    }
  }

  return { locs, diffs, outputTexts }
}

function normalizeUsageCost(cost: AcpUsageCost | null | undefined, fallbackCurrency?: string): { amount?: number; currency?: string } {
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    return { amount: cost, ...(fallbackCurrency ? { currency: fallbackCurrency } : { currency: 'USD' }) }
  }
  if (cost && typeof cost === 'object') {
    const amount = typeof cost.amount === 'number' && Number.isFinite(cost.amount) ? cost.amount : undefined
    const currency = typeof cost.currency === 'string' ? cost.currency : fallbackCurrency
    return {
      ...(amount !== undefined ? { amount } : {}),
      ...(currency ? { currency } : {}),
    }
  }
  return {}
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map(l => l.trim())
    .find(Boolean)
  if (!firstLine) return 'Untitled session'
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine
}

function extractTurnAssistantText(items: readonly TimelineItem[], startIndex?: number): string {
  let from = startIndex
  if (from === undefined || from < 0 || from > items.length) {
    let lastUserIdx = -1
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === 'user') {
        lastUserIdx = i
        break
      }
    }
    from = lastUserIdx >= 0 ? lastUserIdx + 1 : 0
  }
  return items
    .slice(from)
    .filter(i => i.kind === 'assistant' && typeof i.text === 'string' && i.text.trim().length > 0)
    .map(i => i.text!.trim())
    .join('\n\n')
    .trim()
}

function clipForChatReply(text: string, sessionId: string, maxChars = MAX_CHAT_REPLY_CHARS): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n… [truncated at ${maxChars} chars; call claude_session(action: "get", sessionId: "${sessionId}") to inspect the full session]`
}

function formatChatReplyMessage(
  session: InternalSession,
  status: 'completed' | 'error',
  startIndex: number,
  errorText?: string,
): string {
  const assistantText = extractTurnAssistantText(session.items, startIndex)
  const metaParts = [
    `session ${session.sessionId}`,
    `cwd: ${session.cwd}`,
    session.modeId ? `mode: ${session.modeId}` : undefined,
    session.modelId ? `model: ${session.modelId}` : undefined,
  ].filter(Boolean)
  const header =
    status === 'error'
      ? `[Claude Agent error · "${session.title}" · ${metaParts.join(' · ')}]`
      : `[Claude Agent reply · "${session.title}" · ${metaParts.join(' · ')}]`
  const touched =
    session.touchedFiles.size > 0 ? `Touched files: ${[...session.touchedFiles].join(', ')}` : undefined
  const body =
    status === 'error'
      ? [
          errorText ? `Error: ${errorText}` : 'Error: Claude Agent turn failed.',
          assistantText ? `Partial response:\n${assistantText}` : undefined,
        ]
          .filter(Boolean)
          .join('\n\n')
      : assistantText || '(Claude Agent completed with no text output.)'
  return [header, touched, '', clipForChatReply(body, session.sessionId)].filter(v => v !== undefined).join('\n')
}

function toPersisted(session: InternalSession): PersistedSession {
  return {
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
    ...(session.modeId ? { modeId: session.modeId } : {}),
    ...(session.modelId ? { modelId: session.modelId } : {}),
    ...(session.usage ? { usage: session.usage } : {}),
    touchedFiles: [...session.touchedFiles],
    items: session.items.map(({ streaming: _streaming, ...rest }) => rest),
  }
}

function isAuthError(err: unknown): boolean {
  if (err instanceof AcpRpcError) {
    if (err.code === -32000 || err.code === 401) return true
    if (/auth|login|unauthorized|api[_ ]key/i.test(err.message)) return true
  }
  if (err instanceof Error && /auth_required|not authenticated|please run claude \/login/i.test(err.message)) {
    return true
  }
  return false
}

function enrichAcpError(err: unknown, client?: AcpClient | null): Error {
  const base = redactSecrets(err instanceof Error ? err.message : String(err))
  const tail = client?.getStderrTail().slice(-5) ?? []
  const combined = `${base}\n${tail.join('\n')}`
  const parts: string[] = [base]
  if (/^Internal error\b/i.test(base) && tail.length > 0) {
    parts.push(`ACP stderr:\n${tail.join('\n')}`)
  }
  if (/Unknown system error -88|EBADMACHO|Malformed Mach-o/i.test(combined)) {
    parts.push(
      'Hint: The cached Claude binary in ~/.npm/_npx appears truncated or corrupted. Clear ~/.npm/_npx or reinstall @agentclientprotocol/claude-agent-acp.',
    )
  }
  return new Error(parts.join('\n'))
}

type ModelMatch = {
  resolvedId: string
  matched: boolean
  hasCatalog: boolean
}

function collectModelEntries(session: InternalSession): { id: string; name: string }[] {
  const entries: { id: string; name: string }[] = []
  const seen = new Set<string>()
  for (const m of session.availableModels) {
    if (!seen.has(m.modelId)) {
      seen.add(m.modelId)
      entries.push({ id: m.modelId, name: m.name })
    }
  }
  const modelOpt = session.configOptions.find(c => c.category === 'model')
  if (modelOpt) {
    const configValues = modelOpt.options.flatMap(o => ('group' in o ? o.options : [o]))
    for (const v of configValues) {
      if (!seen.has(v.value)) {
        seen.add(v.value)
        entries.push({ id: v.value, name: v.name })
      }
    }
  }
  return entries
}

function splitModelWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function containsModelWords(haystack: string, needleWords: readonly string[]): boolean {
  if (needleWords.length === 0) return false
  const words = splitModelWords(haystack)
  for (let i = 0; i + needleWords.length <= words.length; i++) {
    if (needleWords.every((w, offset) => words[i + offset] === w)) return true
  }
  return false
}

function matchModelId(session: InternalSession, requested: string): ModelMatch {
  const trimmed = requested.trim()
  const entries = collectModelEntries(session)
  const hasCatalog = entries.length > 0
  if (!trimmed) return { resolvedId: requested, matched: false, hasCatalog }
  const needle = trimmed.toLowerCase()

  const exactId = entries.find(e => e.id === trimmed) ?? entries.find(e => e.id.toLowerCase() === needle)
  if (exactId) return { resolvedId: exactId.id, matched: true, hasCatalog }

  const exactName = entries.find(e => e.name.toLowerCase() === needle)
  if (exactName) return { resolvedId: exactName.id, matched: true, hasCatalog }

  const needleWords = splitModelWords(trimmed)
  const isMetaAlias = (id: string) => {
    const lower = id.toLowerCase()
    return lower === 'default' || lower === 'opusplan'
  }
  const allowMeta = needle.includes('default') || needle.includes('plan')
  const candidates = allowMeta ? entries : entries.filter(e => !isMetaAlias(e.id))

  const wordId = candidates.find(e => containsModelWords(e.id, needleWords))
  if (wordId) return { resolvedId: wordId.id, matched: true, hasCatalog }

  const wordName = candidates.find(e => containsModelWords(e.name, needleWords))
  if (wordName) return { resolvedId: wordName.id, matched: true, hasCatalog }

  const sub = candidates.find(e => e.id.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle))
  if (sub) return { resolvedId: sub.id, matched: true, hasCatalog }

  return { resolvedId: trimmed, matched: false, hasCatalog }
}

function isModeSupported(session: InternalSession, modeId: string): boolean {
  if (session.availableModes.length > 0) {
    return session.availableModes.some(m => m.id === modeId)
  }
  const modeOpt = session.configOptions.find(c => c.category === 'mode')
  if (modeOpt) {
    const values = modeOpt.options.flatMap(o => ('group' in o ? o.options : [o]))
    if (values.length > 0) {
      return values.some(v => v.value === modeId)
    }
  }
  return true
}

export class SessionManager {
  private readonly deps: SessionManagerDeps
  private readonly sessions = new Map<string, InternalSession>()
  private readonly autoArchiveIdleMs: number
  private readonly cancelTimeoutMs: number
  private readonly minAskTimeoutMs: number
  private readonly minWaitTimeoutMs: number
  private client: AcpClient | null = null
  private connectingClient: AcpClient | null = null
  private connectPromise: Promise<void> | null = null
  private connectEpoch = 0
  private loadedFromDisk = false
  private disposed = false

  private diagStatus: DiagnosticsInfo['status'] = 'idle'
  private binaryResolution: BinaryResolution | undefined
  private agentInfo: AcpAgentInfo | undefined
  private agentCapabilities: AcpAgentCapabilities | undefined
  private authMethods: AcpAuthMethod[] = []
  private authRequired = false
  private lastError: string | undefined
  private lastStderrTail: string[] = []
  private reqCounter = 0
  private catalogVersion = 1
  private focusSessionId: string | undefined
  private focusCatalogVersion = 0
  private readonly catalogWaiters = new Set<PollWaiter>()

  constructor(deps: SessionManagerDeps) {
    this.deps = deps
    this.autoArchiveIdleMs = deps.autoArchiveIdleMs ?? DEFAULT_AUTO_ARCHIVE_IDLE_MS
    this.cancelTimeoutMs = deps.cancelTimeoutMs ?? DEFAULT_CANCEL_SETTLE_TIMEOUT_MS
    this.minAskTimeoutMs = deps.minAskTimeoutMs ?? MIN_ASK_TIMEOUT_MS
    this.minWaitTimeoutMs = deps.minWaitTimeoutMs ?? MIN_WAIT_TIMEOUT_MS
    try {
      this.binaryResolution = resolveAcpBinary(deps.binaryDeps)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.diagStatus = 'error'
    }
  }

  getDiagnostics(): DiagnosticsInfo {
    const stderrTail = (this.client ?? this.connectingClient)?.getStderrTail() ?? this.lastStderrTail
    return {
      status: this.diagStatus,
      ...(this.binaryResolution ? { binarySource: this.binaryResolution.source, binaryDisplay: this.binaryResolution.display } : {}),
      ...(this.agentInfo ? { agentInfo: this.agentInfo } : {}),
      ...(this.agentCapabilities ? { agentCapabilities: this.agentCapabilities } : {}),
      authMethods: this.authMethods,
      authRequired: this.authRequired,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      stderrTail,
    }
  }

  async ensureHydrated(): Promise<void> {
    if (this.loadedFromDisk) return
    this.loadedFromDisk = true
    const data = await this.deps.store.load()
    for (const saved of data.sessions) {
      if (this.sessions.has(saved.sessionId)) continue
      this.sessions.set(saved.sessionId, {
        sessionId: saved.sessionId,
        title: saved.title,
        cwd: saved.cwd,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        archivedAt: saved.archivedAt,
        status: 'idle',
        loadedInProcess: false,
        modeId: saved.modeId,
        availableModes: [],
        modelId: saved.modelId,
        availableModels: [],
        configOptions: [],
        availableCommands: [],
        plan: [],
        usage: saved.usage,
        touchedFiles: new Set(saved.touchedFiles),
        items: saved.items.map(i => ({ ...i })),
        pendingPermissions: new Map(),
        readOnlyLock: false,
        cancelling: false,
        activeTurnReplyToChat: false,
        activeTurnStartIndex: 0,
        events: [],
        nextSeq: 1,
        waiters: new Set(),
        turnGen: 0,
      })
    }
    await this.archiveStaleSessions()
  }

  async ensureConnected(): Promise<AcpClient> {
    if (this.disposed) throw new Error('Session manager has been shut down.')
    if (this.client?.isAlive) return this.client
    const myEpoch = this.connectEpoch
    if (this.connectPromise) {
      try {
        await this.connectPromise
      } catch (err) {
        if (this.connectEpoch === myEpoch) throw err
      }
      if (this.client?.isAlive) return this.client
      if (this.connectEpoch !== myEpoch) {
        return this.ensureConnected()
      }
    }

    const p = this.startAcpClient(myEpoch)
    this.connectPromise = p
    try {
      await p
    } finally {
      if (this.connectPromise === p) {
        this.connectPromise = null
      }
    }
    if (!this.client?.isAlive) {
      throw new Error(this.lastError || 'Failed to connect to claude-agent-acp.')
    }
    return this.client
  }

  async reconnect(): Promise<DiagnosticsInfo> {
    this.connectEpoch++
    const prevConnect = this.connectPromise
    this.connectPromise = null
    await this.disposeClient()
    if (prevConnect) {
      await prevConnect.catch(() => undefined)
    }
    this.lastError = undefined
    this.authRequired = false
    try {
      await this.ensureConnected()
      await this.syncAcpSessionList()
    } catch (err) {
      this.lastError = redactSecrets(err instanceof Error ? err.message : String(err))
      this.diagStatus = this.authRequired ? 'auth_required' : 'error'
    }
    return this.getDiagnostics()
  }

  async authenticate(methodId: string): Promise<DiagnosticsInfo> {
    const client = await this.ensureConnected()
    try {
      await client.request('authenticate', { methodId }, { timeoutMs: 120_000 })
      this.authRequired = false
      this.lastError = undefined
      this.diagStatus = 'ready'
    } catch (err) {
      this.lastError = redactSecrets(err instanceof Error ? err.message : String(err))
      this.diagStatus = isAuthError(err) ? 'auth_required' : 'error'
      throw err
    }
    return this.getDiagnostics()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.disposeClient()
    for (const session of this.sessions.values()) {
      this.flushWaitersNow(session)
    }
    this.flushCatalogWaiters()
    // Drain any in-flight store writes before returning so callers can safely clean up dataDir or exit.
    await this.deps.store.load().catch(() => undefined)
  }

  private clearSessionPendingPermissions(session: InternalSession, emitEvents = true): boolean {
    if (session.pendingPermissions.size === 0) return false
    const pending = [...session.pendingPermissions.values()]
    session.pendingPermissions.clear()
    for (const perm of pending) {
      perm.resolve({ outcome: 'cancelled' })
      if (emitEvents) {
        this.pushEvent(
          session,
          {
            type: 'permission_resolved',
            sessionId: session.sessionId,
            requestId: perm.requestId,
            outcome: { outcome: 'cancelled' },
          },
          true,
        )
      }
    }
    if (emitEvents) {
      this.bumpCatalog()
    }
    return true
  }

  private async disposeClient(): Promise<void> {
    const clientsToDispose: AcpClient[] = []
    if (this.client) {
      clientsToDispose.push(this.client)
      this.lastStderrTail = this.client.getStderrTail()
      this.client = null
    }
    if (this.connectingClient) {
      if (!clientsToDispose.includes(this.connectingClient)) {
        clientsToDispose.push(this.connectingClient)
      }
      this.lastStderrTail = this.connectingClient.getStderrTail()
      this.connectingClient = null
    }
    this.agentCapabilities = undefined

    for (const session of this.sessions.values()) {
      const wasRunning = session.status === 'running'
      const wasLoaded = session.loadedInProcess
      session.loadedInProcess = false
      if (wasRunning || session.activeTurn) {
        session.turnGen++
        session.activeTurn = undefined
        session.cancelling = false
        session.activeTurnReplyToChat = false
      }
      const hadPermissions = this.clearSessionPendingPermissions(session, !this.disposed)
      if (wasRunning) {
        this.finalizeStreamingItems(session)
        session.status = 'idle'
        session.updatedAt = nowIso()
        if (!this.disposed) {
          this.pushEvent(
            session,
            {
              type: 'turn_finished',
              sessionId: session.sessionId,
              stopReason: 'cancelled',
            },
            true,
          )
          void this.deps.store
            .upsertSession(toPersisted(session))
            .catch(err =>
              this.deps.log?.(`claude-agent: store persist failed: ${err instanceof Error ? err.message : String(err)}`),
            )
        }
      }
      if (!this.disposed && (wasRunning || hadPermissions || wasLoaded)) {
        this.emitMeta(session)
      }
    }

    for (const c of clientsToDispose) {
      await c.dispose()
    }
  }

  private async startAcpClient(epoch: number): Promise<void> {
    if (epoch !== this.connectEpoch || this.disposed) {
      throw new Error('ACP connection superseded.')
    }
    this.diagStatus = 'connecting'
    this.lastError = undefined

    let bin: BinaryResolution
    let client: AcpClient
    try {
      bin = resolveAcpBinary(this.deps.binaryDeps)
      this.binaryResolution = bin

      client = new AcpClient({
        command: bin.command,
        args: bin.args,
        cwd: this.deps.defaultCwd,
        env: buildAcpEnv(this.deps.env),
        spawn: this.deps.spawn,
        onLog: this.deps.log,
        onNotification: (method, params) => {
          if (method === 'session/update') {
            this.handleSessionUpdate(params)
          }
        },
        onRequest: (method, params) => this.handleAgentRequest(method, params),
        onExit: info => {
          if (epoch !== this.connectEpoch) return
          this.lastStderrTail = info.stderrTail
          if (this.connectingClient === client) {
            this.connectingClient = null
            return
          }
          if (this.client === client) {
            this.client = null
            this.agentCapabilities = undefined
            this.diagStatus = 'error'
            this.lastError = `claude-agent-acp exited unexpectedly (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`
            for (const session of this.sessions.values()) {
              const wasRunning = session.status === 'running'
              const wasLoaded = session.loadedInProcess
              const shouldReplyToChat = session.activeTurnReplyToChat
              session.loadedInProcess = false
              if (wasRunning || session.activeTurn) {
                session.turnGen++
                session.activeTurn = undefined
                session.cancelling = false
                session.activeTurnReplyToChat = false
              }
              const hadPermissions = this.clearSessionPendingPermissions(session, true)
              if (wasRunning) {
                this.finalizeStreamingItems(session)
                session.status = 'error'
                session.updatedAt = nowIso()
                this.appendSystemItem(session, 'error', this.lastError)
                if (shouldReplyToChat) {
                  this.queuePendingChatReply(session, 'error', this.lastError)
                }
                this.pushEvent(
                  session,
                  {
                    type: 'turn_finished',
                    sessionId: session.sessionId,
                    stopReason: 'error',
                    error: this.lastError,
                  },
                  true,
                )
                this.emitMeta(session)
                void this.deps.store
                  .upsertSession(toPersisted(session))
                  .catch(err =>
                    this.deps.log?.(`claude-agent: store persist failed: ${err instanceof Error ? err.message : String(err)}`),
                  )
              } else if (hadPermissions || wasLoaded) {
                this.emitMeta(session)
              }
            }
          }
        },
      })
    } catch (err) {
      this.lastError = redactSecrets(err instanceof Error ? err.message : String(err))
      this.diagStatus = 'error'
      throw err
    }

    this.connectingClient = client

    try {
      const initTimeoutMs = bin.source === 'npx' ? 90_000 : 30_000
      const init = await client.request<AcpInitializeResult>(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'antigravity-claude-agent', version: '0.4.0' },
          clientCapabilities: {},
        },
        { timeoutMs: initTimeoutMs },
      )
      if (epoch !== this.connectEpoch || this.disposed) {
        if (this.connectingClient === client) this.connectingClient = null
        await client.dispose()
        throw new Error('ACP connection superseded.')
      }
      this.agentInfo = init.agentInfo ?? undefined
      this.agentCapabilities = init.agentCapabilities ?? {}
      this.authMethods = Array.isArray(init.authMethods) ? init.authMethods : []
      this.connectingClient = null
      this.client = client
      this.diagStatus = 'ready'
      this.authRequired = false
    } catch (err) {
      if (this.connectingClient === client) this.connectingClient = null
      if (epoch !== this.connectEpoch || this.disposed) {
        if (this.client === client) this.client = null
        await client.dispose()
        throw err
      }
      this.lastError = redactSecrets(err instanceof Error ? err.message : String(err))
      this.authRequired = isAuthError(err)
      this.diagStatus = this.authRequired ? 'auth_required' : 'error'
      await client.dispose()
      await this.disposeClient()
      throw err
    }
  }

  private async syncAcpSessionList(): Promise<void> {
    if (!this.client?.isAlive || !this.agentCapabilities?.sessionCapabilities?.list) return
    try {
      const res = await this.client.request<AcpSessionListResult>('session/list', {})
      if (!Array.isArray(res.sessions)) return
      for (const entry of res.sessions) {
        if (!entry || typeof entry.sessionId !== 'string') continue
        // Only refresh metadata for sessions already tracked by Antigravity; never import external CLI sessions.
        const existing = this.sessions.get(entry.sessionId)
        if (!existing) continue
        let changed = false
        if (entry.title && (!existing.title || existing.title === 'Untitled session')) {
          existing.title = entry.title.trim().slice(0, 160) || existing.title
          changed = true
        }
        if (!existing.archivedAt && entry.updatedAt) {
          const entryMs = Date.parse(entry.updatedAt)
          const existingMs = Date.parse(existing.updatedAt)
          if (Number.isFinite(entryMs) && (!Number.isFinite(existingMs) || entryMs > existingMs)) {
            existing.updatedAt = entry.updatedAt
            changed = true
          }
        }
        if (changed) {
          this.emitMeta(existing)
          await this.deps.store
            .upsertSession(toPersisted(existing))
            .catch(err => this.deps.log?.(`claude-agent: store persist failed: ${err instanceof Error ? err.message : String(err)}`))
        }
      }
    } catch (err) {
      this.deps.log?.(`claude-agent: session/list skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async createSession(opts: { cwd?: string; modeId?: string; modelId?: string; strictMode?: boolean; focus?: boolean } = {}): Promise<SessionSnapshot> {
    await this.ensureHydrated()
    const client = await this.ensureConnected()
    const resolved = await resolveDirectory(opts.cwd, await this.pickFallbackCwd())
    if (resolved.error !== undefined) throw new Error(resolved.error)

    let created: AcpSessionNewResult
    try {
      created = await client.request<AcpSessionNewResult>(
        'session/new',
        {
          cwd: resolved.cwd,
          mcpServers: [],
        },
        { timeoutMs: 60_000 },
      )
    } catch (err) {
      const enriched = enrichAcpError(err, client)
      if (isAuthError(err)) {
        this.authRequired = true
        this.diagStatus = 'auth_required'
      }
      this.lastError = enriched.message
      throw enriched
    }

    const ts = nowIso()
    const session: InternalSession = {
      sessionId: created.sessionId,
      title: `Session in ${basename(resolved.cwd) || resolved.cwd}`,
      cwd: resolved.cwd,
      createdAt: ts,
      updatedAt: ts,
      status: 'idle',
      loadedInProcess: true,
      modeId: created.modes?.currentModeId,
      availableModes: created.modes?.availableModes ?? [],
      modelId: created.models?.currentModelId,
      availableModels: created.models?.availableModels ?? [],
      configOptions: created.configOptions ?? [],
      availableCommands: [],
      plan: [],
      touchedFiles: new Set(),
      items: [],
      pendingPermissions: new Map(),
      readOnlyLock: false,
      cancelling: false,
      activeTurnReplyToChat: false,
      activeTurnStartIndex: 0,
      events: [],
      nextSeq: 1,
      waiters: new Set(),
      turnGen: 0,
    }

    this.sessions.set(session.sessionId, session)
    if (opts.focus) {
      this.focusSessionId = session.sessionId
      this.focusCatalogVersion = this.catalogVersion + 1
    }
    await this.deps.store.recordCwd(resolved.cwd)

    const storeData = await this.deps.store.load()

    // Apply model before mode: claude-agent-acp checks currentModelInfo.supportsAutoMode
    // when activating `auto`, so switching to Opus first avoids a premature fallback.
    const desiredModel = opts.modelId ?? storeData.preferences.defaultModelId ?? DEFAULT_MODEL_ID
    if (desiredModel) {
      const match = matchModelId(session, desiredModel)
      const modelSupported = !match.hasCatalog || match.matched
      if ((opts.modelId || modelSupported) && match.resolvedId !== session.modelId) {
        await this.setSessionModel(session.sessionId, match.resolvedId).catch(() => undefined)
      }
    }

    const desiredMode = opts.modeId ?? storeData.preferences.defaultModeId ?? DEFAULT_MODE_ID
    const modeSupported = isModeSupported(session, desiredMode)
    if (desiredMode && desiredMode !== session.modeId) {
      if (opts.strictMode) {
        if (!modeSupported) {
          await this.deleteSession(session.sessionId).catch(() => undefined)
          throw new Error(`Could not switch session into requested mode "${desiredMode}": mode is not supported by this ACP agent.`)
        }
        try {
          await this.setSessionMode(session.sessionId, desiredMode)
        } catch (err) {
          await this.deleteSession(session.sessionId).catch(() => undefined)
          throw new Error(
            `Could not switch session into requested mode "${desiredMode}": ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
          )
        }
        if (session.modeId !== desiredMode) {
          await this.deleteSession(session.sessionId).catch(() => undefined)
          throw new Error(`Could not switch session into requested mode "${desiredMode}".`)
        }
      } else if (modeSupported) {
        await this.setSessionMode(session.sessionId, desiredMode).catch(() => undefined)
      }
    }

    await this.deps.store.upsertSession(toPersisted(session))
    this.bumpCatalog()
    return this.snapshotOf(session)
  }

  async ensureSessionLoaded(sessionId: string): Promise<InternalSession> {
    await this.ensureHydrated()
    const existing = this.sessions.get(sessionId)
    if (!existing) throw new Error(`Unknown session: ${sessionId}`)
    if (existing.loadedInProcess && this.client?.isAlive) return existing
    if (existing.loadingPromise) return existing.loadingPromise

    const loadTask = (async (): Promise<InternalSession> => {
      const client = await this.ensureConnected()
      if (this.agentCapabilities?.loadSession) {
        const prevItems = existing.items
        existing.items = []
        existing.replayingLoad = true
        existing.sawReplayUpdate = false
        existing.activeAssistantId = undefined
        existing.activeThoughtId = undefined
        try {
          const res = await client.request<AcpSessionLoadResult>(
            'session/load',
            {
              sessionId: existing.sessionId,
              cwd: existing.cwd,
              mcpServers: [],
            },
            { timeoutMs: 60_000 },
          )
          existing.replayingLoad = false
          if (!existing.sawReplayUpdate && prevItems.length > 0) {
            existing.items = prevItems
          }
          this.finalizeStreamingItems(existing)
          existing.loadedInProcess = true
          if (res.modes) {
            existing.modeId = res.modes.currentModeId
            existing.availableModes = res.modes.availableModes
          }
          if (res.models) {
            existing.modelId = res.models.currentModelId
            existing.availableModels = res.models.availableModels
          }
          if (res.configOptions) {
            existing.configOptions = res.configOptions
          }
          this.emitMeta(existing)
          await this.deps.store.upsertSession(toPersisted(existing))
          return existing
        } catch (err) {
          existing.replayingLoad = false
          existing.items = prevItems
          this.deps.log?.(`claude-agent: session/load failed (${sessionId}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Fallback: create a fresh ACP session in the same directory so the user can keep working.
      let fresh: AcpSessionNewResult
      try {
        fresh = await client.request<AcpSessionNewResult>(
          'session/new',
          {
            cwd: existing.cwd,
            mcpServers: [],
          },
          { timeoutMs: 60_000 },
        )
      } catch (err) {
        const enriched = enrichAcpError(err, client)
        this.lastError = enriched.message
        throw enriched
      }
      const oldId = existing.sessionId
      const prevModeId = existing.modeId
      const prevModelId = existing.modelId
      this.sessions.delete(oldId)
      existing.sessionId = fresh.sessionId
      existing.loadedInProcess = true
      existing.modeId = fresh.modes?.currentModeId ?? existing.modeId
      existing.availableModes = fresh.modes?.availableModes ?? existing.availableModes
      existing.modelId = fresh.models?.currentModelId ?? existing.modelId
      existing.availableModels = fresh.models?.availableModels ?? existing.availableModels
      existing.configOptions = fresh.configOptions ?? existing.configOptions
      this.appendSystemItem(
        existing,
        'status',
        `Started a new ACP session (${fresh.sessionId.slice(0, 8)}) in ${existing.cwd} because the previous session could not be resumed directly.`,
      )
      this.sessions.set(fresh.sessionId, existing)
      await this.deps.store.deleteSession(oldId)

      const storeData = await this.deps.store.load()
      const desiredModel = prevModelId ?? storeData.preferences.defaultModelId ?? DEFAULT_MODEL_ID
      if (desiredModel) {
        const match = matchModelId(existing, desiredModel)
        if ((!match.hasCatalog || match.matched) && match.resolvedId !== existing.modelId) {
          await this.setSessionModel(existing.sessionId, match.resolvedId).catch(() => undefined)
        }
      }
      const desiredMode = existing.readOnlyLock
        ? 'plan'
        : prevModeId ?? storeData.preferences.defaultModeId ?? DEFAULT_MODE_ID
      if (desiredMode && desiredMode !== existing.modeId && isModeSupported(existing, desiredMode)) {
        await this.setSessionMode(existing.sessionId, desiredMode).catch(() => undefined)
      }

      await this.deps.store.upsertSession(toPersisted(existing))
      return existing
    })()

    existing.loadingPromise = loadTask
    try {
      return await loadTask
    } finally {
      if (existing.loadingPromise === loadTask) {
        existing.loadingPromise = undefined
      }
    }
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionSnapshot> {
    const session = await this.ensureSessionLoaded(sessionId)
    if (session.readOnlyLock && modeId !== 'plan') {
      throw new Error('Cannot change mode while a read-only claude_ask turn is in progress.')
    }
    const client = await this.ensureConnected()
    const prevModeId = session.modeId
    let effectiveModeId = modeId
    const modeOpt = session.configOptions.find(c => c.category === 'mode')
    if (modeOpt) {
      let appliedViaConfig = false
      try {
        const res = await client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
          sessionId: session.sessionId,
          configId: modeOpt.id,
          value: modeId,
        })
        if (Array.isArray(res?.configOptions)) {
          session.configOptions = res.configOptions
          const updatedModeOpt = session.configOptions.find(c => c.category === 'mode')
          if (!updatedModeOpt) {
            appliedViaConfig = true
          } else if (updatedModeOpt.currentValue === modeId || updatedModeOpt.currentValue !== prevModeId) {
            effectiveModeId = updatedModeOpt.currentValue
            appliedViaConfig = true
          }
        } else {
          appliedViaConfig = true
        }
      } catch {
        // Fall through to legacy session/set_mode below.
      }
      if (!appliedViaConfig) {
        await client.request('session/set_mode', { sessionId: session.sessionId, modeId })
        effectiveModeId = modeId
      }
    } else {
      await client.request('session/set_mode', { sessionId: session.sessionId, modeId })
    }
    session.modeId = effectiveModeId
    session.updatedAt = nowIso()
    this.emitMeta(session)
    await this.deps.store.upsertSession(toPersisted(session))
    this.bumpCatalog()
    return this.snapshotOf(session)
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<SessionSnapshot> {
    const session = await this.ensureSessionLoaded(sessionId)
    const client = await this.ensureConnected()
    const resolvedId = matchModelId(session, modelId).resolvedId
    const prevModelId = session.modelId
    let effectiveModelId = resolvedId
    const modelOpt = session.configOptions.find(c => c.category === 'model')
    if (modelOpt) {
      let appliedViaConfig = false
      try {
        const res = await client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
          sessionId: session.sessionId,
          configId: modelOpt.id,
          value: resolvedId,
        })
        if (Array.isArray(res?.configOptions)) {
          session.configOptions = res.configOptions
          const updatedModeOpt = session.configOptions.find(c => c.category === 'mode')
          if (updatedModeOpt) session.modeId = updatedModeOpt.currentValue
          const updatedModelOpt = session.configOptions.find(c => c.category === 'model')
          if (!updatedModelOpt) {
            appliedViaConfig = true
          } else if (updatedModelOpt.currentValue === resolvedId || updatedModelOpt.currentValue !== prevModelId) {
            effectiveModelId = updatedModelOpt.currentValue
            appliedViaConfig = true
          }
        } else {
          appliedViaConfig = true
        }
      } catch {
        // Fall through to legacy session/set_model below.
      }
      if (!appliedViaConfig) {
        await client.request('session/set_model', { sessionId: session.sessionId, modelId: resolvedId })
        effectiveModelId = resolvedId
      }
    } else {
      await client.request('session/set_model', { sessionId: session.sessionId, modelId: resolvedId })
    }
    session.modelId = effectiveModelId
    session.updatedAt = nowIso()
    this.emitMeta(session)
    await this.deps.store.upsertSession(toPersisted(session))
    this.bumpCatalog()
    return this.snapshotOf(session)
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<SessionSnapshot> {
    const session = await this.ensureSessionLoaded(sessionId)
    if (session.readOnlyLock) {
      const opt = session.configOptions.find(c => c.id === configId)
      const isModeConfig = opt?.category === 'mode' || (!opt && /mode/i.test(configId))
      if (isModeConfig && value !== 'plan') {
        throw new Error('Cannot change mode while a read-only claude_ask turn is in progress.')
      }
    }
    const client = await this.ensureConnected()
    const res = await client.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option', {
      sessionId: session.sessionId,
      configId,
      value,
    })
    if (Array.isArray(res?.configOptions)) {
      session.configOptions = res.configOptions
      const modeOpt = session.configOptions.find(c => c.category === 'mode')
      if (modeOpt) session.modeId = modeOpt.currentValue
      const modelOpt = session.configOptions.find(c => c.category === 'model')
      if (modelOpt) session.modelId = modelOpt.currentValue
    }
    session.updatedAt = nowIso()
    this.emitMeta(session)
    await this.deps.store.upsertSession(toPersisted(session))
    this.bumpCatalog()
    return this.snapshotOf(session)
  }

  async renameSession(sessionId: string, title: string): Promise<SessionSnapshot> {
    await this.ensureHydrated()
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    session.title = title.trim().slice(0, 160) || session.title
    session.updatedAt = nowIso()
    this.emitMeta(session)
    await this.deps.store.upsertSession(toPersisted(session))
    this.bumpCatalog()
    return this.snapshotOf(session)
  }

  async archiveSession(sessionId: string): Promise<SessionSnapshot> {
    await this.ensureHydrated()
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (session.status === 'running') {
      throw new Error('Cannot archive a session while a turn is in progress.')
    }
    if (!session.archivedAt) {
      session.archivedAt = nowIso()
      this.emitMeta(session)
      await this.deps.store.upsertSession(toPersisted(session))
      this.bumpCatalog()
    }
    return this.snapshotOf(session)
  }

  async unarchiveSession(sessionId: string): Promise<SessionSnapshot> {
    await this.ensureHydrated()
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (session.archivedAt) {
      session.archivedAt = undefined
      session.updatedAt = nowIso()
      this.emitMeta(session)
      await this.deps.store.upsertSession(toPersisted(session))
      this.bumpCatalog()
    }
    return this.snapshotOf(session)
  }

  private async archiveStaleSessions(): Promise<void> {
    if (this.autoArchiveIdleMs <= 0) return
    const cutoff = Date.now() - this.autoArchiveIdleMs
    for (const session of this.sessions.values()) {
      if (session.archivedAt || session.status === 'running' || session.pendingPermissions.size > 0) continue
      const updatedMs = Date.parse(session.updatedAt)
      if (Number.isFinite(updatedMs) && updatedMs <= cutoff) {
        session.archivedAt = nowIso()
        this.emitMeta(session)
        await this.deps.store
          .upsertSession(toPersisted(session))
          .catch(err => this.deps.log?.(`claude-agent: store persist failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureHydrated()
    const session = this.sessions.get(sessionId)
    if (session) {
      session.turnGen++
      session.activeTurn = undefined
      session.cancelling = false
      session.readOnlyLock = false
      session.activeTurnReplyToChat = false
      session.pendingChatReply = undefined
      if (session.status === 'running' && this.client?.isAlive && session.loadedInProcess) {
        this.client.notify('session/cancel', { sessionId })
      }
      for (const perm of session.pendingPermissions.values()) {
        perm.resolve({ outcome: 'cancelled' })
      }
      session.pendingPermissions.clear()
      this.flushWaitersNow(session)
      this.sessions.delete(sessionId)
      if (this.focusSessionId === sessionId) this.focusSessionId = undefined
    }
    await this.deps.store.deleteSession(sessionId)
    this.bumpCatalog()
  }

  async startPrompt(
    sessionId: string,
    promptText: string,
    files: readonly string[] = [],
    opts: { allowReadOnlyLock?: boolean; replyToChat?: boolean } = {},
  ): Promise<SessionSnapshot> {
    const trimmed = promptText.trim()
    if (!trimmed) throw new Error('Prompt cannot be empty.')
    const session = await this.ensureSessionLoaded(sessionId)
    if (session.status === 'running' || (session.readOnlyLock && !opts.allowReadOnlyLock)) {
      throw new Error('This session already has a turn in progress. Stop it first or wait for completion.')
    }

    const client = await this.ensureConnected()
    const promptBlocks: AcpContentBlock[] = []
    for (const file of files) {
      const abs = isAbsolute(file) ? resolve(file) : resolve(session.cwd, file)
      promptBlocks.push({
        type: 'resource_link',
        uri: pathToFileURL(abs).href,
        name: basename(abs) || abs,
      })
    }
    promptBlocks.push({ type: 'text', text: trimmed })

    if (session.items.length === 0 || session.title.startsWith('Session in ') || session.title.startsWith('Session ')) {
      session.title = deriveTitle(trimmed)
    }
    session.archivedAt = undefined
    session.status = 'running'
    session.cancelling = false
    session.activeTurnReplyToChat = Boolean(opts.replyToChat)
    session.pendingChatReply = undefined
    session.updatedAt = nowIso()
    session.activeAssistantId = undefined
    session.activeThoughtId = undefined

    const userItem: TimelineItem = {
      id: makeId('user'),
      kind: 'user',
      text: files.length > 0 ? `${files.map(f => `@${f}`).join(' ')}\n${trimmed}` : trimmed,
      timestamp: nowIso(),
    }
    session.items.push(userItem)
    session.activeTurnStartIndex = session.items.length
    this.pushEvent(session, { type: 'timeline_upsert', sessionId: session.sessionId, item: userItem }, true)
    this.emitMeta(session)
    this.bumpCatalog()

    const myTurnGen = ++session.turnGen
    const turnPromise = (async () => {
      try {
        const result = await client.request<AcpPromptResult>(
          'session/prompt',
          { sessionId: session.sessionId, prompt: promptBlocks },
          { timeoutMs: 0 },
        )
        if (session.turnGen !== myTurnGen || this.sessions.get(session.sessionId) !== session) return
        const wasCancelling = session.cancelling
        const shouldReplyToChat = session.activeTurnReplyToChat
        session.cancelling = false
        session.activeTurnReplyToChat = false
        this.finalizeStreamingItems(session)
        session.status = 'idle'
        session.updatedAt = nowIso()
        const stopReason = wasCancelling ? 'cancelled' : result?.stopReason ?? 'end_turn'
        if (shouldReplyToChat && stopReason !== 'cancelled') {
          this.queuePendingChatReply(session, 'completed')
        }
        await this.deps.store
          .upsertSession(toPersisted(session))
          .catch(err => this.deps.log?.(`claude-agent: store persist failed: ${err instanceof Error ? err.message : String(err)}`))
        if (session.turnGen !== myTurnGen || this.sessions.get(session.sessionId) !== session) return
        this.emitMeta(session)
        this.bumpCatalog()
        this.pushEvent(
          session,
          {
            type: 'turn_finished',
            sessionId: session.sessionId,
            stopReason,
          },
          true,
        )
      } catch (err) {
        if (session.turnGen !== myTurnGen || this.sessions.get(session.sessionId) !== session) return
        const wasCancelling = session.cancelling
        const shouldReplyToChat = session.activeTurnReplyToChat
        session.cancelling = false
        session.activeTurnReplyToChat = false
        this.finalizeStreamingItems(session)
        if (wasCancelling) {
          session.status = 'idle'
          session.updatedAt = nowIso()
          await this.deps.store
            .upsertSession(toPersisted(session))
            .catch(persistErr =>
              this.deps.log?.(`claude-agent: store persist failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`),
            )
          if (session.turnGen !== myTurnGen || this.sessions.get(session.sessionId) !== session) return
          this.emitMeta(session)
          this.pushEvent(
            session,
            {
              type: 'turn_finished',
              sessionId: session.sessionId,
              stopReason: 'cancelled',
            },
            true,
          )
          return
        }
        const msg = enrichAcpError(err, client).message
        if (isAuthError(err)) {
          this.authRequired = true
          this.diagStatus = 'auth_required'
          this.lastError = msg
        }
        session.status = 'error'
        session.updatedAt = nowIso()
        this.appendSystemItem(session, 'error', msg)
        if (shouldReplyToChat) {
          this.queuePendingChatReply(session, 'error', msg)
        }
        await this.deps.store
          .upsertSession(toPersisted(session))
          .catch(persistErr =>
            this.deps.log?.(`claude-agent: store persist failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`),
          )
        if (session.turnGen !== myTurnGen || this.sessions.get(session.sessionId) !== session) return
        this.emitMeta(session)
        this.pushEvent(
          session,
          {
            type: 'turn_finished',
            sessionId: session.sessionId,
            stopReason: 'error',
            error: msg,
          },
          true,
        )
      } finally {
        if (session.turnGen === myTurnGen) {
          session.activeTurn = undefined
          session.cancelling = false
          session.activeTurnReplyToChat = false
        }
      }
    })()

    session.activeTurn = turnPromise
    return this.snapshotOf(session)
  }

  async cancelTurn(sessionId: string): Promise<SessionSnapshot> {
    await this.ensureHydrated()
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)

    session.activeTurnReplyToChat = false
    const prevTurn = session.activeTurn
    if (prevTurn) {
      session.cancelling = true
    }
    if (this.client?.isAlive && session.loadedInProcess) {
      this.client.notify('session/cancel', { sessionId: session.sessionId })
    }
    const clearedPerms = this.clearSessionPendingPermissions(session, true)
    if (clearedPerms) {
      this.emitMeta(session)
    }

    if (prevTurn) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          prevTurn,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, this.cancelTimeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }

      if (session.activeTurn === prevTurn) {
        // Agent did not settle within the grace window; force-invalidate the old turn so the UI can recover.
        session.turnGen++
        session.activeTurn = undefined
        session.cancelling = false
        this.finalizeStreamingItems(session)
        if (session.status === 'running') {
          session.status = 'idle'
          session.updatedAt = nowIso()
          this.pushEvent(
            session,
            {
              type: 'turn_finished',
              sessionId: session.sessionId,
              stopReason: 'cancelled',
            },
            true,
          )
          this.emitMeta(session)
          await this.deps.store
            .upsertSession(toPersisted(session))
            .catch(err => this.deps.log?.(`claude-agent: store persist failed: ${err instanceof Error ? err.message : String(err)}`))
        }
      }
      return this.snapshotOf(session)
    }

    session.cancelling = false
    this.finalizeStreamingItems(session)
    if (session.status === 'running') {
      session.status = 'idle'
      session.updatedAt = nowIso()
      this.pushEvent(
        session,
        {
          type: 'turn_finished',
          sessionId: session.sessionId,
          stopReason: 'cancelled',
        },
        true,
      )
      this.emitMeta(session)
      await this.deps.store
        .upsertSession(toPersisted(session))
        .catch(err => this.deps.log?.(`claude-agent: store persist failed: ${err instanceof Error ? err.message : String(err)}`))
    }
    return this.snapshotOf(session)
  }

  async resolvePermission(
    sessionId: string,
    requestId: string,
    outcome: 'selected' | 'cancelled',
    optionId?: string,
  ): Promise<SessionSnapshot> {
    await this.ensureHydrated()
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    const pending = session.pendingPermissions.get(requestId)
    if (!pending) throw new Error(`Permission request not found or already resolved: ${requestId}`)

    let resultOutcome: AcpPermissionOutcome
    if (outcome === 'selected') {
      if (!optionId) throw new Error('optionId is required when outcome is "selected".')
      resultOutcome = { outcome: 'selected', optionId }
    } else {
      resultOutcome = { outcome: 'cancelled' }
    }

    session.pendingPermissions.delete(requestId)
    pending.resolve(resultOutcome)
    this.pushEvent(
      session,
      {
        type: 'permission_resolved',
        sessionId: session.sessionId,
        requestId,
        outcome: resultOutcome,
      },
      true,
    )
    this.emitMeta(session)
    this.bumpCatalog()
    return this.snapshotOf(session)
  }

  async pollEvents(
    sessionId: string | undefined,
    afterSeq = 0,
    waitMs = DEFAULT_POLL_WAIT_MS,
    clientId?: string,
    afterCatalogVersion?: number,
  ): Promise<{
    sessionId?: string
    events: PollEvent[]
    latestSeq: number
    resync: boolean
    snapshot?: SessionSnapshot
    catalogVersion: number
    sessions?: SessionSummary[]
    focusSessionId?: string
    pendingReplies?: PendingChatReplyRef[]
  }> {
    await this.ensureHydrated()
    const normalizedClientId = typeof clientId === 'string' && clientId.trim() ? clientId.trim() : undefined

    // Wake only waiters belonging to the same view/clientId so switching sessions in one view is instant
    // without ping-ponging a second open view (e.g., aux_pane + global) polling a different session.
    for (const [id, other] of this.sessions.entries()) {
      if (other.waiters.size === 0) continue
      if (id === sessionId && normalizedClientId === undefined) continue
      for (const waiter of [...other.waiters]) {
        if (waiter.clientId === normalizedClientId) {
          waiter.wake()
        }
      }
    }
    for (const waiter of [...this.catalogWaiters]) {
      if (waiter.clientId === normalizedClientId) {
        waiter.wake()
      }
    }

    const catalogUpdate = () => {
      const changed = afterCatalogVersion !== undefined && afterCatalogVersion < this.catalogVersion
      if (!changed) return {}
      const focusValid =
        this.focusSessionId !== undefined &&
        this.focusCatalogVersion > afterCatalogVersion &&
        this.sessions.has(this.focusSessionId)
      return {
        sessions: this.sortedSessions().map(s => this.summaryOf(s)),
        ...(focusValid ? { focusSessionId: this.focusSessionId } : {}),
      }
    }

    if (!sessionId) {
      const hasCatalogDiff = afterCatalogVersion !== undefined && afterCatalogVersion < this.catalogVersion
      if (hasCatalogDiff || waitMs <= 0) {
        const pendingReplies = this.listPendingReplies()
        return {
          events: [],
          latestSeq: 0,
          resync: false,
          catalogVersion: this.catalogVersion,
          ...catalogUpdate(),
          ...(pendingReplies.length > 0 ? { pendingReplies } : {}),
        }
      }

      const clampedWait = Math.min(MAX_POLL_WAIT_MS, Math.max(200, waitMs))
      await new Promise<void>(resolve => {
        const waiter: PollWaiter = {
          afterSeq: 0,
          ...(normalizedClientId !== undefined ? { clientId: normalizedClientId } : {}),
          wake: () => {
            if (waiter.timer) clearTimeout(waiter.timer)
            if (waiter.coalesceTimer) clearTimeout(waiter.coalesceTimer)
            this.catalogWaiters.delete(waiter)
            resolve()
          },
        }
        waiter.timer = setTimeout(waiter.wake, clampedWait)
        this.catalogWaiters.add(waiter)
      })

      const pendingReplies = this.listPendingReplies()
      return {
        events: [],
        latestSeq: 0,
        resync: false,
        catalogVersion: this.catalogVersion,
        ...catalogUpdate(),
        ...(pendingReplies.length > 0 ? { pendingReplies } : {}),
      }
    }

    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)

    const latestSeq = session.nextSeq - 1
    const oldestSeq = session.events[0]?.seq ?? session.nextSeq
    if (afterSeq > latestSeq || (afterSeq > 0 && afterSeq < oldestSeq - 1)) {
      const pendingReplies = this.listPendingReplies()
      return {
        sessionId,
        events: [],
        latestSeq,
        resync: true,
        snapshot: this.snapshotOf(session),
        catalogVersion: this.catalogVersion,
        ...catalogUpdate(),
        ...(pendingReplies.length > 0 ? { pendingReplies } : {}),
      }
    }

    const immediate = session.events.filter(ev => ev.seq > afterSeq)
    const hasCatalogDiff = afterCatalogVersion !== undefined && afterCatalogVersion < this.catalogVersion
    if (immediate.length > 0 || hasCatalogDiff || waitMs <= 0) {
      const pendingReplies = this.listPendingReplies()
      return {
        sessionId,
        events: immediate,
        latestSeq: session.nextSeq - 1,
        resync: false,
        catalogVersion: this.catalogVersion,
        ...catalogUpdate(),
        ...(pendingReplies.length > 0 ? { pendingReplies } : {}),
      }
    }

    const clampedWait = Math.min(MAX_POLL_WAIT_MS, Math.max(200, waitMs))
    await new Promise<void>(resolve => {
      const waiter: PollWaiter = {
        afterSeq,
        ...(normalizedClientId !== undefined ? { clientId: normalizedClientId } : {}),
        ...(afterCatalogVersion !== undefined ? { watchCatalog: true } : {}),
        wake: () => {
          if (waiter.timer) clearTimeout(waiter.timer)
          if (waiter.coalesceTimer) clearTimeout(waiter.coalesceTimer)
          session.waiters.delete(waiter)
          resolve()
        },
      }
      waiter.timer = setTimeout(waiter.wake, clampedWait)
      session.waiters.add(waiter)
    })

    const pendingReplies = this.listPendingReplies()
    return {
      sessionId,
      events: session.events.filter(ev => ev.seq > afterSeq),
      latestSeq: session.nextSeq - 1,
      resync: false,
      catalogVersion: this.catalogVersion,
      ...catalogUpdate(),
      ...(pendingReplies.length > 0 ? { pendingReplies } : {}),
    }
  }

  async getBootstrap(opts: {
    cwd?: string
    sessionId?: string
    workspaceRoots?: readonly string[]
  }): Promise<BootstrapPayload> {
    await this.ensureHydrated()
    await this.archiveStaleSessions()
    const data = await this.deps.store.load()
    const roots = [...new Set((opts.workspaceRoots ?? []).filter(Boolean))]
    let active: InternalSession | undefined
    if (opts.sessionId && this.sessions.has(opts.sessionId)) {
      active = this.sessions.get(opts.sessionId)
    } else {
      active = this.sortedSessions().find(s => !s.archivedAt)
    }

    let activeSnapshot: SessionSnapshot | undefined
    let truncatedItems = false
    if (active) {
      activeSnapshot = this.snapshotOf(active)
      if (activeSnapshot.items.length > MAX_BOOTSTRAP_ITEMS) {
        activeSnapshot = {
          ...activeSnapshot,
          items: activeSnapshot.items.slice(-MAX_BOOTSTRAP_ITEMS),
        }
        truncatedItems = true
      }
    }

    const pendingReplies = this.listPendingReplies()
    return {
      diagnostics: this.getDiagnostics(),
      preferences: data.preferences,
      workspaceRoots: roots,
      recentCwds: data.recentCwds,
      sessions: this.sortedSessions().map(s => this.summaryOf(s)),
      catalogVersion: this.catalogVersion,
      ...(activeSnapshot ? { activeSession: activeSnapshot } : {}),
      ...(truncatedItems ? { truncatedItems: true } : {}),
      ...(pendingReplies.length > 0 ? { pendingReplies } : {}),
    }
  }

  // --- Model-facing tool implementations ---

  async handleOpenTool(input: ToolInputs['claude_open'], workspaceRoots: readonly string[]): Promise<Reply> {
    if (input.mode !== undefined && !ALLOWED_OPEN_MODES.has(input.mode)) {
      return {
        text: `Invalid mode for claude_open: ${String(input.mode)}. Allowed: default, auto, acceptEdits, plan.`,
        isError: true,
      }
    }
    await this.ensureHydrated()
    let targetSessionId = input.sessionId
    const promptText = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    let createdFresh = false
    if (promptText) {
      let session: InternalSession
      if (targetSessionId && this.sessions.has(targetSessionId)) {
        session = await this.ensureSessionLoaded(targetSessionId)
        if (session.status === 'running' || session.readOnlyLock) {
          return {
            text: `Session ${session.sessionId} already has a turn in progress. Stop it first or wait for completion.`,
            isError: true,
          }
        }
      } else {
        try {
          const created = await this.createSession({
            cwd: input.cwd ?? workspaceRoots[0],
            modeId: input.mode,
            modelId: input.model,
            strictMode: Boolean(input.mode),
            focus: true,
          })
          session = this.sessions.get(created.sessionId)!
          createdFresh = true
        } catch (err) {
          if (input.mode) {
            return {
              text: `claude_open aborted: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
              isError: true,
            }
          }
          throw err
        }
      }
      if (input.mode && !isModeSupported(session, input.mode)) {
        if (createdFresh) {
          await this.deleteSession(session.sessionId).catch(() => undefined)
        }
        return {
          text: `claude_open aborted: could not switch session into requested mode "${input.mode}": mode is not supported by this ACP agent.`,
          isError: true,
        }
      }
      if (input.model) {
        const match = matchModelId(session, input.model)
        if (match.resolvedId !== session.modelId) {
          await this.setSessionModel(session.sessionId, match.resolvedId).catch(() => undefined)
        }
      }
      if (input.mode && input.mode !== session.modeId) {
        try {
          await this.setSessionMode(session.sessionId, input.mode)
        } catch (err) {
          if (createdFresh) {
            await this.deleteSession(session.sessionId).catch(() => undefined)
          }
          return {
            text: `claude_open aborted: could not switch session into requested mode "${input.mode}": ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
            isError: true,
          }
        }
        if (session.modeId !== input.mode) {
          if (createdFresh) {
            await this.deleteSession(session.sessionId).catch(() => undefined)
          }
          return {
            text: `claude_open aborted: could not switch session into requested mode "${input.mode}".`,
            isError: true,
          }
        }
      }
      const replyToChat = input.replyToChat ?? true
      await this.startPrompt(session.sessionId, promptText, [], { replyToChat })
      targetSessionId = session.sessionId
    } else if (input.cwd && !targetSessionId) {
      const resolved = await resolveDirectory(input.cwd, workspaceRoots[0] ?? this.deps.defaultCwd)
      if (resolved.cwd) {
        await this.deps.store.recordCwd(resolved.cwd)
      }
    }

    if (!createdFresh && targetSessionId && this.sessions.has(targetSessionId)) {
      this.bumpCatalog(targetSessionId)
    }

    const bootstrap = await this.getBootstrap({
      cwd: input.cwd,
      sessionId: targetSessionId,
      workspaceRoots,
    })

    const replyEnabled = Boolean(promptText) && (input.replyToChat ?? true)
    const active = bootstrap.activeSession
    const modeLabel = active?.modeId ? `, mode: ${active.modeId}` : ''
    const modelLabel = active?.modelId ? `, model: ${active.modelId}` : ''
    const text = promptText
      ? replyEnabled
        ? `Started asynchronous Claude Agent turn in session ${targetSessionId}${modeLabel}${modelLabel} (auto-reply enabled). End your turn now and wait — when Claude finishes, the open Claude Agent side pane will automatically deliver the response back into this conversation. If the side pane is closed or you need to check progress manually, call claude_session (action: "wait" or "get", sessionId: "${targetSessionId}").`
        : `Started interactive Claude Agent turn in session ${targetSessionId}${modeLabel}${modelLabel}. The Claude Agent panel is open for streaming output and permission approvals. Use claude_session (action: "wait" or "get") to check status or collect results.`
      : `Claude Agent panel ready (${bootstrap.sessions.filter(s => !s.archivedAt).length} active session(s)).`

    return {
      text,
      structuredContent: bootstrap as unknown as Record<string, unknown>,
    }
  }

  async handleAskTool(
    input: ToolInputs['claude_ask'],
    workspaceRoots: readonly string[],
    progress: (message: string) => void,
  ): Promise<Reply> {
    const promptText = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!promptText) return { text: 'prompt must be a non-empty string.', isError: true }

    await this.ensureHydrated()
    const reusedExisting = Boolean(input.sessionId && this.sessions.has(input.sessionId))
    let session: InternalSession
    if (reusedExisting && input.sessionId) {
      session = await this.ensureSessionLoaded(input.sessionId)
    } else {
      try {
        const created = await this.createSession({
          cwd: input.cwd ?? workspaceRoots[0],
          modeId: 'plan',
          modelId: input.model,
          strictMode: true,
        })
        session = this.sessions.get(created.sessionId)!
      } catch (err) {
        return {
          text: `claude_ask aborted: could not switch session into read-only "plan" mode (${redactSecrets(err instanceof Error ? err.message : String(err))}).`,
          isError: true,
        }
      }
    }

    if (session.status === 'running' || session.readOnlyLock) {
      return {
        text: `Session ${session.sessionId} already has an active turn. Use a different sessionId or omit it to start a fresh read-only session.`,
        isError: true,
      }
    }

    const prevMode = session.modeId
    session.readOnlyLock = true
    const rawTimeout = typeof input.timeoutSeconds === 'number' && Number.isFinite(input.timeoutSeconds)
      ? input.timeoutSeconds
      : DEFAULT_ASK_TIMEOUT_SECONDS
    const timeoutMs = Math.min(
      MAX_ASK_TIMEOUT_SECONDS * 1_000,
      Math.max(this.minAskTimeoutMs, Math.round(rawTimeout * 1_000)),
    )
    const timeoutSecondsLabel = Math.max(1, Math.round(timeoutMs / 1_000))

    let heartbeat: ReturnType<typeof setInterval> | undefined
    let cancelPromise: Promise<unknown> | undefined

    try {
      if (session.modeId !== 'plan') {
        try {
          await this.setSessionMode(session.sessionId, 'plan')
        } catch {
          // Checked below (fail closed).
        }
      }
      if (session.modeId !== 'plan') {
        if (!reusedExisting) {
          await this.deleteSession(session.sessionId).catch(() => undefined)
        }
        return {
          text: 'claude_ask aborted: could not switch session into read-only "plan" mode.',
          isError: true,
        }
      }
      if (input.model) {
        const match = matchModelId(session, input.model)
        if (match.resolvedId !== session.modelId) {
          await this.setSessionModel(session.sessionId, match.resolvedId).catch(() => undefined)
        }
      }

      heartbeat = setInterval(() => progress('Waiting on Claude Agent (read-only)…'), 10_000)

      const startIndex = session.items.length
      await this.startPrompt(session.sessionId, promptText, [], { allowReadOnlyLock: true })
      const turn = session.activeTurn
      if (turn) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            turn,
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                cancelPromise = this.cancelTurn(session.sessionId).catch(err => {
                  this.deps.log?.(
                    `claude-agent: timeout cancel failed: ${err instanceof Error ? err.message : String(err)}`,
                  )
                })
                reject(new Error(`claude_ask timed out after ${timeoutSecondsLabel}s`))
              }, timeoutMs)
            }),
          ])
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle)
        }
      }

      const newItems = session.items.slice(startIndex)
      const assistantText = newItems
        .filter(i => i.kind === 'assistant' && i.text)
        .map(i => i.text!)
        .join('\n\n')
        .trim()
      const errorText = newItems
        .filter(i => i.kind === 'error' && i.text)
        .map(i => i.text!)
        .join('\n')
        .trim()

      if (errorText && !assistantText) {
        return {
          text: `Claude Agent failed: ${errorText}`,
          structuredContent: {
            sessionId: session.sessionId,
            cwd: session.cwd,
            status: session.status,
          },
          isError: true,
        }
      }

      const touched = [...session.touchedFiles]
      return {
        text: assistantText || '(Claude Agent completed with no text output.)',
        structuredContent: {
          sessionId: session.sessionId,
          cwd: session.cwd,
          modeId: session.modeId,
          modelId: session.modelId,
          touchedFiles: touched,
          ...(session.usage ? { usage: session.usage } : {}),
        },
      }
    } catch (err) {
      return {
        text: redactSecrets(err instanceof Error ? err.message : String(err)),
        structuredContent: { sessionId: session.sessionId, cwd: session.cwd },
        isError: true,
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      if (cancelPromise) {
        await cancelPromise
      }
      session.readOnlyLock = false
      const current = this.sessions.get(session.sessionId)
      if (current && prevMode && prevMode !== current.modeId) {
        await this.setSessionMode(current.sessionId, prevMode).catch(() => undefined)
      }
      if (current && !reusedExisting && current.status !== 'running' && !current.archivedAt) {
        current.archivedAt = nowIso()
        this.emitMeta(current)
        await this.deps.store
          .upsertSession(toPersisted(current))
          .catch(err => this.deps.log?.(`claude-agent: store persist failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
  }

  async handleSessionTool(input: ToolInputs['claude_session'], progress?: (message: string) => void): Promise<Reply> {
    await this.ensureHydrated()
    await this.archiveStaleSessions()
    switch (input.action) {
      case 'list': {
        const allMatching = this.sortedSessions()
          .filter(s => !input.cwd || s.cwd === input.cwd)
          .map(s => this.summaryOf(s))
        const archivedCount = allMatching.filter(s => Boolean(s.archivedAt)).length
        const list = input.includeArchived ? allMatching : allMatching.filter(s => !s.archivedAt)
        const shown = list.slice(0, 25)
        const lines = shown.map(
          s =>
            `- ${s.sessionId} [${s.status}${s.archivedAt ? ', archived' : ''}] "${s.title}" (${s.cwd})${s.pendingPermissionCount > 0 ? ` — ${s.pendingPermissionCount} pending permission(s)` : ''}`,
        )
        if (list.length > shown.length) {
          lines.push(`... and ${list.length - shown.length} more session(s). Pass cwd to filter.`)
        }
        if (!input.includeArchived && archivedCount > 0) {
          lines.push(`(${archivedCount} archived session(s) hidden. Pass includeArchived: true to include them.)`)
        }
        return {
          text:
            lines.length > 0
              ? lines.join('\n')
              : 'No Claude Agent sessions yet.',
          structuredContent: { sessions: list.slice(0, 50), total: list.length, archivedCount },
        }
      }
      case 'get': {
        if (!input.sessionId) return { text: 'sessionId is required for action "get".', isError: true }
        const session = this.sessions.get(input.sessionId)
        if (!session) return { text: `Unknown session: ${input.sessionId}`, isError: true }
        if (session.status !== 'running' && session.pendingChatReply) {
          session.pendingChatReply = undefined
          this.emitMeta(session)
        }
        return this.formatSessionInspection(session, false)
      }
      case 'wait': {
        if (!input.sessionId) return { text: 'sessionId is required for action "wait".', isError: true }
        const session = this.sessions.get(input.sessionId)
        if (!session) return { text: `Unknown session: ${input.sessionId}`, isError: true }
        const rawTimeout =
          typeof input.timeoutSeconds === 'number' && Number.isFinite(input.timeoutSeconds)
            ? input.timeoutSeconds
            : DEFAULT_WAIT_TIMEOUT_SECONDS
        const timeoutMs = Math.min(
          MAX_WAIT_TIMEOUT_SECONDS * 1_000,
          Math.max(this.minWaitTimeoutMs, Math.round(rawTimeout * 1_000)),
        )
        const turn = session.activeTurn
        let timedOut = false
        if (turn && session.status === 'running') {
          let timer: ReturnType<typeof setTimeout> | undefined
          let heartbeat: ReturnType<typeof setInterval> | undefined
          try {
            if (progress) {
              heartbeat = setInterval(() => progress(`Waiting on Claude Agent session ${session.sessionId}…`), 10_000)
            }
            await Promise.race([
              turn,
              new Promise<void>(resolve => {
                timer = setTimeout(() => {
                  timedOut = true
                  resolve()
                }, timeoutMs)
              }),
            ])
          } finally {
            if (timer) clearTimeout(timer)
            if (heartbeat) clearInterval(heartbeat)
          }
        }
        const current = this.sessions.get(input.sessionId)
        if (!current) return { text: `Session ${input.sessionId} was deleted while waiting.`, isError: true }
        if (current.status !== 'running' && current.pendingChatReply) {
          current.pendingChatReply = undefined
          this.emitMeta(current)
        }
        return this.formatSessionInspection(current, timedOut && current.status === 'running')
      }
      case 'cancel': {
        if (!input.sessionId) return { text: 'sessionId is required for action "cancel".', isError: true }
        const snap = await this.cancelTurn(input.sessionId)
        return {
          text: `Cancelled active turn for session ${snap.sessionId}.`,
          structuredContent: snap as unknown as Record<string, unknown>,
        }
      }
      default:
        return {
          text: `Invalid action for claude_session: ${String((input as { action?: unknown }).action)}. Allowed: list, get, wait, cancel.`,
          isError: true,
        }
    }
  }

  // --- App-only tool handlers ---

  async handleUiBootstrap(input: ToolInputs['claude_ui_bootstrap'], workspaceRoots: readonly string[]): Promise<Reply> {
    const payload = await this.getBootstrap({
      cwd: input.cwd,
      sessionId: input.sessionId,
      workspaceRoots,
    })
    return {
      text: 'ok',
      structuredContent: payload as unknown as Record<string, unknown>,
    }
  }

  async handleUiSession(input: ToolInputs['claude_ui_session'], workspaceRoots: readonly string[]): Promise<Reply> {
    await this.ensureHydrated()
    switch (input.action) {
      case 'connect': {
        try {
          await this.ensureConnected()
          await this.syncAcpSessionList()
        } catch (err) {
          this.lastError = redactSecrets(err instanceof Error ? err.message : String(err))
          this.diagStatus = this.authRequired ? 'auth_required' : 'error'
        }
        const bootstrap = await this.getBootstrap({ sessionId: input.sessionId, workspaceRoots })
        return { text: 'ok', structuredContent: bootstrap as unknown as Record<string, unknown> }
      }
      case 'reconnect': {
        await this.reconnect()
        const bootstrap = await this.getBootstrap({ sessionId: input.sessionId, workspaceRoots })
        return { text: 'ok', structuredContent: bootstrap as unknown as Record<string, unknown> }
      }
      case 'authenticate': {
        if (!input.methodId) return { text: 'methodId is required.', isError: true }
        const diagnostics = await this.authenticate(input.methodId)
        return { text: 'Authenticated', structuredContent: { diagnostics } }
      }
      case 'create': {
        const session = await this.createSession({
          cwd: input.cwd ?? workspaceRoots[0],
          modeId: input.modeId,
          modelId: input.modelId,
        })
        const data = await this.deps.store.load()
        return {
          text: 'created',
          structuredContent: {
            session,
            recentCwds: data.recentCwds,
            diagnostics: this.getDiagnostics(),
          },
        }
      }
      case 'get': {
        if (!input.sessionId) return { text: 'sessionId is required.', isError: true }
        const existing = this.sessions.get(input.sessionId)
        if (!existing) return { text: `Unknown session: ${input.sessionId}`, isError: true }
        return { text: 'ok', structuredContent: { session: this.snapshotOf(existing) } }
      }
      case 'load': {
        if (!input.sessionId) return { text: 'sessionId is required.', isError: true }
        const requestedId = input.sessionId
        const loaded = await this.ensureSessionLoaded(requestedId)
        const replaced = loaded.sessionId !== requestedId
        return {
          text: 'loaded',
          structuredContent: {
            session: this.snapshotOf(loaded),
            diagnostics: this.getDiagnostics(),
            ...(replaced
              ? {
                  replacedSessionId: requestedId,
                  sessions: this.sortedSessions().map(s => this.summaryOf(s)),
                }
              : {}),
          },
        }
      }
      case 'delete': {
        if (!input.sessionId) return { text: 'sessionId is required.', isError: true }
        await this.deleteSession(input.sessionId)
        return {
          text: 'deleted',
          structuredContent: {
            sessions: this.sortedSessions().map(s => this.summaryOf(s)),
          },
        }
      }
      case 'rename': {
        if (!input.sessionId || typeof input.title !== 'string' || !input.title.trim()) {
          return { text: 'sessionId and title are required.', isError: true }
        }
        const session = await this.renameSession(input.sessionId, input.title)
        return { text: 'renamed', structuredContent: { session } }
      }
      case 'archive': {
        if (!input.sessionId) return { text: 'sessionId is required.', isError: true }
        const session = await this.archiveSession(input.sessionId)
        return {
          text: 'archived',
          structuredContent: {
            session,
            sessions: this.sortedSessions().map(s => this.summaryOf(s)),
          },
        }
      }
      case 'unarchive': {
        if (!input.sessionId) return { text: 'sessionId is required.', isError: true }
        const session = await this.unarchiveSession(input.sessionId)
        return {
          text: 'unarchived',
          structuredContent: {
            session,
            sessions: this.sortedSessions().map(s => this.summaryOf(s)),
          },
        }
      }
      case 'set_mode': {
        if (!input.sessionId || !input.modeId) return { text: 'sessionId and modeId are required.', isError: true }
        const session = await this.setSessionMode(input.sessionId, input.modeId)
        return { text: 'ok', structuredContent: { session } }
      }
      case 'set_model': {
        if (!input.sessionId || !input.modelId) return { text: 'sessionId and modelId are required.', isError: true }
        const session = await this.setSessionModel(input.sessionId, input.modelId)
        return { text: 'ok', structuredContent: { session } }
      }
      case 'set_config': {
        if (!input.sessionId || !input.configId || input.value === undefined) {
          return { text: 'sessionId, configId, and value are required.', isError: true }
        }
        const session = await this.setSessionConfigOption(input.sessionId, input.configId, input.value)
        return { text: 'ok', structuredContent: { session } }
      }
      case 'claim_reply': {
        if (!input.sessionId || !input.replyId) {
          return { text: 'sessionId and replyId are required.', isError: true }
        }
        const claim = this.claimChatReply(input.sessionId, input.replyId, input.clientId)
        return { text: claim.claimed ? 'claimed' : 'unavailable', structuredContent: claim }
      }
      case 'ack_reply': {
        if (!input.sessionId || !input.replyId) {
          return { text: 'sessionId and replyId are required.', isError: true }
        }
        const acked = this.ackChatReply(input.sessionId, input.replyId, input.clientId)
        return { text: acked ? 'acked' : 'noop', structuredContent: { acked } }
      }
      case 'release_reply': {
        if (!input.sessionId || !input.replyId) {
          return { text: 'sessionId and replyId are required.', isError: true }
        }
        const released = this.releaseChatReply(input.sessionId, input.replyId, input.clientId)
        return { text: released ? 'released' : 'noop', structuredContent: { released } }
      }
      default:
        return {
          text: `Invalid action for claude_ui_session: ${String((input as { action?: unknown }).action)}.`,
          isError: true,
        }
    }
  }

  async handleUiPrompt(input: ToolInputs['claude_ui_prompt']): Promise<Reply> {
    if (!input.sessionId) return { text: 'sessionId is required.', isError: true }
    if (input.action === 'cancel') {
      const session = await this.cancelTurn(input.sessionId)
      return { text: 'cancelled', structuredContent: { session } }
    }
    if (input.action === 'send') {
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        return { text: 'prompt is required for action "send".', isError: true }
      }
      const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string') : []
      const session = await this.startPrompt(input.sessionId, input.prompt, files)
      return { text: 'started', structuredContent: { session } }
    }
    return {
      text: `Invalid action for claude_ui_prompt: ${String((input as { action?: unknown }).action)}. Allowed: send, cancel.`,
      isError: true,
    }
  }

  async handleUiPermission(input: ToolInputs['claude_ui_permission']): Promise<Reply> {
    if (!input.sessionId || !input.requestId) {
      return { text: 'sessionId and requestId are required.', isError: true }
    }
    if (input.outcome !== 'selected' && input.outcome !== 'cancelled') {
      return {
        text: `Invalid outcome for claude_ui_permission: ${String((input as { outcome?: unknown }).outcome)}. Allowed: selected, cancelled.`,
        isError: true,
      }
    }
    const session = await this.resolvePermission(input.sessionId, input.requestId, input.outcome, input.optionId)
    return { text: 'resolved', structuredContent: { session } }
  }

  async handleUiPoll(input: ToolInputs['claude_ui_poll']): Promise<Reply> {
    const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : undefined
    const afterSeq = typeof input.afterSeq === 'number' && Number.isFinite(input.afterSeq) ? input.afterSeq : 0
    const afterCatalogVersion =
      typeof input.afterCatalogVersion === 'number' && Number.isFinite(input.afterCatalogVersion)
        ? input.afterCatalogVersion
        : undefined
    const data = await this.pollEvents(sessionId, afterSeq, input.waitMs, input.clientId, afterCatalogVersion)
    return { text: 'ok', structuredContent: data as unknown as Record<string, unknown> }
  }

  async handleUiFs(input: ToolInputs['claude_ui_fs'], workspaceRoots: readonly string[]): Promise<Reply> {
    switch (input.action) {
      case 'list_dirs': {
        const dirs = await listDirectories(input.query ?? '', {
          baseCwd: input.cwd ?? workspaceRoots[0] ?? this.deps.defaultCwd,
        })
        return { text: 'ok', structuredContent: { dirs } }
      }
      case 'search_files': {
        const cwdRes = await resolveDirectory(input.cwd, workspaceRoots[0] ?? this.deps.defaultCwd)
        if (cwdRes.error !== undefined) return { text: cwdRes.error, isError: true }
        const files = await searchWorkspaceFiles(cwdRes.cwd, input.query ?? '')
        return { text: 'ok', structuredContent: { files } }
      }
      case 'save_prefs': {
        if (input.defaultModeId === 'bypassPermissions') {
          return { text: 'Cannot persist bypassPermissions as the default mode.', isError: true }
        }
        const data = await this.deps.store.savePreferences({
          ...(input.sidebarWidthPct !== undefined ? { sidebarWidthPct: input.sidebarWidthPct } : {}),
          ...(input.lastCwd !== undefined ? { lastCwd: input.lastCwd } : {}),
          ...(input.defaultModeId !== undefined ? { defaultModeId: input.defaultModeId } : {}),
          ...(input.defaultModelId !== undefined ? { defaultModelId: input.defaultModelId } : {}),
        })
        return { text: 'saved', structuredContent: { preferences: data.preferences } }
      }
      default:
        return {
          text: `Invalid action for claude_ui_fs: ${String((input as { action?: unknown }).action)}. Allowed: list_dirs, search_files, save_prefs.`,
          isError: true,
        }
    }
  }

  // --- Inbound ACP handlers ---

  private async handleAgentRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== 'session/request_permission') {
      throw new AcpRpcError(-32601, `Unsupported client method: ${method}`)
    }
    const req = params as unknown as AcpRequestPermissionParams
    const session = this.sessions.get(req.sessionId)
    if (!session) {
      return { outcome: { outcome: 'cancelled' } }
    }
    if (session.readOnlyLock) {
      const options = Array.isArray(req.options) ? req.options : []
      const rejectOpt =
        options.find(o => o?.kind === 'reject_once') ??
        options.find(o => o?.kind === 'reject_always') ??
        options.find(o => typeof o?.kind === 'string' && o.kind.startsWith('reject_'))
      if (rejectOpt && typeof rejectOpt.optionId === 'string') {
        return { outcome: { outcome: 'selected', optionId: rejectOpt.optionId } }
      }
      return { outcome: { outcome: 'cancelled' } }
    }

    const requestId = `perm-${++this.reqCounter}`
    const { locs, diffs } = extractToolDetails(req.toolCall?.content, req.toolCall?.locations, session.cwd)
    for (const l of locs) session.touchedFiles.add(l.path)

    const outcome = await new Promise<AcpPermissionOutcome>(resolve => {
      const perm: InternalPermission = {
        requestId,
        sessionId: session.sessionId,
        toolCallId: req.toolCall?.toolCallId ?? requestId,
        title: req.toolCall?.title?.trim() || 'Permission requested',
        ...(req.toolCall?.kind ? { kind: req.toolCall.kind } : {}),
        ...(req.toolCall?.rawInput !== undefined ? { rawInput: stringifyCompact(req.toolCall.rawInput, 3_000) } : {}),
        ...(locs.length ? { locations: locs } : {}),
        ...(diffs.length ? { diffs } : {}),
        options: Array.isArray(req.options) ? req.options : [],
        createdAt: nowIso(),
        resolve,
      }
      session.pendingPermissions.set(requestId, perm)
      const { resolve: _r, ...publicPerm } = perm
      this.pushEvent(session, { type: 'permission_request', sessionId: session.sessionId, permission: publicPerm }, true)
      this.emitMeta(session)
      this.bumpCatalog()
    })

    return { outcome }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    const update = params.update as AcpSessionUpdate | undefined
    if (!sessionId || !update || typeof update !== 'object') return
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.updatedAt = nowIso()
    if (session.replayingLoad) session.sawReplayUpdate = true

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const chunk = extractTextFromBlock(update.content)
        if (!chunk) return
        const isStreaming = !session.replayingLoad && session.status === 'running'
        this.finalizeActiveThought(session)
        let item = session.activeAssistantId
          ? session.items.find(i => i.id === session.activeAssistantId)
          : undefined
        if (!item) {
          item = {
            id: makeId('asst'),
            kind: 'assistant',
            text: chunk,
            streaming: isStreaming,
            timestamp: nowIso(),
          }
          session.items.push(item)
          session.activeAssistantId = item.id
        } else {
          item.text = `${item.text ?? ''}${chunk}`
          item.streaming = isStreaming
        }
        this.pushEvent(session, { type: 'timeline_upsert', sessionId, item: { ...item } }, false)
        return
      }
      case 'agent_thought_chunk': {
        const chunk = extractTextFromBlock(update.content)
        if (!chunk) return
        const isStreaming = !session.replayingLoad && session.status === 'running'
        let item = session.activeThoughtId
          ? session.items.find(i => i.id === session.activeThoughtId)
          : undefined
        if (!item) {
          item = {
            id: makeId('thought'),
            kind: 'thought',
            text: chunk,
            streaming: isStreaming,
            timestamp: nowIso(),
          }
          session.items.push(item)
          session.activeThoughtId = item.id
        } else {
          item.text = `${item.text ?? ''}${chunk}`
          item.streaming = isStreaming
        }
        this.pushEvent(session, { type: 'timeline_upsert', sessionId, item: { ...item } }, false)
        return
      }
      case 'user_message_chunk': {
        const chunk = extractTextFromBlock(update.content)
        if (!chunk) return
        const isStreaming = !session.replayingLoad && session.status === 'running'
        session.activeAssistantId = undefined
        this.finalizeActiveThought(session)
        const last = session.items[session.items.length - 1]
        if (last && last.kind === 'user' && (last.streaming || session.replayingLoad)) {
          last.text = `${last.text ?? ''}${chunk}`
          this.pushEvent(session, { type: 'timeline_upsert', sessionId, item: { ...last } }, false)
        } else {
          const item: TimelineItem = {
            id: makeId('user'),
            kind: 'user',
            text: chunk,
            streaming: isStreaming,
            timestamp: nowIso(),
          }
          session.items.push(item)
          this.pushEvent(session, { type: 'timeline_upsert', sessionId, item: { ...item } }, false)
        }
        return
      }
      case 'tool_call': {
        session.activeAssistantId = undefined
        this.finalizeActiveThought(session)
        const { locs, diffs, outputTexts } = extractToolDetails(update.content, update.locations, session.cwd)
        for (const l of locs) session.touchedFiles.add(l.path)

        const rawInput = stringifyCompact(update.rawInput)
        const rawOutput = outputTexts.length > 0 ? outputTexts.join('\n') : stringifyCompact(update.rawOutput)
        const item: TimelineItem = {
          id: `tc-${update.toolCallId}`,
          kind: 'tool_call',
          toolCallId: update.toolCallId,
          title: update.title || 'Tool call',
          ...(update.kind ? { toolKind: update.kind } : {}),
          status: update.status ?? 'pending',
          ...(locs.length ? { locations: locs } : {}),
          ...(diffs.length ? { diffs } : {}),
          ...(rawInput ? { rawInput } : {}),
          ...(rawOutput ? { rawOutput } : {}),
          timestamp: nowIso(),
        }
        const existingIdx = session.items.findIndex(i => i.id === item.id)
        if (existingIdx >= 0) {
          session.items[existingIdx] = item
        } else {
          session.items.push(item)
        }
        this.pushEvent(session, { type: 'timeline_upsert', sessionId, item: { ...item } }, true)
        if (locs.length > 0) this.emitMeta(session)
        return
      }
      case 'tool_call_update': {
        const id = `tc-${update.toolCallId}`
        let found = session.items.find(i => i.id === id)
        if (!found) {
          found = {
            id,
            kind: 'tool_call',
            toolCallId: update.toolCallId,
            title: update.title || 'Tool call',
            status: update.status ?? 'in_progress',
            timestamp: nowIso(),
          }
          session.items.push(found)
        }
        const item = found
        if (update.title) item.title = update.title
        if (update.kind) item.toolKind = update.kind
        if (update.status) item.status = update.status
        const { locs, diffs, outputTexts } = extractToolDetails(update.content, update.locations, session.cwd)
        if (locs.length > 0) {
          const merged = new Map((item.locations ?? []).map(l => [l.path, l]))
          for (const l of locs) {
            merged.set(l.path, l)
            session.touchedFiles.add(l.path)
          }
          item.locations = [...merged.values()]
        }
        if (diffs.length > 0) {
          item.diffs = [...(item.diffs ?? []), ...diffs]
        }
        const rawInput = stringifyCompact(update.rawInput)
        if (rawInput) item.rawInput = rawInput
        const rawOutput = outputTexts.length > 0 ? outputTexts.join('\n') : stringifyCompact(update.rawOutput)
        if (rawOutput) item.rawOutput = rawOutput

        this.pushEvent(session, { type: 'timeline_upsert', sessionId, item: { ...item } }, true)
        if (locs.length > 0) this.emitMeta(session)
        return
      }
      case 'plan': {
        session.plan = Array.isArray(update.entries) ? update.entries : []
        this.pushEvent(session, { type: 'plan_update', sessionId, plan: session.plan }, true)
        return
      }
      case 'available_commands_update': {
        session.availableCommands = Array.isArray(update.availableCommands) ? update.availableCommands : []
        this.pushEvent(session, { type: 'commands_update', sessionId, commands: session.availableCommands }, true)
        return
      }
      case 'current_mode_update': {
        if (typeof update.currentModeId === 'string') {
          session.modeId = update.currentModeId
          this.emitMeta(session)
        }
        return
      }
      case 'config_option_update': {
        if (Array.isArray(update.configOptions)) {
          session.configOptions = update.configOptions
          const modeOpt = session.configOptions.find(c => c.category === 'mode')
          if (modeOpt) session.modeId = modeOpt.currentValue
          const modelOpt = session.configOptions.find(c => c.category === 'model')
          if (modelOpt) session.modelId = modelOpt.currentValue
          this.emitMeta(session)
        }
        return
      }
      case 'usage_update': {
        const used = typeof update.used === 'number' ? update.used : session.usage?.used ?? 0
        const size = typeof update.size === 'number' ? update.size : session.usage?.size ?? 0
        const costInfo = normalizeUsageCost(update.cost, update.currency)
        session.usage = {
          used,
          size,
          ...(costInfo.amount !== undefined ? { costAmount: costInfo.amount } : {}),
          ...(costInfo.currency ? { costCurrency: costInfo.currency } : {}),
        }
        this.emitMeta(session)
        return
      }
      case 'session_info_update': {
        if (typeof update.title === 'string' && update.title.trim()) {
          session.title = update.title.trim().slice(0, 160)
        }
        if (typeof update.updatedAt === 'string') {
          session.updatedAt = update.updatedAt
        }
        this.emitMeta(session)
        return
      }
    }
  }

  private finalizeActiveThought(session: InternalSession): void {
    const thoughtId = session.activeThoughtId
    session.activeThoughtId = undefined
    if (!thoughtId) return
    const item = session.items.find(i => i.id === thoughtId)
    if (item && item.streaming) {
      item.streaming = false
      this.pushEvent(session, { type: 'timeline_upsert', sessionId: session.sessionId, item: { ...item } }, false)
    }
  }

  private finalizeStreamingItems(session: InternalSession): void {
    session.activeAssistantId = undefined
    session.activeThoughtId = undefined
    for (const item of session.items) {
      if (item.streaming) {
        item.streaming = false
        this.pushEvent(session, { type: 'timeline_upsert', sessionId: session.sessionId, item: { ...item } }, false)
      }
    }
  }

  private appendSystemItem(session: InternalSession, kind: 'status' | 'error', text: string): void {
    const item: TimelineItem = {
      id: makeId(kind),
      kind,
      text,
      timestamp: nowIso(),
    }
    session.items.push(item)
    this.pushEvent(session, { type: 'timeline_upsert', sessionId: session.sessionId, item }, true)
  }

  private emitMeta(session: InternalSession): void {
    this.pushEvent(
      session,
      {
        type: 'session_meta',
        sessionId: session.sessionId,
        summary: this.summaryOf(session),
        availableModes: session.availableModes,
        availableModels: session.availableModels,
        configOptions: session.configOptions,
        touchedFiles: [...session.touchedFiles],
      },
      true,
    )
  }

  private pushEvent(
    session: InternalSession,
    event: PollEventInput,
    immediate: boolean,
  ): void {
    const seq = session.nextSeq++
    const stamped = { ...event, seq } as PollEvent
    session.events.push(stamped)
    if (session.events.length > MAX_EVENT_BUFFER) {
      session.events.splice(0, session.events.length - MAX_EVENT_BUFFER)
    }

    if (immediate) {
      this.flushWaitersNow(session)
      return
    }
    for (const waiter of session.waiters) {
      if (!waiter.coalesceTimer) {
        waiter.coalesceTimer = setTimeout(() => waiter.wake(), COALESCE_MS)
      }
    }
  }

  private flushWaitersNow(session: InternalSession): void {
    for (const waiter of [...session.waiters]) {
      waiter.wake()
    }
  }

  private flushCatalogWaiters(): void {
    for (const waiter of [...this.catalogWaiters]) {
      waiter.wake()
    }
  }

  private flushAllSessionWaiters(): void {
    for (const session of this.sessions.values()) {
      this.flushWaitersNow(session)
    }
    this.flushCatalogWaiters()
  }

  private bumpCatalog(focusSessionId?: string): void {
    this.catalogVersion++
    if (focusSessionId) {
      this.focusSessionId = focusSessionId
      this.focusCatalogVersion = this.catalogVersion
    }
    for (const session of this.sessions.values()) {
      for (const waiter of [...session.waiters]) {
        if (waiter.watchCatalog) waiter.wake()
      }
    }
    this.flushCatalogWaiters()
  }

  private queuePendingChatReply(session: InternalSession, status: 'completed' | 'error', errorText?: string): void {
    session.pendingChatReply = {
      replyId: makeId('reply'),
      turnGen: session.turnGen,
      status,
      createdAt: nowIso(),
      text: formatChatReplyMessage(session, status, session.activeTurnStartIndex, errorText),
    }
    this.flushAllSessionWaiters()
  }

  private listPendingReplies(): PendingChatReplyRef[] {
    const now = Date.now()
    const refs: PendingChatReplyRef[] = []
    for (const session of this.sessions.values()) {
      const pending = session.pendingChatReply
      if (!pending) continue
      const leaseActive = pending.claimedAt !== undefined && now - pending.claimedAt < REPLY_CLAIM_LEASE_MS
      if (leaseActive) continue
      refs.push({
        sessionId: session.sessionId,
        replyId: pending.replyId,
        status: pending.status,
      })
    }
    return refs
  }

  private claimChatReply(
    sessionId: string,
    replyId: string,
    clientId?: string,
  ): { claimed: boolean; replyId: string; text?: string } {
    const session = this.sessions.get(sessionId)
    const pending = session?.pendingChatReply
    if (!session || !pending || pending.replyId !== replyId) {
      return { claimed: false, replyId }
    }
    const now = Date.now()
    const holder = clientId?.trim() || 'anonymous'
    const leaseActive = pending.claimedAt !== undefined && now - pending.claimedAt < REPLY_CLAIM_LEASE_MS
    if (leaseActive && pending.claimedBy !== holder) {
      return { claimed: false, replyId }
    }
    pending.claimedBy = holder
    pending.claimedAt = now
    return { claimed: true, replyId, text: pending.text }
  }

  private ackChatReply(sessionId: string, replyId: string, clientId?: string): boolean {
    const session = this.sessions.get(sessionId)
    const pending = session?.pendingChatReply
    if (!session || !pending || pending.replyId !== replyId) return false
    const holder = clientId?.trim() || 'anonymous'
    if (pending.claimedBy && pending.claimedBy !== holder) return false
    session.pendingChatReply = undefined
    this.emitMeta(session)
    return true
  }

  private releaseChatReply(sessionId: string, replyId: string, clientId?: string): boolean {
    const session = this.sessions.get(sessionId)
    const pending = session?.pendingChatReply
    if (!session || !pending || pending.replyId !== replyId) return false
    const holder = clientId?.trim() || 'anonymous'
    if (pending.claimedBy && pending.claimedBy !== holder) return false
    pending.claimedBy = undefined
    pending.claimedAt = undefined
    return true
  }

  private formatSessionInspection(session: InternalSession, stillRunningAfterWait: boolean): Reply {
    const snap = this.snapshotOf(session)
    const turnStart = session.activeTurnStartIndex > 0 && session.activeTurnStartIndex <= snap.items.length
      ? session.activeTurnStartIndex
      : undefined
    const latestResponse = extractTurnAssistantText(snap.items, turnStart)
    const latestError = [...snap.items].reverse().find(i => i.kind === 'error' && i.text)?.text
    const toolCallsCount = snap.items.filter(i => i.kind === 'tool_call').length
    const lastTool = [...snap.items].reverse().find(i => i.kind === 'tool_call')
    const clippedResponse = latestResponse ? clipForChatReply(latestResponse, snap.sessionId) : undefined

    const summaryText = [
      `Session ${snap.sessionId}: "${snap.title}" [${snap.status}${snap.archivedAt ? ', archived' : ''}]`,
      `cwd: ${snap.cwd}`,
      snap.modeId || snap.modelId
        ? [snap.modeId ? `mode: ${snap.modeId}` : undefined, snap.modelId ? `model: ${snap.modelId}` : undefined]
            .filter(Boolean)
            .join(' · ')
        : undefined,
      stillRunningAfterWait
        ? `Still running after wait window (${toolCallsCount} tool call(s) so far${lastTool?.title ? `; latest: ${lastTool.title}` : ''}). Turn was NOT cancelled; wait again or let the side pane deliver the final reply.`
        : undefined,
      snap.pendingPermissions.length > 0 ? `Pending permissions: ${snap.pendingPermissions.length}` : undefined,
      snap.touchedFiles.length > 0 ? `Touched files: ${snap.touchedFiles.join(', ')}` : undefined,
      latestError && snap.status === 'error' ? `\nError:\n${latestError}` : undefined,
      clippedResponse ? `\nLatest response:\n${clippedResponse}` : undefined,
    ]
      .filter(Boolean)
      .join('\n')

    return {
      text: summaryText,
      structuredContent: {
        ...this.summaryOf(session),
        stillRunning: snap.status === 'running',
        toolCallsCount,
        ...(lastTool?.title ? { lastToolTitle: lastTool.title } : {}),
        touchedFiles: snap.touchedFiles,
        ...(latestError && snap.status === 'error' ? { error: latestError } : {}),
        ...(clippedResponse ? { latestResponse: clippedResponse } : {}),
      },
    }
  }

  private async pickFallbackCwd(): Promise<string> {
    const data = await this.deps.store.load()
    return data.preferences.lastCwd || data.recentCwds[0] || this.deps.defaultCwd
  }

  private sortedSessions(): InternalSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private summaryOf(session: InternalSession): SessionSummary {
    return {
      sessionId: session.sessionId,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
      status: session.status,
      loadedInProcess: session.loadedInProcess,
      pendingPermissionCount: session.pendingPermissions.size,
      touchedFilesCount: session.touchedFiles.size,
      ...(session.modeId ? { modeId: session.modeId } : {}),
      ...(session.modelId ? { modelId: session.modelId } : {}),
      ...(session.usage ? { usage: session.usage } : {}),
      ...(session.status === 'running' && session.activeTurnReplyToChat ? { replyToChat: true } : {}),
      ...(session.pendingChatReply ? { pendingChatReplyId: session.pendingChatReply.replyId } : {}),
    }
  }

  private snapshotOf(session: InternalSession): SessionSnapshot {
    const pendingPermissions = [...session.pendingPermissions.values()].map(({ resolve: _r, ...rest }) => rest)
    return {
      ...this.summaryOf(session),
      availableModes: session.availableModes,
      availableModels: session.availableModels,
      configOptions: session.configOptions,
      availableCommands: session.availableCommands,
      plan: session.plan,
      touchedFiles: [...session.touchedFiles],
      pendingPermissions,
      items: session.items,
      latestSeq: session.nextSeq - 1,
    }
  }
}
