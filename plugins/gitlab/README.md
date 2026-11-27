# GitLab Plugin for Antigravity

Work on GitLab merge requests, comments, draft notes, pipelines, jobs, and labels across both `gitlab.com` and self-hosted GitLab instances. The MCP server reads the repository's git remote so each GitLab host automatically receives only its own token.

## Features

- **Zero runtime dependencies:** native Node.js TypeScript MCP server (`server/main.ts`, Node 22.18+) serving a prebuilt self-contained MCP App HTML bundle (`ui/dist/app.html`).
- **Interactive MR Dashboard (MCP App):** open **GitLab MRs** full-page from Antigravity's left sidebar (`global`) or beside a conversation (`aux_pane`) with resizable master-detail split, multi-MR tabs, multi-repo batched GraphQL listing (with automatic CE/REST fallback), persistent local repository registration (**Repos** popover + multi-root MCP workspace auto-discovery), isolated git worktree checkout & safe removal via an integrated worktree popover (including fork MRs), qualifier search (`label:`, `author:`, `draft:`, `checks:`) with `/` shortcut, `Waiting on me` / `Reviewing` / `Authored` / `Others` involvement filters, `Merge readiness` sort, Saved Views, inline CI job logs (auto-loaded for failed jobs with copy), discussions & private draft notes, Unified/Split diff viewer with path-compressed collapsible file tree, sticky file headers, soft-wrap toggle, inline comments & `Viewed` marks, guarded Merge confirmation `<dialog>`, and Agent Handoff actions in `aux_pane` (starting a new conversation when `ui/message` is supported, or falling back gracefully to attaching the prompt to chat context and copying it to the clipboard when the host omits `ui/message`).
- **Persistent UI state:** preferences, registered local repositories, Saved Views, and per-SHA `filesViewed` marks are stored locally in `${PLUGIN_DATA}` (never credentials or MR contents). Managed review worktrees are stored under `${PLUGIN_DATA}/worktrees`.
- **Multi-host isolation:** map multiple GitLab hosts to separate tokens (`host=token` pairs); each token is sent only to its paired host.
- **Smart host resolution:**
  - Inside a GitLab clone (or with an explicit `cwd`), detects host, project, and current branch from git (including `~/.ssh/config` aliases via `ssh -G`).
  - Outside a GitLab repo with a URL or explicit `host`, targets that host directly.
  - Outside a GitLab repo without `host`, automatically targets the sole configured host when only one host is present in `GITLAB_MCP_TOKENS`. If multiple hosts are configured, refuses and lists the configured host names so `host` can be passed explicitly.
- **Safe by default:** guarded `merge`, draft notes for reviews, and explicit opt-in (`allowOthers: true`) for writes on other people's MRs.

## Setup

### 1. Install the plugin

Install directly with the Antigravity CLI:

```bash
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/gitlab
```

Re-run the same command to update an existing installation in place, or run `agy plugin uninstall gitlab` to remove it.

### 2. Enable and configure credentials

Because `mcp_config.json` declares `GITLAB_MCP_TOKENS` as a plugin variable, Antigravity installs `gitlab` disabled until you enter your token(s):

1. Open `/plugin` in the CLI or **Customizations > Installed** in Antigravity Desktop.
2. Enable **GitLab** and fill in `GITLAB_MCP_TOKENS` with comma- or whitespace-separated `host=token` pairs:

```text
gitlab.com=glpat-...,gitlab.example.com=glpat-...
```

Tokens need `api` scope (`read_api` for read-only use). When only one host is configured, it is automatically used outside GitLab repositories; when multiple hosts are configured, pass `host` (or a GitLab URL) outside a GitLab clone.

## Tools (`gitlab_gitlab` MCP server)

- `gitlab_mr`: `list`, `get`, `status`, `diff`, `commits`, `create`, `update`, `approve`, `unapprove`, `rebase`, `merge`
- `gitlab_mr_comment`: `list`, `unresolved`, `drafts`, `comment`, `reply`, `line`, `edit`, `resolve`, `unresolve`, `publish`
- `gitlab_pipeline`: `list`, `jobs`, `wait`, `run`, `retry`, `cancel`, `play`, `artifacts`
- `gitlab_job_log`: `errors` (default), `tail`, `full`
- `gitlab_label`: `list`, `create`
- `gitlab_user`: current token owner (`@me`) or lookup by `username`
- `gitlab_mr_dashboard`: opens the interactive **GitLab MRs** MCP App (`global` sidebar and `aux_pane` side pane)

App-only UI tools (`gitlab_ui_list`, `gitlab_ui_detail`, `gitlab_ui_diff`, `gitlab_ui_job_log`, `gitlab_ui_action`, `gitlab_ui_state`) are marked `visibility: ["app"]` so only the dashboard iframe can invoke them.

Every tool accepts an optional `cwd` (absolute repository path) to override or supplement MCP workspace roots when detecting the git remote and current branch.

## Security Invariants

- No generic API tool and no delete actions (aside from `merge`'s `removeSourceBranch`).
- One token per host, sent only to its own host in `PRIVATE-TOKEN`, stripped on cross-origin redirects (and never re-attached on redirect bounce-back), and masked as `[token]` in every response.
- Credentials are captured at startup and scrubbed from `process.env` and child process environments before spawning `git` or `ssh`.
- Writes on MRs authored by someone else are refused without `allowOthers: true`.
- `merge` requires an explicit `iid` and full head `sha`, refuses drafts/conflicts/unresolved blocking discussions/non-open MRs, and requires `allowProtectedTarget: true` for `release*` or protected branches other than `main`, `master`, or `develop`.

## Development & Validation

For local development with live reloads, clone `spider-antigravity-mods` and symlink `plugins/gitlab` into Antigravity's global plugins directory:

```bash
git clone https://github.com/anderson-spider/spider-antigravity-mods.git
ln -s "$(pwd)/spider-antigravity-mods/plugins/gitlab" ~/.gemini/config/plugins/gitlab
```

Run tests, UI build, typechecks, and strict manifest validation from `plugins/gitlab`:

```bash
pnpm build:ui
node --test 'tests/*.test.ts'
pnpm typecheck
agy plugin validate --strict .
```
