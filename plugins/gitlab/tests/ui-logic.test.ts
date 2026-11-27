import type { App } from '@modelcontextprotocol/ext-apps'
import { ServerBridge } from '../ui/src/bridge.ts'
import { buildSplitPairs, parseUnifiedDiff, tokenizeCode } from '../ui/src/lib/diff.ts'
import { buildDiffFileTree, filterDiffFiles, splitFilePath } from '../ui/src/lib/fileTree.ts'
import { parseMarkdown, toggleMarkdownCheckbox } from '../ui/src/lib/markdown.ts'
import { filterAndSortMrs, formatRelativeTime, groupMrs, parseSearchQuery, readinessScore } from '../ui/src/lib/query.ts'
import type { DiffFile, MrListItem } from '../ui/src/types.ts'
import { expect, test } from './expect.ts'

const sampleMr = (overrides: Partial<MrListItem>): MrListItem => ({
  id: 'gitlab.example.com:g/p:1',
  host: 'gitlab.example.com',
  project: 'g/p',
  iid: 1,
  title: 'Base MR',
  state: 'opened',
  draft: false,
  involvement: 'authored',
  isAuthored: true,
  isReviewing: false,
  author: { username: 'ann' },
  assignees: [],
  reviewers: [],
  sourceBranch: 'feat/a',
  targetBranch: 'main',
  updatedAt: '2026-11-25T11:00:00Z',
  conflicts: false,
  labels: [],
  url: 'https://gitlab.example.com/g/p/-/merge_requests/1',
  ...overrides,
})

test('parseSearchQuery extracts label, author, draft, checks qualifiers and free text', () => {
  const parsed = parseSearchQuery('label:Backend author:@Maya draft:no checks:failing payment retry')
  expect(parsed.labels).toEqual(['backend'])
  expect(parsed.author).toBe('maya')
  expect(parsed.draft).toBe(false)
  expect(parsed.checks).toBe('failing')
  expect(parsed.free).toBe('payment retry')
  expect(parsed.chips).toEqual(['label:backend', 'author:maya', 'draft:no', 'checks:failing'])
})

test('filterAndSortMrs orders by Merge readiness and groupMrs splits Reviewing vs Authored', () => {
  const ready = sampleMr({ id: '1', iid: 1, title: 'Ready', pipeline: { status: 'success' }, approvals: { approved: true, by: ['bob'] }, mergeStatus: 'mergeable' })
  const failing = sampleMr({ id: '2', iid: 2, title: 'Failing', isAuthored: false, isReviewing: true, involvement: 'reviewing', pipeline: { status: 'failed' } })
  const draft = sampleMr({ id: '3', iid: 3, title: 'Draft', draft: true })

  expect(readinessScore(ready) < readinessScore(failing)).toBe(true)
  expect(readinessScore(failing) < readinessScore(draft)).toBe(true)

  const sorted = filterAndSortMrs([draft, failing, ready], { q: '', state: 'opened', involvement: 'all', sort: 'ready', hostOrProject: 'all' })
  expect(sorted.map((m) => m.iid)).toEqual([1, 2, 3])

  const groups = groupMrs(sorted, 'all')
  expect(groups.map((g) => g.key)).toEqual(['reviewing', 'authored'])
  expect(groups[0]?.entries.map((m) => m.iid)).toEqual([2])
  expect(groups[1]?.entries.map((m) => m.iid)).toEqual([1, 3])
})

test('filterAndSortMrs supports waiting/others involvement and mine scope, and groupMrs labels Other MRs', () => {
  const waiting = sampleMr({ id: '1', iid: 1, isAuthored: false, isReviewing: true, isWaitingOnMe: true, involvement: 'reviewing' })
  const approvedReview = sampleMr({ id: '2', iid: 2, isAuthored: false, isReviewing: true, isWaitingOnMe: false, involvement: 'reviewing' })
  const authored = sampleMr({ id: '3', iid: 3, isAuthored: true, isReviewing: false, isWaitingOnMe: false, involvement: 'authored' })
  const other = sampleMr({ id: '4', iid: 4, isAuthored: false, isReviewing: false, isWaitingOnMe: false, involvement: 'other' })

  const all = [waiting, approvedReview, authored, other]
  expect(filterAndSortMrs(all, { q: '', state: 'opened', involvement: 'waiting', sort: 'ready', hostOrProject: 'mine' }).map((m) => m.iid)).toEqual([1])
  expect(filterAndSortMrs(all, { q: '', state: 'opened', involvement: 'others', sort: 'ready', hostOrProject: 'all' }).map((m) => m.iid)).toEqual([4])

  const groups = groupMrs(all, 'all')
  expect(groups.map((g) => [g.key, g.label])).toEqual([
    ['reviewing', 'Reviewing'],
    ['authored', 'Authored'],
    ['others', 'Other MRs'],
  ])
})

