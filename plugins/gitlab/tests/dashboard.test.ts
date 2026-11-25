import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchResponse } from '../server/api.ts'
import { runDashboardTool } from '../server/dashboard.ts'
import type { Deps } from '../server/run.ts'
import { createStore } from '../server/store.ts'
import { expect, test } from './expect.ts'

function makeDeps(opts: {
  remote?: string
  branch?: string
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>
}): Deps {
  return {
    git: async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return opts.remote ? { exitCode: 0, stdout: opts.remote } : { exitCode: 1, stdout: '' }
      }
      if (args[0] === 'remote') return { exitCode: 1, stdout: '' }
      if (args[0] === 'rev-parse') return opts.branch ? { exitCode: 0, stdout: opts.branch } : { exitCode: 1, stdout: '' }
      return { exitCode: 1, stdout: '' }
    },
    ssh: async () => ({ exitCode: 1, stdout: '' }),
    fetch: opts.fetch ?? (async () => ({ status: 404, ok: false, text: '{}' })),
    env: async () => undefined,
    clock: { now: () => Date.parse('2026-11-25T12:00:00Z'), sleep: async () => {} },
  }
}

const okJson = (data: unknown): FetchResponse => ({ status: 200, ok: true, text: JSON.stringify(data), headers: {} })

test('gitlab_mr_dashboard detects workspace scope and lists configured hosts without leaking tokens', async () => {
  const store = createStore()
  const deps = makeDeps({ remote: 'git@gitlab.example.com:platform/app.git', branch: 'feat/ui' })
  const reply = await runDashboardTool(
    'gitlab_mr_dashboard',
    deps,
    {},
    { tokens: 'gitlab.example.com=glpat-secret-1,gitlab.com=glpat-secret-2' },
    store,
  )
  expect(reply.isError).toBeUndefined()
  expect(reply.text).not.toContain('glpat-secret')
  expect(reply.structuredContent?.configuredHosts).toEqual(['gitlab.example.com', 'gitlab.com'])
  expect(reply.structuredContent?.initialScope).toBe('project')
  expect(reply.structuredContent?.workspace).toEqual({ host: 'gitlab.example.com', project: 'platform/app', branch: 'feat/ui' })
})

