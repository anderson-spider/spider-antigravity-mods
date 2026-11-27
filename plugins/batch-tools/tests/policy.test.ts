import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  createAuditLog,
  MAX_AUDIT_DIFF_BYTES,
  MAX_AUDIT_ENTRIES,
} from '../server/audit.ts'
import {
  detectUtf16Bom,
  hasUtf8Bom,
  isLikelyBinary,
  readTextFile,
  toPosixPath,
  walkFiles,
} from '../server/fs.ts'
import {
  createMcpServer,
  folderOf,
  foldersOf,
  PROTOCOL,
  SERVER_VERSION,
} from '../server/mcp.ts'
import {
  createPolicyGuard,
  ENV_ALLOW_EDITS,
  ENV_EXTRA_DENY_GLOBS,
  ENV_WORKSPACE_ROOTS,
  getRgDenyGlobs,
  isBuiltinSecretPath,
  isGitInternalPath,
} from '../server/policy.ts'
import { redactSecrets, scrubChildEnv } from '../server/redact.ts'

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

describe('redact.ts', () => {
  it('redacts high-confidence credential patterns while preserving safe SSH URLs', () => {
    const sample = [
      'gitlab=glpat-AbCdEf1234567890',
      'gh1=ghp_1234567890abcdef123456',
      'gh2=gho_1234567890abcdef123456',
      'gh3=github_pat_1234567890abcdef123456',
      'openai=sk-1234567890abcdef123456',
      'anthropic=sk-ant-1234567890ab',
      'aws=AKIA1234567890ABCDEF',
      'auth=Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'basic=https://alice:supersecret@gitlab.example.com/group/project.git',
      'ssh=ssh://git@gitlab.example.com/group/project.git',
    ].join('\n')

    const redacted = redactSecrets(sample)
    assert.ok(!redacted.includes('AbCdEf1234567890'))
    assert.ok(!redacted.includes('1234567890abcdef'))
    assert.ok(!redacted.includes('AKIA1234567890ABCDEF'))
    assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9'))
    assert.ok(!redacted.includes('alice:supersecret'))
    assert.ok(redacted.includes('glpat-***'))
    assert.ok(redacted.includes('gh_***'))
    assert.ok(redacted.includes('sk-***'))
    assert.ok(redacted.includes('sk-ant-***'))
    assert.ok(redacted.includes('AKIA***'))
    assert.ok(redacted.includes('Bearer ***'))
    assert.ok(redacted.includes('https://***:***@gitlab.example.com/group/project.git'))
    assert.ok(redacted.includes('ssh://git@gitlab.example.com/group/project.git'))
  })

  it('scrubs sensitive and tool-hijack environment variables for child processes', () => {
    const scrubbed = scrubChildEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/example',
      LANG: 'en_US.UTF-8',
      CUSTOM_TOKEN: 'secret1',
      APP_SECRET: 'secret2',
      API_KEY: 'secret3',
      DB_PASSWORD: 'secret4',
      AWS_ACCESS_KEY_ID: 'AKIA123',
      AWS_REGION: 'us-east-1',
      GITLAB_MCP_TOKENS: 'gitlab.example.com=glpat-xxx',
      GITHUB_TOKEN: 'ghp_xxx',
      GH_TOKEN: 'gho_xxx',
      NPM_TOKEN: 'npm_xxx',
      NPM_CONFIG_REGISTRY: 'https://registry.example.com',
      ANTIGRAVITY_CSRF_TOKEN: 'csrf',
      RIPGREP_CONFIG_PATH: '/tmp/evil.rgrc',
      GIT_DIR: '/tmp/fakegit',
      GIT_WORK_TREE: '/tmp',
      GIT_SSH_COMMAND: 'evil',
      GIT_CONFIG_COUNT: '1',
      GIT_EXTERNAL_DIFF: '/bin/sh',
    })

    assert.deepEqual(scrubbed, {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/example',
      LANG: 'en_US.UTF-8',
    })
  })
})

