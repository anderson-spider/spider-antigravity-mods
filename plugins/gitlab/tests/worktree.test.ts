import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputError } from '../server/context.ts'
import { gitAt } from '../server/node.ts'
import {
  checkoutWorktree,
  findWorktree,
  getWorktreeRoot,
  isPathInside,
  removeWorktree,
  validateBranchName,
  type GitAt,
} from '../server/worktree.ts'
import { expect, test } from './expect.ts'

test('validateBranchName rejects unsafe refs and isPathInside blocks escapes', () => {
  expect(validateBranchName('feat/my-branch_1.0', 'source')).toBe('feat/my-branch_1.0')
  for (const bad of ['', '   ', '-flag', 'feat/..bad', 'has space', 'ctrl\nchar', 'bad.lock', 'a//b']) {
    let threw = false
    try {
      validateBranchName(bad, 'source')
    } catch (err) {
      threw = err instanceof InputError
    }
    expect(threw).toBe(true)
  }

  expect(isPathInside('/tmp/wt/repo/branch', '/tmp/wt')).toBe(true)
  expect(isPathInside('/tmp/wt', '/tmp/wt')).toBe(false)
  expect(isPathInside('/tmp/wt/../other', '/tmp/wt')).toBe(false)
  expect(isPathInside('/tmp/wt2/repo/branch', '/tmp/wt')).toBe(false)
})

test('checkoutWorktree handles fork MRs, main-checkout collisions, existing worktree reuse, and ff-only warnings', async () => {
  const dataDir = '/tmp/gitlab-wt-unit'
  const root = getWorktreeRoot(dataDir)
  const calls: { cwd: string; args: string[] }[] = []

  // Case 1: Fork MR fetches merge-requests/<iid>/head into review/mr-<iid>
  const forkGit: GitAt = async (cwd, args) => {
    calls.push({ cwd, args })
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return { exitCode: 0, stdout: '/repos/app/.git\n' }
    if (args[0] === 'fetch') return { exitCode: 0, stdout: '' }
    if (args[0] === 'worktree' && args[1] === 'list') return { exitCode: 0, stdout: 'worktree /repos/app\nbranch refs/heads/main\n' }
    if (args[0] === 'show-ref') return { exitCode: 1, stdout: '' }
    if (args[0] === 'worktree' && args[1] === 'add') return { exitCode: 0, stdout: '' }
    return { exitCode: 0, stdout: '' }
  }
  const forkRes = await checkoutWorktree(
    forkGit,
    { repoPath: '/repos/app', sourceBranch: 'fix/typo', targetBranch: 'main', iid: 42, fork: true, dataDir },
    { mkdir: async () => {}, realpath: async (p) => p },
  )
  expect(forkRes.branch).toBe('review/mr-42')
  expect(forkRes.reused).toBe(false)
  expect(forkRes.path).toBe(join(root, 'app', 'review-mr-42'))
  expect(calls.some((c) => c.args.includes('+merge-requests/42/head:refs/review/mr-42'))).toBe(true)

  // Case 2: Source branch checked out in main repo -> switches to review/<branch>
  const collisionCalls: string[][] = []
  const collisionGit: GitAt = async (_cwd, args) => {
    collisionCalls.push(args)
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return { exitCode: 0, stdout: '/repos/app/.git\n' }
    if (args[0] === 'fetch') return { exitCode: 0, stdout: '' }
    if (args[0] === 'worktree' && args[1] === 'list') return { exitCode: 0, stdout: 'worktree /repos/app\nbranch refs/heads/feat/ui\n' }
    if (args[0] === 'show-ref') return { exitCode: 1, stdout: '' }
    if (args[0] === 'worktree' && args[1] === 'add') return { exitCode: 0, stdout: '' }
    return { exitCode: 0, stdout: '' }
  }
  const colRes = await checkoutWorktree(
    collisionGit,
    { repoPath: '/repos/app', sourceBranch: 'feat/ui', targetBranch: 'main', iid: 7, dataDir },
    { mkdir: async () => {}, realpath: async (p) => p },
  )
  expect(colRes.branch).toBe('review/feat/ui')
  expect(colRes.reused).toBe(false)
  expect(collisionCalls.some((a) => a[0] === 'worktree' && a[1] === 'add' && a.includes('review/feat/ui'))).toBe(true)

  // Case 2b: sourceBranch already starts with review/ (or review/<branch> also external) -> falls back to review/mr-<iid>
  const reviewPrefixGit: GitAt = async (_cwd, args) => {
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return { exitCode: 0, stdout: '/repos/app/.git\n' }
    if (args[0] === 'fetch') return { exitCode: 0, stdout: '' }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return { exitCode: 0, stdout: 'worktree /repos/app\nbranch refs/heads/review/cleanup\n' }
    }
    if (args[0] === 'show-ref') return { exitCode: 1, stdout: '' }
    if (args[0] === 'worktree' && args[1] === 'add') return { exitCode: 0, stdout: '' }
    return { exitCode: 0, stdout: '' }
  }
  const reviewFallbackRes = await checkoutWorktree(
    reviewPrefixGit,
    { repoPath: '/repos/app', sourceBranch: 'review/cleanup', targetBranch: 'main', iid: 88, dataDir },
    { mkdir: async () => {}, realpath: async (p) => p },
  )
  expect(reviewFallbackRes.branch).toBe('review/mr-88')
  expect(reviewFallbackRes.reused).toBe(false)

  // Case 3: Existing worktree inside worktreeRoot is reused; ff-only failure becomes a warning
  const reuseWt = join(root, 'app', 'feat-ui')
  const reuseGit: GitAt = async (_cwd, args) => {
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return { exitCode: 0, stdout: '/repos/app/.git\n' }
    if (args[0] === 'fetch') return { exitCode: 0, stdout: '' }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return { exitCode: 0, stdout: `worktree /repos/app\nbranch refs/heads/main\n\nworktree ${reuseWt}\nbranch refs/heads/feat/ui\n` }
    }
    if (args[0] === 'merge') return { exitCode: 1, stdout: '', stderr: 'Not possible to fast-forward' }
    return { exitCode: 0, stdout: '' }
  }
  const reuseRes = await checkoutWorktree(
    reuseGit,
    { repoPath: '/repos/app', sourceBranch: 'feat/ui', targetBranch: 'main', iid: 7, dataDir },
    { mkdir: async () => {}, realpath: async (p) => p },
  )
  expect(reuseRes.reused).toBe(true)
  expect(reuseRes.path).toBe(reuseWt)
  expect(reuseRes.warnings).toHaveLength(1)
  expect(reuseRes.warnings[0]).toContain('could not fast-forward')
})

