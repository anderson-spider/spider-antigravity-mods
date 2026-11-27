---
name: claude-agent
description: Delegate coding tasks, code reviews, or architecture questions to Claude Code via the `claude-agent_claude-agent` MCP server and its interactive MCP App UI. Use when the user asks to ask Claude, consult Claude for a second opinion, open Claude Agent, or hand off a task to Claude Code.
---

# Claude Agent

Use this plugin's MCP server (`claude-agent_claude-agent`) to consult Claude Code or open an interactive Claude Agent session inside Antigravity.

## Tools (`claude-agent_claude-agent` MCP server)

Tools may be exposed directly or lazy-loaded via `call_mcp_tool` with `ServerName: "claude-agent_claude-agent"`:

- `claude_ask`: Synchronous **read-only** consultation (runs in `plan` mode; any write/execute permission prompt is automatically declined so it never hangs). Use for second opinions, code reviews, architecture analysis, or explaining a module.
- `claude_open`: Opens or focuses the interactive **Claude Agent** MCP App in the side pane (`aux_pane`) or sidebar (`global`). Pass optional `cwd`, `sessionId`, `prompt`, `mode` (`default`, `auto`, `acceptEdits`, or `plan`; defaults to `auto` when supported, falling back to `default`), and `model`. When `prompt` is provided, it starts an asynchronous Claude turn and opens the side pane so the user can watch streaming output and approve permissions live.
- `claude_session`: Manage dispatched or existing sessions (`list`, `get` to inspect status/latest response/touched files, or `cancel` to stop an active turn).

## Choosing between `claude_ask` and `claude_open`

- Use `claude_ask` when you need Claude's read-only analysis right away inside your own reasoning loop (pass `cwd` to target the active repository).
- Use `claude_open` with `prompt` when the task involves editing files, running tests/commands, or interactive user supervision in the side pane. After dispatching, tell the user the session ID and that they can review/approve tool calls in the **Claude Agent** panel; use `claude_session` (`action: "get"`) if asked to check progress or collect the result.
- Use `claude_open` with `{}` (no arguments) when the user simply wants to open the Claude Agent chat UI.
- Never pass `bypassPermissions` or work around user permission prompts.
