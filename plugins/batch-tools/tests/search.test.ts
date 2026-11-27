import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createAuditLog } from '../server/audit.ts'
import { DEFAULT_INLINE_MAX_BYTES, utf8ByteLength } from '../server/budget.ts'
import { createPolicyGuard } from '../server/policy.ts'
import {
  execBinaryAsync,
  isRipgrepAvailable,
  resetRipgrepCache,
} from '../server/rg.ts'
import { runBatchSearch } from '../server/search.ts'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('rg.ts', () => {
  it('executes binaries with shell: false, scrubs sensitive env vars, caps output, redacts stderr, and kills on timeout', async () => {
    const dir = await makeTempDir('bt-rg-exec-')

    // 1. Scrubs credential env vars and does not use a shell (metacharacters remain literal)
    const envCheck = await execBinaryAsync(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify({ arg: process.argv[1], token: process.env.API_TOKEN ?? null, rgCfg: process.env.RIPGREP_CONFIG_PATH ?? null, ok: process.env.SAFE_TEST_VAR ?? null }))',
        'literal;echo_not_run$(whoami)',
      ],
      {
        cwd: dir,
        timeoutMs: 5000,
        env: {
          ...process.env,
          API_TOKEN: 'secret-token-value',
          RIPGREP_CONFIG_PATH: '/tmp/evil.rgrc',
          SAFE_TEST_VAR: 'kept',
        },
      },
    )
    assert.equal(envCheck.exitCode, 0)
    assert.equal(envCheck.timedOut, false)
    const parsed = JSON.parse(envCheck.stdout.trim()) as {
      arg: string
      token: string | null
      rgCfg: string | null
      ok: string | null
    }
    assert.equal(parsed.arg, 'literal;echo_not_run$(whoami)')
    assert.equal(parsed.token, null)
    assert.equal(parsed.rgCfg, null)
    assert.equal(parsed.ok, 'kept')

    // 2. Redacts credential patterns in stderr
    const stderrCheck = await execBinaryAsync(
      process.execPath,
      ['-e', 'console.error("failed with glpat-SuperSecret123456 and Bearer abcdefghij123456"); process.exit(1)'],
      { cwd: dir, timeoutMs: 5000 },
    )
    assert.equal(stderrCheck.exitCode, 1)
    assert.ok(!stderrCheck.stderr.includes('SuperSecret123456'))
    assert.ok(!stderrCheck.stderr.includes('abcdefghij123456'))
    assert.ok(stderrCheck.stderr.includes('glpat-***'))
    assert.ok(stderrCheck.stderr.includes('Bearer ***'))

    // 3. Caps stdout at maxOutputBytes without corrupting UTF-8
    const capCheck = await execBinaryAsync(
      process.execPath,
      ['-e', 'process.stdout.write("🚀".repeat(500))'],
      { cwd: dir, timeoutMs: 5000, maxOutputBytes: 25 },
    )
    assert.equal(capCheck.truncated, true)
    assert.ok(utf8ByteLength(capCheck.stdout) <= 25)
    assert.equal(Buffer.from(capCheck.stdout, 'utf8').toString('utf8'), capCheck.stdout)

    // 4. Kills long-running child cleanly on timeout
    const timeoutCheck = await execBinaryAsync(
      process.execPath,
      ['-e', 'setTimeout(() => console.log("late"), 10000)'],
      { cwd: dir, timeoutMs: 120 },
    )
    assert.equal(timeoutCheck.timedOut, true)
    assert.ok(timeoutCheck.durationMs < 3000)

    // 5. Cached ripgrep probe returns a boolean consistently
    resetRipgrepCache()
    const first = await isRipgrepAvailable()
    const second = await isRipgrepAvailable()
    assert.equal(typeof first, 'boolean')
    assert.equal(first, second)
  })
})

