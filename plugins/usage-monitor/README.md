# Usage & Speed Monitor

Offline telemetry sidecar and CLI status bar for Google Antigravity Desktop and `agy`.

## Overview

Usage & Speed Monitor tracks token throughput, latency, context allocation, and quota consumption locally on your machine without external network calls or host binary patches.

### Key Capabilities

- **Quota Pace & Burn-Rate Tracking:** Computes expected cycle progress for 5-hour and weekly quota windows, overlays a vertical expected-pace marker on each quota bar, and shows directional delta badges (`▼ -9% · exp 52%`, `▲ +14% · exp 38%`, `● On pace`) with burn-rate tooltips. Can be toggled under **Settings > Structure > Overview**.
- **Live Telemetry Cards:** Tracks output speed (`tok/s`), time-to-first-token (`TTFT`), session average throughput, step/session USD estimates, cache hit rate, tightest quota pool, and total session tokens.
- **10-Category Context Inspector:** Breaks down the active prompt window across assistant replies, tool results, user input, subagent notifications, checkpoints, system prompt, system tools, MCP tools, skills, and user rules, with main/subagent switching.
- **Multi-Pool Quotas:** Monitors 5-hour and weekly quotas, reset countdowns, and per-cycle token/cost totals across `Gemini`, `Gemini 4 Argon`, `Gemini 4 Carbon`, and `Claude & GPT` pools.
- **Call & Trend Breakdown:** Inspects **By Step** and **By Model** records with configurable columns, custom token combo formats, turn rails, and aggregated usage views (`Today`, `1d`, `7d`, `14d`, `30d`, `All`, or custom date ranges).
- **Local Client Modes:**
  - **Antigravity Desktop:** Auxiliary sidebar pane (`sidecars/panel/sidecar.json`).
  - **Antigravity CLI (`agy`):** Single-line ANSI `statusLine` integration (toggle with `/statusline` or under **Settings > Structure**).
  - **Standalone Local Web UI:** Optional HTTP server (`sidecars/panel/standalone.mjs`) bound to `127.0.0.1:8787` by default.
- **Bilingual Support (`en-US` / `pt-BR`):** Supports English and Brazilian Portuguese across the panel UI and CLI `statusLine`, with automatic system-locale detection (`Follow System`, defaulting to `en-US`).

## Installation

Install directly from this repository using the Antigravity CLI:

```bash
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/usage-monitor
```

Re-run the same command to update in place, or run `agy plugin uninstall usage-monitor` to remove the plugin.

After installation, enable **Usage & Speed Monitor** (`usage-monitor`) in `/plugin` or **Customizations > Installed**.

## Standalone Web Mode

To run the panel outside the Desktop sidebar:

```bash
node ~/.gemini/config/plugins/usage-monitor/sidecars/panel/standalone.mjs --port 8787
```

Available flags include `--host`, `--port`, `--token`, `--data-dir`, `--app-data-dir`, `--gemini-dir`, `--ls-addr`, and `--csrf-token`. Binding to a non-loopback address is rejected unless `--token` (or `USAGE_MONITOR_STANDALONE_TOKEN`) is supplied.

When the Antigravity Language Server is offline, the backend reads local SQLite + WAL databases, `annotations/*.pbtxt`, `transcript.jsonl`, and `.deep_stats_cache.json` under `~/.gemini/antigravity-cli`. Plugin settings and caches are persisted under `~/.gemini/antigravity/sidecar_data/usage-monitor/` (or `sidecars/panel/.data/` in standalone mode without `--data-dir`).

## Security & Offline Guarantees

- **Strictly local:** Zero external network requests, no remote pricing sync, and no background auto-updater.
- **Zero host tampering:** No `app.asar` modifications, no CDP/DevTools injection, and no OAuth or account switching code.
- **Loopback-safe:** Standalone mode binds to `127.0.0.1` by default and enforces token authentication on non-loopback interfaces.
- **Zero runtime dependencies:** Uses Node.js `22.18+` built-ins (`node:sqlite`, `node:http`) and native Web Components.

## Development

Symlink the plugin directory into Antigravity's plugin folder for local iteration:

```bash
git clone https://github.com/anderson-spider/spider-antigravity-mods.git
ln -s "$(pwd)/spider-antigravity-mods/plugins/usage-monitor" ~/.gemini/config/plugins/usage-monitor
```

Rebuild `app.js` and `styles.css` after editing files under `sidecars/panel/src/`, then run tests, syntax checks, and manifest validation:

```bash
pnpm --filter usage-monitor build
pnpm --filter usage-monitor test
pnpm --filter usage-monitor typecheck
agy plugin validate --strict plugins/usage-monitor
```

## License

Licensed under the [GNU General Public License v3.0](./LICENSE).