test('formatRelativeTime formats seconds, minutes, hours, and days', () => {
  const now = Date.parse('2026-11-25T12:00:00Z')
  expect(formatRelativeTime('2026-11-25T11:59:30Z', now)).toBe('just now')
  expect(formatRelativeTime('2026-11-25T11:45:00Z', now)).toBe('15m')
  expect(formatRelativeTime('2026-11-25T09:00:00Z', now)).toBe('3h')
  expect(formatRelativeTime('2026-11-20T12:00:00Z', now)).toBe('5d')
})

test('parseUnifiedDiff, buildSplitPairs, and tokenizeCode parse diff hunks accurately', () => {
  const raw = [
    '@@ -10,4 +10,5 @@ function greet() {',
    ' const a = 1',
    '-return "old"',
    '+const b = 2 // comment',
    '+return "new"',
    ' }',
  ].join('\n')

  const hunks = parseUnifiedDiff(raw)
  expect(hunks).toHaveLength(1)
  expect(hunks[0]?.lines.map((l) => [l.type, l.oldNum, l.newNum])).toEqual([
    ['ctx', 10, 10],
    ['del', 11, null],
    ['add', null, 11],
    ['add', null, 12],
    ['ctx', 12, 13],
  ])

  const pairs = buildSplitPairs(hunks[0]!.lines)
  expect(pairs).toHaveLength(4)
  expect(pairs[1]?.left?.text).toBe('return "old"')
  expect(pairs[1]?.right?.text).toBe('const b = 2 // comment')
  expect(pairs[2]?.left).toBeNull()
  expect(pairs[2]?.right?.text).toBe('return "new"')

  const tokens = tokenizeCode('const x = 42 // hi')
  expect(tokens.some((t) => t.kind === 'kw' && t.text === 'const')).toBe(true)
  expect(tokens.some((t) => t.kind === 'num' && t.text === '42')).toBe(true)
  expect(tokens.some((t) => t.kind === 'com' && t.text === '// hi')).toBe(true)
})

test('parseUnifiedDiff preserves interior blank context lines and strips only one trailing newline', () => {
  const raw = [
    '@@ -5,5 +5,5 @@ function demo() {',
    ' const first = 1',
    '',
    '-const oldVal = 2',
    '+const newVal = 3',
    '',
    ' return newVal',
    '',
  ].join('\n')

  const hunks = parseUnifiedDiff(raw)
  expect(hunks).toHaveLength(1)
  expect(hunks[0]?.lines).toEqual([
    { type: 'ctx', oldNum: 5, newNum: 5, text: 'const first = 1' },
    { type: 'ctx', oldNum: 6, newNum: 6, text: '' },
    { type: 'del', oldNum: 7, newNum: null, text: 'const oldVal = 2' },
    { type: 'add', oldNum: null, newNum: 7, text: 'const newVal = 3' },
    { type: 'ctx', oldNum: 8, newNum: 8, text: '' },
    { type: 'ctx', oldNum: 9, newNum: 9, text: 'return newVal' },
  ])
})

test('parseMarkdown renders structured AST safely without executing HTML and toggles task checkboxes', () => {
  const md = [
    '### Summary',
    'Check `<script>alert(1)</script>` and [docs](https://gitlab.example.com/docs).',
    '- [ ] Verify staging',
    '- [x] Add tests',
  ].join('\n')

  const blocks = parseMarkdown(md)
  expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list'])
  const toggled = toggleMarkdownCheckbox(md, 2, true)
  expect(toggled).toContain('- [x] Verify staging')
  const untoggled = toggleMarkdownCheckbox(toggled, 3, false)
  expect(untoggled).toContain('- [ ] Add tests')
})

type SendCall = { params: Record<string, unknown>; options: Record<string, unknown> | undefined }

