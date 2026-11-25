# Changelog

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
