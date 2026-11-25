import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DASHBOARD_MIME, DASHBOARD_URI } from '../server/dashboard.ts'
import { SERVER_VERSION, folderOf, server, type CallContext, type ResourceEntry } from '../server/mcp.ts'
import { SPECS } from '../server/tools.ts'
import { expect, test } from './expect.ts'

/** A server whose answers are kept in `out`, each call recorded with what it got. */
function session(
  opts: {
    reply?: (name: string) => Promise<{ text: string; structuredContent?: Record<string, unknown>; isError?: true }>
    resources?: readonly ResourceEntry[]
  } = {},
) {
  const out: Record<string, unknown>[] = []
  const calls: { name: string; input: Record<string, unknown>; context: CallContext }[] = []
  const mcp = server({
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    resources: opts.resources,
    call: async (name, input, context) => {
      calls.push({ name, input, context })
      return opts.reply ? opts.reply(name) : { text: `ran ${name}` }
    },
    rootsTimeoutMs: 1_000,
  })
  const send = (message: Record<string, unknown>) => mcp.receive(JSON.stringify({ jsonrpc: '2.0', ...message }))
  return { out, calls, send }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test('initialize answers tools and resources capabilities, and tools/list exposes core, dashboard entrypoint, and app-only tools', async () => {
  const { out, send } = session({
    resources: [{ uri: DASHBOARD_URI, name: 'GitLab MR Dashboard', mimeType: DASHBOARD_MIME, read: async () => '<html>ok</html>' }],
  })
  await send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })
  await send({ method: 'notifications/initialized' })
  await send({ id: 2, method: 'tools/list' })
  await send({ id: 3, method: 'ping' })
  await send({ id: 4, method: 'resources/list' })
  await send({ id: 5, method: 'resources/read', params: { uri: DASHBOARD_URI } })
  await send({ id: 6, method: 'resources/read', params: { uri: 'ui://gitlab/missing.html' } })
  await settle()

  expect(out[0]).toEqual({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'gitlab', version: SERVER_VERSION } },
  })
  const tools = (out[1]?.result as { tools: { name: string; inputSchema: unknown; _meta?: Record<string, unknown> }[] }).tools
  expect(tools.map((t) => t.name)).toEqual([
    'gitlab_mr',
    'gitlab_mr_comment',
    'gitlab_pipeline',
    'gitlab_job_log',
    'gitlab_label',
    'gitlab_user',
    'gitlab_mr_dashboard',
    'gitlab_ui_list',
    'gitlab_ui_detail',
    'gitlab_ui_diff',
    'gitlab_ui_job_log',
    'gitlab_ui_action',
    'gitlab_ui_state',
  ])
  expect(tools[0]?.inputSchema).toEqual(SPECS[0]?.inputSchema)
  const dashboard = tools.find((t) => t.name === 'gitlab_mr_dashboard')
  expect(dashboard?._meta).toEqual({
    ui: { resourceUri: DASHBOARD_URI },
    'com.google.antigravity/ui': {
      entrypoints: [
        { type: 'aux_pane', title: 'GitLab MRs' },
        { type: 'global', title: 'GitLab MRs' },
      ],
    },
  })
  for (const appTool of tools.filter((t) => t.name.startsWith('gitlab_ui_'))) {
    expect(appTool._meta).toEqual({ ui: { visibility: ['app'] } })
  }
  expect(out[2]).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  expect((out[3]?.result as { resources: { uri: string; mimeType: string }[] }).resources).toEqual([
    { uri: DASHBOARD_URI, name: 'GitLab MR Dashboard', mimeType: DASHBOARD_MIME },
  ])
  const readRes = out.find((m) => m.id === 5)?.result as { contents: { uri: string; mimeType: string; text: string }[] }
  expect(readRes.contents).toEqual([{ uri: DASHBOARD_URI, mimeType: DASHBOARD_MIME, text: '<html>ok</html>' }])
  expect((out.find((m) => m.id === 6)?.error as { code: number }).code).toBe(-32602)
})

