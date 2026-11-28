// End-to-end stdio JSON-RPC 2.0 tests spawning `node plugins/batch-tools/server/main.ts`.
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_INLINE_MAX_BYTES, utf8ByteLength } from '../server/budget.ts'
import { ENV_ALLOW_EDITS, ENV_WORKSPACE_ROOTS } from '../server/policy.ts'

const SERVER_ENTRY = fileURLToPath(new URL('../server/main.ts', import.meta.url))
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface McpTestClient {
  request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcMessage>
  notify: (method: string, params?: Record<string, unknown>) => void
  setRoots: (roots: string[]) => void
  getRootsRequestCount: () => number
  getStderr: () => string
  close: () => Promise<void>
}

function spawnMcpClient(options: {
  cwd: string
  env?: NodeJS.ProcessEnv
  roots?: string[]
}): McpTestClient {
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv[ENV_WORKSPACE_ROOTS]
  delete childEnv[ENV_ALLOW_EDITS]
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      if (v === undefined) delete childEnv[k]
      else childEnv[k] = v
    }
  }

  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: options.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let currentRoots = options.roots ? [...options.roots] : []
  let rootsRequestCount = 0
  let nextId = 1
  let stderr = ''
  const pending = new Map<
    number,
    { resolve: (msg: JsonRpcMessage) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >()

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch (err) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`Non-JSON line on stdout: ${line} (${String(err)})`))
      }
      pending.clear()
      return
    }

    // Handle server-to-client requests (e.g. roots/list).
    if (msg.method === 'roots/list' && msg.id !== undefined && msg.id !== null) {
      rootsRequestCount += 1
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          roots: currentRoots.map((dir) => ({
            uri: pathToFileURL(dir).href,
            name: path.basename(dir),
          })),
        },
      }
      child.stdin.write(`${JSON.stringify(response)}\n`)
      return
    }

    if (typeof msg.id === 'number') {
      const waiter = pending.get(msg.id)
      if (waiter) {
        clearTimeout(waiter.timer)
        pending.delete(msg.id)
        waiter.resolve(msg)
      }
    }
  })

  child.on('exit', (code, signal) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(
        new Error(
          `MCP server exited unexpectedly (code=${String(code)}, signal=${String(signal)}). stderr: ${stderr}`,
        ),
      )
    }
    pending.clear()
  })

  return {
    request(method, params) {
      const id = nextId++
      return new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timed out waiting for response to ${method} (id=${id}). stderr: ${stderr}`))
        }, 15_000)
        pending.set(id, { resolve, reject, timer })
        const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method }
        if (params !== undefined) payload.params = params
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      })
    },
    notify(method, params) {
      const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
      if (params !== undefined) payload.params = params
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    },
    setRoots(roots) {
      currentRoots = [...roots]
    },
    getRootsRequestCount() {
      return rootsRequestCount
    },
    getStderr() {
      return stderr
    },
    async close() {
      rl.close()
      if (!child.killed && child.exitCode === null) {
        child.stdin.end()
        await new Promise<void>((resolve) => {
          const killTimer = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
          }, 2_000)
          killTimer.unref()
          child.once('exit', () => {
            clearTimeout(killTimer)
            resolve()
          })
        })
      }
    },
  }
}

async function createSampleWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-tools-e2e-'))
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, '.git'), { recursive: true })

  await fs.writeFile(
    path.join(dir, 'src', 'math.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a + b',
      '}',
      '',
      'export function multiply(a: number, b: number): number {',
      '  return a * b',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(dir, 'src', 'worker.py'),
    [
      'class Worker:',
      '    def run(self, value):',
      '        return value + 1',
      '',
      'def helper_entry():',
      '    return Worker().run(41)',
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(path.join(dir, '.env'), 'API_SECRET=TOP_SECRET_MARKER_VALUE\n', 'utf8')
  await fs.writeFile(path.join(dir, '.env.example'), 'API_SECRET=EXAMPLE_MARKER_VALUE\n', 'utf8')
  await fs.writeFile(path.join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8')
  return dir
}

function getToolText(res: JsonRpcMessage): { text: string; isError: boolean } {
  assert.equal(res.error, undefined, `Expected tool result, got JSON-RPC error: ${JSON.stringify(res.error)}`)
  const result = res.result as {
    content?: Array<{ type: string; text: string }>
    isError?: boolean
  }
  assert.ok(Array.isArray(result.content) && result.content.length >= 1)
  return {
    text: result.content[0]!.text,
    isError: Boolean(result.isError),
  }
}

describe('MCP stdio E2E (server/main.ts)', () => {
  it('completes initialize, tools/list, resources/list, roots/list round-trip, and all 4 tools', async () => {
    const workspace = await createSampleWorkspace()
    const client = spawnMcpClient({
      cwd: PLUGIN_ROOT, // Plugin dir is unsafe by itself; MCP roots/list supplies the workspace root.
      roots: [workspace],
    })

    try {
      const init = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: 'e2e-test', version: '1.0.0' },
      })
      assert.equal(init.error, undefined)
      const initResult = init.result as {
        protocolVersion: string
        capabilities: { tools?: unknown; resources?: unknown }
        serverInfo: { name: string; version: string }
      }
      assert.equal(initResult.serverInfo.name, 'batch-tools')
      assert.equal(initResult.serverInfo.version, '0.1.0')
      assert.ok(initResult.capabilities.tools)
      assert.ok(initResult.capabilities.resources)
      client.notify('notifications/initialized')

      const ping = await client.request('ping')
      assert.deepEqual(ping.result, {})

      const toolsRes = await client.request('tools/list')
      const tools = (toolsRes.result as { tools: Array<{ name: string; _meta?: unknown }> }).tools
      assert.deepEqual(
        tools.map((t) => t.name),
        ['batch_search', 'quick_outline', 'read_slices', 'apply_edits'],
      )
      for (const tool of tools) {
        assert.equal(tool._meta, undefined, `Core tool ${tool.name} must stay headless (no _meta.ui)`)
      }

      const resourcesRes = await client.request('resources/list')
      assert.deepEqual(resourcesRes.result, { resources: [] })

      const promptsRes = await client.request('prompts/list')
      assert.deepEqual(promptsRes.result, { prompts: [] })

      // 1. batch_search (triggers lazy roots/list round-trip)
      const searchRes = getToolText(
        await client.request('tools/call', {
          name: 'batch_search',
          arguments: {
            queries: [
              { type: 'text', pattern: 'multiply' },
              { type: 'text', pattern: 'API_SECRET=', glob: '.env*' },
              { type: 'glob', pattern: 'src/*.py' },
              { type: 'fuzzy', pattern: 'mth' },
            ],
          },
        }),
      )
      assert.equal(searchRes.isError, false)
      assert.equal(client.getRootsRequestCount(), 1)
      assert.match(searchRes.text, /src\/math\.ts/)
      assert.doesNotMatch(searchRes.text, /TOP_SECRET_MARKER_VALUE/)
      assert.match(searchRes.text, /\.env\.example/)
      assert.match(searchRes.text, /EXAMPLE_MARKER_VALUE/)
      assert.match(searchRes.text, /src\/worker\.py/)
      assert.ok(utf8ByteLength(searchRes.text) <= DEFAULT_INLINE_MAX_BYTES)

      // 2. quick_outline
      const outlineRes = getToolText(
        await client.request('tools/call', {
          name: 'quick_outline',
          arguments: {
            paths: ['src/math.ts', 'src/worker.py'],
          },
        }),
      )
      assert.equal(outlineRes.isError, false)
      assert.match(outlineRes.text, /add \[L1-L3\]/)
      assert.match(outlineRes.text, /multiply \[L5-L7\]/)
      assert.match(outlineRes.text, /Worker \[L1-L3\]/)
      assert.match(outlineRes.text, /helper_entry \[L5-L6\]/)

      // 3. read_slices (combined outlines + lineRanges + slices)
      const slicesRes = getToolText(
        await client.request('tools/call', {
          name: 'read_slices',
          arguments: {
            outlines: ['src/math.ts'],
            lineRanges: ['src/worker.py:1-3'],
            slices: [{ path: 'src/math.ts', ranges: [[5, 7]] }],
          },
        }),
      )
      assert.equal(slicesRes.isError, false)
      assert.match(slicesRes.text, /## Outline: src\/math\.ts/)
      assert.match(slicesRes.text, /return value \+ 1/)
      assert.match(slicesRes.text, /return a \* b/)

      // 4a. apply_edits dryRun preview (no disk changes)
      const dryRunRes = getToolText(
        await client.request('tools/call', {
          name: 'apply_edits',
          arguments: {
            dryRun: true,
            edits: [
              {
                path: 'src/math.ts',
                hunks: [{ target: 'return a + b', replacement: 'return a + b + 0' }],
              },
              {
                path: 'src/new_file.ts',
                create: 'export const CREATED = true\n',
              },
            ],
          },
        }),
      )
      assert.equal(dryRunRes.isError, false)
      assert.match(dryRunRes.text, /Dry run:/)
      assert.match(dryRunRes.text, /\+  return a \+ b \+ 0/)
      await assert.rejects(fs.stat(path.join(workspace, 'src', 'new_file.ts')))

      // 4b. apply_edits real atomic multi-file commit
      const applyRes = getToolText(
        await client.request('tools/call', {
          name: 'apply_edits',
          arguments: {
            edits: [
              {
                path: 'src/math.ts',
                hunks: [{ target: 'return a + b', replacement: 'return a + b + 0' }],
              },
              {
                path: 'src/new_file.ts',
                create: 'export const CREATED = true\n',
              },
            ],
          },
        }),
      )
      assert.equal(applyRes.isError, false)
      assert.match(applyRes.text, /Applied edits atomically: 2 file\(s\) written/)
      assert.match(await fs.readFile(path.join(workspace, 'src', 'math.ts'), 'utf8'), /return a \+ b \+ 0/)
      assert.equal(
        await fs.readFile(path.join(workspace, 'src', 'new_file.ts'), 'utf8'),
        'export const CREATED = true\n',
      )

      // 4c. apply_edits rejects unsupported verify / bestEffort and .git writes
      const verifyRejected = getToolText(
        await client.request('tools/call', {
          name: 'apply_edits',
          arguments: {
            edits: [{ path: 'src/math.ts', hunks: [{ target: 'add', replacement: 'sum' }] }],
            verify: 'echo pwned',
          },
        }),
      )
      assert.equal(verifyRejected.isError, true)
      assert.match(verifyRejected.text, /verify/i)

      const gitRejected = getToolText(
        await client.request('tools/call', {
          name: 'apply_edits',
          arguments: {
            edits: [{ path: '.git/config', create: 'bad', overwrite: true }],
          },
        }),
      )
      assert.equal(gitRejected.isError, true)
      assert.match(gitRejected.text, /\.git/i)

      // 5. notifications/roots/list_changed refreshes roots cleanly
      const workspace2 = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-tools-e2e-root2-'))
      try {
        await fs.writeFile(path.join(workspace2, 'root2.txt'), 'SECOND_ROOT_TOKEN\n', 'utf8')
        client.setRoots([workspace2])
        client.notify('notifications/roots/list_changed')

        const root2Search = getToolText(
          await client.request('tools/call', {
            name: 'batch_search',
            arguments: {
              queries: [{ type: 'text', pattern: 'SECOND_ROOT_TOKEN' }],
            },
          }),
        )
        assert.equal(root2Search.isError, false)
        assert.equal(client.getRootsRequestCount(), 2)
        assert.match(root2Search.text, /root2\.txt/)
      } finally {
        await fs.rm(workspace2, { recursive: true, force: true })
      }
    } finally {
      await client.close()
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  it('enforces <= 8,800 UTF-8 byte inline cap across large multi-byte stdio tool responses', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-tools-e2e-cap-'))
    const bigLine = `export const msg = "🚀 café こんにちは ${'x'.repeat(120)}"\n`
    const bigContent = Array.from({ length: 220 }, (_, i) => `// line ${i + 1}\n${bigLine}`).join('')
    await fs.writeFile(path.join(workspace, 'big.ts'), bigContent, 'utf8')

    const client = spawnMcpClient({
      cwd: PLUGIN_ROOT,
      roots: [workspace],
    })
    try {
      await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { roots: {} },
      })

      const queries = Array.from({ length: 15 }, (_, i) => ({
        type: 'text',
        pattern: `line ${i + 1}`,
        maxResults: 100,
      }))
      const searchOut = getToolText(
        await client.request('tools/call', {
          name: 'batch_search',
          arguments: { queries },
        }),
      )
      assert.equal(searchOut.isError, false)
      assert.ok(
        utf8ByteLength(searchOut.text) <= DEFAULT_INLINE_MAX_BYTES,
        `batch_search exceeded 8800 bytes: ${utf8ByteLength(searchOut.text)}`,
      )

      const slicesOut = getToolText(
        await client.request('tools/call', {
          name: 'read_slices',
          arguments: {
            lineRanges: ['big.ts:1-400'],
          },
        }),
      )
      assert.equal(slicesOut.isError, false)
      assert.ok(
        utf8ByteLength(slicesOut.text) <= DEFAULT_INLINE_MAX_BYTES,
        `read_slices exceeded 8800 bytes: ${utf8ByteLength(slicesOut.text)}`,
      )
    } finally {
      await client.close()
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  it('fails closed when started in plugin dir or $HOME without MCP roots, and honors BATCH_TOOLS_WORKSPACE_ROOTS & BATCH_TOOLS_ALLOW_EDITS=false', async () => {
    const workspace = await createSampleWorkspace()

    // Case A: Started in PLUGIN_ROOT with no roots capability -> denied even with explicit cwd.
    const unsafePluginClient = spawnMcpClient({ cwd: PLUGIN_ROOT })
    try {
      await unsafePluginClient.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
      })
      const denied = getToolText(
        await unsafePluginClient.request('tools/call', {
          name: 'batch_search',
          arguments: {
            cwd: workspace,
            queries: [{ type: 'text', pattern: 'multiply' }],
          },
        }),
      )
      assert.equal(denied.isError, true)
      assert.match(denied.text, /Access denied/i)
    } finally {
      await unsafePluginClient.close()
    }

    // Case B: Started in $HOME with no roots capability -> denied.
    const unsafeHomeClient = spawnMcpClient({ cwd: os.homedir() })
    try {
      await unsafeHomeClient.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
      })
      const denied = getToolText(
        await unsafeHomeClient.request('tools/call', {
          name: 'quick_outline',
          arguments: {
            cwd: workspace,
            paths: ['src/math.ts'],
          },
        }),
      )
      assert.equal(denied.isError, true)
      assert.match(denied.text, /Access denied/i)
    } finally {
      await unsafeHomeClient.close()
    }

    // Case C: Started in PLUGIN_ROOT with BATCH_TOOLS_WORKSPACE_ROOTS + BATCH_TOOLS_ALLOW_EDITS=false.
    const envClient = spawnMcpClient({
      cwd: PLUGIN_ROOT,
      env: {
        [ENV_WORKSPACE_ROOTS]: workspace,
        [ENV_ALLOW_EDITS]: 'false',
      },
    })
    try {
      await envClient.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
      })
      const okRead = getToolText(
        await envClient.request('tools/call', {
          name: 'quick_outline',
          arguments: { paths: ['src/math.ts'] },
        }),
      )
      assert.equal(okRead.isError, false)
      assert.match(okRead.text, /multiply/)

      const blockedEdit = getToolText(
        await envClient.request('tools/call', {
          name: 'apply_edits',
          arguments: {
            edits: [{ path: 'src/math.ts', hunks: [{ target: 'add', replacement: 'sum' }] }],
          },
        }),
      )
      assert.equal(blockedEdit.isError, true)
      assert.match(blockedEdit.text, /BATCH_TOOLS_ALLOW_EDITS=false/)
    } finally {
      await envClient.close()
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})
