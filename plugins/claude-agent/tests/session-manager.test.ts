import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { listDirectories, searchWorkspaceFiles } from '../server/fs-helpers.ts'
import { SessionManager, type PollEvent } from '../server/session-manager.ts'
import { createStore } from '../server/store.ts'

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.ts', import.meta.url))

function createTestManager(
  dataDir: string,
  defaultCwd: string,
  extraEnv: Record<string, string> = {},
  extraDeps: { autoArchiveIdleMs?: number; cancelTimeoutMs?: number; minAskTimeoutMs?: number; minWaitTimeoutMs?: number } = {},
): SessionManager {
  return new SessionManager({
    store: createStore(dataDir),
    binaryDeps: {
      env: {
        CLAUDE_AGENT_ACP_BIN: process.execPath,
        CLAUDE_AGENT_ACP_ARGS: FAKE_AGENT,
      },
      isExecutable: () => true,
    },
    env: { ...process.env, ...extraEnv },
    defaultCwd,
    ...extraDeps,
  })
}

test('SessionManager handles streaming, interactive permissions, touched files, and polling', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-mgr-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const created = await manager.createSession({ cwd: dir })
  assert.equal(created.cwd, dir)
  assert.equal(created.modeId, 'auto')
  assert.equal(created.modelId, 'claude-opus-4-1')
  assert.equal(created.availableModes.length, 5)
  assert.ok(created.availableModes.some(m => m.id === 'auto'))

  await manager.startPrompt(created.sessionId, '[trigger:permission] please edit')

  // Poll until permission_request arrives
  let afterSeq = created.latestSeq
  let permissionRequestId: string | undefined
  for (let attempt = 0; attempt < 10 && !permissionRequestId; attempt++) {
    const poll = await manager.pollEvents(created.sessionId, afterSeq, 1_000)
    afterSeq = poll.latestSeq
    for (const ev of poll.events) {
      if (ev.type === 'permission_request') permissionRequestId = ev.permission.requestId
    }
  }
  assert.ok(permissionRequestId, 'expected permission_request event')

  await manager.resolvePermission(created.sessionId, permissionRequestId!, 'selected', 'allow_once')

  // Poll until turn finishes
  let finished = false
  const collected: PollEvent[] = []
  for (let attempt = 0; attempt < 10 && !finished; attempt++) {
    const poll = await manager.pollEvents(created.sessionId, afterSeq, 1_000)
    afterSeq = poll.latestSeq
    collected.push(...poll.events)
    if (poll.events.some(e => e.type === 'turn_finished')) finished = true
  }
  assert.ok(finished, 'expected turn_finished event')

  const snap = (await manager.handleUiSession({ action: 'get', sessionId: created.sessionId }, [dir])).structuredContent as {
    session: { items: { kind: string; text?: string }[]; touchedFiles: string[] }
  }
  assert.ok(snap.session.items.some(i => i.kind === 'assistant' && i.text?.includes('Applied edit after approval')))
  assert.ok(snap.session.touchedFiles.some(f => f.endsWith('src/app.ts')))
})

test('claude_ask enforces plan mode and auto-declines permission prompts without hanging', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-ask-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const progressBeats: string[] = []
  const reply = await manager.handleAskTool(
    { prompt: '[trigger:permission] review this change', cwd: dir, timeoutSeconds: 15 },
    [dir],
    msg => progressBeats.push(msg),
  )
  assert.equal(reply.isError, undefined)
  assert.ok(reply.text.includes('permission was declined'))
})

test('claude_open with prompt dispatches async turn and supports reconnect + session/load', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-open-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const openRes = await manager.handleOpenTool({ prompt: 'Summarize project', cwd: dir, mode: 'plan' }, [dir])
  assert.ok(openRes.text.includes('Started asynchronous Claude Agent turn'))
  const sc = openRes.structuredContent as { activeSession?: { sessionId: string; replyToChat?: boolean } }
  const sessionId = sc.activeSession?.sessionId
  assert.ok(sessionId)
  assert.equal(sc.activeSession?.replyToChat, true)

  // Wait briefly for fake turn to complete, then reconnect and load session
  await new Promise(r => setTimeout(r, 150))
  await manager.reconnect()
  const loaded = await manager.ensureSessionLoaded(sessionId!)
  assert.equal(loaded.loadedInProcess, true)
})

test('fs helpers list directories and search workspace files excluding ignored dirs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-fs-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(join(dir, 'src'))
  await mkdir(join(dir, 'node_modules/pkg'), { recursive: true })
  await writeFile(join(dir, 'src/index.ts'), 'export {}\n')
  await writeFile(join(dir, 'node_modules/pkg/ignored.ts'), 'export {}\n')

  const dirs = await listDirectories(join(dir, 'sr'))
  assert.equal(dirs.length, 1)
  assert.equal(dirs[0]!.name, 'src')

  const files = await searchWorkspaceFiles(dir, 'index')
  assert.equal(files.length, 1)
  assert.equal(files[0]!.path, join('src', 'index.ts'))
})