test('a call answers its text and structuredContent, an error with isError, and an unknown tool or method is refused', async () => {
  const { out, calls, send } = session({
    reply: async (name) =>
      name === 'gitlab_user'
        ? { text: 'nope', isError: true }
        : name === 'gitlab_mr_dashboard'
          ? { text: 'opened', structuredContent: { configuredHosts: ['gitlab.example.com'] } }
          : { text: 'ok' },
  })
  await send({ id: 1, method: 'initialize', params: { capabilities: {} } })
  await send({ id: 2, method: 'tools/call', params: { name: 'gitlab_mr', arguments: { action: 'get', iid: 7 } } })
  await send({ id: 3, method: 'tools/call', params: { name: 'gitlab_user' } })
  await send({ id: 4, method: 'tools/call', params: { name: 'gitlab_api', arguments: {} } })
  await send({ id: 5, method: 'server/discover' })
  await send({ id: 6, method: 'tools/call', params: { name: 'gitlab_mr_dashboard', arguments: {} } })
  await settle()

  expect(calls.map((c) => [c.name, c.input])).toEqual([
    ['gitlab_mr', { action: 'get', iid: 7 }],
    ['gitlab_user', {}],
    ['gitlab_mr_dashboard', {}],
  ])
  const by = (id: number) => out.find((m) => m.id === id)
  expect(by(2)?.result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  expect(by(3)?.result).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true })
  expect(by(4)?.error).toMatchObject({ code: -32602 })
  expect(by(5)?.error).toMatchObject({ code: -32601 })
  expect(by(6)?.result).toEqual({
    content: [{ type: 'text', text: 'opened' }],
    structuredContent: { configuredHosts: ['gitlab.example.com'] },
  })
})

test('a call that throws still answers, as an error that names no detail', async () => {
  const { out, send } = session({ reply: async () => { throw new Error('secret detail') } })
  await send({ id: 1, method: 'tools/call', params: { name: 'gitlab_mr', arguments: {} } })
  await settle()
  const result = out.find((m) => m.id === 1)?.result as { content: { text: string }[]; isError: true }
  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).not.toContain('secret')
})

test("the session's folder comes from the client's roots, asked once and again after they change", async () => {
  const { out, calls, send } = session()
  await send({ id: 1, method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } })
  const call = (id: number) => send({ id, method: 'tools/call', params: { name: 'gitlab_user', arguments: {}, _meta: { progressToken: id } } })
  const answerRoots = async (path: string) => {
    await settle()
    const asked = out.filter((m) => m.method === 'roots/list').at(-1)!
    await send({ id: asked.id, result: { roots: [{ uri: `file://${path}` }] } })
    await settle()
  }

  void call(2)
  await answerRoots('/work/app')
  void call(3)
  await settle()
  await send({ method: 'notifications/roots/list_changed' })
  void call(4)
  await answerRoots('/work/app%20two')

  expect(calls.map((c) => c.context.cwd)).toEqual(['/work/app', '/work/app', '/work/app two'])
  expect(out.filter((m) => m.method === 'roots/list')).toHaveLength(2)
})

test('without roots a call goes on with no folder, and a wait beats progress on the call token', async () => {
  const out: Record<string, unknown>[] = []
  const contexts: (string | undefined)[] = []
  const mcp = server({
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    call: async (_name, _input, context) => {
      contexts.push(context.cwd)
      context.progress('waiting')
      context.progress('waiting')
      return { text: 'done' }
    },
  })
  await mcp.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }))
  await mcp.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gitlab_pipeline', arguments: {}, _meta: { progressToken: 'p' } } }))
  await settle()

  expect(contexts).toEqual([undefined])
  expect(out.filter((m) => m.method === 'notifications/progress').map((m) => m.params)).toEqual([
    { progressToken: 'p', progress: 1, message: 'waiting' },
    { progressToken: 'p', progress: 2, message: 'waiting' },
  ])
})

