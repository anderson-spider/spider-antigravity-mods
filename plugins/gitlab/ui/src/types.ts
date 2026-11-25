export type MrStateFilter = 'opened' | 'merged' | 'closed' | 'all'
export type InvolvementFilter = 'all' | 'waiting' | 'reviewing' | 'authored' | 'others'
export type SortOrder = 'ready' | 'updated' | 'newest' | 'oldest' | 'largest'
export type DiffMode = 'unified' | 'split'
export type DetailTab = 'summary' | 'discussions' | 'code'

export type RegisteredRepo = {
  path: string
  host: string
  project: string
}

export type ActiveRepo = RegisteredRepo & {
  source: 'workspace' | 'registered'
}

export type WorktreeInfo = {
  path: string
  branch: string
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

export type WorkspaceInfo = {
  host: string
  project: string
  branch?: string
}

export type BootstrapPayload = {
  configuredHosts: string[]
  workspace?: WorkspaceInfo | null
  registeredRepos?: ActiveRepo[]
  initialScope?: 'project' | 'all'
  initialSelection?: { host: string; project: string; iid: number }
  initialState?: MrStateFilter
  initialInvolvement?: InvolvementFilter
  error?: string
  state: DashboardState
}

export type MrLabel = { name: string; color?: string }

export type MrListItem = {
  id: string
  host: string
  project: string
  iid: number
  title: string
  state: string
  draft: boolean
  involvement: 'authored' | 'reviewing' | 'other'
  isAuthored: boolean
  isReviewing: boolean
  isWaitingOnMe?: boolean
  fork?: boolean
  author: { username: string; name?: string }
  assignees: string[]
  reviewers: string[]
  sourceBranch: string
  targetBranch: string
  sha?: string
  updatedAt: string
  createdAt?: string
  additions?: number
  deletions?: number
  fileCount?: number
  conflicts: boolean
  mergeStatus?: string
  labels: MrLabel[]
  pipeline?: { id?: number; status: string; url?: string }
  approvals?: { approved?: boolean; required?: number; left?: number; by: string[] }
  url: string
}

export type PipelineJob = {
  id: number
  name: string
  stage: string
  status: string
  allowFailure?: boolean
  seconds?: number
  failure?: string
  url?: string
}

export type DownstreamPipeline = {
  name: string
  stage: string
  status: string
  pipeline?: number
  pipelineStatus?: string
}

export type DiscussionNote = {
  id: number
  author: string
  createdAt: string
  body: string
}

export type DiscussionItem = {
  id: string
  resolvable: boolean
  resolved: boolean
  at?: { path: string; line?: number; oldLine?: number }
  notes: DiscussionNote[]
}

export type DraftNoteItem = {
  id: number
  discussionId?: string
  at?: { path: string; line?: number; oldLine?: number }
  body: string
}

export type ApprovalRule = {
  name: string
  approved?: boolean
  required?: number
  by: string[]
}

export type MrDetail = {
  iid: number
  host: string
  project: string
  currentUser?: string
  title: string
  description: string
  state: string
  draft?: boolean
  source: string
  target: string
  sha?: string
  author?: string
  authorName?: string
  assignees: string[]
  reviewers: string[]
  labels: MrLabel[]
  mergeStatus?: string
  conflicts?: boolean
  discussionsResolved?: boolean
  isProtectedTarget?: boolean
  localRepoPath?: string
  activeWorktree?: WorktreeInfo | null
  createdAt: string
  updatedAt: string
  pipeline: {
    id: number
    status: string
    sha?: string
    url?: string
    jobs: PipelineJob[]
    downstream: DownstreamPipeline[]
  } | null
  approvals?: { approved?: boolean; left?: number; by: string[] }
  rules?: ApprovalRule[]
  blockers: string[]
  discussions: DiscussionItem[]
  drafts: DraftNoteItem[]
  url: string
}

export type DiffFile = {
  oldPath: string
  newPath: string
  status: 'A' | 'M' | 'D' | 'R'
  diff: string
  tooLarge: boolean
  collapsed: boolean
  additions: number
  deletions: number
}

export type ToastMessage = {
  id: number
  title: string
  detail?: string
  tone?: 'default' | 'success' | 'warning' | 'error'
}
