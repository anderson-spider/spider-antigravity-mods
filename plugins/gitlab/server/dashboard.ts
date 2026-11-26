// GitLab MR Dashboard MCP App backend: entrypoint tool (`gitlab_mr_dashboard`) plus app-only (`visibility: ['app']`)
// tools for multi-host/multi-repo batched GraphQL/REST listing, local repository registration, isolated git worktree
// checkout/removal, detail aggregation, diff loading, job logs, guarded UI actions, and persistent local UI state.
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { GitlabError, NoProjectError, gitlab, type Api } from './api.ts'
import { comment } from './comments.ts'
import { InputError, bool, id, items, makeCtx, need, paging, str, type Ctx, type User } from './context.ts'
import { jobLog } from './joblog.ts'
import { mr, statusView } from './mr.ts'
import { jobView, pipeline } from './pipelines.ts'
import { errorText, hostName, locate, maskSecrets, projectPath, resolveEnv, sshHostname, type Deps, type Options, type Reply } from './run.ts'
import type { DashboardPreferences, RegisteredRepo, SavedViewFilters, Store } from './store.ts'
import { checkoutWorktree, findWorktree, removeWorktree, type GitAt, type WorktreeInfo } from './worktree.ts'

export const DASHBOARD_URI = 'ui://gitlab/mr-dashboard.html'
export const DASHBOARD_MIME = 'text/html;profile=mcp-app'

export type ActiveRepo = RegisteredRepo & { source: 'workspace' | 'registered' }

export type DashboardRuntime = {
  cwds?: readonly string[]
  dataDir?: string
  gitAt?: GitAt
  isDir?: (path: string) => Promise<boolean>
  homedir?: () => string
}

export type DashboardToolName =
  | 'gitlab_mr_dashboard'
  | 'gitlab_ui_list'
  | 'gitlab_ui_detail'
  | 'gitlab_ui_diff'
  | 'gitlab_ui_job_log'
  | 'gitlab_ui_action'
  | 'gitlab_ui_state'

export type DashboardMrItem = {
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
  isWaitingOnMe: boolean
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
  unresolvedCount?: number
  labels: { name: string; color?: string }[]
  pipeline?: { id?: number; status: string; url?: string }
  approvals?: { approved?: boolean; required?: number; left?: number; by: string[] }
  url: string
}

const MR_FIELDS_BASE = `
  iid
  title
  state
  draft
  sourceBranch
  targetBranch
  webUrl
  createdAt
  updatedAt
  conflicts
  detailedMergeStatus
  diffHeadSha
  author { username name }
  assignees { nodes { username } }
  reviewers { nodes { username } }
  labels { nodes { title color } }
  headPipeline { id status }
  diffStatsSummary { additions deletions fileCount }
  userDiscussionsCount
  project { fullPath }
`

const MR_FIELDS_EE = `
  ${MR_FIELDS_BASE}
  sourceProject { fullPath }
  approved
  approvalsRequired
  approvalsLeft
  approvedBy { nodes { username } }
`

function buildUserListQuery(fields: string, withState: boolean): string {
  const args = withState ? '(state: $state, first: 40, sort: UPDATED_DESC)' : '(first: 40, sort: UPDATED_DESC)'
  const varDecl = withState ? '($state: MergeRequestState!)' : ''
  return `query DashboardUserMrs${varDecl} {
    currentUser {
      username
      authored: authoredMergeRequests${args} { nodes { ${fields} } }
      reviewing: reviewRequestedMergeRequests${args} { nodes { ${fields} } }
      assigned: assignedMergeRequests${args} { nodes { ${fields} } }
    }
  }`
}

function buildProjectListQuery(fields: string, withState: boolean): string {
  const args = withState ? '(state: $state, first: 50, sort: UPDATED_DESC)' : '(first: 50, sort: UPDATED_DESC)'
  const varDecl = withState ? '($project: ID!, $state: MergeRequestState!)' : '($project: ID!)'
  return `query DashboardProjectMrs${varDecl} {
    currentUser { username }
    project(fullPath: $project) {
      mergeRequests${args} { nodes { ${fields} } }
    }
  }`
}

function buildBatchProjectListQuery(fields: string, count: number, withState: boolean, limit: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$p${i}: ID!`)
  if (withState) vars.push('$state: MergeRequestState!')
  const args = withState ? `(state: $state, first: ${limit}, sort: UPDATED_DESC)` : `(first: ${limit}, sort: UPDATED_DESC)`
  const aliases = Array.from(
    { length: count },
    (_, i) => `p${i}: project(fullPath: $p${i}) { mergeRequests${args} { nodes { ${fields} } } }`,
  ).join('\n    ')
  return `query DashboardBatchProjectMrs(${vars.join(', ')}) {
    currentUser { username }
    ${aliases}
  }`
}

type GqlNode = {
  iid?: string | number
  title?: string
  state?: string
  draft?: boolean
  sourceBranch?: string
  targetBranch?: string
  webUrl?: string
  createdAt?: string
  updatedAt?: string
  conflicts?: boolean
  detailedMergeStatus?: string
  diffHeadSha?: string | null
  author?: { username?: string; name?: string } | null
  assignees?: { nodes?: ({ username?: string } | null)[] } | null
  reviewers?: { nodes?: ({ username?: string } | null)[] } | null
  labels?: { nodes?: ({ title?: string; color?: string } | null)[] } | null
  headPipeline?: { id?: string; status?: string } | null
  approved?: boolean | null
  approvalsRequired?: number | null
  approvalsLeft?: number | null
  approvedBy?: { nodes?: ({ username?: string } | null)[] } | null
  diffStatsSummary?: { additions?: number; deletions?: number; fileCount?: number } | null
  userDiscussionsCount?: number | null
  project?: { fullPath?: string } | null
  sourceProject?: { fullPath?: string } | null
}

function parseGidNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const tail = raw.split('/').at(-1)
  const n = tail ? Number(tail) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function normalizeStatus(raw: string | undefined): string | undefined {
  return raw ? raw.toLowerCase() : undefined
}

function fromGraphqlNode(host: string, node: GqlNode, me: string | undefined, fallbackProject?: string): DashboardMrItem | undefined {
  const iid = Number(node.iid)
  const project = node.project?.fullPath ?? fallbackProject
  if (!Number.isSafeInteger(iid) || iid <= 0 || !project) return undefined
  const authorUser = node.author?.username ?? 'unknown'
  const assignees = (node.assignees?.nodes ?? []).map((u) => u?.username).filter((u): u is string => Boolean(u))
  const reviewers = (node.reviewers?.nodes ?? []).map((u) => u?.username).filter((u): u is string => Boolean(u))
  const isAuthored = me !== undefined && authorUser.toLowerCase() === me.toLowerCase()
  const isReviewing = me !== undefined && !isAuthored && (reviewers.some((r) => r.toLowerCase() === me.toLowerCase()) || assignees.some((a) => a.toLowerCase() === me.toLowerCase()))
  const involvement: DashboardMrItem['involvement'] = isAuthored ? 'authored' : isReviewing ? 'reviewing' : 'other'
  const approvedBy = (node.approvedBy?.nodes ?? []).map((u) => u?.username).filter((u): u is string => Boolean(u))
  const approvedByMe = me !== undefined && approvedBy.some((u) => u.toLowerCase() === me.toLowerCase())
  const isWaitingOnMe = isReviewing && !approvedByMe
  const fork = node.sourceProject?.fullPath
    ? node.sourceProject.fullPath.toLowerCase() !== project.toLowerCase()
    : undefined
  const hasApprovals = typeof node.approved === 'boolean' || typeof node.approvalsRequired === 'number' || approvedBy.length > 0
  return {
    id: `${host}:${project}:${iid}`,
    host,
    project,
    iid,
    title: node.title ?? `!${iid}`,
    state: normalizeStatus(node.state) ?? 'opened',
    draft: Boolean(node.draft),
    involvement,
    isAuthored,
    isReviewing,
    isWaitingOnMe,
    ...(fork !== undefined ? { fork } : {}),
    author: { username: authorUser, ...(node.author?.name ? { name: node.author.name } : {}) },
    assignees,
    reviewers,
    sourceBranch: node.sourceBranch ?? '',
    targetBranch: node.targetBranch ?? '',
    ...(node.diffHeadSha ? { sha: node.diffHeadSha } : {}),
    updatedAt: node.updatedAt ?? '',
    ...(node.createdAt ? { createdAt: node.createdAt } : {}),
    ...(node.diffStatsSummary ? {
      additions: node.diffStatsSummary.additions,
      deletions: node.diffStatsSummary.deletions,
      fileCount: node.diffStatsSummary.fileCount,
    } : {}),
    conflicts: Boolean(node.conflicts),
    ...(node.detailedMergeStatus ? { mergeStatus: normalizeStatus(node.detailedMergeStatus) } : {}),
    labels: (node.labels?.nodes ?? [])
      .filter((l): l is { title: string; color?: string } => Boolean(l?.title))
      .map((l) => ({ name: l.title, ...(l.color ? { color: l.color } : {}) })),
    ...(node.headPipeline?.status ? {
      pipeline: {
        ...(parseGidNumber(node.headPipeline.id) !== undefined ? { id: parseGidNumber(node.headPipeline.id) } : {}),
        status: normalizeStatus(node.headPipeline.status)!,
      },
    } : {}),
    ...(hasApprovals ? {
      approvals: {
        ...(typeof node.approved === 'boolean' ? { approved: node.approved } : {}),
        ...(typeof node.approvalsRequired === 'number' ? { required: node.approvalsRequired } : {}),
        ...(typeof node.approvalsLeft === 'number' ? { left: node.approvalsLeft } : {}),
        by: approvedBy,
      },
    } : {}),
    url: node.webUrl ?? `https://${host}/${project}/-/merge_requests/${iid}`,
  }
}