test('removeWorktree enforces path containment, dirty/ahead guard, and forced review branch cleanup', async () => {
  const dataDir = '/tmp/gitlab-wt-rm'
  const root = getWorktreeRoot(dataDir)
  const managed = join(root, 'app', 'review-mr-10')

  // Outside worktreeRoot is strictly refused
  let escapedErr = false
  try {
    await removeWorktree(async () => ({ exitCode: 0, stdout: '' }), { repoPath: '/repos/app', worktreePath: '/repos/app', dataDir })
  } catch (err) {
    escapedErr = err instanceof InputError
  }
  expect(escapedErr).toBe(true)

  // Dirty + ahead refuses without force
  const removedCalls: string[][] = []
  const dirtyGit: GitAt = async (_cwd, args) => {
    removedCalls.push(args)
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return { exitCode: 0, stdout: '/repos/app/.git\n' }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return { exitCode: 0, stdout: `worktree ${managed}\nbranch refs/heads/review/mr-10\n` }
    }
    if (args[0] === 'status') return { exitCode: 0, stdout: ' M src/index.ts\n?? temp.txt\n' }
    if (args[0] === 'rev-list') return { exitCode: 0, stdout: '1\n' }
    return { exitCode: 0, stdout: '' }
  }

  const guarded = await removeWorktree(dirtyGit, { repoPath: '/repos/app', worktreePath: managed, dataDir }, { realpath: async (p) => p })
  expect(guarded).toMatchObject({ removed: false, needsForce: true, dirty: 2, ahead: 1 })
  expect(removedCalls.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(false)

  // With force: true removes worktree with --force and deletes review/ branch with -D
  const forced = await removeWorktree(
    dirtyGit,
    { repoPath: '/repos/app', worktreePath: managed, force: true, dataDir },
    { realpath: async (p) => p },
  )
  expect(forced).toEqual({ removed: true, path: managed, branchDeleted: 'review/mr-10', warnings: [] })
  expect(removedCalls.some((a) => a[0] === 'worktree' && a[1] === 'remove' && a[2] === '--force')).toBe(true)
  expect(removedCalls.some((a) => a[0] === 'branch' && a[1] === '-D' && a[2] === 'review/mr-10')).toBe(true)
})

