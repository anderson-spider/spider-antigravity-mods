# Security

These plugins run code on the machine of whoever installs them: MCP servers and tools run inside Google Antigravity with the user's permissions.

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/anderson-spider/spider-antigravity-mods/security/advisories/new) (Security tab, "Report a vulnerability"). Do not open a public issue or pull request for security issues.

Include the affected plugin and version (`version` in its `plugin.json`), your Antigravity and Node.js versions, the impact, and minimal reproduction steps.

## Scope

In scope: plugins under `plugins/`. Examples include sending a token to an unintended host, leaking credentials to child processes or model output, bypassing write/merge guards, or escaping path/URL validation.

Out of scope: Antigravity itself, GitLab, and external services called by the plugins.

## Secrets

Plugins read tokens only from the user's environment (or local `mcp_config.json` overrides), never from this repository. Never commit tokens, internal host names, or work data, including in tests and examples — use placeholders such as `gitlab.example.com` and `group/project`.