type RestMr = {
  iid: number
  title: string
  description?: string | null
  state: string
  draft?: boolean
  source_branch: string
  target_branch: string
  sha?: string
  created_at?: string
  updated_at?: string
  author?: { id?: number; username?: string; name?: string }
  assignees?: { username?: string }[]
  reviewers?: { username?: string }[]
  labels?: string[]
  detailed_merge_status?: string
  merge_status?: string
  has_conflicts?: boolean
  blocking_discussions_resolved?: boolean
  head_pipeline?: { id: number; status: string; sha?: string; web_url?: string } | null
  references?: { full?: string }
  web_url: string
  diff_refs?: { base_sha: string; start_sha: string; head_sha: string }
  source_project_id?: number
  target_project_id?: number
}

function projectFromRestMr(item: RestMr, fallback?: string): string | undefined {
  const full = item.references?.full
  if (full) {
    const bang = full.lastIndexOf('!')
    if (bang > 0) return full.slice(0, bang)
  }
  if (item.web_url) {
    try {
      const path = new URL(item.web_url).pathname
      const marker = path.indexOf('/-/merge_requests/')
      if (marker > 1) return path.slice(1, marker)
    } catch {}
  }
  return fallback
}

function fromRestMr(host: string, item: RestMr, me: string | undefined, fallbackProject?: string): DashboardMrItem | undefined {
  const project = projectFromRestMr(item, fallbackProject)
  if (!project) return undefined
  const authorUser = item.author?.username ?? 'unknown'
  const assignees = (item.assignees ?? []).map((u) => u.username).filter((u): u is string => Boolean(u))
  const reviewers = (item.reviewers ?? []).map((u) => u.username).filter((u): u is string => Boolean(u))
  const isAuthored = me !== undefined && authorUser.toLowerCase() === me.toLowerCase()
  const isReviewing = me !== undefined && !isAuthored && (reviewers.some((r) => r.toLowerCase() === me.toLowerCase()) || assignees.some((a) => a.toLowerCase() === me.toLowerCase()))
  const involvement: DashboardMrItem['involvement'] = isAuthored ? 'authored' : isReviewing ? 'reviewing' : 'other'
  const fork =
    typeof item.source_project_id === 'number' && typeof item.target_project_id === 'number'
      ? item.source_project_id !== item.target_project_id
      : undefined
  return {
    id: `${host}:${project}:${item.iid}`,
    host,
    project,
    iid: item.iid,
    title: item.title,
    state: item.state,
    draft: Boolean(item.draft),
    involvement,
    isAuthored,
    isReviewing,
    isWaitingOnMe: isReviewing,
    ...(fork !== undefined ? { fork } : {}),
    author: { username: authorUser, ...(item.author?.name ? { name: item.author.name } : {}) },
    assignees,
    reviewers,
    sourceBranch: item.source_branch,
    targetBranch: item.target_branch,
    ...(item.sha ? { sha: item.sha } : {}),
    updatedAt: item.updated_at ?? '',
    ...(item.created_at ? { createdAt: item.created_at } : {}),
    conflicts: Boolean(item.has_conflicts),
    mergeStatus: item.detailed_merge_status ?? item.merge_status,
    labels: (item.labels ?? []).map((name) => ({ name })),
    ...(item.head_pipeline
      ? {
          pipeline: {
            id: item.head_pipeline.id,
            status: normalizeStatus(item.head_pipeline.status) ?? item.head_pipeline.status,
            url: item.head_pipeline.web_url,
          },
        }
      : {}),
    url: item.web_url,
  }
}

