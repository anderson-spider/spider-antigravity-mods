import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStore } from '../server/store.ts'

test('store persists sessions, preferences, recent cwds atomically with 0600 mode and backs up corrupt JSON', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-store-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const store = createStore(dir)
  await store.savePreferences({ sidebarWidthPct: 35, defaultModeId: 'plan', defaultEffort: 'max' })
  await store.recordCwd('/tmp/proj-a')
  await store.recordCwd('/tmp/proj-b')
  await store.upsertSession({
    sessionId: 'sess-1',
    title: 'Test Session',
    cwd: '/tmp/proj-b',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    touchedFiles: ['/tmp/proj-b/a.ts'],
    items: [
      {
        id: 'u-1',
        kind: 'user',
        text: 'hello',
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ],
  })

  const st = await stat(join(dir, 'claude-agent-state.json'))
  assert.equal(st.mode & 0o777, 0o600)

  // Reload from disk via a fresh store instance
  const reloaded = await createStore(dir).load()
  assert.equal(reloaded.preferences.sidebarWidthPct, 35)
  assert.equal(reloaded.preferences.defaultModeId, 'auto')
  assert.equal(reloaded.preferences.defaultEffort, 'max')
  assert.deepEqual(reloaded.recentCwds, ['/tmp/proj-b', '/tmp/proj-a'])
  assert.equal(reloaded.sessions.length, 1)
  assert.equal(reloaded.sessions[0]!.sessionId, 'sess-1')

  // Delete session
  const afterDelete = await createStore(dir).deleteSession('sess-1')
  assert.equal(afterDelete.sessions.length, 0)

  // Corrupt JSON recovery backs up corrupt file
  await writeFile(join(dir, 'claude-agent-state.json'), '{bad json', 'utf8')
  const recovered = await createStore(dir).load()
  assert.equal(recovered.version, 1)
  assert.deepEqual(recovered.sessions, [])
  const files = await readdir(dir)
  assert.ok(files.some(f => f.startsWith('claude-agent-state.json.corrupt-')))
})

test('store persists archivedAt and keeps active sessions ahead of archived sessions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-store-arch-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const store = createStore(dir)
  await store.upsertSession({
    sessionId: 'sess-archived',
    title: 'Archived Session',
    cwd: '/tmp/proj-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    archivedAt: '2026-01-03T01:00:00.000Z',
    touchedFiles: [],
    items: [],
  })
  await store.upsertSession({
    sessionId: 'sess-active',
    title: 'Active Session',
    cwd: '/tmp/proj-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    touchedFiles: [],
    items: [],
  })

  const reloaded = await createStore(dir).load()
  assert.equal(reloaded.sessions.length, 2)
  assert.equal(reloaded.sessions[0]!.sessionId, 'sess-active')
  assert.equal(reloaded.sessions[0]!.archivedAt, undefined)
  assert.equal(reloaded.sessions[1]!.sessionId, 'sess-archived')
  assert.equal(reloaded.sessions[1]!.archivedAt, '2026-01-03T01:00:00.000Z')
})

test('store defaults to auto mode, opus model, and high effort, and sanitizes legacy preference fields on existing state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-store-defaults-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const fresh = await createStore(dir).load()
  assert.equal(fresh.preferences.defaultModeId, 'auto')
  assert.equal(fresh.preferences.defaultModelId, 'opus')
  assert.equal(fresh.preferences.defaultEffort, 'high')

  // Legacy state file with removed plan mode and missing model/effort should migrate cleanly
  await writeFile(
    join(dir, 'claude-agent-state.json'),
    JSON.stringify({ version: 1, preferences: { sidebarWidthPct: 30, defaultModeId: 'plan' }, recentCwds: [], sessions: [] }),
    'utf8',
  )
  const migrated = await createStore(dir).load()
  assert.equal(migrated.preferences.sidebarWidthPct, 30)
  assert.equal(migrated.preferences.defaultModeId, 'auto')
  assert.equal(migrated.preferences.defaultModelId, 'opus')
  assert.equal(migrated.preferences.defaultEffort, 'high')

  // Explicit overrides persist (while disallowed defaultModeId clamps to auto)
  await createStore(dir).savePreferences({ defaultModeId: 'acceptEdits', defaultModelId: 'sonnet', defaultEffort: 'low' })
  const updated = await createStore(dir).load()
  assert.equal(updated.preferences.defaultModeId, 'auto')
  assert.equal(updated.preferences.defaultModelId, 'sonnet')
  assert.equal(updated.preferences.defaultEffort, 'low')
})
