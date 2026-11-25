import { buildSplitPairs, parseUnifiedDiff, tokenizeCode } from '../ui/src/lib/diff.ts'
import { parseMarkdown, toggleMarkdownCheckbox } from '../ui/src/lib/markdown.ts'
import { filterAndSortMrs, formatRelativeTime, groupMrs, parseSearchQuery, readinessScore } from '../ui/src/lib/query.ts'
import type { MrListItem } from '../ui/src/types.ts'
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
