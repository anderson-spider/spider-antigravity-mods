# GitLab Plugin for Antigravity

Work on GitLab merge requests, comments, draft notes, pipelines, jobs, and labels across both `gitlab.com` and self-hosted GitLab instances. The MCP server reads the repository's git remote so each GitLab host automatically receives only its own token.

## Features

- **Zero runtime dependencies:** native Node.js TypeScript MCP server (`server/main.ts`, Node 22.18+).
- **Multi-host isolation:** map multiple GitLab hosts to separate tokens (`host=token` pairs); each token is sent only to its paired host.
- **Smart host resolution:**
  - Inside a GitLab clone (or with an explicit `cwd`), detects host, project, and current branch from git (including `~/.ssh/config` aliases via `ssh -G`).
  - Outside a GitLab repo with a URL or explicit `host`, targets that host directly.
  - Outside a GitLab repo without `host`, uses `GITLAB_MCP_DEFAULT_HOST` if set, or automatically targets the sole configured host when only one host is present in `GITLAB_MCP_TOKENS`. If multiple hosts exist with no default, refuses and lists the configured host names.
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

Tokens need `api` scope (`read_api` for read-only use). When only one host is configured, it is automatically used as the default outside GitLab repositories.

### Optional: default host for multiple instances

Only needed when you configure 2+ hosts and call tools outside a GitLab repository without passing `host` or a GitLab URL:

```bash
export GITLAB_MCP_DEFAULT_HOST="gitlab.example.com"
```

On macOS GUI apps (such as Antigravity Desktop), also expose the variable to launched apps and reload MCP servers (or restart Antigravity):

```bash
launchctl setenv GITLAB_MCP_DEFAULT_HOST "gitlab.example.com"
```

## Tools (`gitlab_gitlab` MCP server)

- `gitlab_mr`: `list`, `get`, `status`, `diff`, `commits`, `create`, `update`, `approve`, `unapprove`, `rebase`, `merge`
- `gitlab_mr_comment`: `list`, `unresolved`, `drafts`, `comment`, `reply`, `line`, `edit`, `resolve`, `unresolve`, `publish`
- `gitlab_pipeline`: `list`, `jobs`, `wait`, `run`, `retry`, `cancel`, `play`, `artifacts`
- `gitlab_job_log`: `errors` (default), `tail`, `full`
- `gitlab_label`: `list`, `create`
- `gitlab_user`: current token owner (`@me`) or lookup by `username`

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

Run tests, typechecks, and strict manifest validation from `plugins/gitlab`:

```bash
node --test 'tests/*.test.ts'
pnpm typecheck
agy plugin validate --strict .
```
