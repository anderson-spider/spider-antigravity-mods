// The gitlab MCP server: started by Antigravity from mcp_config.json, receiving credentials from plugin variables or the user's environment.
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { DASHBOARD_MIME, DASHBOARD_URI, runDashboardTool, type DashboardToolName } from './dashboard.ts'
import { server } from './mcp.ts'
import { gitAt, nodeDeps, resolveCwd } from './node.ts'
import { ENV_NAME, run } from './run.ts'
import { createStore } from './store.ts'
import { DASHBOARD_TOOLS, TOOLS, type CoreToolName } from './tools.ts'

/** Captured at startup from Antigravity plugin variables (or user environment), then scrubbed from process.env. */
const options = {
  tokens: process.env[ENV_NAME] || undefined,
}
// Credentials stay in this process only: git and ssh child processes never inherit them.
delete process.env[ENV_NAME]

/** Optional `--data-dir=<path>` flag from mcp_config.json (`${PLUGIN_DATA}`) for persistent UI state. */
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
const defaultHtmlPath = fileURLToPath(new URL('../ui/dist/app.html', import.meta.url))

const mcp = server({
  write: line => process.stdout.write(`${line}\n`),
  log: text => process.stderr.write(`${text}\n`),
  resources: [
    {
      uri: DASHBOARD_URI,
      name: 'GitLab MR Dashboard',
      description: 'Interactive merge request dashboard for GitLab (Global sidebar and side pane).',
      mimeType: DASHBOARD_MIME,
      _meta: { ui: { prefersBorder: false } },
      read: () => readFile(process.env.GITLAB_DASHBOARD_HTML || defaultHtmlPath, 'utf8'),
    },
  ],
  call: async (name, input, context) => {
    const baseCwd = context.cwd ?? process.cwd()
    const resolved = await resolveCwd(input.cwd, baseCwd)
    if (resolved.error !== undefined) return { text: resolved.error, isError: true }
    const deps = nodeDeps(resolved.cwd, () => context.progress('waiting'))
    if (DASHBOARD_TOOLS.has(name)) {
      const cwds = [...new Set([resolved.cwd, ...(context.cwds ?? [])])]
      return runDashboardTool(name as DashboardToolName, deps, input, options, store, { cwds, dataDir, gitAt })
    }
    return run(deps, TOOLS[name as CoreToolName], input, options)
  },
})

createInterface({ input: process.stdin }).on('line', line => {
  void mcp.receive(line).catch(err => {
    process.stderr.write(`gitlab: receive failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  })
})