describe('audit.ts', () => {
  it('enforces bounded ring buffer of 50 entries, 32 KiB diff cap, and secret redaction', () => {
    const audit = createAuditLog()
    assert.equal(audit.size(), 0)

    for (let i = 0; i < MAX_AUDIT_ENTRIES + 15; i++) {
      audit.record({
        tool: 'batch_search',
        status: 'ok',
        summary: `call #${i} glpat-secretTokenValue99`,
      })
    }
    assert.equal(audit.size(), MAX_AUDIT_ENTRIES)
    const list = audit.list()
    assert.equal(list.length, MAX_AUDIT_ENTRIES)
    assert.ok(list[0]!.summary?.startsWith('call #15 '))
    assert.ok(!list[0]!.summary?.includes('secretTokenValue99'))
    assert.ok(list[0]!.summary?.includes('glpat-***'))

    const hugeDiff = `Bearer superSecretToken12345\n${'😀'.repeat(12_000)}`
    const recorded = audit.record({
      tool: 'apply_edits',
      status: 'ok',
      diffPreview: hugeDiff,
    })
    assert.ok(recorded.diffPreview !== undefined)
    assert.ok(Buffer.byteLength(recorded.diffPreview, 'utf8') <= MAX_AUDIT_DIFF_BYTES)
    assert.ok(!recorded.diffPreview.includes('superSecretToken12345'))
    assert.ok(recorded.diffPreview.includes('Bearer ***'))
    assert.ok(recorded.diffPreview.endsWith('\n... [truncated]'))
    // Verify no broken lone surrogates at truncation boundary.
    assert.equal(Buffer.from(recorded.diffPreview, 'utf8').toString('utf8'), recorded.diffPreview)

    audit.clear()
    assert.equal(audit.size(), 0)
  })
})

