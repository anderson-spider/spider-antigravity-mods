import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createAuditLog } from '../server/audit.ts'
import { DEFAULT_INLINE_MAX_BYTES, utf8ByteLength } from '../server/budget.ts'
import {
  APPLY_EDITS_TOOL_SPEC,
  buildUnifiedDiff,
  MAX_EDIT_FILE_BYTES,
  MAX_EDIT_FILES,
  MAX_EDIT_TOTAL_BYTES,
  runApplyEdits,
} from '../server/edits.ts'
import { createPolicyGuard, ENV_ALLOW_EDITS } from '../server/policy.ts'

const tempDirs: string[] = []

async function makeWorkspace(prefix = 'batch-tools-edits-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return await fs.realpath(dir)
}

function makeDeps(workspace: string, env: NodeJS.ProcessEnv = {}) {
  const audit = createAuditLog()
  const policy = createPolicyGuard({
    mcpRoots: [workspace],
    env,
    audit,
  })
  return { policy, audit }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('apply_edits core functionality', () => {
  it('applies multi-file atomic hunks in one batch and records audit summary + diffPreview', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    await fs.mkdir(path.join(ws, 'src'), { recursive: true })
    await fs.writeFile(path.join(ws, 'src/a.ts'), 'export const a = 1\nexport const b = 2\n', 'utf8')
    await fs.writeFile(path.join(ws, 'src/b.ts'), 'export function greet() {\n  return "old"\n}\n', 'utf8')

    const res = await runApplyEdits(
      {
        edits: [
          {
            path: 'src/a.ts',
            hunks: [{ target: 'export const a = 1', replacement: 'export const a = 10' }],
          },
          {
            path: 'src/b.ts',
            hunks: [{ target: 'return "old"', replacement: 'return "new"' }],
          },
        ],
      },
      deps,
    )

    assert.equal(res.isError, false)
    assert.match(res.text, /2 file\(s\) written/)
    assert.equal(
      await fs.readFile(path.join(ws, 'src/a.ts'), 'utf8'),
      'export const a = 10\nexport const b = 2\n',
    )
    assert.equal(
      await fs.readFile(path.join(ws, 'src/b.ts'), 'utf8'),
      'export function greet() {\n  return "new"\n}\n',
    )

    const entries = deps.audit.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.status, 'ok')
    assert.match(entries[0]!.diffPreview ?? '', /--- a\/src\/a\.ts/)
    assert.match(entries[0]!.diffPreview ?? '', /\+export const a = 10/)
  })

  it('supports JSON-stringified edits and hunks arrays', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    await fs.writeFile(path.join(ws, 'note.txt'), 'alpha\nbeta\n', 'utf8')

    const res = await runApplyEdits(
      {
        edits: JSON.stringify([
          {
            path: 'note.txt',
            hunks: JSON.stringify([{ target: 'beta', replacement: 'gamma' }]),
          },
        ]),
      },
      deps,
    )

    assert.equal(res.isError, false)
    assert.equal(await fs.readFile(path.join(ws, 'note.txt'), 'utf8'), 'alpha\ngamma\n')
  })

  it('supports startLine/endLine disambiguation and reports out-of-range exact match hints', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    const content = ['const x = 1', 'const y = 2', 'const x = 1', 'const z = 3'].join('\n') + '\n'
    await fs.writeFile(path.join(ws, 'dup.ts'), content, 'utf8')

    // Ambiguous without startLine/endLine or replaceAll
    const ambig = await runApplyEdits(
      {
        edits: [{ path: 'dup.ts', hunks: [{ target: 'const x = 1', replacement: 'const x = 9' }] }],
      },
      deps,
    )
    assert.equal(ambig.isError, true)
    assert.match(ambig.text, /matched 2 times/)
    assert.equal(await fs.readFile(path.join(ws, 'dup.ts'), 'utf8'), content)

    // Out-of-range exact match hint
    const wrongRange = await runApplyEdits(
      {
        edits: [
          {
            path: 'dup.ts',
            hunks: [{ target: 'const z = 3', replacement: 'const z = 30', startLine: 1, endLine: 2 }],
          },
        ],
      },
      deps,
    )
    assert.equal(wrongRange.isError, true)
    assert.match(wrongRange.text, /Exact match found outside range at L4/)

    // Valid line window targets only line 3
    const ok = await runApplyEdits(
      {
        edits: [
          {
            path: 'dup.ts',
            hunks: [{ target: 'const x = 1', replacement: 'const x = 9', startLine: 3, endLine: 3 }],
          },
        ],
      },
      deps,
    )
    assert.equal(ok.isError, false)
    assert.equal(
      await fs.readFile(path.join(ws, 'dup.ts'), 'utf8'),
      ['const x = 1', 'const y = 2', 'const x = 9', 'const z = 3'].join('\n') + '\n',
    )
  })

  it('supports replaceAll: true and rejects overlapping hunks', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    await fs.writeFile(path.join(ws, 'all.ts'), 'foo(1)\nfoo(2)\nfoo(3)\n', 'utf8')

    const overlap = await runApplyEdits(
      {
        edits: [
          {
            path: 'all.ts',
            hunks: [
              { target: 'foo(1)\nfoo(2)', replacement: 'bar(1)\nbar(2)' },
              { target: 'foo(2)\nfoo(3)', replacement: 'baz(2)\nbaz(3)' },
            ],
          },
        ],
      },
      deps,
    )
    assert.equal(overlap.isError, true)
    assert.match(overlap.text, /overlap/)

    const res = await runApplyEdits(
      {
        edits: [
          {
            path: 'all.ts',
            hunks: [{ target: 'foo', replacement: 'bar', replaceAll: true }],
          },
        ],
      },
      deps,
    )
    assert.equal(res.isError, false)
    assert.equal(await fs.readFile(path.join(ws, 'all.ts'), 'utf8'), 'bar(1)\nbar(2)\nbar(3)\n')
  })

  it('supports create with nested parent dirs and requires overwrite: true for existing files', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)

    const created = await runApplyEdits(
      {
        edits: [{ path: 'nested/dir/hello.txt', create: 'hello world\n' }],
      },
      deps,
    )
    assert.equal(created.isError, false)
    assert.equal(await fs.readFile(path.join(ws, 'nested/dir/hello.txt'), 'utf8'), 'hello world\n')

    // Refuses overwrite without flag
    const blocked = await runApplyEdits(
      {
        edits: [{ path: 'nested/dir/hello.txt', create: 'replaced\n' }],
      },
      deps,
    )
    assert.equal(blocked.isError, true)
    assert.match(blocked.text, /already exists/)
    assert.equal(await fs.readFile(path.join(ws, 'nested/dir/hello.txt'), 'utf8'), 'hello world\n')

    // Succeeds with overwrite: true
    const overwritten = await runApplyEdits(
      {
        edits: [{ path: 'nested/dir/hello.txt', create: 'replaced\n', overwrite: true }],
      },
      deps,
    )
    assert.equal(overwritten.isError, false)
    assert.equal(await fs.readFile(path.join(ws, 'nested/dir/hello.txt'), 'utf8'), 'replaced\n')
  })

  it('preserves UTF-8 BOM, CRLF line endings, and POSIX file mode', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    const filePath = path.join(ws, 'script.sh')
    const initialBuf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('#!/usr/bin/env bash\r\necho "hello"\r\necho "done"\r\n', 'utf8'),
    ])
    await fs.writeFile(filePath, initialBuf)
    if (process.platform !== 'win32') {
      await fs.chmod(filePath, 0o755)
    }

    const res = await runApplyEdits(
      {
        edits: [
          {
            path: 'script.sh',
            hunks: [{ target: 'echo "hello"\necho "done"', replacement: 'echo "hi"\necho "finished"' }],
          },
        ],
      },
      deps,
    )

    assert.equal(res.isError, false)
    const afterBuf = await fs.readFile(filePath)
    assert.equal(afterBuf[0], 0xef)
    assert.equal(afterBuf[1], 0xbb)
    assert.equal(afterBuf[2], 0xbf)
    const body = afterBuf.subarray(3).toString('utf8')
    assert.equal(body, '#!/usr/bin/env bash\r\necho "hi"\r\necho "finished"\r\n')
    if (process.platform !== 'win32') {
      const st = await fs.stat(filePath)
      assert.equal(st.mode & 0o777, 0o755)
    }
  })

  it('returns closest-region mismatch hint and leaves 0 files touched when any file fails', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    await fs.writeFile(path.join(ws, 'first.ts'), 'export const ok = true\n', 'utf8')
    await fs.writeFile(
      path.join(ws, 'second.ts'),
      [
        'export function calculateTotal(items: number[]) {',
        '  let sum = 0',
        '  for (const item of items) {',
        '    sum += item',
        '  }',
        '  return sum',
        '}',
      ].join('\n') + '\n',
      'utf8',
    )

    const res = await runApplyEdits(
      {
        edits: [
          {
            path: 'first.ts',
            hunks: [{ target: 'export const ok = true', replacement: 'export const ok = false' }],
          },
          {
            path: 'second.ts',
            hunks: [
              {
                target: 'export function calculateTotal(items: number[]) {\n  let total = 0',
                replacement: 'export function calculateTotal(items: number[]) {\n  let total = 1',
              },
            ],
          },
        ],
      },
      deps,
    )

    assert.equal(res.isError, true)
    assert.match(res.text, /0 files modified/)
    assert.match(res.text, /Closest match near line 1/)
    assert.match(res.text, /let sum = 0/)
    // Atomicity check: first.ts must remain untouched!
    assert.equal(await fs.readFile(path.join(ws, 'first.ts'), 'utf8'), 'export const ok = true\n')
  })

  it('returns compact unified diff on dryRun: true without touching disk and redacts secrets in audit', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    const token = 'glpat-SuperSecret123456'
    await fs.writeFile(path.join(ws, 'config.ts'), `export const sample = "placeholder"\n`, 'utf8')

    const res = await runApplyEdits(
      {
        dryRun: true,
        edits: [
          {
            path: 'config.ts',
            hunks: [
              {
                target: 'export const sample = "placeholder"',
                replacement: `export const sample = "${token}"`,
              },
            ],
          },
          {
            path: 'brand-new.ts',
            create: 'export const created = true\n',
          },
        ],
      },
      deps,
    )

    assert.equal(res.isError, false)
    assert.ok(utf8ByteLength(res.text) <= DEFAULT_INLINE_MAX_BYTES)
    assert.match(res.text, /Dry run:/)
    assert.match(res.text, /--- a\/config\.ts/)
    assert.match(res.text, /\+\+\+ b\/config\.ts/)
    assert.match(res.text, /@@ -1,1 \+1,1 @@/)
    assert.match(res.text, /--- \/dev\/null/)
    assert.match(res.text, /\+\+\+ b\/brand-new\.ts/)

    // Disk must remain untouched
    assert.equal(
      await fs.readFile(path.join(ws, 'config.ts'), 'utf8'),
      'export const sample = "placeholder"\n',
    )
    await assert.rejects(() => fs.stat(path.join(ws, 'brand-new.ts')), { code: 'ENOENT' })

    // Audit entry must have redacted diffPreview
    const entries = deps.audit.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.status, 'ok')
    assert.ok(!(entries[0]!.diffPreview ?? '').includes('SuperSecret123456'))
    assert.match(entries[0]!.diffPreview ?? '', /glpat-\*\*\*/)
  })

  it('caps large dryRun unified diffs strictly within DEFAULT_INLINE_MAX_BYTES', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    const bigLine = 'x'.repeat(200)
    const edits = []
    for (let i = 0; i < 10; i++) {
      const content = Array.from({ length: 40 }, (_, ln) => `line_${i}_${ln}_${bigLine}`).join('\n') + '\n'
      edits.push({ path: `big_${i}.txt`, create: content })
    }

    const res = await runApplyEdits({ dryRun: true, edits }, deps)
    assert.equal(res.isError, false)
    assert.ok(
      utf8ByteLength(res.text) <= DEFAULT_INLINE_MAX_BYTES,
      `Expected <= ${DEFAULT_INLINE_MAX_BYTES} bytes, got ${utf8ByteLength(res.text)}`,
    )
  })
})

