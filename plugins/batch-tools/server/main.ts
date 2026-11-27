// The batch-tools MCP server entrypoint: started by Antigravity from mcp_config.json.
// Speaks newline-delimited JSON-RPC 2.0 over stdio; never writes logs to stdout.
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createAuditLog } from './audit.ts'
import { createMcpServer, SERVER_VERSION } from './mcp.ts'
import { redactSecrets } from './redact.ts'
import { createToolDispatcher, TOOL_SPECS } from './tools.ts'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const audit = createAuditLog()
const dispatcher = createToolDispatcher({ audit, pluginRoot })

const mcp = createMcpServer({
  name: 'batch-tools',
  version: SERVER_VERSION,
  tools: TOOL_SPECS,
  write: (line) => {
    process.stdout.write(`${line}\n`)
  },
  log: (text) => {
    process.stderr.write(`${redactSecrets(text)}\n`)
  },
  call: (name, input, context) => dispatcher.call(name, input, context),
})

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    process.exit(0)
  }
})

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  void mcp.receive(line).catch((err) => {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err)
    process.stderr.write(`batch-tools: receive failed: ${redactSecrets(detail)}\n`)
  })
})