describe('policy.ts', () => {
  it('resolves workspace roots across all 3 fail-closed tiers', async () => {
    const ws1 = await makeTempDir('bt-ws1-')
    const ws2 = await makeTempDir('bt-ws2-')
    const pluginDir = await makeTempDir('bt-plugin-')
    await fs.writeFile(path.join(pluginDir, 'plugin.json'), '{}', 'utf8')

    // Tier 1: MCP roots/list wins over env and process.cwd
    const tier1 = createPolicyGuard({
      mcpRoots: [ws1],
      env: { [ENV_WORKSPACE_ROOTS]: ws2 },
      processCwd: () => ws2,
      pluginRoot: pluginDir,
    })
    const r1 = await tier1.getRoots()
    assert.equal(r1.ok, true)
    assert.deepEqual(r1.value, [await fs.realpath(ws1)])

    // Tier 2: BATCH_TOOLS_WORKSPACE_ROOTS when MCP roots absent
    const tier2 = createPolicyGuard({
      env: { [ENV_WORKSPACE_ROOTS]: `${ws1}${path.delimiter}${ws2}` },
      processCwd: () => '/',
      pluginRoot: pluginDir,
    })
    const r2 = await tier2.getRoots()
    assert.equal(r2.ok, true)
    assert.deepEqual(r2.value, [await fs.realpath(ws1), await fs.realpath(ws2)])

    // Tier 3: safe process.cwd() accepted
    const tier3Ok = createPolicyGuard({
      env: {},
      processCwd: () => ws1,
      pluginRoot: pluginDir,
    })
    const r3Ok = await tier3Ok.getRoots()
    assert.equal(r3Ok.ok, true)
    assert.deepEqual(r3Ok.value, [await fs.realpath(ws1)])

    // Tier 3 fail-closed: filesystem root rejected
    const tier3Root = createPolicyGuard({
      env: {},
      processCwd: () => path.parse(ws1).root,
      pluginRoot: pluginDir,
    })
    const r3Root = await tier3Root.getRoots()
    assert.equal(r3Root.ok, false)
    assert.equal(r3Root.reason, 'no_workspace_roots')

    // Tier 3 fail-closed: $HOME rejected
    const fakeHome = await makeTempDir('bt-home-')
    const tier3Home = createPolicyGuard({
      env: { HOME: fakeHome },
      processCwd: () => fakeHome,
      pluginRoot: pluginDir,
    })
    const r3Home = await tier3Home.getRoots()
    assert.equal(r3Home.ok, false)
    assert.equal(r3Home.reason, 'no_workspace_roots')

    // Tier 3 fail-closed: plugin directory rejected
    const tier3Plugin = createPolicyGuard({
      env: {},
      processCwd: () => pluginDir,
      pluginRoot: pluginDir,
    })
    const r3Plugin = await tier3Plugin.getRoots()
    assert.equal(r3Plugin.ok, false)
    assert.equal(r3Plugin.reason, 'no_workspace_roots')
  })

  it('blocks tilde paths, .. escapes, and symlink escapes on read and write', async () => {
    const ws = await makeTempDir('bt-jail-ws-')
    const outside = await makeTempDir('bt-jail-out-')
    const audit = createAuditLog()
    const policy = createPolicyGuard({ mcpRoots: [ws], env: {}, audit })

    await fs.writeFile(path.join(ws, 'ok.ts'), 'export const x = 1\n', 'utf8')
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8')
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'escape-file.txt'))
    await fs.symlink(outside, path.join(ws, 'escape-dir'))
    await fs.symlink(path.join(outside, 'does-not-exist.txt'), path.join(ws, 'dangling-escape.txt'))
    await fs.symlink(path.join(ws, 'ok.ts'), path.join(ws, 'internal-link.ts'))

    // Tilde forbidden
    const tildeRead = await policy.authorizeRead('~/env.sh', undefined, 'read_slices')
    assert.equal(tildeRead.ok, false)
    assert.equal(tildeRead.reason, 'tilde_forbidden')

    const tildeCwd = await policy.resolveCwd('~', 'batch_search')
    assert.equal(tildeCwd.ok, false)
    assert.equal(tildeCwd.reason, 'tilde_forbidden')

    // .. traversal forbidden
    const dotDot = await policy.authorizeRead('../outside.txt', undefined, 'read_slices')
    assert.equal(dotDot.ok, false)
    assert.equal(dotDot.reason, 'outside_workspace')

    // Symlink escaping jail forbidden on read & write
    const symRead = await policy.authorizeRead('escape-file.txt', undefined, 'read_slices')
    assert.equal(symRead.ok, false)
    assert.equal(symRead.reason, 'outside_workspace')

    const symDirRead = await policy.authorizeRead('escape-dir/secret.txt', undefined, 'read_slices')
    assert.equal(symDirRead.ok, false)
    assert.equal(symDirRead.reason, 'outside_workspace')

    const symDirWrite = await policy.authorizeWrite('escape-dir/new.ts', undefined, 'apply_edits')
    assert.equal(symDirWrite.ok, false)
    assert.equal(symDirWrite.reason, 'outside_workspace')

    const danglingWrite = await policy.authorizeWrite('dangling-escape.txt', undefined, 'apply_edits')
    assert.equal(danglingWrite.ok, false)
    assert.equal(danglingWrite.reason, 'outside_workspace')

    // Even an in-workspace symlink is rejected on write
    const internalSymWrite = await policy.authorizeWrite('internal-link.ts', undefined, 'apply_edits')
    assert.equal(internalSymWrite.ok, false)
    assert.equal(internalSymWrite.reason, 'symlink_forbidden')

    // Normal in-workspace read and write succeed
    const okRead = await policy.authorizeRead('ok.ts', undefined, 'read_slices')
    assert.equal(okRead.ok, true)
    const okWrite = await policy.authorizeWrite('nested/new.ts', undefined, 'apply_edits')
    assert.equal(okWrite.ok, true)

    // Output path filter rejects symlink escape and allows normal file
    assert.equal(await policy.isAllowedOutputPath('escape-file.txt', ws), false)
    assert.equal(await policy.isAllowedOutputPath('ok.ts', ws), true)

    // Blocked events were logged to in-memory audit buffer
    assert.ok(audit.list().some((e) => e.status === 'blocked' && e.reason === 'outside_workspace'))
    assert.ok(audit.list().some((e) => e.status === 'blocked' && e.reason === 'symlink_forbidden'))
  })

  it('enforces portable secret-file denylist, allows .env templates, and honors extra deny globs', async () => {
    const ws = await makeTempDir('bt-secrets-')
    const policy = createPolicyGuard({
      mcpRoots: [ws],
      env: { [ENV_EXTRA_DENY_GLOBS]: '**/private/**,*.credentials' },
    })

    const deniedPaths = [
      '.env',
      '.env.local',
      '.env.production',
      'sub/.env.development',
      'secrets/db.json',
      '.secrets/token.txt',
      'certs/server.pem',
      'certs/private.key',
      'certs/bundle.p12',
      'certs/store.pfx',
      'certs/trust.jks',
      'ssh/id_rsa',
      'ssh/id_ed25519',
      '.netrc',
      '.npmrc',
      '.pypirc',
      'app/private/config.json',
      'auth.credentials',
    ]

    for (const rel of deniedPaths) {
      const res = await policy.authorizeRead(rel, undefined, 'read_slices')
      assert.equal(res.ok, false, `Expected ${rel} to be denied`)
      assert.equal(res.reason, 'secret_file', `Expected secret_file for ${rel}`)
      assert.equal(await policy.isAllowedOutputPath(rel, ws), false)
    }

    const allowedPaths = [
      '.env.example',
      '.env.sample',
      '.env.template',
      'config/.env.example',
      'src/index.ts',
      'ssh/id_rsa.pub',
    ]

    for (const rel of allowedPaths) {
      const res = await policy.authorizeRead(rel, undefined, 'read_slices')
      assert.equal(res.ok, true, `Expected ${rel} to be allowed`)
      assert.equal(await policy.isAllowedOutputPath(rel, ws), true)
    }

    assert.equal(isBuiltinSecretPath('.env.local'), true)
    assert.equal(isBuiltinSecretPath('.env.example'), false)

    const rgGlobs = getRgDenyGlobs(policy.getExtraDenyGlobs())
    assert.ok(rgGlobs.includes('--glob=!**/.env'))
    assert.ok(rgGlobs.includes('--glob=!**/secrets/**'))
    assert.ok(rgGlobs.includes('--glob=!**/*.pem'))
    assert.ok(rgGlobs.includes('--glob=!**/private/**'))
    assert.ok(rgGlobs.includes('--glob=!*.credentials'))
    assert.ok(rgGlobs.includes('--glob=!**/*.credentials'))
    // Must never emit a positive glob that restricts ripgrep.
    assert.ok(rgGlobs.every((flag) => flag.startsWith('--glob=!')))
  })

  it('protects .git writes across case/Win32 variants while allowing .gitignore and .github', async () => {
    const ws = await makeTempDir('bt-git-')
    const policy = createPolicyGuard({ mcpRoots: [ws], env: {} })

    for (const bad of ['.git/config', '.git/hooks/pre-commit', '.GIT/HEAD', 'sub/.git']) {
      const res = await policy.authorizeWrite(bad, undefined, 'apply_edits')
      assert.equal(res.ok, false, `Expected ${bad} write to be blocked`)
      assert.equal(res.reason, 'git_internal')
    }

    assert.equal(isGitInternalPath('.git./config', 'win32'), true)
    assert.equal(isGitInternalPath('.git:stream/config', 'win32'), true)
    assert.equal(isGitInternalPath('.gitignore', 'win32'), false)
    assert.equal(isGitInternalPath('.github/workflows/ci.yml', 'win32'), false)

    const okGitignore = await policy.authorizeWrite('.gitignore', undefined, 'apply_edits')
    assert.equal(okGitignore.ok, true)
    const okGithub = await policy.authorizeWrite('.github/workflows/ci.yml', undefined, 'apply_edits')
    assert.equal(okGithub.ok, true)
  })

  it('respects BATCH_TOOLS_ALLOW_EDITS=false kill-switch', async () => {
    const ws = await makeTempDir('bt-edits-flag-')

    const enabled = createPolicyGuard({ mcpRoots: [ws], env: {} })
    assert.equal(enabled.isEditAllowed(), true)
    assert.equal((await enabled.authorizeWrite('a.ts')).ok, true)

    const disabled = createPolicyGuard({
      mcpRoots: [ws],
      env: { [ENV_ALLOW_EDITS]: 'false' },
    })
    assert.equal(disabled.isEditAllowed(), false)
    const res = await disabled.authorizeWrite('a.ts', undefined, 'apply_edits')
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'edits_disabled')
    // Read remains allowed even when edits are disabled.
    assert.equal((await disabled.authorizeRead('a.ts')).ok, true)
  })
})