describe('search.ts — query modes & rg/Node fallback parity', () => {
  it('supports text, regex, outputMode, contextLines, multiline, fileType, glob, and caseSensitive with rg and Node fallback parity', async () => {
    const ws = await makeTempDir('bt-search-parity-')
    await fs.mkdir(path.join(ws, 'src'), { recursive: true })
    await fs.mkdir(path.join(ws, 'docs'), { recursive: true })
    await fs.mkdir(path.join(ws, 'node_modules', 'dep'), { recursive: true })

    await fs.writeFile(
      path.join(ws, 'src', 'alpha.ts'),
      [
        'export function greetUser(name: string): string {',
        '  const marker = "FIND_ME_ALPHA"',
        '  return `Hello ${name}`',
        '}',
        '',
        'async function fetchRecord(',
        '  id: number',
        '): Promise<string> {',
        '  return String(id)',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    await fs.writeFile(
      path.join(ws, 'src', 'beta.ts'),
      [
        'export const tag = "find_me_alpha"',
        'export const second = "FIND_ME_ALPHA"',
        'export const third = "FIND_ME_ALPHA"',
        '',
      ].join('\n'),
      'utf8',
    )
    await fs.writeFile(
      path.join(ws, 'docs', 'guide.md'),
      'Documentation mentions FIND_ME_ALPHA here.\n',
      'utf8',
    )
    // Ignored dir should never show up
    await fs.writeFile(
      path.join(ws, 'node_modules', 'dep', 'index.ts'),
      'export const ignored = "FIND_ME_ALPHA"\n',
      'utf8',
    )

    const policy = createPolicyGuard({ mcpRoots: [ws], env: {} })
    const audit = createAuditLog()
    const rgAvailable = await isRipgrepAvailable()

    const queries = [
      // 1. text (case-sensitive, default content)
      { type: 'text' as const, pattern: 'FIND_ME_ALPHA', fileType: 'ts', contextLines: 1 },
      // 2. text (case-insensitive, files_with_matches)
      {
        type: 'text' as const,
        pattern: 'find_me_alpha',
        caseSensitive: false,
        outputMode: 'files_with_matches' as const,
      },
      // 3. regex (count mode)
      {
        type: 'regex' as const,
        pattern: 'FIND_ME_\\w+',
        outputMode: 'count' as const,
        glob: '*.ts',
      },
      // 4. multiline regex
      {
        type: 'regex' as const,
        pattern: 'async function fetchRecord\\(\\s+id: number',
        multiline: true,
        fileType: 'ts',
      },
      // 5. negated glob
      {
        type: 'text' as const,
        pattern: 'FIND_ME_ALPHA',
        glob: '!*.md',
        outputMode: 'files_with_matches' as const,
      },
      // 6. multiline count mode
      {
        type: 'regex' as const,
        pattern: 'async function fetchRecord\\(\\s+id: number',
        multiline: true,
        outputMode: 'count' as const,
        fileType: 'ts',
      },
      // 7. hyphen-prefixed pattern (verifies `--` separator before pattern in rg)
      {
        type: 'text' as const,
        pattern: '--not-a-flag',
        fileType: 'md',
      },
    ]

    await fs.appendFile(
      path.join(ws, 'docs', 'guide.md'),
      'CLI flag example: --not-a-flag\n',
      'utf8',
    )

    const nodeRes = await runBatchSearch(
      { cwd: ws, queries },
      { policy, audit, forceNodeFallback: true },
    )
    assert.equal(nodeRes.isError, false)
    assert.equal(nodeRes.structuredContent?.engine, 'node')

    // Verify Node fallback results
    assert.ok(nodeRes.text.includes('src/alpha.ts'))
    assert.ok(nodeRes.text.includes('src/beta.ts'))
    assert.ok(!nodeRes.text.includes('node_modules'))
    assert.ok(nodeRes.text.includes('src/alpha.ts: 1 matching lines'))
    assert.ok(nodeRes.text.includes('src/beta.ts: 2 matching lines'))
    assert.ok(nodeRes.text.includes('6: async function fetchRecord('))
    assert.ok(nodeRes.text.includes('7:   id: number'))
    // Context line (line 1 before match on line 2) present in Query 1
    assert.ok(nodeRes.text.includes('1- export function greetUser'))
    // Query 5 excludes docs/guide.md
    const q5Node = nodeRes.text.split('## Query 5')[1]?.split('## Query 6')[0] ?? ''
    assert.ok(!q5Node.includes('docs/guide.md'))
    assert.ok(q5Node.includes('src/alpha.ts'))
    // Query 6 multiline count + Query 7 hyphen-prefixed pattern
    assert.ok(nodeRes.text.includes('src/alpha.ts: 1 matches'))
    assert.ok(nodeRes.text.includes('CLI flag example: --not-a-flag'))

    if (rgAvailable) {
      const rgRes = await runBatchSearch(
        { cwd: ws, queries },
        { policy, audit, forceNodeFallback: false },
      )
      assert.equal(rgRes.isError, false)
      assert.equal(rgRes.structuredContent?.engine, 'ripgrep')
      // Exact parity between ripgrep and pure-Node fallback!
      assert.equal(rgRes.text, nodeRes.text)
    }

    // Verify JSON-stringified queries work identically
    const jsonRes = await runBatchSearch(
      { cwd: ws, queries: JSON.stringify([{ type: 'text', pattern: 'FIND_ME_ALPHA', fileType: 'md' }]) },
      { policy, audit },
    )
    assert.equal(jsonRes.isError, false)
    assert.ok(jsonRes.text.includes('docs/guide.md'))

    // Verify audit recorded non-secret call summary
    const entries = audit.list()
    assert.ok(entries.some((e) => e.tool === 'batch_search' && e.status === 'ok'))
  })

  it('supports glob (sortBy path & mtime) and fuzzy queries, and rejects type: git', async () => {
    const ws = await makeTempDir('bt-search-glob-fuzzy-')
    await fs.mkdir(path.join(ws, 'src', 'auth'), { recursive: true })

    const olderPath = path.join(ws, 'src', 'a-older.ts')
    const newerPath = path.join(ws, 'src', 'z-newer.ts')
    const authPath = path.join(ws, 'src', 'auth', 'tokenService.ts')

    await fs.writeFile(olderPath, 'export const a = 1\n', 'utf8')
    await fs.writeFile(newerPath, 'export const z = 2\n', 'utf8')
    await fs.writeFile(authPath, 'export class TokenService {}\n', 'utf8')

    const now = Date.now() / 1000
    await fs.utimes(olderPath, now - 120, now - 120)
    await fs.utimes(authPath, now - 60, now - 60)
    await fs.utimes(newerPath, now - 5, now - 5)

    const policy = createPolicyGuard({ mcpRoots: [ws], env: {} })

    const res = await runBatchSearch(
      {
        cwd: ws,
        queries: [
          { type: 'glob', pattern: 'src/**/*.ts', sortBy: 'path' },
          { type: 'glob', pattern: 'src/**/*.ts', sortBy: 'mtime' },
          { type: 'fuzzy', pattern: 'tokSrv' },
          // Unsupported git mode must fail cleanly per-query
          { type: 'git' as unknown as 'text', pattern: 'status --short' },
        ],
      },
      { policy },
    )

    assert.equal(res.isError, false)
    const sections = res.text.split('\n\n## Query ')
    const q1 = sections[0] ?? ''
    const q2 = sections[1] ?? ''
    const q3 = sections[2] ?? ''
    const q4 = sections[3] ?? ''

    // sortBy: "path" -> a-older before auth/tokenService before z-newer
    assert.ok(q1.indexOf('src/a-older.ts') < q1.indexOf('src/auth/tokenService.ts'))
    assert.ok(q1.indexOf('src/auth/tokenService.ts') < q1.indexOf('src/z-newer.ts'))

    // sortBy: "mtime" -> z-newer first, then auth/tokenService, then a-older
    assert.ok(q2.indexOf('src/z-newer.ts') < q2.indexOf('src/auth/tokenService.ts'))
    assert.ok(q2.indexOf('src/auth/tokenService.ts') < q2.indexOf('src/a-older.ts'))

    // fuzzy finds tokenService.ts
    assert.ok(q3.includes('src/auth/tokenService.ts'))

    // git query rejected cleanly
    assert.ok(q4.includes("ERROR: Unsupported query type 'git'"))
    assert.equal(res.structuredContent?.errorCount, 1)
  })

  it('strictly enforces <= 8,800 UTF-8 bytes ceiling across 20 large multi-byte queries', async () => {
    const ws = await makeTempDir('bt-search-budget-')
    await fs.mkdir(path.join(ws, 'big'), { recursive: true })

    for (let f = 0; f < 5; f++) {
      const lines = Array.from(
        { length: 40 },
        (_, i) => `export const line_${f}_${i} = "PAYLOAD_HIT 🚀 日本語データ ${'x'.repeat(160)}"`,
      )
      await fs.writeFile(path.join(ws, 'big', `mod${f}.ts`), lines.join('\n') + '\n', 'utf8')
    }

    const policy = createPolicyGuard({ mcpRoots: [ws], env: {} })
    const twentyQueries = Array.from({ length: 20 }, (_, idx) => ({
      type: 'text' as const,
      pattern: 'PAYLOAD_HIT',
      maxResults: 200,
      contextLines: idx % 2 === 0 ? 2 : 0,
    }))

    for (const forceNodeFallback of [false, true]) {
      const res = await runBatchSearch(
        { cwd: ws, queries: twentyQueries, maxChars: 99_999 },
        { policy, forceNodeFallback },
      )
      assert.equal(res.isError, false)
      assert.ok(
        utf8ByteLength(res.text) <= DEFAULT_INLINE_MAX_BYTES,
        `Expected <= ${DEFAULT_INLINE_MAX_BYTES} bytes (fallback=${forceNodeFallback}), got ${utf8ByteLength(res.text)}`,
      )
      assert.equal(res.structuredContent?.truncated, true)
      assert.equal(Buffer.from(res.text, 'utf8').toString('utf8'), res.text)
    }

    // Rejects > 20 queries
    const tooMany = await runBatchSearch(
      {
        cwd: ws,
        queries: Array.from({ length: 21 }, () => ({ type: 'text' as const, pattern: 'PAYLOAD_HIT' })),
      },
      { policy },
    )
    assert.equal(tooMany.isError, true)
    assert.ok(tooMany.text.includes('at most 20'))
  })
})

describe('search.ts — security hardening', () => {
  it('hides .env even with glob "*.env" or "**/*", allows .env.example, skips escaping symlinks, and blocks ~ and .. escapes in both rg and Node fallback', async () => {
    const ws = await makeTempDir('bt-search-sec-ws-')
    const outside = await makeTempDir('bt-search-sec-out-')
    await fs.mkdir(path.join(ws, 'src'), { recursive: true })
    await fs.mkdir(path.join(ws, 'secrets'), { recursive: true })

    await fs.writeFile(path.join(ws, '.env'), 'SHARED_NEEDLE=REAL_DOTENV_SECRET_VALUE\n', 'utf8')
    await fs.writeFile(
      path.join(ws, '.env.local'),
      'SHARED_NEEDLE=REAL_LOCAL_SECRET_VALUE\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(ws, '.env.custom'),
      'SHARED_NEEDLE=REAL_CUSTOM_SECRET_VALUE\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(ws, 'secrets', 'creds.txt'),
      'SHARED_NEEDLE=SECRETS_DIR_VALUE\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(ws, '.env.example'),
      'SHARED_NEEDLE=SAFE_EXAMPLE_TEMPLATE\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(ws, 'src', 'app.ts'),
      'export const marker = "SHARED_NEEDLE"\n',
      'utf8',
    )

    // External file + symlinks pointing outside workspace & to internal secret
    await fs.writeFile(
      path.join(outside, 'external.ts'),
      'export const leak = "SHARED_NEEDLE_OUTSIDE_LEAK"\n',
      'utf8',
    )
    await fs.symlink(path.join(outside, 'external.ts'), path.join(ws, 'src', 'escape-link.ts'))
    await fs.symlink(outside, path.join(ws, 'escape-dir'))
    await fs.symlink(path.join(ws, '.env'), path.join(ws, 'src', 'disguised.txt'))

    const audit = createAuditLog()
    const policy = createPolicyGuard({
      mcpRoots: [ws],
      env: { BATCH_TOOLS_EXTRA_DENY_GLOBS: '*.credentials' },
      audit,
    })
    await fs.writeFile(
      path.join(ws, 'src', 'vault.credentials'),
      'SHARED_NEEDLE=EXTRA_DENY_SECRET\n',
      'utf8',
    )

    // 1. cwd with ~ or .. escape is rejected upfront
    const tildeCwd = await runBatchSearch(
      { cwd: '~', queries: [{ type: 'text', pattern: 'SHARED_NEEDLE' }] },
      { policy, audit },
    )
    assert.equal(tildeCwd.isError, true)
    assert.ok(/home-directory|~/i.test(tildeCwd.text))

    const dotDotCwd = await runBatchSearch(
      { cwd: '..', queries: [{ type: 'text', pattern: 'SHARED_NEEDLE' }] },
      { policy, audit },
    )
    assert.equal(dotDotCwd.isError, true)
    assert.ok(/outside allowed workspace/i.test(dotDotCwd.text))

    // 2. Run security query suite under BOTH rg and pure-Node fallback
    const secQueries = [
      // Attempt to bypass denylist with glob: "*.env"
      { type: 'text' as const, pattern: 'SHARED_NEEDLE', glob: '*.env' },
      // Attempt to bypass denylist with glob: "**/*"
      { type: 'text' as const, pattern: 'SHARED_NEEDLE', glob: '**/*' },
      // Attempt to search .env directly via path
      { type: 'text' as const, pattern: 'SHARED_NEEDLE', path: '.env' },
      // Allowed .env.example via explicit path
      { type: 'text' as const, pattern: 'SAFE_EXAMPLE_TEMPLATE', path: '.env.example' },
      // Allowed .env.example via hidden glob while .env/.env.local/.env.custom stay hidden
      { type: 'text' as const, pattern: 'SHARED_NEEDLE', glob: '.env*' },
      // Attempt to escape via ~ in query.path
      { type: 'text' as const, pattern: 'SHARED_NEEDLE', path: '~/anything' },
      // Attempt to escape via .. in query.path
      { type: 'text' as const, pattern: 'SHARED_NEEDLE', path: '../' + path.basename(outside) },
      // Attempt to escape via symlink directly in query.path
      { type: 'text' as const, pattern: 'SHARED_NEEDLE', path: 'src/escape-link.ts' },
      // Attempt to read .env through a harmless-looking symlink inside workspace
      { type: 'text' as const, pattern: 'SHARED_NEEDLE', path: 'src/disguised.txt' },
      // Glob query over hidden .env* should show ONLY .env.example
      { type: 'glob' as const, pattern: '.env*' },
      // Fuzzy query should never surface secrets or escaping symlinks
      { type: 'fuzzy' as const, pattern: 'escape' },
    ]

    for (const forceNodeFallback of [false, true]) {
      const res = await runBatchSearch(
        { cwd: ws, queries: secQueries },
        { policy, audit, forceNodeFallback },
      )
      assert.equal(res.isError, false)

      // Zero secret content or outside-workspace content leaked anywhere!
      assert.ok(!res.text.includes('REAL_DOTENV_SECRET_VALUE'), `leaked .env (fallback=${forceNodeFallback})`)
      assert.ok(!res.text.includes('REAL_LOCAL_SECRET_VALUE'), `leaked .env.local (fallback=${forceNodeFallback})`)
      assert.ok(!res.text.includes('REAL_CUSTOM_SECRET_VALUE'), `leaked .env.custom (fallback=${forceNodeFallback})`)
      assert.ok(!res.text.includes('SECRETS_DIR_VALUE'), `leaked secrets/ (fallback=${forceNodeFallback})`)
      assert.ok(!res.text.includes('EXTRA_DENY_SECRET'), `leaked extra-deny file (fallback=${forceNodeFallback})`)
      assert.ok(!res.text.includes('SHARED_NEEDLE_OUTSIDE_LEAK'), `leaked symlink target (fallback=${forceNodeFallback})`)
      assert.ok(!res.text.includes('escape-link.ts\n  1:'), `matched symlink content (fallback=${forceNodeFallback})`)

      const sections = res.text.split(/\n\n(?=## Query )/)
      const q1 = sections[0] ?? ''
      const q2 = sections[1] ?? ''
      const q3 = sections[2] ?? ''
      const q4 = sections[3] ?? ''
      const q5 = sections[4] ?? ''
      const q6 = sections[5] ?? ''
      const q7 = sections[6] ?? ''
      const q8 = sections[7] ?? ''
      const q9 = sections[8] ?? ''
      const q10 = sections[9] ?? ''
      const q11 = sections[10] ?? ''

      // Q1 (glob: "*.env") finds nothing
      assert.ok(q1.includes('(no matches)'), `Q1 should have no matches: ${q1}`)

      // Q2 (glob: "**/*") finds src/app.ts, never secrets or outside symlinks
      assert.ok(q2.includes('src/app.ts'), `Q2 should find src/app.ts: ${q2}`)

      // Q3 (path: ".env") cleanly fails with policy error
      assert.ok(q3.includes('ERROR:') && /secret-file denylist/i.test(q3), `Q3: ${q3}`)

      // Q4 (path: ".env.example") succeeds!
      assert.ok(q4.includes('.env.example') && q4.includes('SAFE_EXAMPLE_TEMPLATE'), `Q4: ${q4}`)

      // Q5 (glob: ".env*") finds ONLY .env.example
      assert.ok(q5.includes('.env.example') && q5.includes('SAFE_EXAMPLE_TEMPLATE'), `Q5: ${q5}`)
      assert.ok(!q5.includes('.env.local') && !q5.includes('.env.custom'), `Q5: ${q5}`)

      // Q6 (path: "~/anything") blocked
      assert.ok(q6.includes('ERROR:') && /home-directory|~/i.test(q6), `Q6: ${q6}`)

      // Q7 (path: "../outside") blocked
      assert.ok(q7.includes('ERROR:') && /escapes allowed workspace/i.test(q7), `Q7: ${q7}`)

      // Q8 (path: "src/escape-link.ts") blocked
      assert.ok(q8.includes('ERROR:') && /escapes allowed workspace/i.test(q8), `Q8: ${q8}`)

      // Q9 (path: "src/disguised.txt" -> .env) blocked
      assert.ok(q9.includes('ERROR:') && /secret-file denylist/i.test(q9), `Q9: ${q9}`)

      // Q10 (glob: ".env*") returns ONLY .env.example
      assert.ok(q10.includes('.env.example'), `Q10: ${q10}`)
      assert.ok(!q10.includes('\n.env\n') && !q10.endsWith('\n.env'), `Q10 leaked .env: ${q10}`)

      // Q11 (fuzzy: "escape") does not include symlinked files
      assert.ok(q11.includes('(no files matched)'), `Q11: ${q11}`)
    }

    // Audit buffer must contain blocked events and ZERO leaked secret values
    const auditSerialized = JSON.stringify(audit.list())
    assert.ok(!auditSerialized.includes('REAL_DOTENV_SECRET_VALUE'))
    assert.ok(!auditSerialized.includes('SHARED_NEEDLE_OUTSIDE_LEAK'))
    assert.ok(audit.list().some((e) => e.status === 'blocked'))
  })

  it('blocks uppercase/mixed-case secret paths with --iglob=! and sets isError: true + redacts headers when all queries fail', async () => {
    const ws = await makeTempDir('bt-search-case-err-')
    await fs.mkdir(path.join(ws, 'Secrets'), { recursive: true })
    await fs.writeFile(path.join(ws, '.ENV'), 'CASE_NEEDLE=UPPERCASE_ENV_SECRET\n', 'utf8')
    await fs.writeFile(
      path.join(ws, 'Secrets', 'cred.txt'),
      'CASE_NEEDLE=MIXED_SECRETS_DIR\n',
      'utf8',
    )
    await fs.writeFile(path.join(ws, 'server.PEM'), 'CASE_NEEDLE=UPPERCASE_PEM_KEY\n', 'utf8')
    await fs.writeFile(path.join(ws, 'safe.txt'), 'CASE_NEEDLE=VISIBLE_OK\n', 'utf8')

    const audit = createAuditLog()
    const policy = createPolicyGuard({ mcpRoots: [ws], env: {}, audit })

    for (const forceNodeFallback of [false, true]) {
      const res = await runBatchSearch(
        {
          cwd: ws,
          queries: [{ type: 'text', pattern: 'CASE_NEEDLE', glob: '**/*' }],
        },
        { policy, audit, forceNodeFallback },
      )
      assert.equal(res.isError, false)
      assert.ok(res.text.includes('VISIBLE_OK'))
      assert.ok(!res.text.includes('UPPERCASE_ENV_SECRET'))
      assert.ok(!res.text.includes('MIXED_SECRETS_DIR'))
      assert.ok(!res.text.includes('UPPERCASE_PEM_KEY'))
    }

    // All-blocked batch returns isError: true and redacts credential patterns in errored headers
    const allBlocked = await runBatchSearch(
      {
        cwd: ws,
        queries: [
          { type: 'text', pattern: 'glpat-SecretLeakToken1234', path: '.ENV' },
          { type: 'text', pattern: 'Bearer SuperSecretBearer999', path: '../escape' },
        ],
      },
      { policy, audit },
    )
    assert.equal(allBlocked.isError, true)
    assert.equal(allBlocked.structuredContent?.errorCount, 2)
    assert.ok(!allBlocked.text.includes('SecretLeakToken1234'))
    assert.ok(!allBlocked.text.includes('SuperSecretBearer999'))
    assert.ok(allBlocked.text.includes('glpat-***'))
    assert.ok(allBlocked.text.includes('Bearer ***'))
  })
})
