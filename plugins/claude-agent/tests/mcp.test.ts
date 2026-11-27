import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ToolInputs } from '../server/inputs.ts'
import { server } from '../server/mcp.ts'
import { APP_MIME, APP_URI, SessionManager } from '../server/session-manager.ts'
import { createStore } from '../server/store.ts'

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.ts', import.meta.url))

function rpcHarness(manager: SessionManager, opts: { roots?: string[] } = {}) {
  const out: Record<string, unknown>[] = []
  const waiters = new Map<string | number, (msg: Record<string, unknown>) => void>()
  let srv: ReturnType<typeof server>
  srv = server({
    write: line => {
      const msg = JSON.parse(line) as Record<string, unknown>
      out.push(msg)
      if (msg.method === 'roots/list' && (typeof msg.id === 'string' || typeof msg.id === 'number')) {
        void srv.receive(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { roots: (opts.roots ?? []).map(r => ({ uri: `file://${r}` })) },
          }),
        )
        return
      }
      if (typeof msg.id === 'string' || typeof msg.id === 'number') {
        const w = waiters.get(msg.id)
        if (w) {
          waiters.delete(msg.id)
          w(msg)
        }
      }
    },
    resources: [
      {
        uri: APP_URI,
        name: 'Claude Agent UI',
        mimeType: APP_MIME,
        _meta: { ui: { prefersBorder: false } },
        read: async () => '<!DOCTYPE html><html><body>mock</body></html>',
      },
    ],
    call: async (name, input, context) => {
      switch (name) {
        case 'claude_open':
          return manager.handleOpenTool(input as ToolInputs['claude_open'], context.cwds)
        case 'claude_ask':
          return manager.handleAskTool(input as ToolInputs['claude_ask'], context.cwds, context.progress)
        case 'claude_session':
          return manager.handleSessionTool(input as ToolInputs['claude_session'])
        case 'claude_ui_bootstrap':
          return manager.handleUiBootstrap(input as ToolInputs['claude_ui_bootstrap'], context.cwds)
        case 'claude_ui_session':
          return manager.handleUiSession(input as ToolInputs['claude_ui_session'], context.cwds)
        case 'claude_ui_prompt':
          return manager.handleUiPrompt(input as ToolInputs['claude_ui_prompt'])
        case 'claude_ui_permission':
          return manager.handleUiPermission(input as ToolInputs['claude_ui_permission'])
        case 'claude_ui_poll':
          return manager.handleUiPoll(input as ToolInputs['claude_ui_poll'])
        case 'claude_ui_fs':
          return manager.handleUiFs(input as ToolInputs['claude_ui_fs'], context.cwds)
      }
    },
  })

  async function request(method: string, params: Record<string, unknown> = {}, id = Math.floor(Math.random() * 10_000)) {
    const replyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`Timed out waiting for MCP reply to ${method} (id=${id})`))
      }, 5_000)
      waiters.set(id, msg => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
    await srv.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return replyPromise
  }

  return { srv, request, out }
}

test('MCP server exposes entrypoints, app-only visibility, ui:// resource, and executes claude_ask', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-mcp-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const manager = new SessionManager({
    store: createStore(dir),
    binaryDeps: {
      env: { CLAUDE_AGENT_ACP_BIN: process.execPath, CLAUDE_AGENT_ACP_ARGS: FAKE_AGENT },
      isExecutable: () => true,
    },
    defaultCwd: dir,
  })
  t.after(async () => {
    await manager.dispose()
  })

  const { request } = rpcHarness(manager, { roots: [dir] })

  const init = (await request('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: {} } }, 1)) as {
    result: { capabilities: { tools: unknown; resources: unknown } }
  }
  assert.ok(init.result.capabilities.tools)
  assert.ok(init.result.capabilities.resources)

  const toolsResp = (await request('tools/list', {}, 2)) as {
    result: { tools: { name: string; _meta?: Record<string, unknown> }[] }
  }
  const openTool = toolsResp.result.tools.find(tool => tool.name === 'claude_open')
  assert.ok(openTool?._meta?.['com.google.antigravity/ui'])
  const uiTools = toolsResp.result.tools.filter(tool => tool.name.startsWith('claude_ui_'))
  assert.equal(uiTools.length, 6)
  for (const uiTool of uiTools) {
    assert.deepEqual(uiTool._meta, { ui: { visibility: ['app'] } })
  }

  const resRead = (await request('resources/read', { uri: APP_URI }, 3)) as {
    result: { contents: { mimeType: string; text: string }[] }
  }
  assert.equal(resRead.result.contents[0]!.mimeType, APP_MIME)
  assert.ok(resRead.result.contents[0]!.text.includes('mock'))

  const askResp = (await request(
    'tools/call',
    { name: 'claude_ask', arguments: { prompt: 'hello from mcp' } },
    4,
  )) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  assert.equal(askResp.result.isError, undefined)
  assert.ok(askResp.result.content[0]!.text.includes('Echo (plan): hello from mcp'))
})

test('MCP server handles invalid actions and malformed tool replies without crashing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-agent-mcp-invalid-'))
  const manager = new SessionManager({
    store: createStore(dir),
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

  const { request } = rpcHarness(manager, { roots: [dir] })

  for (const [id, name, args] of [
    [10, 'claude_session', { action: 'bogus' }],
    [11, 'claude_ui_session', { action: 'bogus' }],
    [12, 'claude_ui_fs', { action: 'bogus' }],
    [13, 'claude_ui_prompt', { action: 'bogus', sessionId: 's1' }],
    [14, 'claude_ui_permission', { sessionId: 's1', requestId: 'r1', outcome: 'bogus' }],
  ] as const) {
    const resp = (await request('tools/call', { name, arguments: args }, id)) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    assert.equal(resp.result.isError, true, `expected isError for ${name}`)
    assert.ok(resp.result.content[0]!.text.includes('Invalid'), `expected Invalid message for ${name}`)
  }

  // Verify mcp.ts guards against a handler returning undefined/non-Reply
  const out: Record<string, unknown>[] = []
  const brokenSrv = server({
    write: line => out.push(JSON.parse(line) as Record<string, unknown>),
    call: (async () => undefined) as unknown as Parameters<typeof server>[0]['call'],
  })
  await brokenSrv.receive(
    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'claude_session', arguments: { action: 'list' } } }),
  )
  await new Promise(r => setTimeout(r, 30))
  const reply = out.find(m => m.id === 99) as { result?: { isError?: boolean; content?: { text: string }[] } } | undefined
  assert.ok(reply?.result, 'expected JSON-RPC reply even when handler returns undefined')
  assert.equal(reply.result.isError, true)
  assert.ok(reply.result.content?.[0]?.text.includes('invalid reply'))
})
