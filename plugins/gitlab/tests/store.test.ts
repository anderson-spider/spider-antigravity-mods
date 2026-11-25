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