describe('apply_edits security hardenings & caps', () => {
  it('explicitly rejects verify, verifyTimeoutSec, and bestEffort with clear errors', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    await fs.writeFile(path.join(ws, 'a.ts'), 'const a = 1\n', 'utf8')

    const withVerify = await runApplyEdits(
      {
        edits: [{ path: 'a.ts', hunks: [{ target: '1', replacement: '2' }] }],
        verify: 'echo pwned',
      },
      deps,
    )
    assert.equal(withVerify.isError, true)
    assert.match(withVerify.text, /'verify'.*intentionally unsupported/i)
    assert.equal(await fs.readFile(path.join(ws, 'a.ts'), 'utf8'), 'const a = 1\n')
    assert.equal(deps.audit.list().at(-1)?.status, 'blocked')

    const withBestEffort = await runApplyEdits(
      {
        edits: [{ path: 'a.ts', hunks: [{ target: '1', replacement: '2' }] }],
        bestEffort: true,
      },
      deps,
    )
    assert.equal(withBestEffort.isError, true)
    assert.match(withBestEffort.text, /'bestEffort'.*intentionally unsupported/i)
    assert.equal(await fs.readFile(path.join(ws, 'a.ts'), 'utf8'), 'const a = 1\n')
    assert.equal(deps.audit.list().at(-1)?.status, 'blocked')

    // Tool schema also does not advertise verify or bestEffort
    const props = (APPLY_EDITS_TOOL_SPEC.inputSchema as { properties: Record<string, unknown> }).properties
    assert.equal('verify' in props, false)
    assert.equal('bestEffort' in props, false)
  })

  it('denies all edits when BATCH_TOOLS_ALLOW_EDITS=false and records blocked audit entry', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws, { [ENV_ALLOW_EDITS]: 'false' })
    await fs.writeFile(path.join(ws, 'a.ts'), 'const a = 1\n', 'utf8')

    const res = await runApplyEdits(
      {
        edits: [{ path: 'a.ts', hunks: [{ target: '1', replacement: '2' }] }],
      },
      deps,
    )

    assert.equal(res.isError, true)
    assert.match(res.text, /BATCH_TOOLS_ALLOW_EDITS=false/)
    assert.equal(await fs.readFile(path.join(ws, 'a.ts'), 'utf8'), 'const a = 1\n')
    const entries = deps.audit.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.status, 'blocked')
    assert.equal(entries[0]!.reason, 'edits_disabled')
  })

  it('rejects duplicate canonical paths in the same batch before touching disk', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    await fs.mkdir(path.join(ws, 'src'), { recursive: true })
    await fs.writeFile(path.join(ws, 'src/dup.ts'), 'const a = 1\nconst b = 2\n', 'utf8')

    const res = await runApplyEdits(
      {
        edits: [
          { path: 'src/dup.ts', hunks: [{ target: 'a = 1', replacement: 'a = 10' }] },
          { path: './src/../src/dup.ts', hunks: [{ target: 'b = 2', replacement: 'b = 20' }] },
        ],
      },
      deps,
    )

    assert.equal(res.isError, true)
    assert.match(res.text, /duplicate path in batch/)
    assert.equal(
      await fs.readFile(path.join(ws, 'src/dup.ts'), 'utf8'),
      'const a = 1\nconst b = 2\n',
    )
  })

  it('enforces >25 files, >2 MiB per file, and >10 MiB total batch caps', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)

    // >25 files
    const tooMany = Array.from({ length: MAX_EDIT_FILES + 1 }, (_, i) => ({
      path: `f_${i}.txt`,
      create: 'ok\n',
    }))
    const resMany = await runApplyEdits({ edits: tooMany }, deps)
    assert.equal(resMany.isError, true)
    assert.match(resMany.text, /at most 25 file entries/)

    // >2 MiB planned create
    const over2MiB = 'a'.repeat(MAX_EDIT_FILE_BYTES + 1)
    const resBigCreate = await runApplyEdits(
      { edits: [{ path: 'huge.txt', create: over2MiB }] },
      deps,
    )
    assert.equal(resBigCreate.isError, true)
    assert.match(resBigCreate.text, /exceeds 2 MiB limit/)

    // >2 MiB existing file read
    await fs.writeFile(path.join(ws, 'existing-huge.txt'), over2MiB, 'utf8')
    const resBigRead = await runApplyEdits(
      { edits: [{ path: 'existing-huge.txt', hunks: [{ target: 'aaa', replacement: 'bbb' }] }] },
      deps,
    )
    assert.equal(resBigRead.isError, true)
    assert.match(resBigRead.text, /exceeds maximum size/)

    // >10 MiB total across 6 files (each 1.8 MiB < 2 MiB, sum 10.8 MiB > 10 MiB)
    const chunk18 = 'b'.repeat(Math.floor(MAX_EDIT_TOTAL_BYTES / 5.5))
    assert.ok(chunk18.length < MAX_EDIT_FILE_BYTES)
    assert.ok(chunk18.length * 6 > MAX_EDIT_TOTAL_BYTES)
    const batchOver10 = Array.from({ length: 6 }, (_, i) => ({
      path: `part_${i}.txt`,
      create: chunk18,
    }))
    const resTotal = await runApplyEdits({ edits: batchOver10 }, deps)
    assert.equal(resTotal.isError, true)
    assert.match(resTotal.text, /exceeds 10 MiB limit/)
    await assert.rejects(() => fs.stat(path.join(ws, 'part_0.txt')), { code: 'ENOENT' })
  })

  it('blocks symlinks, .env, .git/config, .. traversal, and ~ paths (while allowing .env.example)', async () => {
    const ws = await makeWorkspace()
    const outside = await makeWorkspace('batch-tools-outside-')
    const deps = makeDeps(ws)

    await fs.writeFile(path.join(ws, 'real.txt'), 'real\n', 'utf8')
    await fs.symlink(path.join(ws, 'real.txt'), path.join(ws, 'link.txt'))
    await fs.mkdir(path.join(ws, '.git'), { recursive: true })
    await fs.writeFile(path.join(ws, '.git/config'), '[core]\n', 'utf8')
    await fs.writeFile(path.join(ws, '.env'), 'SECRET=1\n', 'utf8')
    await fs.writeFile(path.join(outside, 'escape.txt'), 'outside\n', 'utf8')

    // Symlink write
    const symRes = await runApplyEdits(
      { edits: [{ path: 'link.txt', hunks: [{ target: 'real', replacement: 'evil' }] }] },
      deps,
    )
    assert.equal(symRes.isError, true)
    assert.match(symRes.text, /symlink/)
    assert.equal(await fs.readFile(path.join(ws, 'real.txt'), 'utf8'), 'real\n')

    // .env
    const envRes = await runApplyEdits(
      { edits: [{ path: '.env', hunks: [{ target: 'SECRET=1', replacement: 'SECRET=2' }] }] },
      deps,
    )
    assert.equal(envRes.isError, true)
    assert.match(envRes.text, /secret-file denylist/)
    assert.equal(await fs.readFile(path.join(ws, '.env'), 'utf8'), 'SECRET=1\n')

    // .git/config
    const gitRes = await runApplyEdits(
      { edits: [{ path: '.git/config', hunks: [{ target: '[core]', replacement: '[pwn]' }] }] },
      deps,
    )
    assert.equal(gitRes.isError, true)
    assert.match(gitRes.text, /\.git/)
    assert.equal(await fs.readFile(path.join(ws, '.git/config'), 'utf8'), '[core]\n')

    // .. traversal outside workspace
    const relOutside = path.relative(ws, path.join(outside, 'escape.txt'))
    const dotDotRes = await runApplyEdits(
      { edits: [{ path: relOutside, hunks: [{ target: 'outside', replacement: 'pwned' }] }] },
      deps,
    )
    assert.equal(dotDotRes.isError, true)
    assert.match(dotDotRes.text, /escapes allowed workspace roots/)
    assert.equal(await fs.readFile(path.join(outside, 'escape.txt'), 'utf8'), 'outside\n')

    // ~ home path
    const tildeRes = await runApplyEdits(
      { edits: [{ path: '~/evil.txt', create: 'nope\n' }] },
      deps,
    )
    assert.equal(tildeRes.isError, true)
    assert.match(tildeRes.text, /home-directory \(~\) paths are forbidden/)

    // .env.example is explicitly allowed
    const exampleRes = await runApplyEdits(
      { edits: [{ path: '.env.example', create: 'PORT=3000\n' }] },
      deps,
    )
    assert.equal(exampleRes.isError, false)
    assert.equal(await fs.readFile(path.join(ws, '.env.example'), 'utf8'), 'PORT=3000\n')

    // Symlinked parent directory blocked on create
    await fs.symlink(outside, path.join(ws, 'symdir'))
    const symDirRes = await runApplyEdits(
      { edits: [{ path: 'symdir/escape-new.txt', create: 'nope\n' }] },
      deps,
    )
    assert.equal(symDirRes.isError, true)
    assert.match(symDirRes.text, /symlink|escapes/)
    await assert.rejects(() => fs.stat(path.join(outside, 'escape-new.txt')), { code: 'ENOENT' })
  })

  it('redacts secrets in error output and preserves mixed EOL locally', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    await fs.writeFile(path.join(ws, 'mixed.txt'), 'line1\r\nline2\r\nline3\nline4\n', 'utf8')

    // Mixed EOL preservation: CRLF region stays CRLF, LF region stays LF
    const mixRes = await runApplyEdits(
      {
        edits: [
          {
            path: 'mixed.txt',
            hunks: [
              { target: 'line1\nline2', replacement: 'L1\nL2' },
              { target: 'line3\nline4', replacement: 'L3\nL4' },
            ],
          },
        ],
      },
      deps,
    )
    assert.equal(mixRes.isError, false)
    assert.equal(
      await fs.readFile(path.join(ws, 'mixed.txt'), 'utf8'),
      'L1\r\nL2\r\nL3\nL4\n',
    )

    // Secret in a failing path/mismatch snippet is redacted from error text
    await fs.writeFile(
      path.join(ws, 'fixture.ts'),
      'export const fixture = "ghp_1234567890abcdef123456"\n',
      'utf8',
    )
    const errRes = await runApplyEdits(
      {
        edits: [
          {
            path: 'fixture.ts',
            hunks: [{ target: 'export const fixture = "different_value"', replacement: 'x' }],
          },
        ],
      },
      deps,
    )
    assert.equal(errRes.isError, true)
    assert.ok(!errRes.text.includes('1234567890abcdef123456'))
    assert.match(errRes.text, /gh_\*\*\*/)
  })
})

