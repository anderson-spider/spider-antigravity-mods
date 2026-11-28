import assert from 'node:assert/strict'
import test from 'node:test'
import { redactSecrets } from '../server/redact.ts'
import { computeLineDiff } from '../ui/src/lib/diff.ts'
import { AUTO_REPLY_BACKOFF_MS, MAX_AUTO_REPLY_ATTEMPTS, ReplyDeliveryTracker } from '../ui/src/lib/reply-delivery.ts'
import {
  applyPollEvents,
  buildTimelineEntries,
  extractLatestTurnResponse,
  formatToolTitle,
  stripCwdPrefix,
  summarizeToolGroup,
} from '../ui/src/lib/timeline.ts'
import {
  applyTriggerReplacement,
  detectInputTrigger,
  formatPromptPreview,
  formatUsage,
  isFenceClosing,
  isSafeHttpUrl,
  parseFenceOpening,
  pathToFileUri,
} from '../ui/src/lib/triggers.ts'
import type { SessionSnapshot, TimelineItem } from '../ui/src/types.ts'

test('detectInputTrigger detects leading slash commands and @mentions', () => {
  const slash = detectInputTrigger('  /comp', 7)
  assert.deepEqual(slash, { kind: 'slash', query: 'comp', start: 2, end: 7 })

  const midSlash = detectInputTrigger('hello /comp', 11)
  assert.equal(midSlash, null)

  const mention = detectInputTrigger('check @src/app', 14)
  assert.deepEqual(mention, { kind: 'mention', query: 'src/app', start: 6, end: 14 })

  assert.deepEqual(applyTriggerReplacement('check @src/app', mention!, '@src/app.ts'), {
    nextText: 'check @src/app.ts ',
    nextCursor: 18,
  })
})

test('computeLineDiff produces expected additions, deletions, and context', () => {
  const lines = computeLineDiff('a\nb\nc', 'a\nx\nc\nd')
  assert.ok(lines.some(l => l.type === 'del' && l.text === 'b'))
  assert.ok(lines.some(l => l.type === 'add' && l.text === 'x'))
  assert.ok(lines.some(l => l.type === 'add' && l.text === 'd'))
})

test('pathToFileUri, formatUsage, isSafeHttpUrl, and redactSecrets behave safely', () => {
  assert.equal(pathToFileUri('/Users/dev/my file.ts'), 'file:///Users/dev/my%20file.ts')
  assert.equal(formatUsage({ used: 50_000, size: 200_000, costAmount: 0.123, costCurrency: 'USD' }), '50.0k / 200.0k (25%) · $0.12')
  assert.equal(isSafeHttpUrl('https://example.com'), true)
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false)
  assert.equal(redactSecrets('ANTHROPIC_API_KEY=sk-ant-api03-abcdef123456'), 'ANTHROPIC_API_KEY=***')
  assert.equal(redactSecrets('ghp_1234567890abcdef1234'), 'gh_***')
  assert.equal(redactSecrets('glpat-abcdef1234567890'), 'glpat-***')
  assert.equal(redactSecrets('AKIAIOSFODNN7EXAMPLE'), 'AKIA***')
})

test('buildTimelineEntries groups consecutive non-diff non-failed tool calls', () => {
  const ts = '2026-11-27T12:00:00Z'
  const items: TimelineItem[] = [
    { id: 'u1', kind: 'user', text: 'Review branch', timestamp: ts },
    { id: 't1', kind: 'tool_call', toolCallId: '1', toolKind: 'read', title: 'Read /repo/a.ts', status: 'completed', timestamp: ts },
    { id: 't2', kind: 'tool_call', toolCallId: '2', toolKind: 'read', title: 'Read /repo/b.ts', status: 'in_progress', timestamp: ts },
    {
      id: 't3',
      kind: 'tool_call',
      toolCallId: '3',
      toolKind: 'edit',
      title: 'Edit /repo/c.ts',
      status: 'completed',
      diffs: [{ path: '/repo/c.ts', oldText: 'a', newText: 'b' }],
      timestamp: ts,
    },
    { id: 't4', kind: 'tool_call', toolCallId: '4', toolKind: 'execute', title: 'Run tests', status: 'failed', timestamp: ts },
    { id: 'a1', kind: 'assistant', text: 'Done.', timestamp: ts },
  ]

  const entries = buildTimelineEntries(items)
  assert.equal(entries.length, 5)
  assert.equal(entries[0]?.kind, 'item')
  assert.equal(entries[1]?.kind, 'tool_group')
  if (entries[1]?.kind === 'tool_group') {
    const summary = summarizeToolGroup(entries[1].items, '/repo')
    assert.equal(summary.label, 'Read 2 files')
    assert.equal(summary.running, 1)
    assert.equal(summary.completed, 1)
    assert.equal(summary.activeTitle, 'Read b.ts')
  }
  assert.equal(entries[2]?.kind, 'item')
  assert.equal(entries[3]?.kind, 'item')
  assert.equal(entries[4]?.kind, 'item')
  assert.equal(stripCwdPrefix('/repo/src/index.ts', '/repo'), 'src/index.ts')
  assert.deepEqual(formatToolTitle(items[1]!, '/repo'), { verb: 'Read', detail: 'a.ts' })
})

