# Changelog

## 1.0.0 - 2026-11-24

- Initial integration of `usage-monitor` into `spider-antigravity-mods` (`plugins/usage-monitor/`).
- Replace plugin icon with an original dark-slate telemetry gauge and pace-marker SVG (`assets/logo.svg`).
- Add **Quota Pace & Expected Usage** tracking (`computeQuotaPace`, `formatQuotaPaceSummary`, expected-pace bar tick marker, directional status pills, burn-rate tooltips, and `showQuotaPace` setting under **Settings > Structure > Overview**).
- Operate strictly offline with zero external network sync, no auto-updater, no OAuth/account switcher, and no CDP window injection.
- Add monorepo workspace scripts (`build`, `test`, `typecheck`, `standalone`) and deterministic locale-independent unit/widget tests.