function fakeApp(
  overrides: {
    capabilities?: Record<string, unknown> | undefined
    sendMessage?: (params: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Record<string, unknown>>
    updateModelContext?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
  } = {},
) {
  const sendCalls: SendCall[] = []
  const contextCalls: Record<string, unknown>[] = []
  const app = {
    getHostCapabilities: () => overrides.capabilities,
    sendMessage: async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
      sendCalls.push({ params, options })
      if (overrides.sendMessage) return overrides.sendMessage(params, options)
      return {}
    },
    updateModelContext: async (params: Record<string, unknown>) => {
      contextCalls.push(params)
      if (overrides.updateModelContext) return overrides.updateModelContext(params)
      return {}
    },
  }
  return { app: app as unknown as App, sendCalls, contextCalls }
}

test('ServerBridge.capabilities reflects advertised message, updateModelContext, and openLinks', () => {
  const empty = new ServerBridge(fakeApp({ capabilities: undefined }).app)
  expect(empty.capabilities).toEqual({ canMessage: false, canUpdateContext: false, canOpenLinks: false })

  const partial = new ServerBridge(fakeApp({ capabilities: { updateModelContext: {}, openLinks: {} } }).app)
  expect(partial.capabilities).toEqual({ canMessage: false, canUpdateContext: true, canOpenLinks: true })

  const full = new ServerBridge(fakeApp({ capabilities: { message: {}, updateModelContext: {}, openLinks: {} } }).app)
  expect(full.capabilities).toEqual({ canMessage: true, canUpdateContext: true, canOpenLinks: true })
})

test('ServerBridge.sendMessage sends target new metadata and extracts conversationId when message is advertised', async () => {
  const { app, sendCalls } = fakeApp({
    capabilities: { message: {} },
    sendMessage: async () => ({
      _meta: { 'com.google.antigravity/message': { conversationId: 'conv-123' } },
    }),
  })
  const bridge = new ServerBridge(app)

  const res = await bridge.sendMessage('Review MR !1', { target: 'new' })
  expect(res).toEqual({ ok: true, conversationId: 'conv-123' })
  expect(sendCalls).toHaveLength(1)
  expect(sendCalls[0]).toEqual({
    params: {
      role: 'user',
      content: [{ type: 'text', text: 'Review MR !1' }],
      _meta: { 'com.google.antigravity/message': { target: 'new' } },
    },
    options: undefined,
  })

  const plain = await bridge.sendMessage('Follow up')
  expect(plain).toEqual({ ok: true, conversationId: 'conv-123' })
  expect(sendCalls[1]?.params._meta).toBe(undefined)
  expect(sendCalls[1]?.options).toBe(undefined)
})

test('ServerBridge.sendMessage blocks unadvertised calls without allowUnadvertised and caches rejection after isError', async () => {
  const { app, sendCalls } = fakeApp({
    capabilities: { updateModelContext: {} },
    sendMessage: async () => ({ isError: true }),
  })
  const bridge = new ServerBridge(app)

  expect(await bridge.sendMessage('Blocked', { target: 'new' })).toEqual({ ok: false })
  expect(sendCalls).toHaveLength(0)

  expect(await bridge.sendMessage('Probe once', { target: 'new', allowUnadvertised: true })).toEqual({ ok: false })
  expect(sendCalls).toHaveLength(1)
  expect(sendCalls[0]?.options).toEqual({ timeout: 5000 })

  // Cached rejected state: second call must not invoke app.sendMessage again
  expect(await bridge.sendMessage('Probe twice', { target: 'new', allowUnadvertised: true })).toEqual({ ok: false })
  expect(sendCalls).toHaveLength(1)
})

test('ServerBridge.sendMessage caches rejection after thrown error on unadvertised probe', async () => {
  const { app, sendCalls } = fakeApp({
    capabilities: { updateModelContext: {} },
    sendMessage: async () => {
      throw new Error('Method not found')
    },
  })
  const bridge = new ServerBridge(app)

  expect(await bridge.sendMessage('Probe throw', { target: 'new', allowUnadvertised: true })).toEqual({ ok: false })
  expect(sendCalls).toHaveLength(1)
  expect(sendCalls[0]?.options).toEqual({ timeout: 5000 })

  expect(await bridge.sendMessage('After throw', { target: 'new', allowUnadvertised: true })).toEqual({ ok: false })
  expect(sendCalls).toHaveLength(1)
})