test('reconnect while ensureConnected is in flight resolves cleanly without ACP client disposed error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-reconnect-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const firstConnect = manager.ensureConnected().catch(() => undefined)
  const diag = await manager.reconnect()
  await firstConnect

  assert.equal(diag.status, 'ready')
  assert.equal(diag.lastError, undefined)
})

test('setSessionModel resolves case-insensitive model alias', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-model-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const created = await manager.createSession({ cwd: dir })
  assert.equal(created.modelId, 'claude-opus-4-1')
  const switchedToSonnet = await manager.setSessionModel(created.sessionId, 'SONNET')
  assert.equal(switchedToSonnet.modelId, 'claude-sonnet-4-5')
  const updated = await manager.setSessionModel(created.sessionId, 'Opus')
  assert.equal(updated.modelId, 'claude-opus-4-1')
})

test('claude_open supports auto mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-auto-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const openRes = await manager.handleOpenTool({ prompt: 'Run check', cwd: dir, mode: 'auto' }, [dir])
  const sc = openRes.structuredContent as { activeSession?: { sessionId: string; modeId?: string } }
  assert.equal(sc.activeSession?.modeId, 'auto')

  await new Promise(r => setTimeout(r, 150))
})

test('claude_open rejects bypassPermissions at runtime', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-bypass-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const res = await manager.handleOpenTool(
    { prompt: 'hi', cwd: dir, mode: 'bypassPermissions' as unknown as 'auto' },
    [dir],
  )
  assert.equal(res.isError, true)
  assert.ok(res.text.includes('Invalid mode'))
})

test('claude_ask fails closed if plan mode cannot be enabled', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-reject-plan-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir, { FAKE_ACP_REJECT_PLAN: '1' })
  t.after(async () => {
    await manager.dispose()
  })

  const res = await manager.handleAskTool({ prompt: 'review', cwd: dir }, [dir], () => undefined)
  assert.equal(res.isError, true)
  assert.ok(res.text.includes('plan'))
})

test('cancelTurn followed immediately by startPrompt is not clobbered by old turn', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-cancel-race-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const created = await manager.createSession({ cwd: dir })
  await manager.startPrompt(created.sessionId, '[trigger:slow] first')
  await manager.cancelTurn(created.sessionId)
  await manager.startPrompt(created.sessionId, 'second quick prompt')

  await new Promise(r => setTimeout(r, 250))
  const got = (await manager.handleUiSession({ action: 'get', sessionId: created.sessionId }, [dir])).structuredContent as {
    session: { status: string; items: { kind: string; text?: string }[] }
  }
  assert.equal(got.session.status, 'idle')
  assert.ok(got.session.items.some(i => i.kind === 'assistant' && i.text?.includes('second quick prompt')))
})

test('session/load replay does not duplicate items and clears streaming flags', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-replay-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir, { FAKE_ACP_REPLAY: '1' })
  t.after(async () => {
    await manager.dispose()
  })

  const created = await manager.createSession({ cwd: dir })
  await manager.startPrompt(created.sessionId, 'first message')
  await new Promise(r => setTimeout(r, 150))

  await manager.reconnect()
  const loaded = await manager.ensureSessionLoaded(created.sessionId)
  assert.equal(loaded.items.length, 2)
  assert.equal(loaded.items[0]!.kind, 'user')
  assert.equal(loaded.items[1]!.kind, 'assistant')
  assert.ok(loaded.items.every(i => !i.streaming))
})

test('pollEvents resyncs when afterSeq > latestSeq and wakes other session pollers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-poll-resync-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
  })

  const s1 = await manager.createSession({ cwd: dir })
  const s2 = await manager.createSession({ cwd: dir })

  const resync = await manager.pollEvents(s1.sessionId, 9999, 500)
  assert.equal(resync.resync, true)
  assert.ok(resync.snapshot)

  const startedAt = Date.now()
  const p1 = manager.pollEvents(s1.sessionId, s1.latestSeq, 5_000)
  await new Promise(r => setTimeout(r, 30))
  await manager.pollEvents(s2.sessionId, s2.latestSeq, 100)
  await p1
  assert.ok(Date.now() - startedAt < 1_000)
})

test('syncAcpSessionList ignores external CLI sessions and only refreshes tracked metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-filter-'))
  const manager = createTestManager(dir, dir, { FAKE_ACP_EXTERNAL_SESSION: 'external-cli-999' })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await manager.createSession({ cwd: dir })
  await manager.renameSession(created.sessionId, 'Untitled session')

  const connectRes = await manager.handleUiSession({ action: 'connect' }, [dir])
  const bootstrap = connectRes.structuredContent as { sessions: { sessionId: string; title: string }[] }
  assert.equal(bootstrap.sessions.some(s => s.sessionId === 'external-cli-999'), false)
  const tracked = bootstrap.sessions.find(s => s.sessionId === created.sessionId)
  assert.ok(tracked)
  assert.equal(tracked.title, `Fake ${created.sessionId}`)
})

