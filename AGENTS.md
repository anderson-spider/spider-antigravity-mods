# AGENTS.md

Monorepo of Google Antigravity plugins; one plugin per `plugins/<name>/`.

## Commands

- Setup: Node from `.nvmrc` (Node 22.18+ required for native TypeScript execution), `pnpm install`.
- Root checks: `pnpm check` (`test` + `typecheck`); single plugin: `pnpm --filter <name> test` / `pnpm --filter <name> typecheck`.
- Manifest validation (when `agy` CLI is installed): `agy plugin validate --strict plugins/<name>`.
- Single Node test: `node --test --test-name-pattern=<regex> <file>` from the plugin folder.

## Code rules

- Plugins should have zero runtime npm dependencies whenever possible (Node built-ins + native TypeScript type-stripping).
- Use `${PLUGIN_ROOT}` and portable commands (`node`) in `mcp_config.json`; never hardcode user home paths or machine-specific binary paths.
- Keep `SKILL.md` generic and language-neutral so any user can install the plugin without inheriting personal workflow rules.
- Credentials: never commit secrets, internal host names, or work data. Scrub credential environment variables before spawning child processes (`git`, `ssh`, etc.) and mask secrets in tool outputs.
- Placeholders only (`gitlab.example.com`, `group/project`, `glpat-...`) in code, tests, and documentation.

## Done for a plugin change

1. `pnpm test`, `pnpm typecheck`, and `agy plugin validate --strict plugins/<name>` pass.
2. Any shipped change raises `version` in `plugins/<name>/plugin.json` (semver) and adds a `plugins/<name>/CHANGELOG.md` entry.
3. The root `README.md` and the plugin's `README.md` match the current behavior.

## Conventions

- English for code, comments, docs, commits, and PR titles; Conventional Commits for commits and PR titles.