test('gitlab_ui_list uses GraphQL enrichment, falls back to REST per host, and isolates host failures', async () => {
  const store = createStore()
  const deps = makeDeps({
    fetch: async (url, init) => {
      // Host 1: GraphQL succeeds with full enrichment
      if (url === 'https://gitlab.example.com/api/graphql') {
        expect(init.headers['PRIVATE-TOKEN']).toBe('tok-one')
        return okJson({
          data: {
            currentUser: {
              username: 'ann',
              reviewing: {
                nodes: [
                  {
                    iid: '42',
                    title: 'GraphQL enriched MR',
                    state: 'opened',
                    draft: false,
                    sourceBranch: 'feat/gql',
                    targetBranch: 'main',
                    webUrl: 'https://gitlab.example.com/g/p/-/merge_requests/42',
                    updatedAt: '2026-11-25T11:50:00Z',
                    conflicts: false,
                    detailedMergeStatus: 'mergeable',
                    diffHeadSha: 'a'.repeat(40),
                    author: { username: 'bob', name: 'Bob' },
                    assignees: { nodes: [] },
                    reviewers: { nodes: [{ username: 'ann' }] },
                    labels: { nodes: [{ title: 'backend', color: '#1f75cb' }] },
                    headPipeline: { id: 'gid://gitlab/Ci::Pipeline/900', status: 'SUCCESS' },
                    approved: true,
                    approvalsRequired: 1,
                    approvalsLeft: 0,
                    approvedBy: { nodes: [{ username: 'ann' }] },
                    diffStatsSummary: { additions: 50, deletions: 12, fileCount: 3 },
                    project: { fullPath: 'g/p' },
                  },
                ],
              },
              authored: { nodes: [] },
              assigned: { nodes: [] },
            },
          },
        })
      }
      // Host 2: GraphQL returns 404 -> automatic REST fallback
      if (url === 'https://gitlab.legacy.test/api/graphql') {
        return { status: 404, ok: false, text: 'Not Found' }
      }
      if (url === 'https://gitlab.legacy.test/api/v4/user') {
        expect(init.headers['PRIVATE-TOKEN']).toBe('tok-two')
        return okJson({ id: 7, username: 'ann' })
      }
      if (url.startsWith('https://gitlab.legacy.test/api/v4/merge_requests')) {
        if (url.includes('author_username=ann')) {
          return okJson([
            {
              iid: 9,
              title: 'Legacy REST MR',
              state: 'opened',
              draft: true,
              source_branch: 'wip/legacy',
              target_branch: 'main',
              updated_at: '2026-11-25T10:00:00Z',
              author: { username: 'ann' },
              assignees: [],
              reviewers: [],
              labels: ['legacy'],
              references: { full: 'old/repo!9' },
              web_url: 'https://gitlab.legacy.test/old/repo/-/merge_requests/9',
            },
          ])
        }
        return okJson([])
      }
      // Host 3: unreachable / 500 error (isolated without failing hosts 1 and 2)
      if (url.startsWith('https://gitlab.down.test/')) {
        return { status: 500, ok: false, text: JSON.stringify({ message: 'Internal error tok-three' }) }
      }
      return { status: 404, ok: false, text: '{}' }
    },
  })

  const reply = await runDashboardTool(
    'gitlab_ui_list',
    deps,
    { state: 'opened' },
    { tokens: 'gitlab.example.com=tok-one,gitlab.legacy.test=tok-two,gitlab.down.test=tok-three' },
    store,
  )

  expect(reply.isError).toBeUndefined()
  const sc = reply.structuredContent as {
    mergeRequests: { id: string; host: string; additions?: number; labels: { name: string; color?: string }[]; pipeline?: { id?: number; status: string } }[]
    enriched: boolean
    errors: { host: string; message: string }[]
  }
  expect(sc.enriched).toBe(true)
  expect(sc.mergeRequests).toHaveLength(2)
  const gqlItem = sc.mergeRequests.find((m) => m.host === 'gitlab.example.com')!
  expect(gqlItem.additions).toBe(50)
  expect(gqlItem.labels[0]).toEqual({ name: 'backend', color: '#1f75cb' })
  expect(gqlItem.pipeline).toEqual({ id: 900, status: 'success' })

  const restItem = sc.mergeRequests.find((m) => m.host === 'gitlab.legacy.test')!
  expect(restItem.id).toBe('gitlab.legacy.test:old/repo:9')

  // Host 3 error is isolated and its token is masked inside structuredContent
  expect(sc.errors).toHaveLength(1)
  expect(sc.errors[0]?.host).toBe('gitlab.down.test')
  expect(sc.errors[0]?.message).not.toContain('tok-three')
  expect(sc.errors[0]?.message).toContain('[token]')
})