async function listHostGraphql(
  api: Api,
  host: string,
  state: 'opened' | 'merged' | 'closed' | 'all',
  project: string | undefined,
): Promise<{ me?: string; items: DashboardMrItem[] }> {
  const withState = state !== 'all'
  const variables: Record<string, unknown> = {
    ...(project ? { project } : {}),
    ...(withState ? { state } : {}),
  }

  const runQuery = async (fields: string, strictErrors: boolean) => {
    const query = project ? buildProjectListQuery(fields, withState) : buildUserListQuery(fields, withState)
    const reply = await api.graphql(query, variables)
    const errorMsg = (reply.errors ?? []).map((e) => e.message).filter(Boolean).join('; ')
    const data = reply.data ?? {}
    if (reply.errors?.length) {
      if (strictErrors || !reply.data || (!data.currentUser && !data.project)) {
        throw new GitlabError(400, errorMsg || 'GraphQL query returned errors', 'POST')
      }
    }
    if (project && data.project == null) {
      throw new GitlabError(400, errorMsg || `Project ${project} not found in GraphQL response`, 'POST')
    }
    if (!project && data.currentUser == null) {
      throw new GitlabError(400, errorMsg || 'currentUser not returned in GraphQL response', 'POST')
    }
    return data
  }

  let data: Record<string, unknown>
  try {
    data = await runQuery(MR_FIELDS_EE, true)
  } catch (err) {
    // Self-hosted CE instances may omit Enterprise approval fields; retry once with CE-safe fields before REST fallback.
    if (err instanceof GitlabError && err.status === 400) {
      data = await runQuery(MR_FIELDS_BASE, false)
    } else {
      throw err
    }
  }

  const currentUser = data.currentUser as {
    username?: string
    authored?: { nodes?: GqlNode[] }
    reviewing?: { nodes?: GqlNode[] }
    assigned?: { nodes?: GqlNode[] }
  } | null | undefined
  const me = currentUser?.username

  const rawNodes: GqlNode[] = []
  if (project) {
    const proj = data.project as { mergeRequests?: { nodes?: GqlNode[] } } | null | undefined
    rawNodes.push(...(proj?.mergeRequests?.nodes ?? []))
  } else {
    rawNodes.push(
      ...(currentUser?.reviewing?.nodes ?? []),
      ...(currentUser?.authored?.nodes ?? []),
      ...(currentUser?.assigned?.nodes ?? []),
    )
  }

  const dedup = new Map<string, DashboardMrItem>()
  for (const node of rawNodes) {
    const mapped = fromGraphqlNode(host, node, me, project)
    if (!mapped) continue
    if (!dedup.has(mapped.id)) dedup.set(mapped.id, mapped)
  }
  return { me, items: [...dedup.values()] }
}

async function listHostRest(
  api: Api,
  host: string,
  state: 'opened' | 'merged' | 'closed' | 'all',
  project: string | undefined,
): Promise<{ me?: string; items: DashboardMrItem[] }> {
  const user = (await api.root('/user')) as User
  const me = user?.username
  const dedup = new Map<string, DashboardMrItem>()
  const ingest = (list: RestMr[]) => {
    for (const item of list) {
      const mapped = fromRestMr(host, item, me, project)
      if (mapped && !dedup.has(mapped.id)) dedup.set(mapped.id, mapped)
    }
  }
  if (project) {
    const page = await api.page('/merge_requests', { state, order_by: 'updated_at', per_page: 50 })
    ingest(items<RestMr>(page))
  } else if (me) {
    const [authored, reviewing, assigned] = await Promise.all([
      api.rootPage('/merge_requests', { state, scope: 'all', author_username: me, order_by: 'updated_at', per_page: 40 }),
      api.rootPage('/merge_requests', { state, scope: 'all', reviewer_username: me, order_by: 'updated_at', per_page: 40 }),
      api.rootPage('/merge_requests', { state, scope: 'all', assignee_username: me, order_by: 'updated_at', per_page: 40 }),
    ])
    ingest(items<RestMr>(reviewing))
    ingest(items<RestMr>(authored))
    ingest(items<RestMr>(assigned))
  } else {
    const page = await api.rootPage('/merge_requests', { state, scope: 'created_by_me', order_by: 'updated_at', per_page: 40 })
    ingest(items<RestMr>(page))
  }
  return { me, items: [...dedup.values()] }
}

async function optional<T>(read: Promise<unknown>): Promise<T | undefined> {
  try {
    return (await read) as T
  } catch (err) {
    if (err instanceof GitlabError && (err.status === 403 || err.status === 404)) return undefined
    throw err
  }
}

function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

function makeHostCtx(deps: Deps, host: string, token: string, project: string | undefined): Ctx {
  const api = gitlab(deps.fetch, host, project, token)
  return makeCtx(api, async () => undefined, deps.clock, true)
}

function requireHostAndProject(tokens: Map<string, string>, input: Record<string, unknown>): { host: string; token: string; project: string } {
  const host = hostName(input.host)
  if (!host) throw new InputError('host must be a valid GitLab host name (for example gitlab.example.com).')
  const token = tokens.get(host)
  if (!token) throw new InputError(`No token configured for ${host}.`)
  const project = projectPath(input.project)
  if (!project) throw new InputError('project must be a valid project path (group/project) or numeric id.')
  return { host, token, project }
}

async function runPool<T, R>(list: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(list.length)
  let nextIdx = 0
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (nextIdx < list.length) {
      const idx = nextIdx++
      results[idx] = await fn(list[idx]!)
    }
  })
  await Promise.all(workers)
  return results
}

const MULTI_REPO_BATCH_SIZE = 3
const MULTI_REPO_CONCURRENCY = 4

async function listHostProjectBatchGraphql(
  api: Api,
  host: string,
  projects: readonly string[],
  state: 'opened' | 'merged' | 'closed' | 'all',
  limit: number,
): Promise<{ me?: string; items: DashboardMrItem[]; missing: string[] }> {
  const withState = state !== 'all'
  const variables: Record<string, unknown> = { ...(withState ? { state } : {}) }
  for (let i = 0; i < projects.length; i++) variables[`p${i}`] = projects[i]

  const runBatch = async (fields: string, strictErrors: boolean) => {
    const query = buildBatchProjectListQuery(fields, projects.length, withState, limit)
    const reply = await api.graphql(query, variables)
    const errorMsg = (reply.errors ?? []).map((e) => e.message).filter(Boolean).join('; ')
    const data = reply.data ?? {}
    const anyProject = projects.some((_, i) => data[`p${i}`] != null)
    if (reply.errors?.length) {
      if (strictErrors || !reply.data || (!data.currentUser && !anyProject)) {
        throw new GitlabError(400, errorMsg || 'GraphQL batch query returned errors', 'POST')
      }
    }
    if (!anyProject || data.currentUser == null) {
      throw new GitlabError(400, errorMsg || 'Projects or currentUser not resolved in GraphQL batch response', 'POST')
    }
    return data
  }

  let data: Record<string, unknown>
  try {
    data = await runBatch(MR_FIELDS_EE, true)
  } catch (err) {
    if (err instanceof GitlabError && err.status === 400) {
      data = await runBatch(MR_FIELDS_BASE, false)
    } else {
      throw err
    }
  }

  const currentUser = data.currentUser as { username?: string } | null | undefined
  const me = currentUser?.username
  const dedup = new Map<string, DashboardMrItem>()
  const missing: string[] = []

  for (let i = 0; i < projects.length; i++) {
    const projPath = projects[i]!
    const proj = data[`p${i}`] as { mergeRequests?: { nodes?: GqlNode[] } } | null | undefined
    if (proj == null) {
      missing.push(projPath)
      continue
    }
    for (const node of proj.mergeRequests?.nodes ?? []) {
      const mapped = fromGraphqlNode(host, node, me, projPath)
      if (mapped && !dedup.has(mapped.id)) dedup.set(mapped.id, mapped)
    }
  }
  return { me, items: [...dedup.values()], missing }
}

