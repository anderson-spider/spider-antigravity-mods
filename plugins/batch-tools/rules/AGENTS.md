# Batch Tools Routing

When `batch-tools` MCP tools (`batch_search`, `quick_outline`, `read_slices`, `apply_edits`) are available, prefer them over serial native calls when batching saves round-trips:

- **2+ searches (`text`, `regex`, `glob`, or `fuzzy`)**: pack all queries into one `batch_search` call (use `outputMode: "files_with_matches"` or `"count"` for broad scans).
- **Unknown large files (`> 300` lines) or multi-file structure**: call `quick_outline` (up to 40 files) first, then use `read_slices` for short targeted windows (`<= 150` lines total) or parallel built-in `read_file` with `StartLine`/`EndLine` for larger ranges.
- **Coordinated edits across 2+ files (or 2+ non-adjacent hunks)**: use `apply_edits` for atomic all-or-nothing updates (pass `dryRun: true` to preview risky diffs). Keep single-file edits on `edit_file` when native diff UI helps.
- **Shell, tests, builds, and `git`**: always use built-in `run_command` (`batch-tools` intentionally never runs shell commands).
- **Explicit `cwd`**: pass the active workspace root's absolute path in `cwd` on hosts that do not advertise MCP `roots/list` (such as Desktop Hub).
