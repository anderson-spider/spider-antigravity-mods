# Changelog

## [0.5.0] - 2026-11-28

### Changed

- Removed `plan`, `default`, and `acceptEdits` permission modes across the server, MCP tools, and UI so only `auto` and `bypassPermissions` remain available (filtering ACP-advertised mode lists and migrating legacy persisted defaults to `auto`).
- Default new sessions to `auto` mode, `opus` model, and `high` reasoning effort (when advertised via ACP `thought_level` / `effort` config options), and added optional `effort` overrides on `claude_open` and `claude_ask` plus `defaultEffort` persistence in **Save as default**.
- Switched `claude_ask` from `plan` mode to `auto` mode while preserving its turn lock and automatic permission-prompt declination so synchronous consultations never hang.
- Allowed explicit `mode: "bypassPermissions"` on `claude_open` while keeping `bypassPermissions` blocked from being saved as the global default.

## [0.4.0] - 2026-11-27

### Added

- Auto-collapse `ThoughtBlock` disclosures as soon as thinking completes (`streaming: true -> false`), finalizing active thoughts on the server immediately when Claude transitions to a tool call or message chunk while still letting users expand them manually.
- Cross-session pending permission alert bar (`.perm-alert-bar`) in the panel header whenever another session is waiting for approval (`pendingPermissionCount > 0`), backed by live `catalogVersion` bumps on permission request, resolution, and cancellation.
- **Load earlier messages** button at the top of long threads when bootstrap truncates history (`truncatedItems: true`), fetching the full session transcript via `claude_ui_session(action: "get")` while preserving scroll position.
- **Save as default** action in the Session Options popover to persist the current mode and model via `claude_ui_fs(action: "save_prefs")`, blocking `bypassPermissions` as a persisted default in both the UI and server.

## [0.3.2] - 2026-11-27

### Fixed

- Fixed header workspace chip (`.session-cwd-chip`) clipping and missing folder icon by keeping `flex-shrink: 0` on the icon, moving `.truncate` to an inner text span so ellipsis renders cleanly, and widening `max-width` (`240px` / `140px` on narrow panes).

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