test('ServerBridge.sendMessage caches supported after unadvertised probe succeeds and skips probe timeout on later calls', async () => {
  const { app, sendCalls } = fakeApp({
    capabilities: { updateModelContext: {} },
    sendMessage: async () => ({
      _meta: { 'com.google.antigravity/message': { conversationId: 'conv-probe' } },
    }),
  })
  const bridge = new ServerBridge(app)

  const first = await bridge.sendMessage('First probe', { target: 'new', allowUnadvertised: true })
  expect(first).toEqual({ ok: true, conversationId: 'conv-probe' })
  expect(sendCalls).toHaveLength(1)
  expect(sendCalls[0]?.options).toEqual({ timeout: 5000 })
  expect(sendCalls[0]?.params._meta).toEqual({ 'com.google.antigravity/message': { target: 'new' } })

  const second = await bridge.sendMessage('Second send', { target: 'new', allowUnadvertised: true })
  expect(second).toEqual({ ok: true, conversationId: 'conv-probe' })
  expect(sendCalls).toHaveLength(2)
  expect(sendCalls[1]?.options).toBe(undefined)
})

test('ServerBridge.updateContext respects capability gating, sends text or clears context, and catches errors', async () => {
  const disabled = fakeApp({ capabilities: {} })
  const disabledBridge = new ServerBridge(disabled.app)
  expect(await disabledBridge.updateContext('MR summary')).toBe(false)
  expect(disabled.contextCalls).toHaveLength(0)

  const enabled = fakeApp({ capabilities: { updateModelContext: {} } })
  const enabledBridge = new ServerBridge(enabled.app)
  expect(await enabledBridge.updateContext('MR summary')).toBe(true)
  expect(await enabledBridge.updateContext('')).toBe(true)
  expect(enabled.contextCalls).toEqual([
    { content: [{ type: 'text', text: 'MR summary' }] },
    { content: [] },
  ])

  const failing = fakeApp({
    capabilities: { updateModelContext: {} },
    updateModelContext: async () => {
      throw new Error('Rejected')
    },
  })
  expect(await new ServerBridge(failing.app).updateContext('MR summary')).toBe(false)
})

const sampleDiffFile = (newPath: string, overrides: Partial<DiffFile> = {}): DiffFile => ({
  oldPath: newPath,
  newPath,
  status: 'M',
  diff: '',
  tooLarge: false,
  collapsed: false,
  additions: 10,
  deletions: 2,
  ...overrides,
})

test('splitFilePath separates directory prefix from basename', () => {
  expect(splitFilePath('README.md')).toEqual({ dir: '', name: 'README.md' })
  expect(splitFilePath('.claude/hooks/check-mr.py')).toEqual({ dir: '.claude/hooks/', name: 'check-mr.py' })
})

test('buildDiffFileTree groups duplicate filenames under path-compressed folders and sorts directories before files', () => {
  const files = [
    sampleDiffFile('README.md'),
    sampleDiffFile('.claude/skills/template-mr/SKILL.md', { status: 'A' }),
    sampleDiffFile('.claude/skills/check-ci/SKILL.md', { status: 'A' }),
    sampleDiffFile('.claude/hooks/check-mr.py', { status: 'A' }),
    sampleDiffFile('fastlane/README.md'),
    sampleDiffFile('src/deep/only/one/file.ts'),
  ]

  const tree = buildDiffFileTree(files)
  expect(tree.map((n) => (n.kind === 'dir' ? `dir:${n.name}` : `file:${n.name}`))).toEqual([
    'dir:.claude',
    'dir:fastlane',
    'dir:src/deep/only/one',
    'file:README.md',
  ])

  const claudeDir = tree[0]
  expect(claudeDir?.kind).toBe('dir')
  if (claudeDir?.kind === 'dir') {
    expect(claudeDir.fileCount).toBe(3)
    expect(claudeDir.children.map((c) => (c.kind === 'dir' ? c.name : c.name))).toEqual(['hooks', 'skills'])
    const skillsDir = claudeDir.children[1]
    if (skillsDir?.kind === 'dir') {
      expect(skillsDir.children.map((c) => (c.kind === 'dir' ? c.name : c.name))).toEqual(['check-ci', 'template-mr'])
    }
  }

  expect(filterDiffFiles(files, 'skill.md').map((f) => f.newPath)).toEqual([
    '.claude/skills/template-mr/SKILL.md',
    '.claude/skills/check-ci/SKILL.md',
  ])
  expect(filterDiffFiles(files, '   ')).toHaveLength(6)
})
