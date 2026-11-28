# Batch Tools

Hardened, zero-dependency MCP plugin for Google Antigravity providing parallel multi-query code search (`ripgrep` with pure-Node fallback), multi-file symbol outlines and line slices, and atomic multi-file edits with strict workspace confinement.

## Tools

The `batch-tools` MCP server exposes four eager tools (paired with a lean `rules/AGENTS.md` routing rule and `skills/batch-tools/SKILL.md`) with water-filling inline output budgeting (`<= 8,800` UTF-8 bytes by default so responses stay inline):

- **`batch_search`**: Run up to 20 parallel `text`, `regex`, `glob`, or `fuzzy` queries in one tool call using `rg` (`shell: false`, `--no-config`, `--no-follow`, `--max-filesize 2M`) with deterministic pure-Node fallback when `rg` is unavailable.
- **`quick_outline`**: Extract structural symbol line-range outlines for up to 40 files in one call across TypeScript/JavaScript, Python, Go, Rust, C/C++/Java/Kotlin/C#, HTML/Vue/Svelte, CSS, Markdown, JSON, and YAML.
- **`read_slices`**: Combine batch symbol outlines and targeted line-range slices (`slices` or `lineRanges` shorthand) with a per-call file cache.
- **`apply_edits`**: All-or-nothing multi-file exact-target hunk replacement and file creation/overwrite with `dryRun` unified diff preview, BOM/mixed-EOL/mode preservation, pre-commit `mtime`/size freshness checks, atomic `wx` temp-file + `rename` writes, and automatic rollback on failure. Contains zero shell execution (`verify` is intentionally omitted).

## Security Model

Every read, search, outline, and write operation passes through a single server-side security policy (`server/policy.ts`):

- **Fail-closed workspace root jail:** Resolves allowed roots from (1) MCP `roots/list` (refreshed on `notifications/roots/list_changed`), (2) optional `BATCH_TOOLS_WORKSPACE_ROOTS`, (3) `process.cwd()` only when it is not the filesystem root, `$HOME`, or inside the plugin directory, or (4) when tiers 1–3 are unavailable (for example, hosts like Antigravity Desktop Hub that spawn global plugins in the plugin directory without `roots/list`), a strictly validated explicit absolute `cwd` that must exist inside a recognized project workspace (`.git` or project manifest) and is never `/`, `$HOME`, system/credential/config directories, or a plugin directory. Omitted or relative `cwd` still fails closed.
- **Traversal & symlink protection:** Rejects `~` expansion and `..` escapes using `realpath` and nearest-ancestor canonicalization (case-insensitive on macOS/Windows). Search passes `--no-follow` to `rg`, Node directory walks skip symlinks, and `apply_edits` rejects writing through symlinks.
- **Portable secret-file denylist:** Blocks reads, searches, outlines, and writes on `.env`, `.env.*` (allowing `.env.example`, `.env.sample`, and `.env.template`), `secrets/` and `.secrets/` directories, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `id_rsa`, `id_ed25519`, `.netrc`, `.npmrc`, and `.pypirc`, plus any user-defined globs in `BATCH_TOOLS_EXTRA_DENY_GLOBS`.
- **`.git` write protection:** Blocks writes targeting any `.git` path segment on both logical and canonical paths.
- **Zero shell & zero network:** Never spawns a shell (`shell: false` everywhere), never runs `verify` or arbitrary commands, makes zero network calls, and scrubs credential environment variables (`*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `AWS_*`, `GITLAB_*`, `GITHUB_*`, `GH_TOKEN`, `NPM_*`, `ANTIGRAVITY_CSRF_TOKEN`, `RIPGREP_CONFIG_PATH`) before spawning `rg`.
- **In-memory audit ring buffer:** Retains up to 50 recent operations and blocked-path events in memory only (never written to disk), redacting credential patterns from errors and diff previews.

## Optional Environment Overrides

`batch-tools` installs enabled and ready to use with zero configuration on hosts that support MCP `roots/list`. Optional environment variables can be configured if needed:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `BATCH_TOOLS_WORKSPACE_ROOTS` | _(unset)_ | Delimiter-separated (`:` on macOS/Linux, `;` on Windows) fallback workspace root directories for hosts that do not advertise MCP `roots/list`. |
| `BATCH_TOOLS_EXTRA_DENY_GLOBS` | _(unset)_ | Comma-separated extra glob patterns blocked from reads, searches, outlines, and writes (for example `**/private/**,*.credentials`). |
| `BATCH_TOOLS_ALLOW_EDITS` | `true` | Set to `false` to disable `apply_edits` while keeping all read/search tools active. |

## Installation

Install directly from this repository using the Antigravity CLI:

```bash
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/batch-tools
```

Re-run the same command to update in place, or run `agy plugin uninstall batch-tools` to remove it.

## Prerequisites

- Node.js **22.18+** (native TypeScript execution, zero runtime npm dependencies)
- Optional: [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) on `PATH` for fastest searches (automatically falls back to pure Node.js if unavailable)

## Development

```bash
pnpm --filter batch-tools test
pnpm --filter batch-tools typecheck
agy plugin validate --strict plugins/batch-tools
```

## License

[MIT](../../LICENSE).
