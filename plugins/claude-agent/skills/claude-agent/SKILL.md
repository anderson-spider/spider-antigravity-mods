---
name: claude-agent
description: Delegate coding tasks, code reviews, or architecture questions to Claude Code via the `claude-agent_claude-agent` MCP server and its interactive MCP App UI. Use when the user asks to ask Claude, consult Claude for a second opinion, open Claude Agent, or hand off a task to Claude Code.
---

# Claude Agent

Use this plugin's MCP server (`claude-agent_claude-agent`) to consult Claude Code or open an interactive Claude Agent session inside Antigravity.

## Tools (`claude-agent_claude-agent` MCP server)

Tools may be exposed directly or lazy-loaded via `call_mcp_tool` with `ServerName: "claude-agent_claude-agent"`:

- `claude_ask`: Synchronous **read-only** consultation (runs in `plan` mode; any write/execute permission prompt is automatically declined so it never hangs; `model` defaults to `opus` when supported; subject to timeout). Reserve this for quick, short questions.
- `claude_open`: Opens or focuses the interactive **Claude Agent** MCP App in the side pane (`aux_pane`) or sidebar (`global`). Pass optional `cwd`, `sessionId`, `prompt`, `mode` (`default`, `auto`, `acceptEdits`, or `plan`; defaults to `auto` when supported, falling back to `default`), `model` (defaults to `opus` when supported), and `replyToChat` (defaults to `true` when `prompt` is provided). When `prompt` is provided, it starts an asynchronous Claude turn with **no timeout**, opens the side pane for live streaming and permission approvals, and automatically posts Claude's completed response back into this conversation when finished.
- `claude_session`: Manage dispatched or existing sessions (`list`, `get` to inspect status/latest response/touched files, `wait` to wait up to 60s on a running turn without cancelling it, or `cancel` to stop an active turn).

## Choosing between `claude_ask` and `claude_open`

- **Prefer `claude_open` with `prompt` (async, no timeout)** for thorough MR/PR reviews, multi-file audits, architecture deep-dives, refactors, edits, or any task that may take longer than ~1 minute. Pass `mode: "plan"` when you want a read-only review, or omit `mode` (defaults to `auto`) for coding tasks. Because `replyToChat` defaults to `true`, tell the user the session ID and **end your turn** so the open **Claude Agent** side pane automatically delivers Claude's reply back to this conversation once finished.
- Use `claude_ask` only for short, quick read-only questions that will finish well within a minute.
- If the side pane was closed (or in a headless session without UI) or the user asks for a progress check, use `claude_session` (`action: "wait"` or `action: "get"`).
- Use `claude_open` with `{}` (no arguments) when the user simply wants to open the Claude Agent chat UI.
- Never pass `bypassPermissions` or work around user permission prompts.
