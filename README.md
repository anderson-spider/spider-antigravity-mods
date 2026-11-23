# spider-antigravity-mods

Native plugins for [Google Antigravity](https://antigravity.google) by [anderson-spider](https://github.com/anderson-spider).

## Plugins

| Plugin | Version | Description |
| :--- | :--- | :--- |
| [`gitlab`](./plugins/gitlab) | `0.1.0` | Work on GitLab merge requests, comments, draft notes, pipelines, jobs, and labels across `gitlab.com` and self-hosted GitLab instances. |

## Prerequisites

- [Google Antigravity](https://antigravity.google)
- Node.js **22.18+** (native TypeScript execution, zero runtime dependencies)

## Installing a plugin

Clone the repository and symlink the desired plugin into `~/.gemini/config/plugins/`:

```bash
git clone https://github.com/anderson-spider/spider-antigravity-mods.git
ln -s "$(pwd)/spider-antigravity-mods/plugins/gitlab" ~/.gemini/config/plugins/gitlab
```

Antigravity discovers plugins in `~/.gemini/config/plugins/` automatically (no manual registration needed). See each plugin's README for required environment variables and configuration.

## Development

```bash
pnpm install
pnpm check
agy plugin validate --strict plugins/gitlab
```

## License

[MIT](./LICENSE)