async function listHostProjectsMulti(
  deps: Deps,
  host: string,
  token: string,
  projects: readonly string[],
  state: 'opened' | 'merged' | 'closed' | 'all',
  limit: number,
): Promise<{ host: string; enriched: boolean; me?: string; items: DashboardMrItem[]; errors: { host: string; message: string }[] }> {
  const numericProjects = projects.filter((p) => /^\d+$/.test(p))
  const pathProjects = projects.filter((p) => !/^\d+$/.test(p))
  const chunks: string[][] = []
  for (let i = 0; i < pathProjects.length; i += MULTI_REPO_BATCH_SIZE) {
    chunks.push(pathProjects.slice(i, i + MULTI_REPO_BATCH_SIZE))
  }

  const rootApi = gitlab(deps.fetch, host, undefined, token)
  const dedup = new Map<string, DashboardMrItem>()
  const restProjects: string[] = [...numericProjects]
  const errors: { host: string; message: string }[] = []
  let me: string | undefined
  let usedGraphql = false
  let authError: string | undefined

  if (chunks.length > 0) {
    const batchResults = await runPool(chunks, MULTI_REPO_CONCURRENCY, async (chunk) => {
      try {
        const res = await listHostProjectBatchGraphql(rootApi, host, chunk, state, limit)
        return { ok: true as const, chunk, res }
      } catch (err) {
        return { ok: false as const, chunk, err }
      }
    })
    for (const r of batchResults) {
      if (r.ok) {
        usedGraphql = true
        if (r.res.me && !me) me = r.res.me
        for (const item of r.res.items) {
          if (!dedup.has(item.id)) dedup.set(item.id, item)
        }
        restProjects.push(...r.res.missing)
      } else if (r.err instanceof GitlabError && r.err.status === 401) {
        authError = errorText(r.err, host, host)
      } else {
        restProjects.push(...r.chunk)
      }
    }
  }

  if (authError) {
    return { host, enriched: false, me: undefined, items: [], errors: [{ host, message: authError }] }
  }

  if (restProjects.length > 0) {
    if (me === undefined) {
      try {
        const user = (await rootApi.root('/user')) as User
        me = user?.username
      } catch (err) {
        if (err instanceof GitlabError && err.status === 401) {
          return { host, enriched: usedGraphql, me: undefined, items: [...dedup.values()], errors: [{ host, message: errorText(err, host, host) }] }
        }
      }
    }
    const restResults = await runPool(restProjects, MULTI_REPO_CONCURRENCY, async (proj) => {
      try {
        const api = gitlab(deps.fetch, host, proj, token)
        const page = await api.page('/merge_requests', { state, order_by: 'updated_at', per_page: limit })
        return { ok: true as const, proj, list: items<RestMr>(page) }
      } catch (err) {
        const msg = err instanceof GitlabError
          ? errorText(err, proj, host)
          : `Call to ${host} failed: ${err instanceof Error ? err.message : String(err)}`
        return { ok: false as const, proj, msg }
      }
    })
    for (const r of restResults) {
      if (r.ok) {
        for (const item of r.list) {
          const mapped = fromRestMr(host, item, me, r.proj)
          if (mapped && !dedup.has(mapped.id)) dedup.set(mapped.id, mapped)
        }
      } else {
        errors.push({ host: `${host}/${r.proj}`, message: r.msg })
      }
    }
  }

  return { host, enriched: usedGraphql, me, items: [...dedup.values()], errors }
}

function defaultIsDir(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory(), () => false)
}

function expandHome(raw: string, getHome: () => string): string {
  const trimmed = raw.trim()
  if (trimmed === '~') return getHome()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(getHome(), trimmed.slice(2))
  return trimmed
}

function runtimeGitAt(deps: Deps, runtime: DashboardRuntime): GitAt {
  return runtime.gitAt ?? ((_cwd, args) => deps.git(args))
}

async function resolveLocalRepo(
  rawPath: string,
  tokens: Map<string, string>,
  deps: Deps,
  runtime: DashboardRuntime,
): Promise<RegisteredRepo> {
  const getHome = runtime.homedir ?? homedir
  const isDir = runtime.isDir ?? defaultIsDir
  const gitAt = runtimeGitAt(deps, runtime)

  const expanded = expandHome(rawPath, getHome)
  if (!expanded || !isAbsolute(expanded)) {
    throw new InputError('Repository path must be an absolute path or start with ~/.')
  }
  const normalized = resolve(expanded)
  if (!(await isDir(normalized))) {
    throw new InputError(`Directory does not exist: ${normalized}`)
  }

  let repoPath: string | undefined
  const common = await gitAt(normalized, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common.exitCode === 0 && common.stdout.trim()) {
    const rawCommon = common.stdout.trim().replace(/[\\/]+$/, '')
    const absCommon = isAbsolute(rawCommon) ? rawCommon : resolve(normalized, rawCommon)
    if (absCommon.endsWith('/.git') || absCommon.endsWith('\\.git')) {
      repoPath = absCommon.slice(0, -5)
    }
  }
  if (!repoPath) {
    const top = await gitAt(normalized, ['rev-parse', '--show-toplevel'])
    if (top.exitCode === 0 && top.stdout.trim()) {
      repoPath = resolve(top.stdout.trim())
    }
  }
  if (!repoPath) {
    throw new InputError(`Directory is not a git repository: ${normalized}`)
  }

  const where = await locate((args) => gitAt(repoPath, args))
  if ('error' in where) {
    throw new InputError(where.error)
  }

  let host = where.host
  if (!tokens.has(host) && where.ssh) {
    const real = await sshHostname(deps.ssh, host)
    if (real) host = real
  }
  if (!tokens.has(host)) {
    throw new InputError(`No token configured for ${host}. Configured hosts: ${[...tokens.keys()].join(', ')}.`)
  }
  return { path: repoPath, host, project: where.project }
}

async function resolveActiveRepos(
  stateRepos: readonly RegisteredRepo[],
  tokens: Map<string, string> | undefined,
  deps: Deps,
  runtime: DashboardRuntime,
): Promise<ActiveRepo[]> {
  const out: ActiveRepo[] = []
  const seen = new Set<string>()
  const keyOf = (host: string, project: string) => `${host.toLowerCase()}|${project.toLowerCase()}`

  if (tokens && runtime.cwds && runtime.cwds.length > 0) {
    for (const dir of runtime.cwds) {
      try {
        const resolved = await resolveLocalRepo(dir, tokens, deps, runtime)
        const key = keyOf(resolved.host, resolved.project)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ ...resolved, source: 'workspace' })
        }
      } catch {}
    }
  }

  for (const repo of stateRepos) {
    const key = keyOf(repo.host, repo.project)
    if (!seen.has(key)) {
      seen.add(key)
      out.push({ ...repo, source: 'registered' })
    }
  }

  return out
}

const VALID_STATES = new Set(['opened', 'merged', 'closed', 'all'])
const OPEN_TARGETS = new Set(['main', 'master', 'develop'])