test('gitlab_ui_detail aggregates MR data and flags release* protected target; gitlab_ui_action enforces merge guards', async () => {
  const store = createStore()
  const sha = 'b'.repeat(40)
  let merged = false
  const deps = makeDeps({
    fetch: async (url, init) => {
      if (url === 'https://gitlab.example.com/api/v4/user') return okJson({ id: 1, username: 'ann' })
      if (url === 'https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests/15' && init.method === 'GET') {
        return okJson({
          iid: 15,
          title: 'Release hotfix',
          description: 'Fix rounding',
          state: 'opened',
          draft: false,
          source_branch: 'hotfix/round',
          target_branch: 'release/2.14',
          sha,
          author: { id: 2, username: 'bob', name: 'Bob' },
          assignees: [],
          reviewers: [{ username: 'ann' }],
          labels: ['bug'],
          detailed_merge_status: 'mergeable',
          has_conflicts: false,
          blocking_discussions_resolved: true,
          head_pipeline: { id: 77, status: 'success', sha, web_url: 'https://gitlab.example.com/g/p/-/pipelines/77' },
          web_url: 'https://gitlab.example.com/g/p/-/merge_requests/15',
        })
      }
      if (url.endsWith('/approvals')) return okJson({ approved: true, approvals_left: 0, approved_by: [{ user: { username: 'ann' } }] })
      if (url.endsWith('/approval_state')) return okJson({ rules: [{ name: 'Release', approved: true, approvals_required: 1, approved_by: [{ username: 'ann' }] }] })
      if (url.includes('/discussions')) return okJson([{ id: 'abc123', notes: [{ id: 1, body: 'Looks good', system: false, resolvable: true, resolved: true, author: { username: 'ann' } }] }])
      if (url.includes('/draft_notes')) return okJson([])
      if (url.includes('/labels')) return okJson([{ name: 'bug', color: '#cf222e' }])
      if (url.includes('/pipelines/77/jobs')) return okJson([{ id: 301, name: 'test', stage: 'test', status: 'success', duration: 30, web_url: 'https://gitlab.example.com/g/p/-/jobs/301' }])
      if (url.includes('/pipelines/77/bridges')) return okJson([])
      if (url.endsWith('/merge_requests/15/merge') && init.method === 'PUT') {
        merged = true
        return okJson({ iid: 15, title: 'Release hotfix', state: 'merged', source_branch: 'hotfix/round', target_branch: 'release/2.14', web_url: 'https://gitlab.example.com/g/p/-/merge_requests/15' })
      }
      return { status: 404, ok: false, text: '{}' }
    },
  })

  const detail = await runDashboardTool('gitlab_ui_detail', deps, { host: 'gitlab.example.com', project: 'g/p', iid: 15 }, { tokens: 'gitlab.example.com=tok' }, store)
  expect(detail.isError).toBeUndefined()
  const d = (detail.structuredContent as { detail: { isProtectedTarget: boolean; labels: { name: string; color?: string }[]; pipeline: { jobs: unknown[] } } }).detail
  expect(d.isProtectedTarget).toBe(true)
  expect(d.labels[0]).toEqual({ name: 'bug', color: '#cf222e' })
  expect(d.pipeline.jobs).toHaveLength(1)

  // Refused without confirmOthers
  const deniedOthers = await runDashboardTool('gitlab_ui_action', deps, { host: 'gitlab.example.com', project: 'g/p', iid: 15, action: 'merge', sha }, { tokens: 'gitlab.example.com=tok' }, store)
  expect(deniedOthers.isError).toBe(true)
  expect(merged).toBe(false)

  // Refused without confirmProtectedTarget
  const deniedTarget = await runDashboardTool(
    'gitlab_ui_action',
    deps,
    { host: 'gitlab.example.com', project: 'g/p', iid: 15, action: 'merge', sha, confirmOthers: true },
    { tokens: 'gitlab.example.com=tok' },
    store,
  )
  expect(deniedTarget.isError).toBe(true)
  expect(merged).toBe(false)

  // Succeeds when both confirmations are explicitly passed
  const allowed = await runDashboardTool(
    'gitlab_ui_action',
    deps,
    { host: 'gitlab.example.com', project: 'g/p', iid: 15, action: 'merge', sha, confirmOthers: true, confirmProtectedTarget: true, squash: true },
    { tokens: 'gitlab.example.com=tok' },
    store,
  )
  expect(allowed.isError).toBeUndefined()
  expect(merged).toBe(true)
})

test('gitlab_ui_list skips GraphQL and uses REST directly for numeric project IDs', async () => {
  const store = createStore()
  let graphqlCalled = false
  const deps = makeDeps({
    fetch: async (url) => {
      if (url.endsWith('/api/graphql')) {
        graphqlCalled = true
        return okJson({ data: { currentUser: { username: 'ann' }, project: null } })
      }
      if (url === 'https://gitlab.example.com/api/v4/user') return okJson({ id: 1, username: 'ann' })
      if (url.startsWith('https://gitlab.example.com/api/v4/projects/12345/merge_requests')) {
        return okJson([
          {
            iid: 8,
            title: 'Numeric project MR',
            state: 'opened',
            draft: false,
            source_branch: 'feat/num',
            target_branch: 'main',
            updated_at: '2026-11-25T11:00:00Z',
            author: { username: 'ann' },
            assignees: [],
            reviewers: [],
            labels: [],
            references: { full: 'group/service!8' },
            web_url: 'https://gitlab.example.com/group/service/-/merge_requests/8',
          },
        ])
      }
      return { status: 404, ok: false, text: '{}' }
    },
  })

  const reply = await runDashboardTool(
    'gitlab_ui_list',
    deps,
    { host: 'gitlab.example.com', project: '12345', state: 'opened' },
    { tokens: 'gitlab.example.com=tok' },
    store,
  )
  expect(reply.isError).toBeUndefined()
  expect(graphqlCalled).toBe(false)
  const sc = reply.structuredContent as { mergeRequests: { id: string; iid: number }[]; enriched: boolean; errors: unknown[] }
  expect(sc.enriched).toBe(false)
  expect(sc.errors).toEqual([])
  expect(sc.mergeRequests).toHaveLength(1)
  expect(sc.mergeRequests[0]?.id).toBe('gitlab.example.com:group/service:8')
})

