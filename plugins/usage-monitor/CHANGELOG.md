# Changelog

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