describe('fs.ts', () => {
  it('reads UTF-8 text files, detects BOM/EOL, and rejects binary, UTF-16, oversized, or denied files', async () => {
    const ws = await makeTempDir('bt-fs-read-')
    const policy = createPolicyGuard({ mcpRoots: [ws], env: {} })

    const bomCrlf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('line1\r\nline2\r\n', 'utf8'),
    ])
    await fs.writeFile(path.join(ws, 'bom.txt'), bomCrlf)
    await fs.writeFile(path.join(ws, 'mixed.txt'), 'a\r\nb\nc\n', 'utf8')
    await fs.writeFile(path.join(ws, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]))
    await fs.writeFile(path.join(ws, 'utf16.txt'), Buffer.from([0xff, 0xfe, 0x61, 0x00]))
    await fs.writeFile(path.join(ws, '.env'), 'SECRET=1\n', 'utf8')

    const readBom = await readTextFile('bom.txt', { policy, baseCwd: ws })
    assert.equal(readBom.hasBom, true)
    assert.equal(readBom.eol, '\r\n')
    assert.equal(readBom.mixedEol, false)
    assert.equal(readBom.content, 'line1\r\nline2\r\n')
    assert.equal(typeof readBom.mtimeMs, 'number')

    const readMixed = await readTextFile('mixed.txt', { policy, baseCwd: ws })
    assert.equal(readMixed.mixedEol, true)

    await assert.rejects(
      () => readTextFile('bin.dat', { policy, baseCwd: ws }),
      /Binary file/,
    )
    await assert.rejects(
      () => readTextFile('utf16.txt', { policy, baseCwd: ws }),
      /UTF-16/,
    )
    await assert.rejects(
      () => readTextFile('bom.txt', { policy, baseCwd: ws, maxBytes: 4 }),
      /exceeds maximum size/,
    )
    await assert.rejects(
      () => readTextFile('.env', { policy, baseCwd: ws }),
      /secret-file denylist/,
    )

    assert.equal(hasUtf8Bom(bomCrlf), true)
    assert.equal(detectUtf16Bom(Buffer.from([0xfe, 0xff, 0x00, 0x41])), 'UTF-16 BE')
    assert.equal(detectUtf16Bom(Buffer.from([0xff, 0xfe, 0x00, 0x00])), null)
    assert.equal(isLikelyBinary(Buffer.from([0, 1, 2])), true)
    assert.equal(toPosixPath(path.join('a', 'b', 'c.ts')), 'a/b/c.ts')
  })

  it('walkFiles skips symlinks, default ignored dirs, and policy-denied secret files', async () => {
    const ws = await makeTempDir('bt-walk-ws-')
    const outside = await makeTempDir('bt-walk-out-')
    const policy = createPolicyGuard({ mcpRoots: [ws], env: {} })

    await fs.mkdir(path.join(ws, 'src'), { recursive: true })
    await fs.mkdir(path.join(ws, 'node_modules', 'pkg'), { recursive: true })
    await fs.mkdir(path.join(ws, 'secrets'), { recursive: true })
    await fs.writeFile(path.join(ws, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    await fs.writeFile(path.join(ws, '.env'), 'SECRET=1\n', 'utf8')
    await fs.writeFile(path.join(ws, '.env.example'), 'SECRET=example\n', 'utf8')
    await fs.writeFile(path.join(ws, 'secrets', 'key.json'), '{}', 'utf8')
    await fs.writeFile(path.join(ws, 'node_modules', 'pkg', 'index.js'), '', 'utf8')
    await fs.writeFile(path.join(outside, 'leak.ts'), 'leak', 'utf8')
    await fs.symlink(path.join(outside, 'leak.ts'), path.join(ws, 'src', 'link.ts'))
    await fs.symlink(outside, path.join(ws, 'src', 'linkdir'))

    const res = await walkFiles(ws, { includeHidden: true, policy })
    assert.deepEqual(res.files, ['.env.example', 'src/a.ts'])
    assert.equal(res.truncated, false)

    const capped = await walkFiles(ws, { includeHidden: true, policy, maxFiles: 1 })
    assert.equal(capped.files.length, 1)
    assert.equal(capped.truncated, true)
  })
})