test('gitlab_ui_list falls back to REST when GraphQL returns partial errors with null currentUser', async () => {
  const store = createStore()
  let graphqlAttempts = 0
  const deps = makeDeps({
    fetch: async (url) => {
      if (url === 'https://gitlab.example.com/api/graphql') {
        graphqlAttempts++
        return okJson({
          data: { currentUser: null },
          errors: [{ message: 'Field approvalRules does not exist' }],
        })
      }
      if (url === 'https://gitlab.example.com/api/v4/user') return okJson({ id: 1, username: 'ann' })
      if (url.startsWith('https://gitlab.example.com/api/v4/merge_requests')) {
        if (url.includes('author_username=ann')) {
          return okJson([
            {
              iid: 21,
              title: 'Fallback REST MR',
              state: 'opened',
              draft: false,
              source_branch: 'feat/fallback',
              target_branch: 'main',
              updated_at: '2026-11-25T11:30:00Z',
              author: { username: 'ann' },
              assignees: [],
              reviewers: [],
              labels: [],
              references: { full: 'group/repo!21' },
              web_url: 'https://gitlab.example.com/group/repo/-/merge_requests/21',
            },
          ])
        }
        return okJson([])
      }
      return { status: 404, ok: false, text: '{}' }
    },
  })

  const reply = await runDashboardTool(
    'gitlab_ui_list',
    deps,
    { host: 'gitlab.example.com', state: 'opened' },
    { tokens: 'gitlab.example.com=tok' },
    store,
  )
  expect(reply.isError).toBeUndefined()
  // First attempt with EE fields, second retry with CE-safe fields, then REST fallback
  expect(graphqlAttempts).toBe(2)
  const sc = reply.structuredContent as { mergeRequests: { id: string }[]; enriched: boolean; errors: unknown[] }
  expect(sc.enriched).toBe(false)
  expect(sc.errors).toEqual([])
  expect(sc.mergeRequests).toHaveLength(1)
  expect(sc.mergeRequests[0]?.id).toBe('gitlab.example.com:group/repo:21')
})

test('gitlab_ui_list falls back to REST when GraphQL returns null currentUser without errors', async () => {
  const store = createStore()
  let graphqlAttempts = 0
  const deps = makeDeps({
    fetch: async (url) => {
      if (url === 'https://gitlab.example.com/api/graphql') {
        graphqlAttempts++
        return okJson({ data: { currentUser: null } })
      }
      if (url === 'https://gitlab.example.com/api/v4/user') return okJson({ id: 1, username: 'ann' })
      if (url.startsWith('https://gitlab.example.com/api/v4/merge_requests')) {
        if (url.includes('author_username=ann')) {
          return okJson([
            {
              iid: 22,
              title: 'Fallback REST MR without GQL errors',
              state: 'opened',
              draft: false,
              source_branch: 'feat/null-user',
              target_branch: 'main',
              updated_at: '2026-11-25T11:35:00Z',
              author: { username: 'ann' },
              assignees: [],
              reviewers: [],
              labels: [],
              references: { full: 'group/repo!22' },
              web_url: 'https://gitlab.example.com/group/repo/-/merge_requests/22',
            },
          ])
        }
        return okJson([])
      }
      return { status: 404, ok: false, text: '{}' }
    },
  })

  const reply = await runDashboardTool(
    'gitlab_ui_list',
    deps,
    { host: 'gitlab.example.com', state: 'opened' },
    { tokens: 'gitlab.example.com=tok' },
    store,
  )
  expect(reply.isError).toBeUndefined()
  expect(graphqlAttempts).toBe(2)
  const sc = reply.structuredContent as { mergeRequests: { id: string }[]; enriched: boolean; errors: unknown[] }
  expect(sc.enriched).toBe(false)
  expect(sc.errors).toEqual([])
  expect(sc.mergeRequests).toHaveLength(1)
  expect(sc.mergeRequests[0]?.id).toBe('gitlab.example.com:group/repo:22')
})

