// Deterministic mock ACP agent speaking JSON-RPC 2.0 over stdio for automated testing.
import { createInterface } from 'node:readline'

type SessionRecord = {
  sessionId: string
  cwd: string
  modeId: string
  modelId: string
  activeTurn?: { cancelled: boolean }
}

const sessions = new Map<string, SessionRecord>()
const pendingOutbound = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>()
let outboundId = 1
let sessionSeq = 0
let authenticated = process.env.FAKE_ACP_REQUIRE_AUTH !== '1'

function write(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  write({ jsonrpc: '2.0', method, params })
}

function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = outboundId++
  return new Promise((resolve, reject) => {
    pendingOutbound.set(id, { resolve, reject })
    write({ jsonrpc: '2.0', id, method, params })
  })
}

function makeModes(currentModeId: string) {
  return {
    currentModeId,
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'auto', name: 'Auto' },
      { id: 'acceptEdits', name: 'Accept Edits' },
      { id: 'plan', name: 'Plan' },
      { id: 'bypassPermissions', name: 'Bypass Permissions' },
    ],
  }
}

function makeModels(currentModelId: string) {
  return {
    currentModelId,
    availableModels: [
      { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      { modelId: 'claude-opus-4-1', name: 'Claude Opus 4.1' },
    ],
  }
}

function promptTextOf(params: Record<string, unknown>): string {
  const prompt = Array.isArray(params.prompt) ? params.prompt : []
  return prompt
    .map(block => {
      if (!block || typeof block !== 'object') return ''
      const b = block as { type?: string; text?: string; name?: string }
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      if (b.type === 'resource_link' && typeof b.name === 'string') return `[link:${b.name}]`
      return ''
    })
    .join(' ')
    .trim()
}

async function handlePrompt(id: number | string, params: Record<string, unknown>): Promise<void> {
  const sessionId = String(params.sessionId ?? '')
  const rec = sessions.get(sessionId)
  if (!rec) {
    write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown session: ${sessionId}` } })
    return
  }
  if (!authenticated) {
    write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'auth_required: Please run claude /login' } })
    return
  }

  const turnToken = { cancelled: false }
  rec.activeTurn = turnToken
  const text = promptTextOf(params)

  if (text.includes('[trigger:internal_error_data]')) {
    write({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: 'Internal error',
        data: { details: 'Query closed before response received sk-ant-secret123456' },
      },
    })
    return
  }

  if (text.includes('[trigger:stderr_secret]')) {
    process.stderr.write('debug token sk-ant-secret1234567890abcdef and Bearer tok_secret_value\n')
  }

  sendNotification('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'compact', description: 'Compact conversation context' },
        { name: 'clear', description: 'Clear current session' },
      ],
    },
  })

  sendNotification('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Checking repository context...' },
    },
  })

  sendNotification('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect target file', status: 'completed', priority: 'high' },
        { content: 'Summarize findings', status: 'in_progress', priority: 'medium' },
      ],
    },
  })

  if (text.includes('[trigger:permission]')) {
    const tcId = 'tc-perm-1'
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: tcId,
        title: 'Edit src/app.ts',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: 'src/app.ts', line: 10 }],
      },
    })

    const permResp = (await sendRequest('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: tcId,
        title: 'Edit src/app.ts',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: 'src/app.ts', line: 10 }],
        content: [{ type: 'diff', path: 'src/app.ts', oldText: 'const a = 1', newText: 'const a = 2' }],
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    })) as { outcome?: { outcome?: string; optionId?: string } }

    const approved = permResp?.outcome?.outcome === 'selected' && permResp.outcome.optionId === 'allow_once'
    const outcomeTag = `${permResp?.outcome?.outcome ?? 'none'}:${permResp?.outcome?.optionId ?? ''}`
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: tcId,
        status: approved ? 'completed' : 'failed',
        content: approved
          ? [{ type: 'diff', path: 'src/app.ts', oldText: 'const a = 1', newText: 'const a = 2' }]
          : [{ type: 'content', content: { type: 'text', text: 'Permission declined' } }],
      },
    })

    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: approved
            ? 'Applied edit after approval.'
            : `Skipped edit because permission was declined (${outcomeTag}).`,
        },
      },
    })
  } else if (text.includes('[trigger:permission_no_reject]')) {
    const tcId = 'tc-perm-noreject'
    const permResp = (await sendRequest('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: tcId,
        title: 'Run dangerous command',
        kind: 'execute',
        status: 'pending',
      },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    })) as { outcome?: { outcome?: string; optionId?: string } }
    const outcomeTag = `${permResp?.outcome?.outcome ?? 'none'}:${permResp?.outcome?.optionId ?? ''}`
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `No-reject permission outcome (${outcomeTag}).` },
      },
    })
  } else if (text.includes('[trigger:crash]')) {
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Partial before crash' },
      },
    })
    await new Promise(r => setTimeout(r, 30))
    process.exit(1)
  } else if (text.includes('[trigger:hang_cancel]')) {
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Working before hang...' },
      },
    })
    // Simulate an agent that fails to acknowledge session/cancel within the client grace window
    await new Promise(r => setTimeout(r, 140))
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' very late chunk' },
      },
    })
    await new Promise(r => setTimeout(r, 40))
    write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
    return
  } else if (text.includes('[trigger:late_chunk_on_cancel]')) {
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Before cancel...' },
      },
    })
    for (let i = 0; i < 40; i++) {
      if (turnToken.cancelled) {
        await new Promise(r => setTimeout(r, 40))
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' late chunk' },
          },
        })
        await new Promise(r => setTimeout(r, 20))
        write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
        return
      }
      await new Promise(r => setTimeout(r, 25))
    }
  } else if (text.includes('[trigger:slow]')) {
    for (let i = 0; i < 15; i++) {
      if (turnToken.cancelled) {
        write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
        return
      }
      await new Promise(r => setTimeout(r, 40))
    }
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Finished slow turn.' },
      },
    })
  } else {
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-read-1',
        title: 'Read README.md',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: 'README.md', line: 1 }],
      },
    })
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-read-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Read 20 lines' } }],
      },
    })
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Echo (${rec.modeId}): ` },
      },
    })
    sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: text },
      },
    })
  }

  sendNotification('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'usage_update',
      used: 1_500,
      size: 200_000,
      cost: { amount: 0.015, currency: 'USD' },
    },
  })

  write({ jsonrpc: '2.0', id, result: { stopReason: turnToken.cancelled ? 'cancelled' : 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line) as {
    id?: number | string
    method?: string
    params?: Record<string, unknown>
    result?: unknown
    error?: { message?: string }
  }

  if (typeof msg.method !== 'string') {
    if (typeof msg.id === 'number') {
      const pending = pendingOutbound.get(msg.id)
      if (pending) {
        pendingOutbound.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error.message || 'error'))
        else pending.resolve(msg.result)
      }
    }
    return
  }

  const params = msg.params ?? {}

  if (msg.method === 'session/cancel') {
    const rec = sessions.get(String(params.sessionId ?? ''))
    if (rec?.activeTurn) rec.activeTurn.cancelled = true
    return
  }

  const id = msg.id!
  switch (msg.method) {
    case 'initialize': {
      const replyInit = () => {
        write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'claude-agent-acp', title: 'Fake Claude ACP', version: '0.1.0-test' },
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { list: {} },
              promptCapabilities: { image: true, embeddedContext: true },
            },
            authMethods: [{ id: 'claude-login', name: 'Claude Code Login', description: 'Run claude /login' }],
          },
        })
      }
      const slowInitMs = Number(process.env.FAKE_ACP_SLOW_INIT_MS || '0')
      if (slowInitMs > 0) {
        setTimeout(replyInit, slowInitMs)
      } else {
        replyInit()
      }
      return
    }
    case 'authenticate':
      authenticated = true
      write({ jsonrpc: '2.0', id, result: {} })
      return
    case 'session/new': {
      if (!authenticated) {
        write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'auth_required: Please run claude /login' } })
        return
      }
      const sessionId = `fake-sess-${++sessionSeq}`
      const cwd = String(params.cwd || process.cwd())
      const rec: SessionRecord = {
        sessionId,
        cwd,
        modeId: 'default',
        modelId: 'claude-sonnet-4-5',
      }
      sessions.set(sessionId, rec)
      const configOptions: Record<string, unknown>[] = [
        {
          id: 'thought_level',
          name: 'Thinking',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
          ],
        },
      ]
      if (process.env.FAKE_ACP_MODE_CONFIG === '1') {
        configOptions.push({
          id: 'permission_mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: rec.modeId,
          options: [
            { value: 'default', name: 'Default' },
            { value: 'auto', name: 'Auto' },
            { value: 'acceptEdits', name: 'Accept Edits' },
            { value: 'plan', name: 'Plan' },
          ],
        })
      }
      write({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
          modes: makeModes(rec.modeId),
          models: makeModels(rec.modelId),
          configOptions,
        },
      })
      return
    }
    case 'session/load': {
      const sessionId = String(params.sessionId ?? '')
      let rec = sessions.get(sessionId)
      if (!rec) {
        rec = {
          sessionId,
          cwd: String(params.cwd || process.cwd()),
          modeId: 'default',
          modelId: 'claude-sonnet-4-5',
        }
        sessions.set(sessionId, rec)
      }
      if (process.env.FAKE_ACP_REPLAY === '1') {
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Replayed user question' },
          },
        })
        sendNotification('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Replayed assistant answer' },
          },
        })
      }
      write({
        jsonrpc: '2.0',
        id,
        result: {
          modes: makeModes(rec.modeId),
          models: makeModels(rec.modelId),
        },
      })
      return
    }
    case 'session/list': {
      const listed = [...sessions.values()].map(s => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: `Fake ${s.sessionId}`,
        updatedAt: new Date().toISOString(),
      }))
      if (process.env.FAKE_ACP_EXTERNAL_SESSION) {
        listed.push({
          sessionId: process.env.FAKE_ACP_EXTERNAL_SESSION,
          cwd: '/tmp/external-cli-project',
          title: 'External CLI Session',
          updatedAt: new Date().toISOString(),
        })
      }
      write({
        jsonrpc: '2.0',
        id,
        result: {
          sessions: listed,
        },
      })
      return
    }
    case 'session/set_mode': {
      const rec = sessions.get(String(params.sessionId ?? ''))
      if (!rec) {
        write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown session' } })
        return
      }
      const nextMode = String(params.modeId ?? 'default')
      const finishSetMode = () => {
        if (process.env.FAKE_ACP_REJECT_PLAN === '1' && nextMode === 'plan') {
          write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'plan mode disabled in test' } })
          return
        }
        rec.modeId = nextMode
        write({ jsonrpc: '2.0', id, result: {} })
      }
      const slowSetModeMs = Number(process.env.FAKE_ACP_SLOW_SET_MODE_MS || '0')
      if (slowSetModeMs > 0) {
        setTimeout(finishSetMode, slowSetModeMs)
      } else {
        finishSetMode()
      }
      return
    }
    case 'session/set_model': {
      const rec = sessions.get(String(params.sessionId ?? ''))
      if (!rec) {
        write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown session' } })
        return
      }
      rec.modelId = String(params.modelId ?? 'claude-sonnet-4-5')
      write({ jsonrpc: '2.0', id, result: {} })
      return
    }
    case 'session/set_config_option': {
      const rec = sessions.get(String(params.sessionId ?? ''))
      const configId = String(params.configId ?? '')
      const value = String(params.value ?? '')
      if (rec && configId === 'permission_mode') {
        if (process.env.FAKE_ACP_REJECT_PLAN === '1' && value === 'plan') {
          write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'plan mode disabled in test' } })
          return
        }
        rec.modeId = value
        write({
          jsonrpc: '2.0',
          id,
          result: {
            configOptions: [
              {
                id: 'permission_mode',
                name: 'Mode',
                category: 'mode',
                type: 'select',
                currentValue: rec.modeId,
                options: [
                  { value: 'default', name: 'Default' },
                  { value: 'auto', name: 'Auto' },
                  { value: 'acceptEdits', name: 'Accept Edits' },
                  { value: 'plan', name: 'Plan' },
                ],
              },
            ],
          },
        })
        return
      }
      write({ jsonrpc: '2.0', id, result: {} })
      return
    }
    case 'session/prompt':
      void handlePrompt(id, params)
      return
    default:
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
})