describe('mcp.ts', () => {
  it('handles initialize, roots/list, list_changed, tools/call with structuredContent, and optional resources', async () => {
    const ws1 = await makeTempDir('bt-mcp-ws1-')
    const ws2 = await makeTempDir('bt-mcp-ws2-')
    const outbound: Array<Record<string, unknown>> = []
    const receivedCwds: Array<readonly string[]> = []

    const srv = createMcpServer({
      tools: [
        {
          name: 'demo_tool',
          description: 'Demo tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      resources: [
        {
          uri: 'ui://batch-tools/app.html',
          name: 'Workbench',
          mimeType: 'text/html;profile=mcp-app',
          read: async () => '<html>ok</html>',
        },
      ],
      write: (line) => outbound.push(JSON.parse(line) as Record<string, unknown>),
      call: async (_name, _input, ctx) => {
        receivedCwds.push(ctx.cwds)
        return {
          text: `root=${ctx.cwd ?? 'none'}`,
          structuredContent: { count: ctx.cwds.length },
        }
      },
    })

    // Initialize with roots capability
    await srv.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL, capabilities: { roots: {} } },
      }),
    )
    assert.deepEqual(outbound.shift(), {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'batch-tools', version: SERVER_VERSION },
      },
    })

    // tools/list
    await srv.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    const listResp = outbound.shift() as { result: { tools: Array<{ name: string }> } }
    assert.equal(listResp.result.tools.length, 1)
    assert.equal(listResp.result.tools[0]!.name, 'demo_tool')

    // tools/call triggers roots/list request to client
    await srv.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'demo_tool', arguments: {} },
      }),
    )
    const rootsReq = outbound.shift() as { id: string; method: string }
    assert.equal(rootsReq.method, 'roots/list')

    // Client answers roots/list with ws1
    await srv.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rootsReq.id,
        result: { roots: [{ uri: pathToFileURL(ws1).href }] },
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    const callResp = outbound.shift() as {
      id: number
      result: { content: Array<{ text: string }>; structuredContent: { count: number } }
    }
    assert.equal(callResp.id, 3)
    assert.equal(callResp.result.content[0]!.text, `root=${ws1}`)
    assert.deepEqual(callResp.result.structuredContent, { count: 1 })

    // notifications/roots/list_changed invalidates cached roots
    await srv.receive(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }),
    )
    await srv.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'demo_tool', arguments: {} },
      }),
    )
    const rootsReq2 = outbound.shift() as { id: string; method: string }
    assert.equal(rootsReq2.method, 'roots/list')
    await srv.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rootsReq2.id,
        result: { roots: [{ uri: pathToFileURL(ws2).href }] },
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    const callResp2 = outbound.shift() as {
      id: number
      result: { content: Array<{ text: string }> }
    }
    assert.equal(callResp2.result.content[0]!.text, `root=${ws2}`)
    assert.equal(receivedCwds.length, 2)

    // resources/list and resources/read
    await srv.receive(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list' }))
    const resList = outbound.shift() as { result: { resources: Array<{ uri: string }> } }
    assert.equal(resList.result.resources[0]!.uri, 'ui://batch-tools/app.html')

    await srv.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'resources/read',
        params: { uri: 'ui://batch-tools/app.html' },
      }),
    )
    await new Promise((r) => setTimeout(r, 10))
    const resRead = outbound.shift() as {
      result: { contents: Array<{ text: string; mimeType: string }> }
    }
    assert.equal(resRead.result.contents[0]!.text, '<html>ok</html>')
    assert.equal(resRead.result.contents[0]!.mimeType, 'text/html;profile=mcp-app')

    // foldersOf / folderOf helpers
    assert.deepEqual(
      foldersOf({
        roots: [
          { uri: pathToFileURL(ws1).href },
          { uri: pathToFileURL(ws1).href },
          { uri: 'https://example.com' },
        ],
      }),
      [ws1],
    )
    assert.equal(folderOf({ roots: [{ uri: pathToFileURL(ws2).href }] }), ws2)
  })
})
