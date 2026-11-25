import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, defaultState } from '../server/store.ts'
import { expect, test } from './expect.ts'

test('persists preferences, saved views, and filesViewed across store instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-store-test-'))
  try {
    const storeA = createStore(dir)
    const initial = await storeA.load()
    expect(initial).toEqual(defaultState())

    await storeA.savePreferences({ diffMode: 'split', listWidthPct: 999, autoRefresh: false })
    await storeA.saveView({
      id: 'v-review',
      name: 'Needs my review',
      filters: { q: 'checks:failing', state: 'opened', involvement: 'reviewing', sort: 'ready', hostOrProject: 'all' },
    })
    await storeA.setFileViewed('gitlab.example.com:g/p:12', 'sha-1', 'src/a.ts', true)
    await storeA.setFileViewed('gitlab.example.com:g/p:12', 'sha-1', 'src/b.ts', true)

    // Re-open fresh instance against the same directory
    const storeB = createStore(dir)
    const loaded = await storeB.load()
    expect(loaded.preferences.diffMode).toBe('split')
    expect(loaded.preferences.listWidthPct).toBe(70) // clamped
    expect(loaded.preferences.autoRefresh).toBe(false)
    expect(loaded.savedViews).toHaveLength(1)
    expect(loaded.savedViews[0]?.name).toBe('Needs my review')
    expect(loaded.filesViewed['gitlab.example.com:g/p:12']).toEqual({ sha: 'sha-1', paths: ['src/a.ts', 'src/b.ts'] })

    // Changing head SHA invalidates old viewed paths for that MR
    const afterPush = await storeB.setFileViewed('gitlab.example.com:g/p:12', 'sha-2', 'src/c.ts', true)
    expect(afterPush.filesViewed['gitlab.example.com:g/p:12']).toEqual({ sha: 'sha-2', paths: ['src/c.ts'] })

    // Unmarking the last file removes the record cleanly
    const afterClear = await storeB.setFileViewed('gitlab.example.com:g/p:12', 'sha-2', 'src/c.ts', false)
    expect(afterClear.filesViewed['gitlab.example.com:g/p:12']).toBeUndefined()

    const afterDelete = await storeB.deleteView('v-review')
    expect(afterDelete.savedViews).toHaveLength(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recovers cleanly from corrupted JSON on disk and supports in-memory fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-store-corrupt-'))
  try {
    writeFileSync(join(dir, 'dashboard-state.json'), '{not valid json', 'utf8')
    const store = createStore(dir)
    expect(await store.load()).toEqual(defaultState())

    const mem = createStore(undefined)
    const saved = await mem.saveView({ name: 'In-memory view', filters: { q: 'draft:no' } })
    expect(saved.savedViews).toHaveLength(1)
    expect(saved.savedViews[0]?.filters.q).toBe('draft:no')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persists registered repos with deduplication, removal, backwards compat, and new involvement filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-store-repos-'))
  try {
    // Backwards compatibility: existing v0.4.0 state file without `repos`
    writeFileSync(
      join(dir, 'dashboard-state.json'),
      JSON.stringify({
        version: 1,
        preferences: { state: 'opened', involvement: 'waiting', sort: 'ready', hostOrProject: 'all', diffMode: 'unified', autoRefresh: true, showFileIndex: true, listWidthPct: 40 },
        savedViews: [{ id: 'v1', name: 'Others', filters: { q: '', state: 'opened', involvement: 'others', sort: 'ready', hostOrProject: 'all' } }],
        filesViewed: {},
      }),
      'utf8',
    )
    const store = createStore(dir)
    const loaded = await store.load()
    expect(loaded.repos).toEqual([])
    expect(loaded.preferences.involvement).toBe('waiting')
    expect(loaded.savedViews[0]?.filters.involvement).toBe('others')

    await store.addRepo({ path: '/repos/api/', host: 'GitLab.Example.Com', project: 'team/api' })
    await store.addRepo({ path: '/repos/web', host: 'gitlab.example.com', project: 'team/web' })
    // Deduplicates case-insensitively by host+project (updates path)
    const afterDedup = await store.addRepo({ path: '/repos/api-v2', host: 'gitlab.example.com', project: 'Team/API' })
    expect(afterDedup.repos).toEqual([
      { path: '/repos/web', host: 'gitlab.example.com', project: 'team/web' },
      { path: '/repos/api-v2', host: 'gitlab.example.com', project: 'Team/API' },
    ])

    // Remove by path
    const afterRemovePath = await store.removeRepo('/repos/web/')
    expect(afterRemovePath.repos).toHaveLength(1)

    // Remove by host|project (case-insensitive)
    const afterRemoveKey = await store.removeRepo('gitlab.example.com|team/api')
    expect(afterRemoveKey.repos).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
