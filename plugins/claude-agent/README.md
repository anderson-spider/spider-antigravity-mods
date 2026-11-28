# Claude Agent for Google Antigravity

Interactive [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) client and Antigravity bridge powered by [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) over the Agent Client Protocol (ACP).

## Features

- **Live Session Monitor (`aux_pane` & `global`)**: Agent-driven console for observing Antigravity-dispatched Claude Code runs with streaming Markdown responses, auto-collapsing thought disclosures, collapsible prompt/plan disclosures, grouped tool call timelines, inline unified diffs, on-demand **Load earlier messages** for long histories, and a Touched Files popover that opens files directly in Antigravity (`com.google.antigravity/toggle-aux-pane`).
- **Interactive Permission & Session Controls**: Live `session/request_permission` approval cards, cross-session pending-approval alert banner when another session pauses for input, `Stop` cancellation, context window usage meter, and an Options popover for ACP mode (`auto` by default, or `bypassPermissions` with warning), model (`opus` by default when supported, falling back to the agent's default model), reasoning effort (`high` by default when supported), session config options, and a **Save as default** action (excluding `bypassPermissions`).
- **Antigravity Agent Bridge**:
  - `claude_open`: Opens the side pane / sidebar monitor or dispatches an asynchronous task with `prompt` (no timeout). Defaults to `auto` mode, `opus` model, and `high` effort (supports `mode: "auto"` or `mode: "bypassPermissions"`). By default (`replyToChat: true`), the open side pane automatically delivers Claude's completed reply back to the Antigravity conversation via `ext-apps` `sendMessage` so the agent resumes automatically.
  - `claude_ask`: Synchronous consultation in `auto` mode for quick questions (auto-declines interactive permission prompts so it never hangs; defaults to `opus` with `high` effort). Ephemeral one-shot `claude_ask` sessions are archived automatically after completion.
  - `claude_session`: List (with optional `includeArchived`), inspect (`get`), `wait` (up to 60s without cancelling the turn), or `cancel` sessions.
  - UI handoff actions to attach session summaries to your next Antigravity message (`updateModelContext`) or post directly to chat (`sendMessage`).
- **Scoped Sessions & Archiving**: Tracks Antigravity-created sessions locally in `${PLUGIN_DATA}` without importing external Claude Code CLI history. The sidebar separates active sessions from a collapsed **Archived** section with manual archive/restore actions, auto-archiving completed one-shot `claude_ask` sessions and idle sessions older than 7 days.

## Prerequisites & Authentication

1. **Node.js 22.18+** (uses native TypeScript type-stripping, zero runtime dependencies).
2. **Claude Code authentication** (choose one):
   - **Claude Pro / Max / Team / Enterprise login (recommended):** install Claude Code and authenticate locally with `claude /login`. No plugin variables are required.
   - **API key (optional):** expose `ANTHROPIC_API_KEY` in your environment.
3. **ACP adapter discovery order:**
   1. `CLAUDE_AGENT_ACP_BIN` (plus optional `CLAUDE_AGENT_ACP_ARGS`)
   2. `claude-agent-acp` on `PATH`
   3. Automatic fallback via `npx -y @agentclientprotocol/claude-agent-acp`

## Installation

```bash
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/claude-agent
```

## Tools Reference

| Tool | Visibility | Purpose |
| :--- | :--- | :--- |
| `claude_open` | Model & UI entrypoints | Open the Claude Agent panel (`aux_pane` / `global`) or dispatch an async `prompt` with optional `replyToChat` (default `true`). |
| `claude_ask` | Model | Synchronous consultation in `auto` mode for quick questions (auto-declines interactive permission prompts; defaults to `opus` + `high` effort). |
| `claude_session` | Model | `list`, `get`, `wait` (non-cancelling), or `cancel` Claude Agent sessions. |
| `claude_ui_*` | App-only (`visibility: ['app']`) | Internal bootstrap, session lifecycle, prompt/cancel, permissions, long-polling, and fs autocomplete. |

## Development

```bash
pnpm install
pnpm --filter claude-agent build:ui
pnpm --filter claude-agent typecheck
pnpm --filter claude-agent test
agy plugin validate --strict plugins/claude-agent
```

For fast UI iteration without rebuilding after every edit, set `CLAUDE_AGENT_APP_HTML` to your local HTML bundle path.