/** Dispatches `gitlab_mr_dashboard` and the six `gitlab_ui_*` app-only tools. */
export async function runDashboardTool(
  name: DashboardToolName,
  deps: Deps,
  input: Record<string, unknown>,
  options: Options,
  store: Store,
  runtime: DashboardRuntime = {},
): Promise<Reply> {
  if (name === 'gitlab_ui_state') {
    const action = str(input.action) ?? 'get'
    const needsRepos = action === 'get' || action === 'add_repo' || action === 'remove_repo'
    const env = needsRepos ? await resolveEnv(deps, options) : undefined
    const secrets = env?.tokens ? [...env.tokens.values()] : []
    const wrapState = (reply: Reply): Reply => maskSecrets(reply, secrets)
    try {
      let nextState
      let added: RegisteredRepo | undefined
      switch (action) {
        case 'get':
          nextState = await store.load()
          break
        case 'save_preferences':
          nextState = await store.savePreferences({
            ...(input.state !== undefined ? { state: input.state as DashboardPreferences['state'] } : {}),
            ...(input.involvement !== undefined ? { involvement: input.involvement as DashboardPreferences['involvement'] } : {}),
            ...(input.sort !== undefined ? { sort: input.sort as DashboardPreferences['sort'] } : {}),
            ...(input.hostOrProject !== undefined ? { hostOrProject: String(input.hostOrProject) } : {}),
            ...(input.diffMode !== undefined ? { diffMode: input.diffMode as DashboardPreferences['diffMode'] } : {}),
            ...(input.autoRefresh !== undefined ? { autoRefresh: bool(input.autoRefresh) } : {}),
            ...(input.showFileIndex !== undefined ? { showFileIndex: bool(input.showFileIndex) } : {}),
            ...(typeof input.listWidthPct === 'number' ? { listWidthPct: input.listWidthPct } : {}),
          })
          break
        case 'save_view':
          nextState = await store.saveView({
            id: str(input.id),
            name: need(str(input.name), 'save_view requires a name.'),
            filters: {
              q: typeof input.q === 'string' ? input.q : '',
              state: input.state as SavedViewFilters['state'],
              involvement: input.involvement as SavedViewFilters['involvement'],
              sort: input.sort as SavedViewFilters['sort'],
              hostOrProject: str(input.hostOrProject) ?? 'all',
            },
          })
          break
        case 'delete_view':
          nextState = await store.deleteView(need(str(input.id), 'delete_view requires an id.'))
          break
        case 'set_file_viewed':
          nextState = await store.setFileViewed(
            need(str(input.mrKey), 'set_file_viewed requires mrKey.'),
            need(str(input.sha), 'set_file_viewed requires sha.'),
            need(str(input.path), 'set_file_viewed requires path.'),
            bool(input.viewed) === true,
          )
          break
        case 'add_repo': {
          if (!env || env.error !== undefined) return { text: env?.error ?? 'GitLab credentials required.', isError: true }
          const rawPath = need(str(input.path), 'add_repo requires path.')
          added = await resolveLocalRepo(rawPath, env.tokens, deps, runtime)
          nextState = await store.addRepo(added)
          break
        }
        case 'remove_repo': {
          const target = need(str(input.path), 'remove_repo requires path.')
          nextState = await store.removeRepo(target)
          break
        }
        default:
          throw new InputError(`Unknown state action: ${action}`)
      }
      const registeredRepos = needsRepos
        ? await resolveActiveRepos(nextState.repos, env?.tokens, deps, runtime)
        : undefined
      return wrapState({
        text: added ? `Registered repository ${added.project}.` : 'Dashboard state updated.',
        structuredContent: {
          state: nextState,
          ...(added ? { added } : {}),
          ...(registeredRepos !== undefined ? { registeredRepos } : {}),
        },
      })
    } catch (err) {
      return wrapState({ text: err instanceof Error ? err.message : String(err), isError: true })
    }
  }

  const env = await resolveEnv(deps, options)
  if (env.error !== undefined) {
    const state = await store.load()
    if (name === 'gitlab_mr_dashboard') {
      return {
        text: env.error,
        structuredContent: { configuredHosts: [], error: env.error, state },
      }
    }
    return { text: env.error, isError: true }
  }

  const { tokens, workspace } = env
  const secrets = [...tokens.values()]
  const wrap = (reply: Reply): Reply => maskSecrets(reply, secrets)

  try {
    switch (name) {
      case 'gitlab_mr_dashboard': {
        const state = await store.load()
        const configuredHosts = [...tokens.keys()]
        const registeredRepos = await resolveActiveRepos(state.repos, tokens, deps, runtime)
        const requestedHost = input.host !== undefined ? hostName(input.host) : undefined
        const requestedProject = input.project !== undefined ? projectPath(input.project) : undefined
        const requestedIid = id(input.iid, 'iid')
        const targetHost = requestedHost ?? workspace?.host ?? (configuredHosts.length === 1 ? configuredHosts[0] : undefined)
        const targetProject = requestedProject ?? (targetHost && workspace?.host === targetHost ? workspace.project : undefined)
        const initialSelection = targetHost && targetProject && requestedIid !== undefined
          ? { host: targetHost, project: targetProject, iid: requestedIid }
          : undefined
        const structuredContent: Record<string, unknown> = {
          configuredHosts,
          workspace: workspace ?? null,
          registeredRepos,
          initialScope: workspace ? 'project' : 'all',
          ...(initialSelection ? { initialSelection } : {}),
          ...(str(input.state) && VALID_STATES.has(str(input.state)!) ? { initialState: str(input.state) } : {}),
          ...(str(input.involvement) ? { initialInvolvement: str(input.involvement) } : {}),
          state,
        }
        const summaryParts = [
          `Opened GitLab MR Dashboard (${configuredHosts.length} host${configuredHosts.length === 1 ? '' : 's'}: ${configuredHosts.join(', ')})`,
          workspace ? `workspace ${workspace.project}${workspace.branch ? ` (${workspace.branch})` : ''}` : null,
          initialSelection ? `focusing ${initialSelection.project}!${initialSelection.iid}` : null,
        ].filter(Boolean)
        return wrap({ text: `${summaryParts.join('; ')}.`, structuredContent })
      }

      case 'gitlab_ui_list': {
        const stateFilter = (str(input.state) ?? 'opened') as 'opened' | 'merged' | 'closed' | 'all'
        if (!VALID_STATES.has(stateFilter)) throw new InputError('state must be opened, merged, closed, or all.')
        const requestedHost = input.host !== undefined ? hostName(input.host) : undefined
        if (input.host !== undefined && !requestedHost) throw new InputError('host must be a valid GitLab host name.')
        const requestedProject = input.project !== undefined ? projectPath(input.project) : undefined
        if (input.project !== undefined && !requestedProject) throw new InputError('project must be a valid project path or numeric id.')
        const requestedScope = str(input.scope)
        if (requestedScope !== undefined && requestedScope !== 'projects' && requestedScope !== 'mine') {
          throw new InputError('scope must be projects or mine.')
        }

        // Default to 'projects' when neither host nor project nor explicit scope is passed
        const useMultiProjects = !requestedHost && !requestedProject && requestedScope !== 'mine'
        let usedFallbackMine = false

        if (useMultiProjects) {
          const state = await store.load()
          const activeRepos = (await resolveActiveRepos(state.repos, tokens, deps, runtime)).filter((r) => tokens.has(r.host))
          if (activeRepos.length > 0) {
            const perProjectLimit = stateFilter === 'opened' ? 20 : 10
            const byHost = new Map<string, string[]>()
            for (const repo of activeRepos) {
              const list = byHost.get(repo.host) ?? []
              list.push(repo.project)
              byHost.set(repo.host, list)
            }
            const hostList = [...byHost.keys()]
            const hostResults = await Promise.all(
              hostList.map((host) => listHostProjectsMulti(deps, host, tokens.get(host)!, byHost.get(host)!, stateFilter, perProjectLimit)),
            )
            const dedup = new Map<string, DashboardMrItem>()
            const meByHost: Record<string, string> = {}
            const errors: { host: string; message: string }[] = []
            let enriched = false
            for (const r of hostResults) {
              if (r.me) meByHost[r.host] = r.me
              if (r.enriched) enriched = true
              errors.push(...r.errors)
              for (const item of r.items) {
                if (!dedup.has(item.id)) dedup.set(item.id, item)
              }
            }
            const merged = [...dedup.values()]
            return wrap({
              text: `Loaded ${merged.length} merge requests from ${activeRepos.length} project(s).`,
              structuredContent: {
                mergeRequests: merged,
                meByHost,
                enriched,
                errors,
                hosts: hostList,
                usedFallbackMine: false,
                fetchedAt: new Date(deps.clock.now()).toISOString(),
              },
            })
          }
          usedFallbackMine = true
        }

        let targetHosts: string[]
        if (requestedHost) {
          if (!tokens.has(requestedHost)) throw new InputError(`No token configured for ${requestedHost}.`)
          targetHosts = [requestedHost]
        } else if (requestedProject) {
          if (workspace && tokens.has(workspace.host) && workspace.project.toLowerCase() === requestedProject.toLowerCase()) {
            targetHosts = [workspace.host]
          } else if (tokens.size === 1) {
            targetHosts = [[...tokens.keys()][0]!]
          } else {
            throw new InputError('Pass host when filtering by project with multiple configured hosts.')
          }
        } else {
          targetHosts = [...tokens.keys()]
        }

        const results = await Promise.all(
          targetHosts.map(async (host) => {
            const token = tokens.get(host)!
            const api = gitlab(deps.fetch, host, requestedProject, token)
            const runRest = async () => {
              try {
                const rest = await listHostRest(api, host, stateFilter, requestedProject)
                return { host, enriched: false, me: rest.me, items: rest.items, error: undefined }
              } catch (restErr) {
                const msg = restErr instanceof GitlabError
                  ? errorText(restErr, requestedProject ?? host, host)
                  : `Call to ${host} failed: ${restErr instanceof Error ? restErr.message : String(restErr)}`
                return { host, enriched: false, me: undefined, items: [] as DashboardMrItem[], error: msg }
              }
            }
            // GitLab GraphQL project(fullPath:) does not accept numeric project IDs; use REST directly.
            if (requestedProject && /^\d+$/.test(requestedProject)) {
              return runRest()
            }
            try {
              const gql = await listHostGraphql(api, host, stateFilter, requestedProject)
              return { host, enriched: true, me: gql.me, items: gql.items, error: undefined }
            } catch (gqlErr) {
              // If auth failed (401), do not spam REST with the same invalid token
              if (gqlErr instanceof GitlabError && gqlErr.status === 401) {
                return { host, enriched: false, me: undefined, items: [] as DashboardMrItem[], error: errorText(gqlErr, requestedProject ?? host, host) }
              }
              return runRest()
            }
          }),
        )

        const merged: DashboardMrItem[] = []
        const meByHost: Record<string, string> = {}
        const errors: { host: string; message: string }[] = []
        let enriched = false
        for (const r of results) {
          if (r.me) meByHost[r.host] = r.me
          if (r.enriched) enriched = true
          if (r.error) errors.push({ host: r.host, message: r.error })
          merged.push(...r.items)
        }

        return wrap({
          text: `Loaded ${merged.length} merge requests from ${targetHosts.length} host(s).`,
          structuredContent: {
            mergeRequests: merged,
            meByHost,
            enriched,
            errors,
            hosts: targetHosts,
            ...(usedFallbackMine ? { usedFallbackMine: true } : {}),
            fetchedAt: new Date(deps.clock.now()).toISOString(),
          },
        })
      }

      case 'gitlab_ui_detail': {
        const { host, token, project } = requireHostAndProject(tokens, input)
        const iid = need(id(input.iid, 'iid'), 'gitlab_ui_detail requires iid.')
        const api = gitlab(deps.fetch, host, project, token)

        type Approvals = { approved?: boolean; approvals_left?: number; approvals_required?: number; approved_by?: { user?: User }[] }
        type ApprovalState = { rules?: { name: string; approved?: boolean; approvals_required?: number; approved_by?: User[] }[] }
        type RawNote = {
          id: number
          body: string
          system?: boolean
          resolvable?: boolean
          resolved?: boolean
          author?: { username?: string; name?: string }
          created_at?: string
          position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null
        }
        type RawDiscussion = { id: string; notes: RawNote[] }
        type RawDraft = { id: number; note: string; discussion_id?: string | null; position?: RawNote['position'] }
        type RawLabel = { name: string; color?: string }

        const [meUser, rawMr, approvals, approvalState, discPage, draftPage, labelPage] = await Promise.all([
          optional<User>(api.root('/user')),
          api.get(`/merge_requests/${iid}`) as Promise<RestMr>,
          optional<Approvals>(api.get(`/merge_requests/${iid}/approvals`)),
          optional<ApprovalState>(api.get(`/merge_requests/${iid}/approval_state`)),
          api.page(`/merge_requests/${iid}/discussions`, { per_page: 100 }),
          optional<{ data: unknown }>(api.page(`/merge_requests/${iid}/draft_notes`, { per_page: 100 })),
          optional<{ data: unknown }>(api.page('/labels', { per_page: 100 })),
        ])

        const labelColors = new Map<string, string>()
        if (labelPage && Array.isArray(labelPage.data)) {
          for (const l of labelPage.data as RawLabel[]) if (l.name && l.color) labelColors.set(l.name, l.color)
        }

        // Check if target branch is protected or release*
        let isProtectedTarget = /^release/i.test(rawMr.target_branch)
        if (!isProtectedTarget && !OPEN_TARGETS.has(rawMr.target_branch)) {
          const branch = await optional<{ protected?: boolean }>(api.get(`/repository/branches/${encodeURIComponent(rawMr.target_branch)}`))
          if (branch?.protected !== false) isProtectedTarget = true
        }

        // Latest pipeline & jobs
        let pipelineId = rawMr.head_pipeline?.id
        let headPipeline = rawMr.head_pipeline ?? undefined
        if (!pipelineId) {
          const pList = await optional<{ id: number; status: string; ref: string; sha: string; created_at?: string; web_url: string }[]>(
            api.get(`/merge_requests/${iid}/pipelines`, { per_page: 1 }),
          )
          if (Array.isArray(pList) && pList[0]) {
            pipelineId = pList[0].id
            headPipeline = pList[0]
          }
        }

        let jobs: Record<string, unknown>[] = []
        let downstream: Record<string, unknown>[] = []
        if (pipelineId !== undefined) {
          type RawJob = Parameters<typeof jobView>[0]
          type RawBridge = { name: string; stage: string; status: string; downstream_pipeline?: { id: number; status: string } | null }
          const [jobsPage, bridges] = await Promise.all([
            optional<{ data: unknown }>(api.page(`/pipelines/${pipelineId}/jobs`, { per_page: 100 })),
            optional<RawBridge[]>(api.get(`/pipelines/${pipelineId}/bridges`, { per_page: 100 })),
          ])
          if (jobsPage && Array.isArray(jobsPage.data)) {
            jobs = (jobsPage.data as RawJob[]).map(jobView)
          }
          if (Array.isArray(bridges)) {
            downstream = bridges.map((b) => ({
              name: b.name,
              stage: b.stage,
              status: b.status,
              pipeline: b.downstream_pipeline?.id,
              pipelineStatus: b.downstream_pipeline?.status,
            }))
          }
        }

        const discussions = items<RawDiscussion>(discPage)
          .map((d) => {
            const notes = d.notes.filter((n) => !n.system)
            const first = notes[0]
            if (!first) return undefined
            const at = first.position
            const resolvable = notes.some((n) => Boolean(n.resolvable))
            const resolved = resolvable ? notes.every((n) => !n.resolvable || Boolean(n.resolved)) : false
            return {
              id: d.id,
              resolvable,
              resolved,
              at: at?.new_path || at?.old_path ? { path: at.new_path ?? at.old_path, line: at.new_line ?? undefined, oldLine: at.old_line ?? undefined } : undefined,
              notes: notes.map((n) => ({
                id: n.id,
                author: n.author?.username ?? 'unknown',
                createdAt: n.created_at ?? '',
                body: n.body,
              })),
            }
          })
          .filter((d): d is NonNullable<typeof d> => d !== undefined)

        const drafts = (draftPage && Array.isArray(draftPage.data) ? (draftPage.data as RawDraft[]) : []).map((d) => {
          const at = d.position
          return {
            id: d.id,
            discussionId: d.discussion_id ?? undefined,
            at: at?.new_path || at?.old_path ? { path: at.new_path ?? at.old_path, line: at.new_line ?? undefined, oldLine: at.old_line ?? undefined } : undefined,
            body: d.note,
          }
        })

        // Detect matching local repo & active review worktree
        let localRepoPath: string | undefined
        let activeWorktree: WorktreeInfo | null = null
        try {
          const state = await store.load()
          const repos = await resolveActiveRepos(state.repos, tokens, deps, runtime)
          const matched = repos.find(
            (r) => r.host.toLowerCase() === host.toLowerCase() && r.project.toLowerCase() === project.toLowerCase(),
          )
          if (matched) {
            localRepoPath = matched.path
            activeWorktree = await findWorktree(runtimeGitAt(deps, runtime), {
              repoPath: matched.path,
              sourceBranch: rawMr.source_branch,
              iid,
              dataDir: runtime.dataDir,
            })
          }
        } catch {}

        const view = statusView(rawMr, approvals, approvalState)
        const detailed: Record<string, unknown> = {
          ...view,
          host,
          project,
          currentUser: meUser?.username,
          description: rawMr.description ?? '',
          createdAt: rawMr.created_at ?? '',
          updatedAt: rawMr.updated_at ?? '',
          authorName: rawMr.author?.name,
          isProtectedTarget,
          ...(localRepoPath ? { localRepoPath } : {}),
          activeWorktree,
          labels: (rawMr.labels ?? []).map((l) => ({ name: l, ...(labelColors.get(l) ? { color: labelColors.get(l) } : {}) })),
          pipeline: headPipeline
            ? {
                id: headPipeline.id,
                status: normalizeStatus(headPipeline.status) ?? headPipeline.status,
                sha: headPipeline.sha,
                url: headPipeline.web_url,
                jobs,
                downstream,
              }
            : null,
          discussions,
          drafts,
        }

        return wrap({
          text: `Loaded detail for ${project}!${iid}.`,
          structuredContent: { detail: detailed },
        })
      }

      case 'gitlab_ui_diff': {
        const { host, token, project } = requireHostAndProject(tokens, input)
        const iid = need(id(input.iid, 'iid'), 'gitlab_ui_diff requires iid.')
        const api = gitlab(deps.fetch, host, project, token)

        type RawDiff = {
          old_path: string
          new_path: string
          diff: string
          new_file?: boolean
          deleted_file?: boolean
          renamed_file?: boolean
          too_large?: boolean
          collapsed?: boolean
        }

        let diffs: RawDiff[]
        let next: number | undefined
        try {
          const page = await api.page(`/merge_requests/${iid}/diffs`, paging(input, 100))
          diffs = items<RawDiff>(page)
          next = page.next
        } catch (err) {
          if (!(err instanceof GitlabError) || err.status !== 404) throw err
          diffs = ((await api.get(`/merge_requests/${iid}/changes`)) as { changes?: RawDiff[] }).changes ?? []
        }

        const files = diffs.map((d) => {
          const stats = countDiffStats(d.diff ?? '')
          const status = d.new_file ? 'A' : d.deleted_file ? 'D' : d.renamed_file ? 'R' : 'M'
          return {
            oldPath: d.old_path,
            newPath: d.new_path,
            status,
            diff: d.diff ?? '',
            tooLarge: Boolean(d.too_large),
            collapsed: Boolean(d.collapsed),
            additions: stats.additions,
            deletions: stats.deletions,
          }
        })

        return wrap({
          text: `Loaded ${files.length} diff file(s) for ${project}!${iid}.`,
          structuredContent: { host, project, iid, files, ...(next !== undefined ? { next } : {}) },
        })
      }

      case 'gitlab_ui_job_log': {
        const { host, token, project } = requireHostAndProject(tokens, input)
        const jobId = need(id(input.jobId, 'jobId'), 'gitlab_ui_job_log requires jobId.')
        const mode = str(input.mode) ?? 'errors'
        const ctx = makeHostCtx(deps, host, token, project)
        const text = await jobLog(ctx, { jobId, mode, lines: input.lines, pattern: input.pattern })
        return wrap({
          text,
          structuredContent: { jobId, mode, text },
        })
      }

      case 'gitlab_ui_action': {
        const { host, token, project } = requireHostAndProject(tokens, input)
        const action = need(str(input.action), 'gitlab_ui_action requires action.')
        const ctx = makeHostCtx(deps, host, token, project)
        const iid = id(input.iid, 'iid')

        let message: string
        switch (action) {
          case 'approve':
          case 'unapprove':
          case 'rebase':
            message = await mr(ctx, { action, iid: need(iid, `${action} requires iid.`), allowOthers: true })
            break
          case 'toggle_draft': {
            const targetIid = need(iid, 'toggle_draft requires iid.')
            const draftVal = bool(input.draft)
            if (draftVal === undefined) throw new InputError('toggle_draft requires boolean draft.')
            message = await mr(ctx, { action: 'update', iid: targetIid, draft: draftVal, allowOthers: true })
            break
          }
          case 'close':
          case 'reopen':
            message = await mr(ctx, { action: 'update', iid: need(iid, `${action} requires iid.`), stateEvent: action, allowOthers: true })
            break
          case 'update_description': {
            const targetIid = need(iid, 'update_description requires iid.')
            if (typeof input.description !== 'string') throw new InputError('update_description requires string description.')
            message = await mr(ctx, { action: 'update', iid: targetIid, description: input.description, allowOthers: true })
            break
          }
          case 'merge':
            message = await mr(ctx, {
              action: 'merge',
              iid: need(iid, 'merge requires iid.'),
              sha: input.sha,
              squash: input.squash,
              removeSourceBranch: input.removeSourceBranch,
              whenPipelineSucceeds: input.whenPipelineSucceeds,
              allowOthers: bool(input.confirmOthers) === true,
              allowProtectedTarget: bool(input.confirmProtectedTarget) === true,
            })
            break
          case 'comment':
            message = await comment(ctx, { action: 'comment', iid: need(iid, 'comment requires iid.'), body: input.body, draft: input.draft, allowOthers: true })
            break
          case 'reply':
            message = await comment(ctx, { action: 'reply', iid: need(iid, 'reply requires iid.'), discussionId: input.discussionId, body: input.body, draft: input.draft, allowOthers: true })
            break
          case 'line_comment':
            message = await comment(ctx, {
              action: 'line',
              iid: need(iid, 'line_comment requires iid.'),
              path: input.path,
              line: input.line,
              oldLine: input.oldLine,
              body: input.body,
              draft: input.draft,
              allowOthers: true,
            })
            break
          case 'edit_note':
            message = await comment(ctx, { action: 'edit', iid: need(iid, 'edit_note requires iid.'), noteId: input.noteId, body: input.body, draft: input.draft, allowOthers: true })
            break
          case 'resolve':
          case 'unresolve':
            message = await comment(ctx, { action, iid: need(iid, `${action} requires iid.`), discussionId: input.discussionId, allowOthers: true })
            break
          case 'publish_draft':
            message = await comment(ctx, { action: 'publish', iid: need(iid, 'publish_draft requires iid.'), noteId: need(id(input.noteId, 'noteId'), 'publish_draft requires noteId.'), allowOthers: true })
            break
          case 'publish_all_drafts':
            message = await comment(ctx, { action: 'publish', iid: need(iid, 'publish_all_drafts requires iid.'), allowOthers: true })
            break
          case 'retry_job':
            message = await pipeline(ctx, { action: 'retry', jobId: need(id(input.jobId, 'jobId'), 'retry_job requires jobId.') })
            break
          case 'cancel_job':
            message = await pipeline(ctx, { action: 'cancel', jobId: need(id(input.jobId, 'jobId'), 'cancel_job requires jobId.') })
            break
          case 'play_job':
            message = await pipeline(ctx, { action: 'play', jobId: need(id(input.jobId, 'jobId'), 'play_job requires jobId.') })
            break
          case 'retry_pipeline':
            message = await pipeline(ctx, { action: 'retry', pipelineId: need(id(input.pipelineId, 'pipelineId'), 'retry_pipeline requires pipelineId.') })
            break
          case 'cancel_pipeline':
            message = await pipeline(ctx, { action: 'cancel', pipelineId: need(id(input.pipelineId, 'pipelineId'), 'cancel_pipeline requires pipelineId.') })
            break
          case 'run_pipeline':
            message = await pipeline(ctx, { action: 'run', iid: need(iid, 'run_pipeline requires iid.'), allowOthers: true })
            break
          case 'checkout_worktree': {
            const targetIid = need(iid, 'checkout_worktree requires iid.')
            const state = await store.load()
            const repos = await resolveActiveRepos(state.repos, tokens, deps, runtime)
            const matched = repos.find(
              (r) => r.host.toLowerCase() === host.toLowerCase() && r.project.toLowerCase() === project.toLowerCase(),
            )
            if (!matched) {
              throw new InputError(`No local repository registered for ${project} on ${host}. Add it in the Repos menu first.`)
            }
            const rawMr = (await ctx.api.get(`/merge_requests/${targetIid}`)) as RestMr
            const fork =
              typeof rawMr.source_project_id === 'number' && typeof rawMr.target_project_id === 'number'
                ? rawMr.source_project_id !== rawMr.target_project_id
                : false
            const result = await checkoutWorktree(runtimeGitAt(deps, runtime), {
              repoPath: matched.path,
              sourceBranch: rawMr.source_branch,
              targetBranch: rawMr.target_branch,
              iid: targetIid,
              fork,
              dataDir: runtime.dataDir,
            })
            const summary = result.reused
              ? `Synced worktree (${result.branch}) at ${result.path}`
              : `Checked out ${result.branch} at ${result.path}`
            return wrap({
              text: summary,
              structuredContent: { ok: true, action, message: summary, ...result },
            })
          }
          case 'remove_worktree': {
            const state = await store.load()
            const repos = await resolveActiveRepos(state.repos, tokens, deps, runtime)
            const matched = repos.find(
              (r) => r.host.toLowerCase() === host.toLowerCase() && r.project.toLowerCase() === project.toLowerCase(),
            )
            if (!matched) {
              throw new InputError(`No local repository registered for ${project} on ${host}.`)
            }
            let targetPath = str(input.worktreePath)
            if (!targetPath && iid !== undefined) {
              const rawMr = (await ctx.api.get(`/merge_requests/${iid}`)) as RestMr
              const found = await findWorktree(runtimeGitAt(deps, runtime), {
                repoPath: matched.path,
                sourceBranch: rawMr.source_branch,
                iid,
                dataDir: runtime.dataDir,
              })
              targetPath = found?.path
            }
            const worktreePath = need(targetPath, 'remove_worktree requires worktreePath.')
            const result = await removeWorktree(runtimeGitAt(deps, runtime), {
              repoPath: matched.path,
              worktreePath,
              force: bool(input.force) === true,
              dataDir: runtime.dataDir,
            })
            const summary = result.removed
              ? `Removed worktree at ${result.path}`
              : result.message
            return wrap({
              text: summary,
              structuredContent: { ok: result.removed, action, message: summary, ...result },
            })
          }
          default:
            throw new InputError(`Unknown UI action: ${action}`)
        }
        return wrap({ text: message, structuredContent: { ok: true, action, message } })
      }
    }
  } catch (err) {
    if (err instanceof NoProjectError) return wrap({ text: 'Project is required.', isError: true })
    if (err instanceof InputError) return wrap({ text: err.message, isError: true })
    if (err instanceof GitlabError) {
      const host = hostName(input.host) ?? 'gitlab'
      const project = projectPath(input.project) ?? host
      return wrap({ text: errorText(err, project, host), isError: true })
    }
    return wrap({ text: err instanceof Error ? err.message : String(err), isError: true })
  }
}
