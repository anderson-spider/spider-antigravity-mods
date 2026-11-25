// Pure, dependency-injected git worktree checkout, discovery, and safe removal for GitLab MR reviews.
// Zero runtime npm dependencies: only Node built-ins and an injected `gitAt(cwd, args)` runner.
import { mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { InputError } from './context.ts'

export type GitResult = { exitCode: number; stdout: string; stderr?: string }
export type GitAt = (cwd: string, args: string[]) => Promise<GitResult>

export type WorktreeEntry = {
  path: string
  branch?: string
  bare?: boolean
  detached?: boolean
}

export type WorktreeInfo = {
  path: string
  branch: string
}

export type WorktreeCheckoutInput = {
  repoPath: string
  sourceBranch: string
  targetBranch: string
  iid: number
  fork?: boolean
  dataDir?: string
}

export type WorktreeCheckoutResult = {
  path: string
  branch: string
  reused: boolean
  warnings: string[]
}

export type WorktreeRemoveInput = {
  repoPath: string
  worktreePath: string
  force?: boolean
  dataDir?: string
}

export type WorktreeRemoveResult =
  | { removed: true; path: string; branchDeleted?: string; warnings: string[] }
  | { removed: false; needsForce: true; dirty: number; ahead: number; message: string }

export type WorktreeFs = {
  mkdir?: (path: string) => Promise<void>
  realpath?: (path: string) => Promise<string>
}

const DEFAULT_FS: Required<WorktreeFs> = {
  mkdir: async (dir) => { await mkdir(dir, { recursive: true }) },
  realpath: async (p) => realpath(p),
}

/** Root directory holding managed review worktrees (`<dataDir>/worktrees` or `<tmpdir>/gitlab-mcp-worktrees`). */
export function getWorktreeRoot(dataDir?: string): string {
  return dataDir ? resolve(dataDir, 'worktrees') : resolve(tmpdir(), 'gitlab-mcp-worktrees')
}

/** Validates a git branch name against option injection, traversal, and invalid git ref characters. */
export function validateBranchName(name: string, label: string): string {
  const trimmed = name.trim()
  if (
    !trimmed ||
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    /[\x00-\x1f\x7f\s~^:?*[\]\\]/.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('.lock') ||
    trimmed.includes('//')
  ) {
    throw new InputError(`Invalid ${label} branch name: ${name}`)
  }
  return trimmed
}

/** Checks that `childPath` is strictly nested inside `parentDir` (never equal to or escaping it). */
export function isPathInside(childPath: string, parentDir: string): boolean {
  const parent = resolve(parentDir)
  const child = resolve(childPath)
  const rel = relative(parent, child)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Canonicalizes `target` via `realpath`, walking up to the deepest existing ancestor when the path does not yet exist
 * (handling macOS `/var` -> `/private/var` and symlinked data directories) and falling back to `resolve()` for virtual paths.
 */
export async function canonicalizePath(
  target: string,
  realpathFn: (p: string) => Promise<string> = DEFAULT_FS.realpath,
): Promise<string> {
  const abs = resolve(target)
  const tail: string[] = []
  let cur = abs
  while (true) {
    try {
      const real = await realpathFn(cur)
      return tail.length > 0 ? resolve(real, ...tail.reverse()) : resolve(real)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs
      tail.push(basename(cur))
      cur = parent
    }
  }
}

/** Parses `git worktree list --porcelain` output into structured entries. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const rawLine of porcelain.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      if (current) {
        entries.push(current)
        current = null
      }
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length).trim() }
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (current && line === 'bare') {
      current.bare = true
    } else if (current && line === 'detached') {
      current.detached = true
    }
  }
  if (current) entries.push(current)
  return entries
}

/** Resolves the main repository checkout directory for any path or worktree inside a git repo. */
export async function resolveMainRepo(gitAt: GitAt, repoPath: string): Promise<string> {
  const common = await gitAt(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common.exitCode === 0 && common.stdout.trim()) {
    const raw = common.stdout.trim().replace(/[\\/]+$/, '')
    const abs = isAbsolute(raw) ? raw : resolve(repoPath, raw)
    if (abs.endsWith('/.git') || abs.endsWith('\\.git')) {
      return abs.slice(0, -5)
    }
  }
  const top = await gitAt(repoPath, ['rev-parse', '--show-toplevel'])
  if (top.exitCode === 0 && top.stdout.trim()) {
    return resolve(top.stdout.trim())
  }
  return resolve(repoPath)
}

function slug(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
  return cleaned || 'wt'
}

function gitErrorDetail(res: GitResult): string {
  return (res.stderr || res.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 240)
}

function isMissingRemoteRef(res: GitResult): boolean {
  const detail = `${res.stderr ?? ''}\n${res.stdout ?? ''}`.toLowerCase()
  return (
    detail.includes("couldn't find remote ref") ||
    detail.includes('no such ref') ||
    detail.includes('not our ref') ||
    detail.includes('remote ref does not exist')
  )
}

async function refExists(gitAt: GitAt, cwd: string, fullRef: string): Promise<boolean> {
  const res = await gitAt(cwd, ['show-ref', '--verify', '--quiet', fullRef])
  return res.exitCode === 0
}

/** Finds an active managed review worktree matching the MR's source branch or review aliases. */
export async function findWorktree(
  gitAt: GitAt,
  input: { repoPath: string; sourceBranch: string; iid: number; dataDir?: string },
  fsDeps: WorktreeFs = {},
): Promise<WorktreeInfo | null> {
  const fsImpl = { ...DEFAULT_FS, ...fsDeps }
  const mainRepo = await resolveMainRepo(gitAt, input.repoPath)
  const worktreeRoot = await canonicalizePath(getWorktreeRoot(input.dataDir), fsImpl.realpath)
  const listed = await gitAt(mainRepo, ['worktree', 'list', '--porcelain'])
  if (listed.exitCode !== 0) return null
  const candidates = new Set([
    input.sourceBranch,
    `review/${input.sourceBranch}`,
    `review/mr-${input.iid}`,
  ])
  for (const entry of parseWorktreeList(listed.stdout)) {
    if (!entry.branch || !candidates.has(entry.branch)) continue
    const canonPath = await canonicalizePath(entry.path, fsImpl.realpath)
    if (isPathInside(canonPath, worktreeRoot)) {
      return { path: canonPath, branch: entry.branch }
    }
  }
  return null
}

/** Creates or syncs an isolated git worktree for reviewing a merge request (supports fork MRs and offline fallback). */
export async function checkoutWorktree(
  gitAt: GitAt,
  input: WorktreeCheckoutInput,
  fsDeps: WorktreeFs = {},
): Promise<WorktreeCheckoutResult> {
  const fsImpl = { ...DEFAULT_FS, ...fsDeps }
  const sourceBranch = validateBranchName(input.sourceBranch, 'source')
  const targetBranch = validateBranchName(input.targetBranch, 'target')
  if (!Number.isSafeInteger(input.iid) || input.iid <= 0) {
    throw new InputError('iid must be a positive integer.')
  }

  const mainRepo = await resolveMainRepo(gitAt, input.repoPath)
  const worktreeRoot = await canonicalizePath(getWorktreeRoot(input.dataDir), fsImpl.realpath)
  const warnings: string[] = []

  // Fetch target branch (best-effort so diffing against target stays up to date)
  const targetFetch = await gitAt(mainRepo, ['fetch', '--quiet', 'origin', targetBranch])
  if (targetFetch.exitCode !== 0) {
    const detail = gitErrorDetail(targetFetch)
    warnings.push(`Could not fetch target branch origin/${targetBranch}${detail ? `: ${detail}` : ''}`)
  }

  let localBranch: string
  let startRef: string
  let trackRemote = false

  const fetchMrHead = async (): Promise<boolean> => {
    const mrRef = `refs/review/mr-${input.iid}`
    const res = await gitAt(mainRepo, ['fetch', '--quiet', 'origin', `+merge-requests/${input.iid}/head:${mrRef}`])
    if (res.exitCode !== 0) return false
    localBranch = `review/mr-${input.iid}`
    startRef = mrRef
    trackRemote = false
    return true
  }

  if (input.fork) {
    const ok = await fetchMrHead()
    if (!ok) {
      throw new Error(`Could not fetch fork MR !${input.iid} head ref (merge-requests/${input.iid}/head) from origin.`)
    }
  } else {
    const srcFetch = await gitAt(mainRepo, ['fetch', '--quiet', 'origin', sourceBranch])
    if (srcFetch.exitCode === 0) {
      localBranch = sourceBranch
      startRef = `origin/${sourceBranch}`
      trackRemote = true
    } else if (isMissingRemoteRef(srcFetch) && (await fetchMrHead())) {
      // Branch lives in a fork or deleted remote ref; fetched via GitLab's merge-requests/<iid>/head ref.
    } else if (await refExists(gitAt, mainRepo, `refs/heads/${sourceBranch}`)) {
      const detail = gitErrorDetail(srcFetch)
      warnings.push(`Fetch of origin/${sourceBranch} failed${detail ? ` (${detail})` : ''}; using existing local branch.`)
      localBranch = sourceBranch
      startRef = `refs/heads/${sourceBranch}`
      trackRemote = false
    } else if (await refExists(gitAt, mainRepo, `refs/remotes/origin/${sourceBranch}`)) {
      const detail = gitErrorDetail(srcFetch)
      warnings.push(`Fetch of origin/${sourceBranch} failed${detail ? ` (${detail})` : ''}; using cached origin/${sourceBranch}.`)
      localBranch = sourceBranch
      startRef = `origin/${sourceBranch}`
      trackRemote = true
    } else {
      const detail = gitErrorDetail(srcFetch)
      throw new Error(`Failed to fetch origin/${sourceBranch}${detail ? `: ${detail}` : ''}, and no local ref exists.`)
    }
  }

  const listRes = await gitAt(mainRepo, ['worktree', 'list', '--porcelain'])
  const rawExisting = listRes.exitCode === 0 ? parseWorktreeList(listRes.stdout) : []
  const existing = await Promise.all(
    rawExisting.map(async (e) => ({ ...e, canonPath: await canonicalizePath(e.path, fsImpl.realpath) })),
  )

  const findByBranch = (branchName: string) => existing.find((e) => e.branch === branchName)

  const syncExisting = async (wtPath: string, branchName: string): Promise<WorktreeCheckoutResult> => {
    if (startRef !== `refs/heads/${branchName}`) {
      const ff = await gitAt(wtPath, ['merge', '--ff-only', '--quiet', startRef])
      if (ff.exitCode !== 0) {
        const detail = gitErrorDetail(ff)
        warnings.push(`Worktree at ${wtPath} could not fast-forward to ${startRef}${detail ? `: ${detail}` : ''}; left untouched.`)
      }
    }
    return { path: wtPath, branch: branchName, reused: true, warnings }
  }

  // Pick a branch name that does not collide with an external worktree (e.g. main checkout).
  // Order: primary -> review/<primary> (if not already prefixed) -> review/mr-<iid>.
  const candidates: string[] = [localBranch!]
  if (!localBranch!.startsWith('review/')) candidates.push(`review/${localBranch!}`)
  const mrFallback = `review/mr-${input.iid}`
  if (!candidates.includes(mrFallback)) candidates.push(mrFallback)

  let chosenBranch: string | undefined
  for (const candidate of candidates) {
    const match = findByBranch(candidate)
    if (!match) {
      chosenBranch = candidate
      break
    }
    if (isPathInside(match.canonPath, worktreeRoot)) {
      return syncExisting(match.canonPath, candidate)
    }
  }
  if (!chosenBranch) {
    throw new Error(`Branch ${localBranch!} and fallback ${mrFallback} are already checked out outside the managed worktree root.`)
  }
  localBranch = chosenBranch

  const repoSlug = slug(basename(mainRepo))
  const branchSlug = slug(localBranch)
  const wtPath = resolve(worktreeRoot, repoSlug, branchSlug)
  if (!isPathInside(wtPath, worktreeRoot)) {
    throw new InputError('Computed worktree path escapes the managed worktree root.')
  }

  await fsImpl.mkdir(resolve(worktreeRoot, repoSlug))

  const hasLocalBranch = await refExists(gitAt, mainRepo, `refs/heads/${localBranch}`)
  if (hasLocalBranch) {
    const addRes = await gitAt(mainRepo, ['worktree', 'add', wtPath, localBranch])
    if (addRes.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${gitErrorDetail(addRes) || 'unknown error'}`)
    }
    if (startRef! !== `refs/heads/${localBranch}`) {
      const ff = await gitAt(wtPath, ['merge', '--ff-only', '--quiet', startRef!])
      if (ff.exitCode !== 0) {
        const detail = gitErrorDetail(ff)
        warnings.push(`Existing branch ${localBranch} could not fast-forward to ${startRef!}${detail ? `: ${detail}` : ''}; left untouched.`)
      }
    }
  } else {
    const addArgs = trackRemote
      ? ['worktree', 'add', '--track', '-b', localBranch, wtPath, startRef!]
      : ['worktree', 'add', '-b', localBranch, wtPath, startRef!]
    const addRes = await gitAt(mainRepo, addArgs)
    if (addRes.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${gitErrorDetail(addRes) || 'unknown error'}`)
    }
  }

  const finalPath = await canonicalizePath(wtPath, fsImpl.realpath)
  return { path: finalPath, branch: localBranch, reused: false, warnings }
}

/** Safely removes a managed review worktree, refusing paths outside worktreeRoot and unpushed/dirty trees unless forced. */
export async function removeWorktree(
  gitAt: GitAt,
  input: WorktreeRemoveInput,
  fsDeps: WorktreeFs = {},
): Promise<WorktreeRemoveResult> {
  const fsImpl = { ...DEFAULT_FS, ...fsDeps }
  const worktreeRoot = await canonicalizePath(getWorktreeRoot(input.dataDir), fsImpl.realpath)
  const target = await canonicalizePath(input.worktreePath, fsImpl.realpath)
  if (!isPathInside(target, worktreeRoot)) {
    throw new InputError('Refusing to remove worktree outside the managed worktree root.')
  }

  const mainRepo = await resolveMainRepo(gitAt, input.repoPath)
  const listRes = await gitAt(mainRepo, ['worktree', 'list', '--porcelain'])
  const rawEntries = listRes.exitCode === 0 ? parseWorktreeList(listRes.stdout) : []
  const entries = await Promise.all(
    rawEntries.map(async (e) => ({ ...e, canonPath: await canonicalizePath(e.path, fsImpl.realpath) })),
  )
  const matched = entries.find((e) => e.canonPath === target)

  const statusRes = await gitAt(target, ['status', '--porcelain'])
  const dirty = statusRes.exitCode === 0 ? statusRes.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length : 0

  const aheadRes = await gitAt(target, ['rev-list', '--count', '@{upstream}..HEAD'])
  const ahead = aheadRes.exitCode === 0 ? Number(aheadRes.stdout.trim()) || 0 : 0

  if ((dirty > 0 || ahead > 0) && !input.force) {
    const parts: string[] = []
    if (dirty > 0) parts.push(`${dirty} uncommitted change${dirty === 1 ? '' : 's'}`)
    if (ahead > 0) parts.push(`${ahead} unpushed commit${ahead === 1 ? '' : 's'}`)
    return {
      removed: false,
      needsForce: true,
      dirty,
      ahead,
      message: `Worktree has ${parts.join(' and ')}. Confirm force removal to delete it.`,
    }
  }

  const rmArgs = input.force ? ['worktree', 'remove', '--force', target] : ['worktree', 'remove', target]
  const rmRes = await gitAt(mainRepo, rmArgs)
  if (rmRes.exitCode !== 0) {
    throw new Error(`git worktree remove failed: ${gitErrorDetail(rmRes) || 'unknown error'}`)
  }

  const warnings: string[] = []
  let branchDeleted: string | undefined
  if (matched?.branch && matched.branch.startsWith('review/')) {
    const delRes = await gitAt(mainRepo, ['branch', input.force ? '-D' : '-d', matched.branch])
    if (delRes.exitCode === 0) {
      branchDeleted = matched.branch
    } else {
      const detail = gitErrorDetail(delRes)
      warnings.push(`Removed worktree, but could not delete branch ${matched.branch}${detail ? `: ${detail}` : ''}`)
    }
  }

  return { removed: true, path: target, ...(branchDeleted ? { branchDeleted } : {}), warnings }
}