test('parseFenceOpening, isFenceClosing, and formatPromptPreview handle markdown edge cases', () => {
  assert.deepEqual(parseFenceOpening('```ts title="a.ts"'), { fenceLen: 3, lang: 'ts' })
  assert.deepEqual(parseFenceOpening('````'), { fenceLen: 4, lang: '' })
  assert.deepEqual(parseFenceOpening('```.env'), { fenceLen: 3, lang: '.env' })
  assert.equal(parseFenceOpening('```inline```'), null)
  assert.equal(isFenceClosing('```', 4), false)
  assert.equal(isFenceClosing('````', 4), true)

  const shortPrompt = formatPromptPreview('One line')
  assert.equal(shortPrompt.isLong, false)
  const longPrompt = formatPromptPreview('l1\nl2\nl3\nl4\nl5')
  assert.equal(longPrompt.isLong, true)
  assert.equal(longPrompt.lineCount, 5)
})

test('applyPollEvents clears archivedAt when session_meta unarchives a session and clears streaming on turn_finished', () => {
  const base: SessionSnapshot = {
    sessionId: 's1',
    title: 'Archived chat',
    cwd: '/repo',
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    archivedAt: '2026-11-21T00:00:00.000Z',
    status: 'running',
    loadedInProcess: true,
    pendingPermissionCount: 0,
    touchedFilesCount: 0,
    availableModes: [],
    availableModels: [],
    configOptions: [],
    availableCommands: [],
    plan: [],
    touchedFiles: [],
    pendingPermissions: [],
    items: [{ id: 'a1', kind: 'assistant', text: 'hi', streaming: true, timestamp: '2026-11-20T00:00:01.000Z' }],
    latestSeq: 1,
  }

  // Server summary omits archivedAt after unarchiving
  const updated = applyPollEvents(
    base,
    [
      {
        seq: 2,
        type: 'session_meta',
        sessionId: 's1',
        summary: {
          sessionId: 's1',
          title: 'Restored chat',
          cwd: '/repo',
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: '2026-11-27T00:00:00.000Z',
          status: 'idle',
          loadedInProcess: true,
          pendingPermissionCount: 0,
          touchedFilesCount: 0,
        },
      },
      {
        seq: 3,
        type: 'turn_finished',
        sessionId: 's1',
        stopReason: 'end_turn',
      },
    ],
    3,
  )

  assert.equal(updated.archivedAt, undefined)
  assert.equal(updated.title, 'Restored chat')
  assert.equal(updated.status, 'idle')
  assert.equal(updated.items[0]!.streaming, false)
  assert.equal(updated.latestSeq, 3)
})

test('extractLatestTurnResponse joins all assistant blocks from the latest turn only', () => {
  const ts = '2026-11-27T12:00:00Z'
  const items: TimelineItem[] = [
    { id: 'u1', kind: 'user', text: 'First prompt', timestamp: ts },
    { id: 'a1', kind: 'assistant', text: 'Old answer', timestamp: ts },
    { id: 'u2', kind: 'user', text: 'Second prompt', timestamp: ts },
    { id: 'a2', kind: 'assistant', text: 'Checking files...', timestamp: ts },
    { id: 't1', kind: 'tool_call', toolCallId: '1', title: 'Read a.ts', status: 'completed', timestamp: ts },
    { id: 'a3', kind: 'assistant', text: 'Final review report.', timestamp: ts },
  ]
  assert.equal(extractLatestTurnResponse(items), 'Checking files...\n\nFinal review report.')
})

test('ReplyDeliveryTracker backs off transient sendMessage failures, prevents duplicates, and recovers on focus retry', () => {
  const tracker = new ReplyDeliveryTracker()
  const replyId = 'reply-1'
  const t0 = 1_000_000

  assert.equal(tracker.canAttempt(replyId, t0), true)
  tracker.markStart(replyId)
  assert.equal(tracker.canAttempt(replyId, t0), false, 'in-flight reply must not be double-dispatched')

  // First transient failure schedules backoff instead of permanently giving up
  const fail1 = tracker.markFailed(replyId, 'Host busy', t0)
  tracker.markFinish(replyId)
  assert.equal(fail1.exhausted, false)
  assert.equal(fail1.retryInMs, AUTO_REPLY_BACKOFF_MS[0])
  assert.equal(tracker.canAttempt(replyId, t0 + 500), false)
  assert.equal(tracker.canAttempt(replyId, t0 + AUTO_REPLY_BACKOFF_MS[0]), true)

  // Exhaust remaining attempts
  let now = t0 + AUTO_REPLY_BACKOFF_MS[0]
  for (let i = 1; i < MAX_AUTO_REPLY_ATTEMPTS; i++) {
    const out = tracker.markFailed(replyId, `Error #${i + 1}`, now)
    if (i < MAX_AUTO_REPLY_ATTEMPTS - 1) {
      assert.equal(out.exhausted, false)
      now += out.retryInMs!
    } else {
      assert.equal(out.exhausted, true)
      assert.equal(out.retryInMs, null)
    }
  }
  assert.equal(tracker.canAttempt(replyId, now + 60_000), false)
  assert.ok(tracker.getExhaustedFailure(replyId)?.lastError?.includes('Error #'))

  // Focus/visibility recovery grants a fresh attempt
  tracker.resetForRetry()
  assert.equal(tracker.canAttempt(replyId, now + 60_001), true)

  // Once delivered, reply can never be re-sent even after resetForRetry()
  tracker.markDelivered(replyId)
  assert.equal(tracker.isDelivered(replyId), true)
  tracker.resetForRetry()
  assert.equal(tracker.canAttempt(replyId, now + 120_000), false)
})
