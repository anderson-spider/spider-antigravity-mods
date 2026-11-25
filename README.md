# spider-antigravity-mods

Native plugins for [Google Antigravity](https://antigravity.google) by [anderson-spider](https://github.com/anderson-spider).

## Plugins

| Plugin | Version | Description |
| :--- | :--- | :--- |
| [`gitlab`](./plugins/gitlab) | `0.3.0` | Work on GitLab merge requests, comments, draft notes, pipelines, jobs, and labels across `gitlab.com` and self-hosted GitLab instances. |
| [`usage-monitor`](./plugins/usage-monitor) | `1.0.0` | Local offline monitor for token usage, generation speed (`tok/s`), TTFT, context breakdown, and quota pools with pace tracking. |

## Prerequisites

- [Google Antigravity](https://antigravity.google) (`agy` CLI for one-command installation)
- Node.js **22.18+** (native TypeScript execution, zero runtime dependencies)

## Installing a plugin

Install any plugin directly from its GitHub subdirectory with the `agy` CLI:

```bash
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
