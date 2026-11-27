# Changelog

## [0.1.0] - 2026-11-27

### Added

- Initial release of the `claude-agent` Antigravity MCP App plugin backed by `@agentclientprotocol/claude-agent-acp`.
- Zero-dependency Node 22.18+ TypeScript MCP server with ACP stdio client, binary discovery cascade (`CLAUDE_AGENT_ACP_BIN` -> `PATH` -> `npx`), secret redaction, atomic `${PLUGIN_DATA}` session persistence with Antigravity-scoped session filtering and archiving (auto-archiving completed one-shot `claude_ask` and stale idle sessions), and view-isolated cursor-based long-polling with chunk coalescing.
- Model-facing tools (`claude_open`, `claude_ask`, `claude_session`) and app-only UI tools (`claude_ui_*`) plus bundled `claude-agent` skill.
- Single-file React 19 MCP App UI (`ui://claude-agent/app.html`) supporting `aux_pane` and `global` entrypoints as an agent-driven monitor and approval console with streaming Markdown, collapsible prompt/thinking/plan disclosures, grouped tool call timelines with inline diffs, interactive permission approvals, active vs. collapsible Archived sidebar sessions with manual archive/restore actions, Touched Files and Session Options popovers, usage/cost tracking, native `<dialog>` ACP diagnostics, and Antigravity file/context/chat bridge actions.