test('session archiving supports manual archive/unarchive, claude_ask auto-archive, and idle auto-archive', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-archive-'))
  const store = createStore(dir)
  // Seed an old idle session (> 7 days old)
  const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString()
  await store.upsertSession({
    sessionId: 'old-idle-sess',
    title: 'Old Idle Session',
    cwd: dir,
    createdAt: oldTs,
    updatedAt: oldTs,
    touchedFiles: [],
    items: [],
  })

  const manager = new SessionManager({
    store,
    binaryDeps: {
      env: { CLAUDE_AGENT_ACP_BIN: process.execPath, CLAUDE_AGENT_ACP_ARGS: FAKE_AGENT },
      isExecutable: () => true,
    },
    defaultCwd: dir,
  })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  // Hydration auto-archives stale idle session
  const boot0 = await manager.getBootstrap({ workspaceRoots: [dir] })
  const oldSummary = boot0.sessions.find(s => s.sessionId === 'old-idle-sess')
  assert.ok(oldSummary?.archivedAt, 'expected stale idle session to be auto-archived')
  assert.equal(boot0.activeSession, undefined, 'archived-only store should not force-open archived session as active')

  // Ephemeral claude_ask auto-archives on completion
  const askReply = await manager.handleAskTool({ prompt: 'Quick question', cwd: dir }, [dir], () => undefined)
  assert.equal(askReply.isError, undefined)
  const askSessionId = (askReply.structuredContent as { sessionId: string }).sessionId
  const bootAfterAsk = await manager.getBootstrap({ workspaceRoots: [dir] })
  const askSummary = bootAfterAsk.sessions.find(s => s.sessionId === askSessionId)
  assert.ok(askSummary?.archivedAt, 'expected completed ephemeral claude_ask session to be auto-archived')

  // Interactive session remains active, and reusing it in claude_ask does NOT auto-archive it
  const interactive = await manager.createSession({ cwd: dir })
  const reuseAsk = await manager.handleAskTool(
    { prompt: 'Second opinion', cwd: dir, sessionId: interactive.sessionId },
    [dir],
    () => undefined,
  )
  assert.equal(reuseAsk.isError, undefined)
  const afterReuse = await manager.getBootstrap({ workspaceRoots: [dir] })
  const interactiveSummary = afterReuse.sessions.find(s => s.sessionId === interactive.sessionId)
  assert.equal(interactiveSummary?.archivedAt, undefined)
  assert.equal(afterReuse.activeSession?.sessionId, interactive.sessionId)

  // claude_session list hides archived by default and shows with includeArchived
  const listDefault = await manager.handleSessionTool({ action: 'list' })
  const listDefaultSc = listDefault.structuredContent as { sessions: { sessionId: string }[]; archivedCount: number }
  assert.equal(listDefaultSc.sessions.length, 1)
  assert.equal(listDefaultSc.archivedCount, 2)
  const listAll = await manager.handleSessionTool({ action: 'list', includeArchived: true })
  const listAllSc = listAll.structuredContent as { sessions: { sessionId: string }[]; archivedCount: number }
  assert.equal(listAllSc.sessions.length, 3)

  // Manual archive & unarchive via claude_ui_session
  const archRes = await manager.handleUiSession({ action: 'archive', sessionId: interactive.sessionId }, [dir])
  assert.equal(archRes.isError, undefined)
  const archSc = archRes.structuredContent as { session: { archivedAt?: string } }
  assert.ok(archSc.session.archivedAt)

  const unarchRes = await manager.handleUiSession({ action: 'unarchive', sessionId: interactive.sessionId }, [dir])
  assert.equal(unarchRes.isError, undefined)
  const unarchSc = unarchRes.structuredContent as { session: { archivedAt?: string } }
  assert.equal(unarchSc.session.archivedAt, undefined)

  // Archiving a running session fails cleanly
  await manager.startPrompt(interactive.sessionId, '[trigger:slow] busy')
  await assert.rejects(() => manager.archiveSession(interactive.sessionId), /in progress/)
  await manager.cancelTurn(interactive.sessionId)

  // Sending a new prompt to an archived session auto-unarchives it
  await manager.archiveSession(interactive.sessionId)
  const resumed = await manager.startPrompt(interactive.sessionId, 'Back to work')
  assert.equal(resumed.archivedAt, undefined)
  await new Promise(r => setTimeout(r, 120))
})