test('non-object JSON lines return Invalid Request and clearing roots resets cwd without spamming roots/list', async () => {
  const { out, calls, send } = session()
  await send({ id: 1, method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } })
  const raw = server({
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    call: async () => ({ text: 'ok' }),
  })
  await raw.receive('null')
  await raw.receive('[]')
  await raw.receive('42')
  expect(out.filter((m) => (m.error as { code?: number } | undefined)?.code === -32600)).toHaveLength(3)

  const answerRoots = async (roots: { uri: string }[]) => {
    await settle()
    const asked = out.filter((m) => m.method === 'roots/list').at(-1)!
    await send({ id: asked.id, result: { roots } })
    await settle()
  }
  void send({ id: 2, method: 'tools/call', params: { name: 'gitlab_user', arguments: {} } })
  await answerRoots([{ uri: 'file:///work/app' }])
  await send({ method: 'notifications/roots/list_changed' })
  void send({ id: 3, method: 'tools/call', params: { name: 'gitlab_user', arguments: {} } })
  await answerRoots([])
  void send({ id: 4, method: 'tools/call', params: { name: 'gitlab_user', arguments: {} } })
  await settle()

  expect(calls.map((c) => c.context.cwd)).toEqual(['/work/app', undefined, undefined])
  expect(out.filter((m) => m.method === 'roots/list')).toHaveLength(2)
})

test('folderOf reads the first file root and nothing else', () => {
  expect(folderOf({ roots: [{ uri: 'file:///a/b%20c' }, { uri: 'file:///d' }] })).toBe('/a/b c')
  for (const bad of [undefined, {}, { roots: [] }, { roots: [{ uri: 'https://x' }] }, { roots: [{}] }]) expect(folderOf(bad)).toBeUndefined()
})

test('node runs server/main.ts over stdio, serves the built dashboard HTML resource, validates cwd, and reports configured hosts', async () => {
  const main = fileURLToPath(new URL('../server/main.ts', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'gitlab-mcp-test-'))
  const repo = join(root, 'repo')
  const dataDir = join(root, 'plugin-data')
  try {
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.fake.test:team/app.git'], { cwd: repo })

    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.includes('GITLAB')))
    const child = spawn(process.execPath, [main, `--data-dir=${dataDir}`], {
      cwd: root,
      env: { ...env, GITLAB_MCP_TOKENS: 'gitlab.alpha.test=tok-a,gitlab.beta.test=tok-b' },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const lines: string[] = []
    let buffer = ''
    const requests = [
      'null',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gitlab_user', arguments: { cwd: 'relative/path' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gitlab_user', arguments: { cwd: repo } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: DASHBOARD_URI } }),
      JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'gitlab_mr_dashboard', arguments: {} } }),
    ]
    const ready = new Promise<void>((resolve) => {
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        lines.push(...parts.filter(Boolean))
        if (lines.length >= requests.length) resolve()
      })
    })
    for (const req of requests) child.stdin.write(`${req}\n`)
    await ready
    child.kill()

    const parsed = lines.map((l) => JSON.parse(l) as { id?: number | null; result?: unknown; error?: { code?: number } })
    const byId = (id: number) => parsed.find((m) => m.id === id)
    expect(parsed[0]?.error?.code).toBe(-32600)
    expect((byId(2)?.result as { tools: { name: string }[] }).tools).toHaveLength(13)
    expect((byId(3)?.result as { isError: boolean; content: { text: string }[] }).content[0]?.text).toBe('cwd must be an absolute directory path.')
    const noHost = (byId(4)?.result as { isError: boolean; content: { text: string }[] }).content[0]?.text
    expect(noHost).toContain('No token configured for gitlab.fake.test')
    expect(noHost).toContain('Configured hosts: gitlab.alpha.test, gitlab.beta.test.')
    expect(noHost).not.toContain('tok-a')

    const resource = (byId(5)?.result as { contents: { uri: string; mimeType: string; text: string }[] }).contents[0]!
    expect(resource.uri).toBe(DASHBOARD_URI)
    expect(resource.mimeType).toBe(DASHBOARD_MIME)
    expect(resource.text).toContain('<!DOCTYPE html>')
    expect(resource.text).toContain('<div id="root"></div>')
    expect(resource.text.length < 10 * 1024 * 1024).toBe(true)

    const dashRes = byId(6)?.result as { structuredContent: { configuredHosts: string[] } }
    expect(dashRes.structuredContent.configuredHosts).toEqual(['gitlab.alpha.test', 'gitlab.beta.test'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
