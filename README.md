# spider-antigravity-mods

Native plugins for [Google Antigravity](https://antigravity.google) by [anderson-spider](https://github.com/anderson-spider).

## Plugins

| Plugin | Version | Description |
| :--- | :--- | :--- |
| [`batch-tools`](./plugins/batch-tools) | `0.1.1` | Hardened, zero-dependency batch code search (`ripgrep` with pure-Node fallback), multi-file symbol outlines and line slices, and atomic multi-file edits with strict workspace confinement and inline byte budgeting. |
| [`claude-agent`](./plugins/claude-agent) | `0.4.0` | Agent-driven Claude Code monitor and Antigravity bridge powered by `@agentclientprotocol/claude-agent-acp`, with streaming responses, grouped tool timelines, diffs, permission approvals, automatic async reply delivery, and scoped session archiving and persistence across sidebar and side pane. |
| [`gitlab`](./plugins/gitlab) | `0.5.2` | Work on GitLab merge requests, comments, draft notes, pipelines, jobs, and labels with an interactive MR Dashboard (multi-repo tracking, isolated worktree checkout, hierarchical diff file tree, Global sidebar & side pane) across `gitlab.com` and self-hosted GitLab instances. |
| [`usage-monitor`](./plugins/usage-monitor) | `2.0.0` | Local offline MCP App and CLI `statusLine` monitor for token usage, generation speed (`tok/s`), TTFT, context breakdown, quota pace, and Session Health diagnostics (left sidebar `global`, right side pane `aux_pane`, and inline chat health card). |

## Prerequisites

- [Google Antigravity](https://antigravity.google) (`agy` CLI for one-command installation)
- Node.js **22.18+** (native TypeScript execution, zero runtime dependencies)

## Installing a plugin

Install any plugin directly from its GitHub subdirectory with the `agy` CLI:

```bash
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/batch-tools
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/claude-agent
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/gitlab
agy plugin install https://github.com/anderson-spider/spider-antigravity-mods/tree/main/plugins/usage-monitor
```

Re-running `agy plugin install` with the same URL updates an existing installation in place; `agy plugin uninstall <plugin>` removes it.

Plugins that declare MCP `variables` install disabled until you enable them and fill in their credentials in Antigravity (`/plugin` in the CLI or **Customizations > Installed** in Antigravity Desktop). See each plugin's README for configuration details.

## Development

To develop locally with live reloads, clone the repository and symlink the plugin into `~/.gemini/config/plugins/`:

```bash
git clone https://github.com/anderson-spider/spider-antigravity-mods.git
ln -s "$(pwd)/spider-antigravity-mods/plugins/<plugin>" ~/.gemini/config/plugins/<plugin>
```

Run checks and strict manifest validation from the repository root:

```bash
pnpm install
pnpm check
agy plugin validate --strict plugins/<plugin>
```

## License

[MIT](./LICENSE), unless a plugin directory includes its own `LICENSE` file (for example, [`plugins/usage-monitor/LICENSE`](./plugins/usage-monitor/LICENSE) is licensed under GNU GPL v3.0).