test('gitlab_ui_action toggle_draft delegates directly to mr update without a redundant GET', async () => {
  const store = createStore()
  let getCount = 0
  const putBodies: Record<string, unknown>[] = []
  let currentTitle = 'Add dashboard filters'
  const deps = makeDeps({
    fetch: async (url, init) => {
      if (url === 'https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests/33' && init.method === 'GET') {
        getCount++
        return okJson({
          iid: 33,
          title: currentTitle,
          state: 'opened',
          draft: currentTitle.startsWith('Draft:'),
          source_branch: 'feat/filters',
          target_branch: 'main',
          author: { id: 2, username: 'bob' },
          web_url: 'https://gitlab.example.com/g/p/-/merge_requests/33',
        })
      }
      if (url === 'https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests/33' && init.method === 'PUT') {
        const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
        putBodies.push(body)
        if (typeof body.title === 'string') currentTitle = body.title
        return okJson({
          iid: 33,
          title: currentTitle,
          state: 'opened',
          draft: currentTitle.startsWith('Draft:'),
          source_branch: 'feat/filters',
          target_branch: 'main',
          author: { id: 2, username: 'bob' },
          web_url: 'https://gitlab.example.com/g/p/-/merge_requests/33',
        })
      }
      return { status: 404, ok: false, text: '{}' }
    },
  })

  const toDraft = await runDashboardTool(
    'gitlab_ui_action',
    deps,
    { host: 'gitlab.example.com', project: 'g/p', iid: 33, action: 'toggle_draft', draft: true },
    { tokens: 'gitlab.example.com=tok' },
    store,
  )
  expect(toDraft.isError).toBeUndefined()
  expect(getCount).toBe(1)
  expect(putBodies[0]).toEqual({ title: 'Draft: Add dashboard filters' })

  const toReady = await runDashboardTool(
    'gitlab_ui_action',
    deps,
    { host: 'gitlab.example.com', project: 'g/p', iid: 33, action: 'toggle_draft', draft: false },
    { tokens: 'gitlab.example.com=tok' },
    store,
  )
  expect(toReady.isError).toBeUndefined()
  expect(getCount).toBe(2)
  expect(putBodies[1]).toEqual({ title: 'Add dashboard filters' })
})

