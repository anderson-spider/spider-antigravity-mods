// The gitlab MCP server: started by Antigravity from mcp_config.json, receiving credentials from plugin variables or the user's environment.
import { createInterface } from 'node:readline'
import { server } from './mcp.ts'
import { nodeDeps, resolveCwd } from './node.ts'
import { ENV_NAME, run } from './run.ts'
import { TOOLS } from './tools.ts'

/** Captured at startup from Antigravity plugin variables (or user environment), then scrubbed from process.env. */
const options = {
  tokens: process.env[ENV_NAME] || undefined,
}
// Credentials stay in this process only: git and ssh child processes never inherit them.
delete process.env[ENV_NAME]

const mcp = server({
  write: line => process.stdout.write(`${line}\n`),
  log: text => process.stderr.write(`${text}\n`),
  call: async (name, input, context) => {
    const baseCwd = context.cwd ?? process.cwd()
    const resolved = await resolveCwd(input.cwd, baseCwd)
    if (resolved.error !== undefined) return { text: resolved.error, isError: true }
    return run(nodeDeps(resolved.cwd, () => context.progress('waiting')), TOOLS[name], input, options)
  },
})

createInterface({ input: process.stdin }).on('line', line => {
  void mcp.receive(line).catch(err => {
    process.stderr.write(`gitlab: receive failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  })
})
