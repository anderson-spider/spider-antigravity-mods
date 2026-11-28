---
name: batch-tools
description: Run parallel multi-query code searches, batch structural symbol outlines and line slices, and atomic multi-file edits via the `batch-tools` MCP server. Use when searching multiple patterns at once, outlining several files before targeted reads, or applying coordinated edits across 2+ files.
---

# Batch Tools

Use the `batch-tools` MCP server to cut round-trips on multi-query exploration and coordinated multi-file edits while respecting workspace confinement and inline output budgets (`<= 8,800` UTF-8 bytes).

## When to use `batch-tools` vs. built-in tools

| Task | Preferred tool |
| :--- | :--- |
| 2+ search patterns, globs, or fuzzy path lookups | `batch_search` (up to 20 queries in one call) |
| Structural overview of multiple source files before reading | `quick_outline` (flat `paths` array, up to 40 files) |
| Small targeted line windows (`<= 120` lines) across multiple files, or outlines + slices together | `read_slices` (`outlines`, `slices`, or `lineRanges`) |
| Large known line ranges (`> 150` lines total) | Built-in `read_file` with `StartLine`/`EndLine` |
| Coordinated refactor across 2+ files (all-or-nothing) | `apply_edits` (supports `dryRun: true` diff preview) |
| Single-file edit or full-file write where native diff/checkpoint UI helps | Built-in `edit_file` / `write_file` |
| Shell commands, tests, builds, linters, or `git` operations | Built-in `run_command` |

## Usage tips

- **Start broad, then narrow:** Use `batch_search` with `outputMode: "files_with_matches"` or `"count"` when scanning large trees, then use `quick_outline` and `read_slices` (or parallel `read_file`) to inspect only the relevant ranges.
- **Preview risky refactors:** Pass `dryRun: true` to `apply_edits` to verify exact targets and inspect unified diffs before writing.
- **Workspace boundaries:** All paths must stay inside the active workspace root(s). On hosts that do not advertise MCP `roots/list` (such as Antigravity Desktop Hub), pass the active project's absolute workspace path in `cwd`; the server validates it as a project workspace and confines all operations strictly inside it. Secret files (`.env`, `.env.*` other than `.env.example`/`.env.sample`/`.env.template`, `secrets/`, private keys, `.netrc`/`.npmrc`/`.pypirc`), symlinks on write, and `.git/` writes are blocked by server policy.
- **No built-in verification shell:** `apply_edits` intentionally does not run shell commands. After applying edits, run tests or typechecks via `run_command`.