test('gitlab_ui_state add_repo / remove_repo validates local repos, expands ~/, and merges with workspace cwds', async () => {
  const store = createStore()
  const gitByCwd: Record<string, string> = {
    '/home/dev/work/service-a': 'git@gitlab.example.com:team/service-a.git',
    '/home/dev/work/service-b': 'git@work-alias:team/service-b.git',
  }
  const deps = makeDeps({})
  deps.ssh = async (args) =>
    args[1] === 'work-alias' ? { exitCode: 0, stdout: 'hostname gitlab.example.com\n' } : { exitCode: 1, stdout: '' }

  const runtime = {
    cwds: ['/home/dev/work/service-a'],
    homedir: () => '/home/dev',
    isDir: async (p: string) => p in gitByCwd || p === '/home/dev/work/service-b/subdir',
    gitAt: async (cwd: string, args: string[]) => {
      const repoRoot = cwd.startsWith('/home/dev/work/service-b') ? '/home/dev/work/service-b' : cwd
      if (!(repoRoot in gitByCwd)) return { exitCode: 128, stdout: '' }
      if (args.includes('--git-common-dir')) return { exitCode: 0, stdout: `${repoRoot}/.git\n` }
      if (args[0] === 'remote' && args[1] === 'get-url') return { exitCode: 0, stdout: `${gitByCwd[repoRoot]}\n` }
      return { exitCode: 1, stdout: '' }
    },
  }

  const added = await runDashboardTool(
    'gitlab_ui_state',
    deps,
    { action: 'add_repo', path: '~/work/service-b/subdir' },
    { tokens: 'gitlab.example.com=glpat-secret' },
    store,
    runtime,
  )
  expect(added.isError).toBeUndefined()
  const addSc = added.structuredContent as {
    added: { path: string; host: string; project: string }
    registeredRepos: { path: string; host: string; project: string; source: string }[]
  }
  expect(addSc.added).toEqual({ path: '/home/dev/work/service-b', host: 'gitlab.example.com', project: 'team/service-b' })
  expect(addSc.registeredRepos).toEqual([
    { path: '/home/dev/work/service-a', host: 'gitlab.example.com', project: 'team/service-a', source: 'workspace' },
    { path: '/home/dev/work/service-b', host: 'gitlab.example.com', project: 'team/service-b', source: 'registered' },
  ])

  const removed = await runDashboardTool(
    'gitlab_ui_state',
    deps,
    { action: 'remove_repo', path: '/home/dev/work/service-b' },
    { tokens: 'gitlab.example.com=glpat-secret' },
    store,
    runtime,
  )
  expect(removed.isError).toBeUndefined()
  const remSc = removed.structuredContent as { registeredRepos: { project: string; source: string }[] }
  expect(remSc.registeredRepos).toEqual([{ path: '/home/dev/work/service-a', host: 'gitlab.example.com', project: 'team/service-a', source: 'workspace' }])

  // Pure store writes (e.g. save_preferences / set_file_viewed) do NOT spawn git/ssh
  let gitCallsDuringPrefSave = 0
  const spyRuntime = {
    ...runtime,
    gitAt: async (cwd: string, args: string[]) => {
      gitCallsDuringPrefSave++
      return runtime.gitAt(cwd, args)
    },
  }
  const spyDeps = makeDeps({})
  spyDeps.git = async () => {
    gitCallsDuringPrefSave++
    return { exitCode: 1, stdout: '' }
  }
  const prefRes = await runDashboardTool(
    'gitlab_ui_state',
    spyDeps,
    { action: 'save_preferences', diffMode: 'split' },
    { tokens: 'gitlab.example.com=glpat-secret' },
    store,
    spyRuntime,
  )
  expect(prefRes.isError).toBeUndefined()
  expect(gitCallsDuringPrefSave).toBe(0)
})

