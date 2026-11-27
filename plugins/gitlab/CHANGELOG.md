# Changelog

## 0.5.2 - 2026-11-27

- Fix collapsed/clipped diff cards in the **Code** tab caused by flex shrinking on `overflow: hidden` cards inside `.diff-scroll`: switch file cards to `flex-shrink: 0` with `overflow: clip`, add sticky file headers, defer off-screen file cards (`content-visibility: auto`), and pin inline review threads inside the visible horizontal viewport when long lines scroll.
- Replace the flat Changed Files list with a path-compressed collapsible directory tree (`buildDiffFileTree`), quick file filter, per-file comment indicators, both `+add` / `-del` stats, split muted directory + bold filename headers, soft line-wrap toggle, Collapse/Expand all controls, and full line-comment support on both sides of Split diffs.
- Streamline detail-pane vertical chrome by consolidating the header, branch flow (`source → target` with click-to-copy), Worktree popover chip (removing the duplicate `Sync` button and permanent path banner), secondary MR action overflow menu (`Draft`, `Rebase`), and unified underline sub-tabs + pipeline jump + Agent Handoff bar.
- Redesign the MR sidebar with a symmetrical 2×2 filter grid, `/` search shortcut, Reset filters button, smart redundant project-name hiding when viewing a single repository, cleaner 2-to-3 line MR row hierarchy with left accent selection bar, and container-query responsive stacking on narrow panes.
- Migrate Merge confirmation and Save View modals to native `<dialog>` elements (`showModal()`, `closedby="any"` with pointer fallback, `::backdrop` scroll containment), standardize thin scrollbars (`scrollbar-color` / `scrollbar-width` with WebKit fallback), auto-load error logs for initially expanded failed CI jobs with a Copy log action, and support `Cmd/Ctrl+Enter` comment submission.

## 0.5.1 - 2026-11-26

- Fix missing Agent Handoff action buttons (`Review MR`, `Fix failing pipeline`, `Address N threads`) in hosts that advertise `updateModelContext` without `message`: render the buttons whenever `message` or `updateModelContext` is available, probe `ui/message` once with a 5s timeout (caching supported/rejected state), and fall back gracefully to attaching the prompt to chat context and/or copying it to the clipboard.
- Add an in-flight `handoffBusy` guard to prevent duplicate handoffs on rapid clicks, and verify clipboard writes asynchronously before reporting copy success in toasts.
- Normalize pipeline status to lowercase across REST list and detail payloads (`server/dashboard.ts`) and match failed pipeline states case-insensitively in the UI (`App.tsx`).

## 0.5.0 - 2026-11-25

- Add multi-root MCP `roots/list` discovery (`foldersOf` and `CallContext.cwds`) so every workspace root is automatically detected alongside persistent registered local repositories (`Repos` popover, backed by `dashboard-state.json`).
- Add multi-repo batched MR listing in **All projects** scope (`scope: 'projects'`, 3 projects per GraphQL query with max concurrency 4, CE-safe fallback, and per-project REST isolation), plus `My MRs (all hosts)` (`scope: 'mine'`), `Waiting on me` and `Others` involvement filters, `you` review pill, and graceful fallback banner when no repositories are tracked yet.
- Add isolated git worktree checkout (`Checkout` / `Sync`) and safe removal (`Remove` with strict path containment inside the managed worktree root and 2-click force confirmation for uncommitted or unpushed changes), including fork MR support via GitLab's `merge-requests/<iid>/head` ref.
- Route Agent Handoff actions (`Review MR`, `Fix failing pipeline`, `Address N threads`) to new Antigravity conversations (`_meta['com.google.antigravity/message'].target = 'new'`) with branch and local worktree context, and add descriptive tooltips across header and Agent bar actions.

## 0.4.0 - 2026-11-25

- Add an interactive **GitLab MR Dashboard** MCP App (`ui://gitlab/mr-dashboard.html`) served directly by the `gitlab_gitlab` MCP server with **Global** (full-page sidebar) and **Aux Pane** (side pane beside chat) entrypoints.
- Enrich MR lists via GitLab GraphQL (`/api/graphql`) in a single request per host (pipeline status, approvals, real label hex colors, `+add / -del` stats) with automatic fallback to REST v4 for older/restricted instances.
- Support context-smart scoping (current repository in `aux_pane` with one-click toggle to all projects; multi-host/cross-project inbox grouped by Reviewing / Authored in Global view), qualifier search (`label:`, `author:`, `draft:`, `checks:`), `Merge readiness` sorting, Saved Views, and visibility-aware 60s auto-refresh.
- Add resizable master-detail split layout with multi-MR tabs (and responsive List ↔ Detail navigation in narrow panes), three detail tabs (**Summary** with Markdown, blockers, approvals, pipeline jobs, and inline job logs; **Discussions** with unresolved filter, replies, resolve/unresolve, and private draft notes; **Code** with Unified/Split diff toggle, file index, syntax highlighting, inline line comments, and per-SHA `Viewed` marks), guarded Merge confirmation modal, and capability-gated Agent Handoff actions in `aux_pane`.
- Persist UI preferences, Saved Views, and `filesViewed` state (never credentials) in `${PLUGIN_DATA}` via `--data-dir=${PLUGIN_DATA}` in `mcp_config.json`.
- Keep the MCP server runtime 100% zero npm dependencies; bundle the React MCP App into a committed single-file `ui/dist/app.html` using dev-only build dependencies.

## 0.3.1 - 2026-11-25

- Consolidate GitLab remote, token, and API error resolution into `server/run.ts` with a single-pass token parser, unified host validation, and single `git` remote lookup on fallback.

## 0.3.0 - 2026-11-23

- Remove `GITLAB_MCP_DEFAULT_HOST` and `options.defaultHost`. Outside a GitLab repository without `host`, the server still auto-targets the sole configured host when only one host exists in `GITLAB_MCP_TOKENS`; when multiple hosts are configured, it refuses and lists the configured hosts so `host` can be passed explicitly.

## 0.2.0 - 2026-11-23

- Declare `GITLAB_MCP_TOKENS` in `mcp_config.json` `variables` so Antigravity prompts for credentials natively in `/plugin` and **Customizations > Installed** instead of requiring manual shell/`launchctl` exports.
- Update root and plugin installation documentation to use `agy plugin install` as the primary installation and update path, moving `git clone` + symlink to development instructions.
- Update the missing-token error message to reference Antigravity plugin settings alongside environment variables, treat an unexpanded `${...}` placeholder as unset, and align MCP `SERVER_VERSION` with `plugin.json` (`0.2.0`).

## 0.1.0 - 2026-11-23

- Initial standalone Antigravity release of the GitLab plugin (`gitlab_gitlab` MCP server and `gitlab` skill).
- Portable `mcp_config.json` using `node` and `${PLUGIN_ROOT}/server/main.ts`.
- Simplified credential configuration via `GITLAB_MCP_TOKENS` (`host=token` pairs) and optional `GITLAB_MCP_DEFAULT_HOST`.
- Automatic single-host fallback outside GitLab repositories, and clear error listing configured hosts when multiple hosts exist without a default.
- Cross-platform `file://` root handling (`fileURLToPath`) and neutral, language-agnostic `SKILL.md`.