test('concurrent ensureConnected and ensureSessionLoaded wait for initialize before checking loadSession', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-init-race-'))
  const store = createStore(dir)
  await store.upsertSession({
    sessionId: 'saved-sess-1',
    title: 'Saved Session',
    cwd: dir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    touchedFiles: [],
    items: [],
  })

  const manager = new SessionManager({
    store,
    binaryDeps: {
      env: { CLAUDE_AGENT_ACP_BIN: process.execPath, CLAUDE_AGENT_ACP_ARGS: FAKE_AGENT },
      isExecutable: () => true,
    },
    env: { ...process.env, FAKE_ACP_SLOW_INIT_MS: '150' },
    defaultCwd: dir,
  })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const pConnect = manager.ensureConnected()
  await new Promise(r => setTimeout(r, 30))
  const loaded = await manager.ensureSessionLoaded('saved-sess-1')
  await pConnect

  // Must have used session/load and preserved the saved sessionId rather than replacing it via session/new
  assert.equal(loaded.sessionId, 'saved-sess-1')
  assert.equal(loaded.loadedInProcess, true)
})

test('pollEvents isolates distinct view clientIds to prevent two-view ping-pong', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-twoview-'))
  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const s1 = await manager.createSession({ cwd: dir })
  const s2 = await manager.createSession({ cwd: dir })

  let view1Resolved = false
  const view1Poll = manager.pollEvents(s1.sessionId, s1.latestSeq, 600, 'view-aux').then(res => {
    view1Resolved = true
    return res
  })
  await new Promise(r => setTimeout(r, 30))

  // Another view polling s2 must NOT wake view-aux on s1
  await manager.pollEvents(s2.sessionId, s2.latestSeq, 200, 'view-global')
  assert.equal(view1Resolved, false, 'view-global must not wake view-aux on a different session')

  // Same view switching to s2 MUST immediately wake view-aux on s1
  const switchStart = Date.now()
  await manager.pollEvents(s2.sessionId, s2.latestSeq, 200, 'view-aux')
  await view1Poll
  assert.equal(view1Resolved, true)
  assert.ok(Date.now() - switchStart < 300)
})

test('cancelTurn waits for agent settlement, blocks overlapping prompts, and finalizes late chunks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-cancel-late-'))
  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await manager.createSession({ cwd: dir })
  await manager.startPrompt(created.sessionId, '[trigger:late_chunk_on_cancel] stream')
  await new Promise(r => setTimeout(r, 40))

  const cancelP = manager.cancelTurn(created.sessionId)
  // While agent is still settling cancellation, overlapping startPrompt must be rejected
  await assert.rejects(() => manager.startPrompt(created.sessionId, 'overlapping prompt'), /already has a turn in progress/)

  const snap = await cancelP
  assert.equal(snap.status, 'idle')
  assert.ok(snap.items.some(i => i.kind === 'assistant' && i.text?.includes('late chunk')))
  assert.ok(
    snap.items.every(i => !i.streaming),
    'no item should remain stuck with streaming: true after cancel settles',
  )
})

test('reconnect clears pending permissions and emits permission_resolved', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-reconnect-perm-'))
  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await manager.createSession({ cwd: dir })
  await manager.startPrompt(created.sessionId, '[trigger:permission] wait for approval')

  let afterSeq = created.latestSeq
  let sawPerm = false
  for (let i = 0; i < 10 && !sawPerm; i++) {
    const poll = await manager.pollEvents(created.sessionId, afterSeq, 500)
    afterSeq = poll.latestSeq
    if (poll.events.some(e => e.type === 'permission_request')) sawPerm = true
  }
  assert.ok(sawPerm, 'expected pending permission before reconnect')

  await manager.reconnect()
  const afterReconnect = await manager.pollEvents(created.sessionId, afterSeq, 50)
  assert.ok(
    afterReconnect.events.some(e => e.type === 'permission_resolved'),
    'expected permission_resolved event on reconnect',
  )
  const snap = (await manager.handleUiSession({ action: 'get', sessionId: created.sessionId }, [dir])).structuredContent as {
    session: { pendingPermissions: unknown[]; pendingPermissionCount: number; status: string }
  }
  assert.equal(snap.session.pendingPermissions.length, 0)
  assert.equal(snap.session.pendingPermissionCount, 0)
  assert.equal(snap.session.status, 'idle')
})

test('unexpected ACP child exit emits exactly one error item and one turn_finished event', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-crash-'))
  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await manager.createSession({ cwd: dir })
  const afterSeq = created.latestSeq
  await manager.startPrompt(created.sessionId, '[trigger:crash] boom')
  await new Promise(r => setTimeout(r, 250))

  const poll = await manager.pollEvents(created.sessionId, afterSeq, 50)
  const finishedEvents = poll.events.filter(e => e.type === 'turn_finished')
  assert.equal(finishedEvents.length, 1, `expected 1 turn_finished event, got ${finishedEvents.length}`)

  const snap = (await manager.handleUiSession({ action: 'get', sessionId: created.sessionId }, [dir])).structuredContent as {
    session: { status: string; items: { kind: string; streaming?: boolean }[] }
  }
  assert.equal(snap.session.status, 'error')
  const errorItems = snap.session.items.filter(i => i.kind === 'error')
  assert.equal(errorItems.length, 1, `expected 1 error item, got ${errorItems.length}`)
  assert.ok(snap.session.items.every(i => !i.streaming))
})