test('gitlab_ui_list batches multi-repo queries in groups of 3, isolates null projects to REST, computes isWaitingOnMe/fork, and falls back to mine when empty', async () => {
  const store = createStore()
  const gqlBatches: Record<string, unknown>[] = []
  const deps = makeDeps({
    fetch: async (url, init) => {
      if (url === 'https://gitlab.example.com/api/graphql') {
        const body = JSON.parse(init.body ?? '{}') as { query: string; variables?: Record<string, unknown> }
        if (body.query.includes('DashboardBatchProjectMrs')) {
          gqlBatches.push(body.variables ?? {})
          const vars = body.variables ?? {}
          if (vars.p0 === 'g/p1') {
            return okJson({
              data: {
                currentUser: { username: 'ann' },
                p0: {
                  mergeRequests: {
                    nodes: [
                      {
                        iid: '1',
                        title: 'Waiting MR',
                        state: 'opened',
                        draft: false,
                        sourceBranch: 'feat/1',
                        targetBranch: 'main',
                        webUrl: 'https://gitlab.example.com/g/p1/-/merge_requests/1',
                        updatedAt: '2026-11-25T11:00:00Z',
                        author: { username: 'bob' },
                        reviewers: { nodes: [{ username: 'ann' }] },
                        approvedBy: { nodes: [] },
                        project: { fullPath: 'g/p1' },
                        sourceProject: { fullPath: 'fork-user/p1' },
                      },
                    ],
                  },
                },
                p1: null, // Missing in GraphQL -> isolated to REST without dropping p0/p2
                p2: {
                  mergeRequests: {
                    nodes: [
                      {
                        iid: '3',
                        title: 'Already approved MR',
                        state: 'opened',
                        draft: false,
                        sourceBranch: 'feat/3',
                        targetBranch: 'main',
                        webUrl: 'https://gitlab.example.com/g/p3/-/merge_requests/3',
                        updatedAt: '2026-11-25T11:00:00Z',
                        author: { username: 'bob' },
                        reviewers: { nodes: [{ username: 'ann' }] },
                        approvedBy: { nodes: [{ username: 'ann' }] },
                        project: { fullPath: 'g/p3' },
                        sourceProject: { fullPath: 'g/p3' },
                      },
                    ],
                  },
                },
              },
            })
          }
          return okJson({
            data: {
              currentUser: { username: 'ann' },
              p0: {
                mergeRequests: {
                  nodes: [
                    {
                      iid: '4',
                      title: 'Fourth repo MR',
                      state: 'opened',
                      draft: false,
                      sourceBranch: 'feat/4',
                      targetBranch: 'main',
                      webUrl: 'https://gitlab.example.com/g/p4/-/merge_requests/4',
                      updatedAt: '2026-11-25T11:00:00Z',
                      author: { username: 'carol' },
                      reviewers: { nodes: [] },
                      project: { fullPath: 'g/p4' },
                    },
                  ],
                },
              },
            },
          })
        }
        // Fallback mine GraphQL query when no repos are registered
        return okJson({ data: { currentUser: { username: 'ann', authored: { nodes: [] }, reviewing: { nodes: [] }, assigned: { nodes: [] } } } })
      }
      if (url.startsWith('https://gitlab.example.com/api/v4/projects/g%2Fp2/merge_requests')) {
        return okJson([
          {
            iid: 2,
            title: 'Isolated REST MR',
            state: 'opened',
            draft: false,
            source_branch: 'feat/2',
            target_branch: 'main',
            updated_at: '2026-11-25T11:00:00Z',
            author: { username: 'dan' },
            assignees: [],
            reviewers: [],
            labels: [],
            source_project_id: 100,
            target_project_id: 200,
            references: { full: 'g/p2!2' },
            web_url: 'https://gitlab.example.com/g/p2/-/merge_requests/2',
          },
        ])
      }
      return { status: 404, ok: false, text: '{}' }
    },
  })

  // With zero repos: falls back to currentUser and reports usedFallbackMine: true
  const emptyRes = await runDashboardTool('gitlab_ui_list', deps, { state: 'opened' }, { tokens: 'gitlab.example.com=tok' }, store)
  expect(emptyRes.isError).toBeUndefined()
  expect(emptyRes.structuredContent?.usedFallbackMine).toBe(true)

  // Register 4 repos -> batched as 3 + 1
  for (const p of ['g/p1', 'g/p2', 'g/p3', 'g/p4']) {
    await store.addRepo({ path: `/repos/${p}`, host: 'gitlab.example.com', project: p })
  }
  const multiRes = await runDashboardTool('gitlab_ui_list', deps, { state: 'opened', scope: 'projects' }, { tokens: 'gitlab.example.com=tok' }, store)
  expect(multiRes.isError).toBeUndefined()
  expect(gqlBatches).toHaveLength(2)
  const sc = multiRes.structuredContent as {
    mergeRequests: { iid: number; isWaitingOnMe: boolean; fork?: boolean }[]
    enriched: boolean
    usedFallbackMine: boolean
    errors: unknown[]
  }
  expect(sc.usedFallbackMine).toBe(false)
  expect(sc.enriched).toBe(true)
  expect(sc.errors).toEqual([])
  expect(sc.mergeRequests.map((m) => m.iid).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  expect(sc.mergeRequests.find((m) => m.iid === 1)).toMatchObject({ isWaitingOnMe: true, fork: true })
  expect(sc.mergeRequests.find((m) => m.iid === 2)).toMatchObject({ isWaitingOnMe: false, fork: true })
  expect(sc.mergeRequests.find((m) => m.iid === 3)).toMatchObject({ isWaitingOnMe: false, fork: false })
})

test('gitlab_ui_detail includes localRepoPath and activeWorktree, and checkout_worktree/remove_worktree actions work', async () => {
  const store = createStore()
  await store.addRepo({ path: '/repos/app', host: 'gitlab.example.com', project: 'g/p' })
  const dataDir = mkdtempSync(join(tmpdir(), 'gitlab-dash-wt-'))
  const managedWt = join(realpathSync(dataDir), 'worktrees', 'app', 'feat-wt')
  let worktreeActive = false

  try {
    const deps = makeDeps({
      fetch: async (url) => {
        if (url === 'https://gitlab.example.com/api/v4/user') return okJson({ id: 1, username: 'ann' })
        if (url === 'https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests/55') {
          return okJson({
            iid: 55,
            title: 'Worktree MR',
            state: 'opened',
            draft: false,
            source_branch: 'feat/wt',
            target_branch: 'main',
            author: { username: 'bob' },
            source_project_id: 10,
            target_project_id: 10,
            web_url: 'https://gitlab.example.com/g/p/-/merge_requests/55',
          })
        }
        if (url.includes('/discussions') || url.includes('/draft_notes') || url.includes('/labels')) return okJson([])
        return { status: 404, ok: false, text: '{}' }
      },
    })

    const runtime = {
      dataDir,
      gitAt: async (_cwd: string, args: string[]) => {
        if (args.includes('--git-common-dir')) return { exitCode: 0, stdout: '/repos/app/.git\n' }
        if (args[0] === 'fetch') return { exitCode: 0, stdout: '' }
        if (args[0] === 'worktree' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: worktreeActive
              ? `worktree /repos/app\nbranch refs/heads/main\n\nworktree ${managedWt}\nbranch refs/heads/feat/wt\n`
              : 'worktree /repos/app\nbranch refs/heads/main\n',
          }
        }
        if (args[0] === 'show-ref') return { exitCode: 1, stdout: '' }
        if (args[0] === 'worktree' && args[1] === 'add') {
          worktreeActive = true
          return { exitCode: 0, stdout: '' }
        }
        if (args[0] === 'status') return { exitCode: 0, stdout: ' M file.ts\n' }
        if (args[0] === 'rev-list') return { exitCode: 0, stdout: '0\n' }
        if (args[0] === 'worktree' && args[1] === 'remove') {
          worktreeActive = false
          return { exitCode: 0, stdout: '' }
        }
        return { exitCode: 0, stdout: '' }
      },
    }

    const checkout = await runDashboardTool(
      'gitlab_ui_action',
      deps,
      { host: 'gitlab.example.com', project: 'g/p', iid: 55, action: 'checkout_worktree' },
      { tokens: 'gitlab.example.com=tok' },
      store,
      runtime,
    )
    expect(checkout.isError).toBeUndefined()
    expect(checkout.structuredContent).toMatchObject({ ok: true, branch: 'feat/wt', path: managedWt, reused: false })

    const detail = await runDashboardTool(
      'gitlab_ui_detail',
      deps,
      { host: 'gitlab.example.com', project: 'g/p', iid: 55 },
      { tokens: 'gitlab.example.com=tok' },
      store,
      runtime,
    )
    expect(detail.isError).toBeUndefined()
    expect(detail.structuredContent?.detail).toMatchObject({
      localRepoPath: '/repos/app',
      activeWorktree: { path: managedWt, branch: 'feat/wt' },
    })

    // Guarded remove refuses when dirty without force
    const rmGuard = await runDashboardTool(
      'gitlab_ui_action',
      deps,
      { host: 'gitlab.example.com', project: 'g/p', iid: 55, action: 'remove_worktree', worktreePath: managedWt },
      { tokens: 'gitlab.example.com=tok' },
      store,
      runtime,
    )
    expect(rmGuard.isError).toBeUndefined()
    expect(rmGuard.structuredContent).toMatchObject({ ok: false, removed: false, needsForce: true, dirty: 1 })

    // Forced remove succeeds
    const rmForce = await runDashboardTool(
      'gitlab_ui_action',
      deps,
      { host: 'gitlab.example.com', project: 'g/p', iid: 55, action: 'remove_worktree', worktreePath: managedWt, force: true },
      { tokens: 'gitlab.example.com=tok' },
      store,
      runtime,
    )
    expect(rmForce.isError).toBeUndefined()
    expect(rmForce.structuredContent).toMatchObject({ ok: true, removed: true, path: managedWt })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
