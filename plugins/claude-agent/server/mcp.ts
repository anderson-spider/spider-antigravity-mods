// Zero-dependency MCP server over stdio (JSON-RPC 2.0, newline-delimited) with roots/list, tools, and ui:// resources.
import { fileURLToPath } from 'node:url'
import type { Reply } from './session-manager.ts'
import { SPECS, type ToolSpec } from './tools.ts'

export const PROTOCOL = '2025-06-18'
export const SERVER_VERSION = '0.1.0'

type Id = string | number
type Message = {
  jsonrpc?: string
  id?: Id | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

export type CallContext = {
  cwd: string | undefined
  cwds: readonly string[]
  progress: (message: string) => void
}

export type ResourceEntry = {
  uri: string
  name: string
  description?: string
  mimeType: string
  _meta?: Record<string, unknown>
  read: () => Promise<string>
}

export type Server = {
  receive: (line: string) => Promise<void>
}

export type ServerDeps = {
  write: (line: string) => void
  call: (name: ToolSpec['name'], input: Record<string, unknown>, context: CallContext) => Promise<Reply>
  resources?: readonly ResourceEntry[]
  log?: (text: string) => void
  rootsTimeoutMs?: number
}

const NAMES: ReadonlySet<string> = new Set(SPECS.map(spec => spec.name))

export function foldersOf(roots: unknown): string[] {
  const list = (roots as { roots?: unknown } | undefined)?.roots
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const uri = (item as { uri?: unknown } | undefined)?.uri
    if (typeof uri !== 'string' || !uri.startsWith('file://')) continue
    try {
      const folder = fileURLToPath(uri)
      if (!seen.has(folder)) {
        seen.add(folder)
        out.push(folder)
      }
    } catch {}
  }
  return out
}

export function server(deps: ServerDeps): Server {
  const send = (message: Record<string, unknown>) => deps.write(JSON.stringify({ jsonrpc: '2.0', ...message }))
  const answer = (id: Id, result: unknown) => send({ id, result })
  const fail = (id: Id, code: number, message: string) => send({ id, error: { code, message } })

  const resourceList = deps.resources ?? []
  const resourceMap = new Map(resourceList.map(r => [r.uri, r]))

  let rootsSupported = false
  let cwds: string[] = []
  let stale = true
  let epoch = 0
  let next = 0
  const pending = new Map<Id, (message: Message) => void>()

  async function folders(): Promise<readonly string[]> {
    if (!rootsSupported || !stale) return cwds
    const askedEpoch = epoch
    const id = `roots-${++next}`
    const reply = await new Promise<Message | undefined>(resolve => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(undefined)
      }, deps.rootsTimeoutMs ?? 2_000)
      pending.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
      send({ id, method: 'roots/list' })
    })
    if (reply && 'result' in reply && askedEpoch === epoch) {
      cwds = foldersOf(reply.result)
      stale = false
    }
    return cwds
  }

  async function call(id: Id, params: Record<string, unknown>): Promise<void> {
    const name = params.name
    if (typeof name !== 'string' || !NAMES.has(name)) return fail(id, -32602, `Unknown tool: ${String(name)}`)
    const args = params.arguments
    const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken
    let beats = 0
    const progress = (message: string) => {
      if (typeof token === 'string' || typeof token === 'number') {
        send({ method: 'notifications/progress', params: { progressToken: token, progress: ++beats, message } })
      }
    }
    let reply: Reply
    try {
      const roots = await folders()
      const rawReply = await deps.call(name as ToolSpec['name'], input, { cwd: roots[0], cwds: roots, progress })
      if (!rawReply || typeof rawReply !== 'object' || typeof rawReply.text !== 'string') {
        throw new Error(`Tool "${name}" returned an invalid reply.`)
      }
      reply = rawReply
    } catch (err) {
      deps.log?.(`claude-agent: ${name} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      reply = {
        text: err instanceof Error ? err.message : 'Claude Agent tool failed before answering.',
        isError: true,
      }
    }
    answer(id, {
      content: [{ type: 'text', text: reply.text }],
      ...(reply.structuredContent !== undefined ? { structuredContent: reply.structuredContent } : {}),
      ...(reply.isError ? { isError: true } : {}),
    })
  }

  async function readResource(id: Id, params: Record<string, unknown>): Promise<void> {
    const uri = params.uri
    if (typeof uri !== 'string') return fail(id, -32602, 'resources/read requires a string uri.')
    const entry = resourceMap.get(uri)
    if (!entry) return fail(id, -32602, `Unknown resource: ${uri}`)
    try {
      const text = await entry.read()
      answer(id, {
        contents: [
          {
            uri: entry.uri,
            mimeType: entry.mimeType,
            text,
            ...(entry._meta ? { _meta: entry._meta } : {}),
          },
        ],
      })
    } catch (err) {
      deps.log?.(`claude-agent: resource ${uri} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      fail(id, -32603, `Failed to read resource: ${uri}`)
    }
  }

  return {
    async receive(line) {
      if (!line.trim()) return
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        return send({ id: null, error: { code: -32700, message: 'Parse error' } })
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return send({ id: null, error: { code: -32600, message: 'Invalid Request' } })
      }
      const message = raw as Message
      const { id, method } = message
      if (method === undefined) {
        if (id !== undefined && id !== null) {
          pending.get(id)?.(message)
          pending.delete(id)
        }
        return
      }
      if (method === 'notifications/roots/list_changed') {
        epoch++
        stale = true
        return
      }
      if (id === undefined || id === null) return
      const rawParams = message.params
      const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? rawParams : {}
      switch (method) {
        case 'initialize': {
          rootsSupported = !!(params.capabilities as { roots?: unknown } | undefined)?.roots
          const asked = params.protocolVersion
          return answer(id, {
            protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'claude-agent', version: SERVER_VERSION },
          })
        }
        case 'ping':
          return answer(id, {})
        case 'tools/list':
          return answer(id, {
            tools: SPECS.map(spec => ({
              name: spec.name,
              ...(spec.title ? { title: spec.title } : {}),
              description: spec.description,
              inputSchema: spec.inputSchema,
              ...(spec._meta ? { _meta: spec._meta } : {}),
            })),
          })
        case 'tools/call':
          void call(id, params).catch(err => {
            deps.log?.(`claude-agent: tools/call failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
          })
          return
        case 'resources/list':
          return answer(id, {
            resources: resourceList.map(r => ({
              uri: r.uri,
              name: r.name,
              ...(r.description ? { description: r.description } : {}),
              mimeType: r.mimeType,
              ...(r._meta ? { _meta: r._meta } : {}),
            })),
          })
        case 'resources/read':
          void readResource(id, params).catch(err => {
            deps.log?.(`claude-agent: resources/read failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
          })
          return
        default:
          return fail(id, -32601, `Method not found: ${method}`)
      }
    },
  }
}