test('claude_open fails closed when explicit mode cannot be applied', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-open-mode-fail-'))
  const manager = createTestManager(dir, dir, { FAKE_ACP_REJECT_PLAN: '1' })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  // New session with explicit rejected mode
  const resNew = await manager.handleOpenTool({ prompt: 'Do not run', cwd: dir, mode: 'plan' }, [dir])
  assert.equal(resNew.isError, true)
  assert.ok(resNew.text.includes('plan'))
  const boot = await manager.getBootstrap({ workspaceRoots: [dir] })
  assert.equal(boot.sessions.length, 0, 'failed strict create should not leave an empty session behind')

  // Existing session with explicit rejected mode
  const existing = await manager.createSession({ cwd: dir })
  const resExisting = await manager.handleOpenTool(
    { sessionId: existing.sessionId, prompt: 'Do not run either', mode: 'plan' },
    [dir],
  )
  assert.equal(resExisting.isError, true)
  assert.ok(resExisting.text.includes('plan'))
  const got = (await manager.handleUiSession({ action: 'get', sessionId: existing.sessionId }, [dir])).structuredContent as {
    session: { items: unknown[]; status: string }
  }
  assert.equal(got.session.items.length, 0, 'prompt must not start when explicit mode switch fails')
  assert.equal(got.session.status, 'idle')
})

test('claude_ask readOnlyLock blocks mode mutation, blocks claude_open mode mutation, and selects reject_once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-ro-lock-'))
  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  // 1) readOnlyLock selects reject_once when offered
  const permReply = await manager.handleAskTool({ prompt: '[trigger:permission] check', cwd: dir }, [dir], () => undefined)
  assert.equal(permReply.isError, undefined)
  assert.ok(permReply.text.includes('selected:reject_once'), `expected selected:reject_once, got: ${permReply.text}`)

  // 2) readOnlyLock falls back to cancelled when no reject_* option is offered
  const noRejectReply = await manager.handleAskTool(
    { prompt: '[trigger:permission_no_reject] check', cwd: dir },
    [dir],
    () => undefined,
  )
  assert.equal(noRejectReply.isError, undefined)
  assert.ok(noRejectReply.text.includes('cancelled:'), `expected cancelled fallback, got: ${noRejectReply.text}`)

  // 3) While claude_ask is in flight on a reused session, setSessionMode & claude_open cannot mutate mode
  const existing = await manager.createSession({ cwd: dir })
  assert.equal(existing.modeId, 'auto')
  const askPromise = manager.handleAskTool(
    { prompt: '[trigger:slow] long review', cwd: dir, sessionId: existing.sessionId },
    [dir],
    () => undefined,
  )
  await new Promise(r => setTimeout(r, 80))

  await assert.rejects(
    () => manager.setSessionMode(existing.sessionId, 'auto'),
    /read-only claude_ask/,
  )

  const openWhileBusy = await manager.handleOpenTool(
    { sessionId: existing.sessionId, prompt: 'hijack', mode: 'acceptEdits' },
    [dir],
  )
  assert.equal(openWhileBusy.isError, true)
  const midSnap = (await manager.handleUiSession({ action: 'get', sessionId: existing.sessionId }, [dir])).structuredContent as {
    session: { modeId?: string }
  }
  assert.equal(midSnap.session.modeId, 'plan', 'mode must stay plan while claude_ask is running')

  const askDone = await askPromise
  assert.equal(askDone.isError, undefined)
  const afterSnap = (await manager.handleUiSession({ action: 'get', sessionId: existing.sessionId }, [dir])).structuredContent as {
    session: { modeId?: string }
  }
  assert.equal(afterSnap.session.modeId, 'auto', 'mode should be restored to auto after claude_ask finishes')
})

test('cancelTurn falls back cleanly when agent hangs past cancelTimeoutMs and late chunks stay non-streaming', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-cancel-hang-'))
  const manager = createTestManager(dir, dir, {}, { cancelTimeoutMs: 50 })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await manager.createSession({ cwd: dir })
  await manager.startPrompt(created.sessionId, '[trigger:hang_cancel] stall')
  await new Promise(r => setTimeout(r, 30))

  const snap = await manager.cancelTurn(created.sessionId)
  assert.equal(snap.status, 'idle')
  assert.ok(snap.items.every(i => !i.streaming))

  // Wait for the late chunk sent by the hung agent after cancelTimeoutMs
  await new Promise(r => setTimeout(r, 200))
  const afterLate = (await manager.handleUiSession({ action: 'get', sessionId: created.sessionId }, [dir])).structuredContent as {
    session: { status: string; items: { kind: string; text?: string; streaming?: boolean }[] }
  }
  assert.equal(afterLate.session.status, 'idle')
  assert.ok(
    afterLate.session.items.every(i => !i.streaming),
    'late chunk arriving after cancelTimeoutMs must not remain streaming: true',
  )
})

