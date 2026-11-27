export type UiPreferences = {
  sidebarWidthPct: number
  lastCwd?: string
  defaultModeId?: string
  defaultModelId?: string
}

export type PersistedUsage = {
  used: number
  size: number
  costAmount?: number
  costCurrency?: string
}

export type TimelineLocation = {
  path: string
  line?: number
}

export type TimelineDiff = {
  path: string
  oldText?: string
  newText: string
}

export type TimelineItem = {
  id: string
  kind: 'user' | 'assistant' | 'thought' | 'tool_call' | 'status' | 'error'
  text?: string
  toolCallId?: string
  title?: string
  toolKind?: string
  status?: string
  locations?: TimelineLocation[]
  diffs?: TimelineDiff[]
  rawInput?: string
  rawOutput?: string
  streaming?: boolean
  timestamp: string
}

export type PermissionOption = {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

export type PermissionRequestState = {
  requestId: string
  sessionId: string
  toolCallId: string
  title: string
  kind?: string
  rawInput?: string
  locations?: TimelineLocation[]
  diffs?: TimelineDiff[]
  options: PermissionOption[]
  createdAt: string
}

export type ModeOption = {
  id: string
  name: string
  description?: string | null
}

export type ModelOption = {
  modelId: string
  name: string
  description?: string | null
}

export type ConfigOptionValue = {
  value: string
  name: string
  description?: string | null
}

export type ConfigOption = {
  id: string
  name: string
  description?: string | null
  category?: string | null
  type: 'select'
  currentValue: string
  options: (ConfigOptionValue | { group: string; name: string; options: ConfigOptionValue[] })[]
}

export type AvailableCommand = {
  name: string
  description: string
  input?: { hint?: string | null } | null
}

export type PlanEntry = {
  content: string
  priority?: string
  status: string
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
}

export type SessionSnapshot = SessionSummary & {
  availableModes: ModeOption[]
  availableModels: ModelOption[]
  configOptions: ConfigOption[]
  availableCommands: AvailableCommand[]
  plan: PlanEntry[]
  touchedFiles: string[]
  pendingPermissions: PermissionRequestState[]
  items: TimelineItem[]
  latestSeq: number
}

export type AuthMethod = {
  id: string
  name: string
  description?: string | null
}

export type DiagnosticsInfo = {
  status: 'idle' | 'connecting' | 'ready' | 'auth_required' | 'error'
  binarySource?: 'env' | 'path' | 'npx'
  binaryDisplay?: string
  agentInfo?: { name: string; title?: string | null; version?: string }
  agentCapabilities?: Record<string, unknown>
  authMethods: AuthMethod[]
  authRequired: boolean
  lastError?: string
  stderrTail: string[]
}

export type BootstrapPayload = {
  diagnostics: DiagnosticsInfo
  preferences: UiPreferences
  workspaceRoots: string[]
  recentCwds: string[]
  sessions: SessionSummary[]
  activeSession?: SessionSnapshot
  truncatedItems?: boolean
}

export type PollEvent =
  | { seq: number; type: 'timeline_upsert'; sessionId: string; item: TimelineItem }
  | { seq: number; type: 'plan_update'; sessionId: string; plan: PlanEntry[] }
  | { seq: number; type: 'commands_update'; sessionId: string; commands: AvailableCommand[] }
  | {
      seq: number
      type: 'session_meta'
      sessionId: string
      summary: SessionSummary
      availableModes?: ModeOption[]
      availableModels?: ModelOption[]
      configOptions?: ConfigOption[]
      touchedFiles?: string[]
    }
  | { seq: number; type: 'permission_request'; sessionId: string; permission: PermissionRequestState }
  | { seq: number; type: 'permission_resolved'; sessionId: string; requestId: string; outcome: unknown }
  | { seq: number; type: 'turn_finished'; sessionId: string; stopReason: string; error?: string }

export type PollResponse = {
  sessionId: string
  events: PollEvent[]
  latestSeq: number
  resync: boolean
  snapshot?: SessionSnapshot
}

export type DirectorySuggestion = {
  name: string
  path: string
}

export type WorkspaceFileMatch = {
  path: string
  absPath: string
  size: number
}

export type ToastMessage = {
  id: number
  title: string
  detail?: string
  tone: 'default' | 'success' | 'error'
}
