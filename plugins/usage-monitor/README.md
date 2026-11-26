# Usage & Speed Monitor

Offline MCP App and CLI `statusLine` telemetry monitor for Google Antigravity Desktop and `agy`.

## Overview

Usage & Speed Monitor tracks token throughput, latency, context allocation, quota consumption, and **Session Health** diagnostics locally on your machine without external network calls or host binary patches.

### Surfaces

- **Left Sidebar (`global` MCP App):** Full-page dashboard (`usage_monitor_dashboard` → `ui://usage-monitor/dashboard.html`) accessible from **Plugins > Usage Monitor**.
- **Right Side Pane (`aux_pane` MCP App):** Responsive auxiliary side-pane dashboard (`usage_monitor_dashboard` → `ui://usage-monitor/dashboard.html`) with automatic active-session tracking and optional agent-driven `{ conversationId?, tab? }` navigation.
- **Inline Chat Session Health Card (`usage_monitor_session_health`):** Compact in-chat MCP App diagnostic card (`ui://usage-monitor/health-card.html`) with live **Refresh** and capability-gated **Attach diagnosis to context** (`updateModelContext`), plus a concise plain-text summary for non-UI clients.
- **Antigravity CLI (`agy` `statusLine`):** Single-line 24-bit ANSI status bar (`cli/statusline.mjs`, toggled via `/statusline` or **Settings > Structure > CLI Status Bar**) with a minimal `⚠ cache ×N` alert shown only during an active sustained cache collapse (streak ≥ 3).

### Key Capabilities

- **Session Health Diagnostics:**
  - **Prompt Cache Miss Attribution:** Classifies cache misses across `plan_mode_switch`, `model_switch`, `error_retry`, `idle_or_wait_gap`, `active_slow_gap`, `async_wakeup_fast`, and `prefix_or_replica_miss` while separating compaction resets and context dilution.
  - **Sustained Cache Collapse Detection:** Flags consecutive cache-miss streaks of 3+ turns across the Overview `SessionHealthWidget`, inline chat card, and CLI `statusLine`.
  - **Active Time & Effective TPS:** Separates LLM generation time from non-blocking tool execution time, calculates Effective TPS over active duration, and tracks active inter-step gaps over 60 seconds.
  - **Context & Workflow Hygiene:** Monitors ≥150k prompt pressure, high-context multimodal turns (≥150k and ≥180k), and single-tool vs. batched tool-turn efficiency, with per-step badges and tooltips in **By Step** and isolated mainline aggregation in multi-agent/swarm sessions.
- **Quota Pace & Burn-Rate Tracking:** Computes expected cycle progress for 5-hour and weekly quota windows, overlays a vertical expected-pace marker on each quota bar, and shows directional delta badges (`▼ -9% · exp 52%`, `▲ +14% · exp 38%`, `● On pace`) with burn-rate tooltips.
- **Live Telemetry Cards:** Tracks output speed (`tok/s`), time-to-first-token (`TTFT`), session average throughput, step/session USD estimates, cache hit rate, tightest quota pool, and total session tokens.
- **10-Category Context Inspector:** Breaks down the active prompt window across assistant replies, tool results, user input, subagent notifications, checkpoints, system prompt, system tools, MCP tools, skills, and user rules, with main/subagent switching.
- **Multi-Pool Quotas:** Monitors 5-hour and weekly quotas, reset countdowns, and per-cycle token/cost totals across `Gemini`, `Gemini 4 Argon`, `Gemini 4 Carbon`, and `Claude & GPT` pools.
- **Call & Trend Breakdown:** Inspects **By Step** and **By Model** records with configurable columns, custom token combo formats, turn rails, and aggregated usage views (`Today`, `1d`, `7d`, `14d`, `30d`, `All`, or custom date ranges).
- **Host-Integrated & Bilingual (`en-US` / `pt-BR`):** Applies Antigravity `HostContext` theme, CSS variables, fonts, and locale across all MCP App surfaces and the CLI `statusLine`, with `Follow System` defaulting to `en-US`.

## Installation

Install directly from this repository using the Antigravity CLI:

```bash
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/usage-monitor
```

Re-run the same command to update in place, or run `agy plugin uninstall usage-monitor` to remove the plugin.

After installation, enable **Usage & Speed Monitor** (`usage-monitor`) in `/plugin` or **Customizations > Installed**.

### Upgrading from v1.x

- **Automatic CLI `statusLine` migration:** On MCP server startup, existing plugin-managed v1.x `statusLine` entries in `~/.gemini/antigravity-cli/settings.json` are transparently updated to point to `cli/statusline.mjs` without touching third-party `statusLine` commands.
- **Settings & cache preservation:** Existing plugin data directories are preserved (falling back to `${PLUGIN_DATA}` on fresh installations). A one-time `settingsSchemaVersion: 2` migration inserts `session_health` into existing `overviewModules` and silently drops removed v1 settings keys.
- **Offline fallback:** When the Antigravity Language Server is offline, the backend reads local SQLite + WAL databases, `annotations/*.pbtxt`, `transcript.jsonl`, and `.deep_stats_cache.json` under `~/.gemini/antigravity-cli`.

## Security & Offline Guarantees

- **Zero external network requests:** Operates strictly against local files and loopback Antigravity Language Server IPC; no remote pricing sync, telemetry upload, or auto-updater.
- **Zero runtime npm dependencies:** Runs on Node.js `22.18+` built-ins (`node:sqlite`, `node:http`, `node:https`) and native Web Components; Vite and `@modelcontextprotocol/ext-apps` are build-time `devDependencies` only.
- **Zero host tampering:** No `app.asar` modifications, no CDP/DevTools injection, and no OAuth or account-switching logic.
- **CSP-safe self-contained HTML:** Both MCP App resources (`mcp/dist/dashboard.html` and `mcp/dist/health-card.html`) are bundled as standalone `< 10 MiB` HTML files with zero external scripts, stylesheets, or remote assets.

## Development

Symlink the plugin directory into Antigravity's plugin folder for local iteration:

```bash
git clone https://github.com/anderson-spider/spider-antigravity-mods.git
ln -s "$(pwd)/spider-antigravity-mods/plugins/usage-monitor" ~/.gemini/config/plugins/usage-monitor
```

Source layout: `backend/`, `shared/`, `ui/dashboard/`, `ui/health-card/`, `cli/`, `mcp/`, and `tests/`.

Rebuild `mcp/dist/dashboard.html` and `mcp/dist/health-card.html` after editing UI or MCP files, then run tests, syntax checks, and strict manifest validation:

```bash
pnpm --filter usage-monitor build
pnpm --filter usage-monitor test
pnpm --filter usage-monitor typecheck
agy plugin validate --strict plugins/usage-monitor
```

## License

Licensed under the [GNU General Public License v3.0](./LICENSE).

Prompt cache-miss attribution and active-time heuristics in `backend/session-health.mjs` are adapted from [`INK-Q/agy-fast`](https://github.com/INK-Q/agy-fast) (`src/benchmark-core.ts`), licensed under the MIT License.