describe('apply_edits Phase 2 concurrent modification detection & rollback', () => {
  it('detects mtimeMs concurrent modification in Phase 2 and rolls back earlier writes and new dirs', async () => {
    const ws = await makeWorkspace()
    const deps = makeDeps(ws)
    const file1 = path.join(ws, 'one.ts')
    const file2NewDir = path.join(ws, 'fresh/nested/two.ts')
    const file3 = path.join(ws, 'three.ts')

    await fs.writeFile(file1, 'export const one = 1\n', 'utf8')
    if (process.platform !== 'win32') {
      await fs.chmod(file1, 0o750)
    }
    await fs.writeFile(file3, 'export const three = 3\n', 'utf8')

    const res = await runApplyEdits(
      {
        edits: [
          {
            path: 'one.ts',
            hunks: [{ target: 'one = 1', replacement: 'one = 111' }],
          },
          {
            path: 'fresh/nested/two.ts',
            create: 'export const two = 2\n',
          },
          {
            path: 'three.ts',
            hunks: [{ target: 'three = 3', replacement: 'three = 333' }],
          },
        ],
      },
      {
        ...deps,
        async beforeWriteHook(ctx) {
          if (ctx.relPath === 'three.ts') {
            // Simulate concurrent IDE edit with same byte length and bumped mtimeMs
            await fs.writeFile(file3, 'export const three = 9\n', 'utf8')
            const future = new Date(Date.now() + 10_000)
            await fs.utimes(file3, future, future)
          }
        },
      },
    )

    assert.equal(res.isError, true)
    assert.match(res.text, /Write failed \(changes rolled back\)/)
    assert.match(res.text, /Concurrent modification detected for three\.ts/)

    // Earlier modified file1 must be completely restored (content + mode)
    assert.equal(await fs.readFile(file1, 'utf8'), 'export const one = 1\n')
    if (process.platform !== 'win32') {
      const st1 = await fs.stat(file1)
      assert.equal(st1.mode & 0o777, 0o750)
    }

    // Newly created file2 and its newly created parent directories must be removed
    await assert.rejects(() => fs.stat(file2NewDir), { code: 'ENOENT' })
    await assert.rejects(() => fs.stat(path.join(ws, 'fresh')), { code: 'ENOENT' })

    // Concurrent edit on file3 must NOT have been clobbered
    assert.equal(await fs.readFile(file3, 'utf8'), 'export const three = 9\n')

    // Audit records rollback error
    const lastAudit = deps.audit.list().at(-1)
    assert.equal(lastAudit?.status, 'error')
    assert.equal(lastAudit?.reason, 'commit_rolled_back')
  })

  it('detects Phase 2 symlink swap TOCTOU and rolls back earlier files', async () => {
    const ws = await makeWorkspace()
    const outside = await makeWorkspace('batch-tools-toctou-')
    const deps = makeDeps(ws)
    const file1 = path.join(ws, 'first.ts')
    const file2 = path.join(ws, 'victim.ts')
    const outsideSecret = path.join(outside, 'secret.txt')

    await fs.writeFile(file1, 'first = 1\n', 'utf8')
    await fs.writeFile(file2, 'victim = 1\n', 'utf8')
    await fs.writeFile(outsideSecret, 'untouched\n', 'utf8')

    const res = await runApplyEdits(
      {
        edits: [
          { path: 'first.ts', hunks: [{ target: '1', replacement: '2' }] },
          { path: 'victim.ts', hunks: [{ target: '1', replacement: '2' }] },
        ],
      },
      {
        ...deps,
        async beforeWriteHook(ctx) {
          if (ctx.relPath === 'victim.ts') {
            await fs.unlink(file2)
            await fs.symlink(outsideSecret, file2)
          }
        },
      },
    )

    assert.equal(res.isError, true)
    assert.match(res.text, /became a symlink before commit/)
    assert.equal(await fs.readFile(file1, 'utf8'), 'first = 1\n')
    assert.equal(await fs.readFile(outsideSecret, 'utf8'), 'untouched\n')
  })
})

describe('buildUnifiedDiff', () => {
  it('formats multi-hunk diffs cleanly with context lines', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const newLines = [...oldLines]
    newLines[1] = 'line 2 CHANGED'
    newLines[17] = 'line 18 CHANGED'

    const diff = buildUnifiedDiff('src/sample.ts', oldLines.join('\n') + '\n', newLines.join('\n') + '\n')
    assert.match(diff, /--- a\/src\/sample\.ts/)
    assert.match(diff, /\+\+\+ b\/src\/sample\.ts/)
    assert.match(diff, /-line 2\n\+line 2 CHANGED/)
    assert.match(diff, /-line 18\n\+line 18 CHANGED/)
    // Should produce two separate hunks since lines 2 and 18 are >6 lines apart
    const hunkHeaders = diff.match(/^@@ /gm) ?? []
    assert.equal(hunkHeaders.length, 2)
  })
})