test('handleAskTool timeout when session is deleted mid-flight does not throw unhandled rejection or resurrect session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-ask-del-timeout-'))
  const manager = createTestManager(dir, dir, {}, { minAskTimeoutMs: 60, cancelTimeoutMs: 50 })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const existing = await manager.createSession({ cwd: dir })
  const askPromise = manager.handleAskTool(
    { prompt: '[trigger:slow] will be deleted', cwd: dir, sessionId: existing.sessionId, timeoutSeconds: 0.08 },
    [dir],
    () => undefined,
  )

  // Delete the session while claude_ask is in flight, before timeout fires
  await new Promise(r => setTimeout(r, 30))
  await manager.deleteSession(existing.sessionId)

  const reply = await askPromise
  // Either timed out or ended without crashing; crucially the deleted session must NOT be resurrected on disk
  assert.ok(reply && typeof reply.text === 'string')
  await new Promise(r => setTimeout(r, 150))

  const diskData = await createStore(dir).load()
  assert.equal(
    diskData.sessions.some(s => s.sessionId === existing.sessionId),
    false,
    'deleted running session must not be resurrected on disk after turn settles',
  )
})

test('deleting a running session prevents zombie resurrection on disk when cancelled turn settles', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-del-running-'))
  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await manager.createSession({ cwd: dir })
  await manager.startPrompt(created.sessionId, '[trigger:slow] delete me')
  await new Promise(r => setTimeout(r, 40))
  await manager.deleteSession(created.sessionId)

  // Wait for agent to finish cancelling and settle the old session/prompt RPC
  await new Promise(r => setTimeout(r, 200))
  const diskData = await createStore(dir).load()
  assert.equal(diskData.sessions.length, 0, 'deleted session must remain absent from persisted store')
})

test('readOnlyLock blocks setSessionConfigOption and protects mode-switch setup window in claude_ask', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-ro-cfg-'))
  const manager = createTestManager(dir, dir, {
    FAKE_ACP_MODE_CONFIG: '1',
    FAKE_ACP_SLOW_SET_MODE_MS: '120',
  })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const existing = await manager.createSession({ cwd: dir })
  assert.equal(existing.modeId, 'auto')

  const askPromise = manager.handleAskTool(
    { prompt: '[trigger:slow] check config lock', cwd: dir, sessionId: existing.sessionId },
    [dir],
    () => undefined,
  )

  // Attack IMMEDIATELY during the slow setSessionMode('plan') setup window (before startPrompt runs)
  await new Promise(r => setTimeout(r, 25))
  await assert.rejects(
    () => manager.setSessionConfigOption(existing.sessionId, 'permission_mode', 'acceptEdits'),
    /read-only claude_ask/,
  )
  await assert.rejects(
    () => manager.setSessionConfigOption(existing.sessionId, 'mode', 'acceptEdits'),
    /read-only claude_ask/,
  )
  await assert.rejects(
    () => manager.startPrompt(existing.sessionId, 'unauthorized write'),
    /already has a turn in progress/,
  )
  const openDuringSetup = await manager.handleOpenTool(
    { sessionId: existing.sessionId, prompt: 'hijack during setup', mode: 'acceptEdits' },
    [dir],
  )
  assert.equal(openDuringSetup.isError, true)

  const askDone = await askPromise
  assert.equal(askDone.isError, undefined)
})

test('claude_open and claude_ask default to opus model (with auto for open, plan for ask) and honor overrides', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-defaults-'))
  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  // claude_open without explicit mode/model defaults to auto + opus
  const openDefault = await manager.handleOpenTool({ prompt: 'Default check', cwd: dir }, [dir])
  assert.equal(openDefault.isError, undefined)
  const openSc = openDefault.structuredContent as { activeSession?: { modeId?: string; modelId?: string } }
  assert.equal(openSc.activeSession?.modeId, 'auto')
  assert.equal(openSc.activeSession?.modelId, 'claude-opus-4-1')

  // claude_open explicit overrides win
  const openOverride = await manager.handleOpenTool(
    { prompt: 'Override check', cwd: dir, mode: 'acceptEdits', model: 'sonnet' },
    [dir],
  )
  assert.equal(openOverride.isError, undefined)
  const overrideSc = openOverride.structuredContent as { activeSession?: { modeId?: string; modelId?: string } }
  assert.equal(overrideSc.activeSession?.modeId, 'acceptEdits')
  assert.equal(overrideSc.activeSession?.modelId, 'claude-sonnet-4-5')

  // claude_ask stays read-only plan mode and defaults to opus
  const askDefault = await manager.handleAskTool({ prompt: 'Read-only default check', cwd: dir }, [dir], () => undefined)
  assert.equal(askDefault.isError, undefined)
  const askDefaultSc = askDefault.structuredContent as { modeId?: string; modelId?: string }
  assert.equal(askDefaultSc.modeId, 'plan')
  assert.equal(askDefaultSc.modelId, 'claude-opus-4-1')

  // claude_ask explicit model override wins
  const askOverride = await manager.handleAskTool(
    { prompt: 'Read-only sonnet check', cwd: dir, model: 'sonnet' },
    [dir],
    () => undefined,
  )
  assert.equal(askOverride.isError, undefined)
  const askOverrideSc = askOverride.structuredContent as { modeId?: string; modelId?: string }
  assert.equal(askOverrideSc.modeId, 'plan')
  assert.equal(askOverrideSc.modelId, 'claude-sonnet-4-5')

  await new Promise(r => setTimeout(r, 150))
})

