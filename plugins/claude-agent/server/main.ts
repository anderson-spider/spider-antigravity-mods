// Entry point for the claude-agent MCP server started by Antigravity from mcp_config.json.
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { ToolInputs } from './inputs.ts'
import { server } from './mcp.ts'
import { APP_MIME, APP_URI, SessionManager } from './session-manager.ts'
import { createStore } from './store.ts'

function parseDataDir(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length).trim()
      return value && !/^\$\{[A-Z0-9_]+\}$/.test(value) ? value : undefined
    }
    if (arg === '--data-dir' && argv[i + 1]) {
      const value = argv[i + 1]!.trim()
      return value && !/^\$\{[A-Z0-9_]+\}$/.test(value) ? value : undefined
    }
  }
  return undefined
}

const dataDir = parseDataDir(process.argv.slice(2))
const store = createStore(dataDir)
const manager = new SessionManager({
  store,
  defaultCwd: process.cwd(),
  log: line => process.stderr.write(`${line}\n`),
})
const defaultHtmlPath = fileURLToPath(new URL('../ui/dist/app.html', import.meta.url))

const mcp = server({
  write: line => process.stdout.write(`${line}\n`),
  log: text => process.stderr.write(`${text}\n`),
  resources: [
    {
      uri: APP_URI,
      name: 'Claude Agent UI',
      description: 'Interactive Claude Code chat, permissions, tool diffs, and session manager.',
      mimeType: APP_MIME,
      _meta: { ui: { prefersBorder: false } },
      read: () => readFile(process.env.CLAUDE_AGENT_APP_HTML || defaultHtmlPath, 'utf8'),
    },
  ],
  call: async (name, input, context) => {
    switch (name) {
      case 'claude_open':
        return manager.handleOpenTool(input as ToolInputs['claude_open'], context.cwds)
      case 'claude_ask':
        return manager.handleAskTool(input as ToolInputs['claude_ask'], context.cwds, context.progress)
      case 'claude_session':
        return manager.handleSessionTool(input as ToolInputs['claude_session'], context.progress)
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
      default:
        return { text: `Unknown tool: ${String(name)}`, isError: true }
    }
  },
})

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  void mcp.receive(line).catch(err => {
    process.stderr.write(`claude-agent: receive failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  })
})

let shuttingDown = false
async function shutdown(signal?: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await manager.dispose().catch(() => undefined)
  if (signal) process.exit(0)
}

rl.on('close', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
