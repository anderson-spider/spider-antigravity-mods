# Changelog

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