test('createSession applies opus before auto, avoids opusplan alias collision, and falls back gracefully without opus', async t => {
  // 1. Model is applied before mode so agents requiring Opus for Auto mode activate both cleanly
  const dir1 = await mkdtemp(join(tmpdir(), 'claude-agent-order-'))
  const mgrOrder = createTestManager(dir1, dir1, {
    FAKE_ACP_AUTO_REQUIRES_OPUS: '1',
    FAKE_ACP_MODE_CONFIG: '1',
  })
  t.after(async () => {
    await mgrOrder.dispose()
    await rm(dir1, { recursive: true, force: true })
  })
  const ordered = await mgrOrder.createSession({ cwd: dir1 })
  assert.equal(ordered.modelId, 'claude-opus-4-1')
  assert.equal(ordered.modeId, 'auto')

  // 2. Opus alias avoids matching opusplan / default when concrete Opus model exists
  const dir2 = await mkdtemp(join(tmpdir(), 'claude-agent-opusplan-'))
  const mgrOpusPlan = createTestManager(dir2, dir2, { FAKE_ACP_WITH_OPUSPLAN: '1' })
  t.after(async () => {
    await mgrOpusPlan.dispose()
    await rm(dir2, { recursive: true, force: true })
  })
  const concrete = await mgrOpusPlan.createSession({ cwd: dir2 })
  assert.equal(concrete.modelId, 'claude-opus-4-1')

  // 3. When agent does not offer any Opus model, default falls back gracefully to agent default
  const dir3 = await mkdtemp(join(tmpdir(), 'claude-agent-no-opus-'))
  const mgrNoOpus = createTestManager(dir3, dir3, { FAKE_ACP_NO_OPUS: '1' })
  t.after(async () => {
    await mgrNoOpus.dispose()
    await rm(dir3, { recursive: true, force: true })
  })
  const fallback = await mgrNoOpus.createSession({ cwd: dir3 })
  assert.equal(fallback.modelId, 'claude-sonnet-4-5')
  assert.equal(fallback.modeId, 'auto')
})

test('ensureSessionLoaded fallback to session/new preserves model and mode defaults', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-load-fallback-'))
  const store = createStore(dir)
  await store.upsertSession({
    sessionId: 'stale-sess-1',
    title: 'Stale Session',
    cwd: dir,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    touchedFiles: [],
    items: [],
  })

  const manager = new SessionManager({
    store,
    binaryDeps: {
      env: { CLAUDE_AGENT_ACP_BIN: process.execPath, CLAUDE_AGENT_ACP_ARGS: FAKE_AGENT },
      isExecutable: () => true,
    },
    env: { ...process.env, FAKE_ACP_FAIL_LOAD: '1', FAKE_ACP_AUTO_REQUIRES_OPUS: '1' },
    defaultCwd: dir,
  })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const loaded = await manager.ensureSessionLoaded('stale-sess-1')
  assert.notEqual(loaded.sessionId, 'stale-sess-1')
  assert.equal(loaded.modelId, 'claude-opus-4-1')
  assert.equal(loaded.modeId, 'auto')
})

