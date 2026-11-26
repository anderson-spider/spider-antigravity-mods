# Changelog

## 2.0.0 - 2026-11-25

### Breaking Changes

- Migrated to a pure MCP App architecture serving three native surfaces (`global` left sidebar, `aux_pane` right side pane, and an inline chat Session Health card) alongside the Antigravity CLI `statusLine`.
- Removed the legacy Sidecar runtime (`sidecars/panel/sidecar.json`) and standalone local HTTP server.
- Removed vestigial CDP/overlay settings and UI (`Per-Model Context Windows` and `/api/context-window`, `Plugin Update Mode`, `hover` tab, and `windowMountMode`); legacy v1 settings keys are silently ignored on load.
- Reorganized plugin source into top-level `backend/`, `shared/`, `ui/`, `cli/`, `mcp/`, and `tests/` directories and replaced the custom `build-bundle.mjs` script with Vite (`mcp/build-mcp-app.mjs`) building self-contained, CSP-safe HTML bundles (`mcp/dist/dashboard.html` and `mcp/dist/health-card.html`).

### Added

- **Session Health Diagnostics (`backend/session-health.mjs`):** Added pure offline diagnostics covering Prompt Cache Miss Attribution (`plan_mode_switch`, `model_switch`, `error_retry`, `idle_or_wait_gap`, `active_slow_gap`, `async_wakeup_fast`, `prefix_or_replica_miss`, plus `compaction` and `context_dilution` tracking), sustained cache collapse detection (consecutive miss streaks ≥ 3), active LLM vs. tool execution timing with Effective TPS, active >60s inter-step gap tracking, and context hygiene (≥150k prompt pressure, high-context multimodal turns at ≥150k / ≥180k, and tool-batching ratio).
- **Dashboard & Inline Health Surfaces:** Added `SessionHealthWidget` in the Overview tab, per-step cache-miss cause badges and >60s active gap tooltips in **By Step**, the inline chat MCP App card (`usage_monitor_session_health` with live Refresh and capability-gated `updateModelContext` diagnosis attachment), and a minimal CLI `statusLine` collapse alert (`⚠ cache ×N` when active streak ≥ 3).
- **Settings Migration & MCP HostContext:** Added `settingsSchemaVersion: 2` one-time migration inserting `session_health` into existing `overviewModules` (preserving subsequent user removals), transparent startup auto-migration of legacy CLI `statusLine` paths to `cli/statusline.mjs`, and full `@modelcontextprotocol/ext-apps` `HostContext` support (theme, host style variables, fonts, locale sync, and agent-driven `{ conversationId?, tab? }` navigation).

### Attribution

- Prompt cache-miss attribution and active-time heuristics adapted from [`INK-Q/agy-fast`](https://github.com/INK-Q/agy-fast) (`src/benchmark-core.ts`, MIT License).

## 1.2.1 - 2026-11-25

- Discover persistent/SSH Language Server daemon files (`ls_*.json`) in addition to desktop `hub_*.json` files in `ls-discovery.mjs`, fixing unavailable 5-hour and weekly quota limits in the left-sidebar MCP App on remote SSH hosts.
- Route loopback HTTPS probes and local `callLsRpc` calls through `postLoopbackHttpsJson` (`rejectUnauthorized: false` restricted to strict loopback addresses) so HTTPS-only Language Servers connect reliably.
- Fix a Mandarin title leak (`每周限额 (Gemini)`) in `QuotaPoolsWidget` when official quotas are unavailable or in custom local weekly mode by using localized `quota.weeklyPool` / `quota.weeklyCustomLocal` labels.
- Fix `usage_monitor_dashboard` plain-text summary pool naming (`poolLabel`/`poolKey`) and include weekly quota percentages.

## 1.2.0 - 2026-11-25

- Add a full-page **Left Sidebar** view (`Plugins > Usage Monitor`) via a zero-runtime-dependency MCP App (`mcp_config.json`, `mcp/server.mjs`, `mcp/main.mjs`, and self-contained `ui://usage-monitor/dashboard.html`) declaring the `com.google.antigravity/ui` `global` entrypoint.
- Keep the existing Auxiliary Side Pane Sidecar (`sidecars/panel/sidecar.json`) intact for automatic active-conversation tracking (`window.sidecar.conversationId`) and CLI `statusLine` sync, sharing the same backend dispatcher and `settings.json` / trajectory cache directory with zero duplicate entries in the right-hand side pane.
- Bridge Antigravity MCP App host theme tokens (`--color-background-*`, `--color-text-*`, `--color-border-*`, live light/dark switching), add full-page centered layout rules for `data-mcp-app="true"`, and guard `window.location.reload()` inside isolated MCP App iframes.

## 1.1.1 - 2026-11-25

- Prune vestigial cloud-sync, auto-updater, and CDP host-injection seams (`context-windows.mjs`, `pricing-catalog.mjs`, `telemetryStore.js`, and settings/header UI).
- Consolidate settings defaults, normalization, and legacy-field patch merging into `shared/settings-normalization.mjs`, removing `backend/settings-schema.mjs`, 41 `config.mjs` re-exports, and 26 `CLIENT_*` aliases.
- Unify local and remote trajectory cache hydration, 30s throttled persistence, exit flush, and quota cache primitives into `backend/trajectory-store.mjs`.
- Replace scattered `'test.invalid'` checks with an explicit `backend/runtime-env.mjs` seam and extract the sidecar Worker supervisor into `backend/sidecar-host.mjs` with dedicated unit tests.
- Unify standalone CLI argument parsing (`backend/standalone-cli-args.mjs`), static panel asset serving (`backend/http-helpers.mjs`), and host runtime boot wiring.

## 1.1.0 - 2026-11-24

- Remove Mandarin (`zh-CN`) language support and replace it with Brazilian Portuguese (`pt-BR`) alongside English (`en-US`), with `auto` defaulting to `en-US` and detecting `pt*` host locales.
- Localize the CLI `statusLine`, `TrendAreaChart` tooltips, `CustomDateTimePicker`, `ConsumptionView` range badge, `metricRegistry`, `CustomSelect`, `SegmentedControl`, `TopLongPillNav`, `CustomNumberInput`, `index.html`, and standalone token login page across `en-US` / `pt-BR`.
- Remove CNY (`≈ ¥`) secondary cost conversion from `ConsumptionView`.

## 1.0.0 - 2026-11-24

- Initial integration of `usage-monitor` into `spider-antigravity-mods` (`plugins/usage-monitor/`).
- Replace plugin icon with an original dark-slate telemetry gauge and pace-marker SVG (`assets/logo.svg`).
- Add **Quota Pace & Expected Usage** tracking (`computeQuotaPace`, `formatQuotaPaceSummary`, expected-pace bar tick marker, directional status pills, burn-rate tooltips, and `showQuotaPace` setting under **Settings > Structure > Overview**).
- Operate strictly offline with zero external network sync, no auto-updater, no OAuth/account switcher, and no CDP window injection.
- Add monorepo workspace scripts (`build`, `test`, `typecheck`, `standalone`) and deterministic locale-independent unit/widget tests.
