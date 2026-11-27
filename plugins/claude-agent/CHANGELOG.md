# Changelog

## [0.3.1] - 2026-11-27

### Fixed

- Live session catalog synchronization in `claude_ui_poll`: allow polling with an optional `sessionId` (so empty/welcome panels stay live), push updated `sessions` lists via `catalogVersion`, and emit `focusSessionId` when `claude_open` dispatches or focuses a session so an already-open `aux_pane` or `global` panel switches immediately to the new conversation.

## [0.3.0] - 2026-11-27

### Added

- Automatic async reply delivery (`replyToChat`, default `true` when `claude_open` receives a `prompt`): the open `aux_pane` receives cross-session `pendingReplies` notifications, atomically claims the completed turn (`claim_reply` / `ack_reply` / `release_reply`), and posts Claude's full turn response back into the Antigravity chat via `@modelcontextprotocol/ext-apps` `app.sendMessage()` so the agent resumes automatically without timeouts.
- `claude_session` `action: "wait"` (5–60s window, default 25s, with MCP progress heartbeats) to wait on a running asynchronous turn without ever cancelling it, serving as a reliable fallback when the side pane is closed or in headless sessions.
- `Auto-reply` status chip in `SessionControlBar` while an auto-reply turn is running in the side pane.

### Changed

- Increased response capture limit to 24,000 characters and joined all assistant message blocks from the latest turn across auto-reply, manual **To Chat** / **Attach**, and `claude_session` (`get` / `wait`).
- Updated `claude_open`, `claude_ask`, `claude_session`, and `SKILL.md` guidance to prefer asynchronous `claude_open` (with `mode: "plan"` for read-only reviews) for multi-file or long-running tasks.

## [0.2.0] - 2026-11-27

### Changed

- Default new sessions to permission mode `auto` (when supported, falling back to `default`; `claude_ask` remains strictly read-only `plan`) and model `opus` (resolved against the ACP agent's advertised model catalog, falling back gracefully to the agent's default model when Opus is unavailable).
- Apply model selection before permission mode during session setup and `claude_open` so ACP agents that gate `auto` mode on model capabilities activate `auto` cleanly without falling back.
- Reapply preserved/default model and mode settings when `session/load` falls back to `session/new`, avoid false alias matches against `opusplan` or `default`, and render model config options in `SessionControlBar` even when advertised only via `configOptions`.

## [0.1.0] - 2026-11-27

### Added

- Initial release of the `claude-agent` Antigravity MCP App plugin backed by `@agentclientprotocol/claude-agent-acp`.
- Zero-dependency Node 22.18+ TypeScript MCP server with ACP stdio client, binary discovery cascade (`CLAUDE_AGENT_ACP_BIN` -> `PATH` -> `npx`), secret redaction, atomic `${PLUGIN_DATA}` session persistence with Antigravity-scoped session filtering and archiving (auto-archiving completed one-shot `claude_ask` and stale idle sessions), and view-isolated cursor-based long-polling with chunk coalescing.
- Model-facing tools (`claude_open`, `claude_ask`, `claude_session`) and app-only UI tools (`claude_ui_*`) plus bundled `claude-agent` skill.
- Single-file React 19 MCP App UI (`ui://claude-agent/app.html`) supporting `aux_pane` and `global` entrypoints as an agent-driven monitor and approval console with streaming Markdown, collapsible prompt/thinking/plan disclosures, grouped tool call timelines with inline diffs, interactive permission approvals, active vs. collapsible Archived sidebar sessions with manual archive/restore actions, Touched Files and Session Options popovers, usage/cost tracking, native `<dialog>` ACP diagnostics, and Antigravity file/context/chat bridge actions.