test('claude_open auto-reply queues pendingReplies with atomic claim/release/ack and cross-session wakeup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-autoreply-'))
  const manager = createTestManager(dir, dir)
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  // Create another session B that a view is actively polling
  const sessionB = await manager.createSession({ cwd: dir })

  // Start long-poll on session B before dispatching async turn on session A
  const pollStart = Date.now()
  const pollBPromise = manager.pollEvents(sessionB.sessionId, sessionB.latestSeq, 5_000, 'aux-view-1')

  // Dispatch async turn on session A with default replyToChat=true
  const openRes = await manager.handleOpenTool({ prompt: 'Review MR async', cwd: dir, mode: 'plan' }, [dir])
  assert.equal(openRes.isError, undefined)
  const sessionAId = (openRes.structuredContent as { activeSession?: { sessionId: string } }).activeSession?.sessionId
  assert.ok(sessionAId)

  // Poll on session B should wake promptly when session A finishes and include pendingReplies
  const pollB = await pollBPromise
  assert.ok(Date.now() - pollStart < 2_000, 'expected cross-session poll wakeup when pending reply became ready')
  const pendingRef = pollB.pendingReplies?.find(r => r.sessionId === sessionAId)
  assert.ok(pendingRef, 'expected pendingReplies entry for completed session A')
  assert.equal(pendingRef!.status, 'completed')

  // Claim atomically from view 1; view 2 must be denied while lease is active
  const claim1 = (
    await manager.handleUiSession(
      { action: 'claim_reply', sessionId: sessionAId!, replyId: pendingRef!.replyId, clientId: 'aux-view-1' },
      [dir],
    )
  ).structuredContent as { claimed: boolean; text?: string }
  assert.equal(claim1.claimed, true)
  assert.ok(claim1.text?.includes('Review MR async'))
  assert.ok(claim1.text?.includes(sessionAId!))

  const claim2 = (
    await manager.handleUiSession(
      { action: 'claim_reply', sessionId: sessionAId!, replyId: pendingRef!.replyId, clientId: 'aux-view-2' },
      [dir],
    )
  ).structuredContent as { claimed: boolean }
  assert.equal(claim2.claimed, false)

  // Release from view 1 allows view 2 to claim and ack
  await manager.handleUiSession(
    { action: 'release_reply', sessionId: sessionAId!, replyId: pendingRef!.replyId, clientId: 'aux-view-1' },
    [dir],
  )
  const claim2Retry = (
    await manager.handleUiSession(
      { action: 'claim_reply', sessionId: sessionAId!, replyId: pendingRef!.replyId, clientId: 'aux-view-2' },
      [dir],
    )
  ).structuredContent as { claimed: boolean; text?: string }
  assert.equal(claim2Retry.claimed, true)

  await manager.handleUiSession(
    { action: 'ack_reply', sessionId: sessionAId!, replyId: pendingRef!.replyId, clientId: 'aux-view-2' },
    [dir],
  )
  const bootAfterAck = await manager.getBootstrap({ workspaceRoots: [dir] })
  assert.equal(bootAfterAck.pendingReplies, undefined)

  // replyToChat: false must NOT queue pendingReplies
  const noReplyOpen = await manager.handleOpenTool({ prompt: 'Silent run', cwd: dir, replyToChat: false }, [dir])
  assert.ok(noReplyOpen.text.includes('Started interactive Claude Agent turn'))
  await new Promise(r => setTimeout(r, 150))
  const bootSilent = await manager.getBootstrap({ workspaceRoots: [dir] })
  assert.equal(bootSilent.pendingReplies, undefined)

  // Manual cancel must NOT queue pendingReplies
  const cancelOpen = await manager.handleOpenTool({ prompt: '[trigger:slow] cancel me', cwd: dir, replyToChat: true }, [dir])
  const cancelSessionId = (cancelOpen.structuredContent as { activeSession?: { sessionId: string } }).activeSession?.sessionId!
  await new Promise(r => setTimeout(r, 40))
  await manager.cancelTurn(cancelSessionId)
  const bootAfterCancel = await manager.getBootstrap({ workspaceRoots: [dir] })
  assert.equal(bootAfterCancel.pendingReplies, undefined)
})

test('claude_session wait returns progress without cancelling turn and clears pendingChatReply on completion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-wait-'))
  const manager = createTestManager(dir, dir, {}, { minWaitTimeoutMs: 50 })
  t.after(async () => {
    await manager.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  const openRes = await manager.handleOpenTool({ prompt: '[trigger:slow] deep review', cwd: dir, mode: 'plan' }, [dir])
  const sessionId = (openRes.structuredContent as { activeSession?: { sessionId: string } }).activeSession?.sessionId!

  // Short wait window times out WITHOUT cancelling the active turn
  const midWait = await manager.handleSessionTool({ action: 'wait', sessionId, timeoutSeconds: 0.08 })
  assert.equal(midWait.isError, undefined)
  const midSc = midWait.structuredContent as { status: string; stillRunning: boolean }
  assert.equal(midSc.status, 'running')
  assert.equal(midSc.stillRunning, true)
  assert.ok(midWait.text.includes('NOT cancelled'))

  // Subsequent wait completes and returns the full response while clearing pendingChatReply to avoid duplicate send
  const doneWait = await manager.handleSessionTool({ action: 'wait', sessionId, timeoutSeconds: 5 })
  assert.equal(doneWait.isError, undefined)
  const doneSc = doneWait.structuredContent as { status: string; stillRunning: boolean; latestResponse?: string }
  assert.equal(doneSc.status, 'idle')
  assert.equal(doneSc.stillRunning, false)
  assert.ok(doneSc.latestResponse?.includes('Finished slow turn.'))

  const boot = await manager.getBootstrap({ workspaceRoots: [dir] })
  assert.equal(boot.pendingReplies, undefined, 'consuming completed turn via wait should clear pendingChatReply')
})
