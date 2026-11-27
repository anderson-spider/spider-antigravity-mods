import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpClient } from '../server/acp-client.ts'
import type { AcpInitializeResult, AcpPromptResult, AcpSessionNewResult } from '../server/acp-types.ts'
import { buildAcpEnv } from '../server/redact.ts'

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.ts', import.meta.url))

test('AcpClient completes initialize, prompt, bidirectional permission, and secret masking', async t => {
  const updates: unknown[] = []
  let permissionSawOptions = 0

  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    env: buildAcpEnv({ ...process.env, GITLAB_MCP_TOKENS: 'should_not_leak' }),
    onNotification: (method, params) => {
      if (method === 'session/update') updates.push(params)
    },
    onRequest: async (method, params) => {
      if (method === 'session/request_permission') {
        const opts = (params.options as { optionId: string }[]) ?? []
        permissionSawOptions = opts.length
        return { outcome: { outcome: 'selected', optionId: opts[0]!.optionId } }
      }
      throw new Error(`Unexpected request: ${method}`)
    },
  })
  t.after(async () => {
    await client.dispose()
  })

  const init = await client.request<AcpInitializeResult>('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'test', version: '1.0.0' },
    clientCapabilities: {},
  })
  assert.equal(init.agentInfo?.name, 'claude-agent-acp')

  const created = await client.request<AcpSessionNewResult>('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  })
  assert.ok(created.sessionId.startsWith('fake-sess-'))

  const promptRes = await client.request<AcpPromptResult>('session/prompt', {
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: '[trigger:permission] [trigger:stderr_secret]' }],
  })
  assert.equal(promptRes.stopReason, 'end_turn')
  assert.equal(permissionSawOptions, 2)
  assert.ok(updates.length >= 4)

  const stderrText = client.getStderrTail().join('\n')
  assert.ok(stderrText.includes('sk-ant-***'))
  assert.ok(stderrText.includes('Bearer ***'))
  assert.ok(!stderrText.includes('secret1234567890abcdef'))
  assert.ok(!stderrText.includes('tok_secret_value'))

  await assert.rejects(
    () =>
      client.request<AcpPromptResult>('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: '[trigger:internal_error_data]' }],
      }),
    err =>
      err instanceof Error &&
      err.message.includes('Internal error: Query closed before response received sk-ant-***') &&
      !err.message.includes('secret123456'),
  )
})

test('AcpClient sets isAlive=false on spawn error without crashing', async t => {
  const logs: string[] = []
  const client = new AcpClient({
    command: '/nonexistent-acp-binary-for-test',
    args: [],
    cwd: process.cwd(),
    env: buildAcpEnv(process.env),
    onLog: line => logs.push(line),
  })
  t.after(async () => {
    await client.dispose()
  })

  await assert.rejects(() => client.request('initialize', { protocolVersion: 1 }))
  assert.equal(client.isAlive, false)
})
