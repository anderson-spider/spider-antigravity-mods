# Changelog

## 0.1.1 - 2026-11-27

- Fix zero-config compatibility on hosts that do not respond to MCP `roots/list` (such as Antigravity Desktop Hub) by adding a strictly validated Tier 4 per-call project-root jail for explicit absolute `cwd` arguments (requiring a recognized project marker such as `.git` or a standard project manifest, rejecting `/`, `$HOME`, system/credential/config directories, and plugin directories, while keeping `~/.gemini/antigravity/worktrees/*` project checkouts allowed and preserving fail-closed behavior for omitted/relative `cwd` and higher-priority tiers).
- Deduplicate concurrent in-flight `roots/list` requests in `server/mcp.ts`, lower default `rootsTimeoutMs` to 1s, and settle timeout/error responses until `notifications/roots/list_changed` so subsequent tool calls do not re-stall.
- Document explicit absolute `cwd` usage in tool schemas, `SKILL.md`, and `README.md`.

## 0.1.0 - 2026-11-27

- Initial standalone Antigravity release of `batch-tools` (`batch-tools` MCP server and `batch-tools` routing skill) with zero runtime dependencies on Node.js 22.18+ native TypeScript.
- Add hardened server-side security core (`server/policy.ts`, `server/redact.ts`, `server/audit.ts`, `server/fs.ts`): fail-closed 3-tier workspace root jail (`roots/list` → `BATCH_TOOLS_WORKSPACE_ROOTS` → safe `process.cwd()`), symlink escape defense, portable secret-file denylist (`.env`, `.env.*` except `.env.example`/`.env.sample`/`.env.template`, `secrets/`, key material, `.netrc`/`.npmrc`/`.pypirc`, plus `BATCH_TOOLS_EXTRA_DENY_GLOBS`), `.git` write protection, child-process env scrubbing, scoped secret redaction, and bounded in-memory audit ring buffer.
- Add `batch_search` (`rg` with deterministic 2-pass search + pure-Node fallback), `quick_outline`, `read_slices`, and hardened all-or-nothing `apply_edits` (with `dryRun` unified diff preview, `mtime`/size freshness check, `wx` temp+rename writes, rollback, and `BATCH_TOOLS_ALLOW_EDITS=false` kill-switch).
- Add UTF-8 water-filling byte budgeter (`<= 8,800` UTF-8 bytes default) and zero-dep MCP stdio server (`server/mcp.ts`) with `roots/list` and optional `resources/*` + `structuredContent` seams.