test('real git integration: checkoutWorktree, findWorktree, dirty guard, and removeWorktree', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gitlab-wt-real-')))
  const bare = join(base, 'origin.git')
  const clone = join(base, 'app')
  const dataDir = join(base, 'data')
  try {
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    }
    mkdirSync(bare, { recursive: true })
    execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main'], { cwd: bare, env: gitEnv })
    execFileSync('git', ['clone', '-q', bare, clone], { cwd: base, env: gitEnv })
    writeFileSync(join(clone, 'README.md'), 'hello\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: clone, env: gitEnv })

    execFileSync('git', ['checkout', '-q', '-b', 'feat/review-me'], { cwd: clone, env: gitEnv })
    writeFileSync(join(clone, 'feature.txt'), 'v1\n', 'utf8')
    execFileSync('git', ['add', 'feature.txt'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add feature'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'feat/review-me'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['branch', '-D', 'feat/review-me'], { cwd: clone, env: gitEnv })

    const checked = await checkoutWorktree(gitAt, {
      repoPath: clone,
      sourceBranch: 'feat/review-me',
      targetBranch: 'main',
      iid: 99,
      dataDir,
    })
    expect(checked.reused).toBe(false)
    expect(checked.branch).toBe('feat/review-me')
    expect(isPathInside(checked.path, getWorktreeRoot(dataDir))).toBe(true)

    const found = await findWorktree(gitAt, { repoPath: clone, sourceBranch: 'feat/review-me', iid: 99, dataDir })
    expect(found).toEqual({ path: checked.path, branch: 'feat/review-me' })

    // Dirty the worktree -> guarded removal refuses without force
    writeFileSync(join(checked.path, 'scratch.txt'), 'uncommitted\n', 'utf8')
    const refused = await removeWorktree(gitAt, { repoPath: clone, worktreePath: checked.path, dataDir })
    expect(refused).toMatchObject({ removed: false, needsForce: true, dirty: 1 })

    // Force removal succeeds and findWorktree returns null
    const forced = await removeWorktree(gitAt, { repoPath: clone, worktreePath: checked.path, force: true, dataDir })
    expect(forced).toMatchObject({ removed: true, path: checked.path })
    const after = await findWorktree(gitAt, { repoPath: clone, sourceBranch: 'feat/review-me', iid: 99, dataDir })
    expect(after).toBeNull()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('real git integration with symlinked dataDir: checkout, find, reuse/sync, and review branch removal', async () => {
  const base = mkdtempSync(join(tmpdir(), 'gitlab-wt-symlink-'))
  const bare = join(base, 'origin.git')
  const clone = join(base, 'app')
  const realData = join(base, 'real-data')
  const linkedData = join(base, 'linked-data')
  try {
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    }
    mkdirSync(bare, { recursive: true })
    mkdirSync(realData, { recursive: true })
    symlinkSync(realData, linkedData)

    execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main'], { cwd: bare, env: gitEnv })
    execFileSync('git', ['clone', '-q', bare, clone], { cwd: base, env: gitEnv })
    writeFileSync(join(clone, 'README.md'), 'v1\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: clone, env: gitEnv })

    // Keep feat/symlink checked out in main clone so checkoutWorktree creates a review/ branch
    execFileSync('git', ['checkout', '-q', '-b', 'feat/symlink'], { cwd: clone, env: gitEnv })
    writeFileSync(join(clone, 'a.txt'), 'hello\n', 'utf8')
    execFileSync('git', ['add', 'a.txt'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feat'], { cwd: clone, env: gitEnv })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'feat/symlink'], { cwd: clone, env: gitEnv })

    const created = await checkoutWorktree(gitAt, {
      repoPath: clone,
      sourceBranch: 'feat/symlink',
      targetBranch: 'main',
      iid: 12,
      dataDir: linkedData,
    })
    expect(created.reused).toBe(false)
    expect(created.branch).toBe('review/feat/symlink')

    const found = await findWorktree(gitAt, { repoPath: clone, sourceBranch: 'feat/symlink', iid: 12, dataDir: linkedData })
    expect(found).toEqual({ path: created.path, branch: 'review/feat/symlink' })

    const synced = await checkoutWorktree(gitAt, {
      repoPath: clone,
      sourceBranch: 'feat/symlink',
      targetBranch: 'main',
      iid: 12,
      dataDir: linkedData,
    })
    expect(synced.reused).toBe(true)
    expect(synced.path).toBe(created.path)

    const removed = await removeWorktree(gitAt, { repoPath: clone, worktreePath: created.path, dataDir: linkedData })
    expect(removed).toEqual({ removed: true, path: created.path, branchDeleted: 'review/feat/symlink', warnings: [] })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
