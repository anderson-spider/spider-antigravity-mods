# Changelog

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
