# Changelog

## 0.1.0 - 2026-11-23

- Initial standalone Antigravity release of the GitLab plugin (`gitlab_gitlab` MCP server and `gitlab` skill).
- Portable `mcp_config.json` using `node` and `${PLUGIN_ROOT}/server/main.ts`.
- Simplified credential configuration via `GITLAB_MCP_TOKENS` (`host=token` pairs) and optional `GITLAB_MCP_DEFAULT_HOST`.
- Automatic single-host fallback outside GitLab repositories, and clear error listing configured hosts when multiple hosts exist without a default.
- Cross-platform `file://` root handling (`fileURLToPath`) and neutral, language-agnostic `SKILL.md`.
