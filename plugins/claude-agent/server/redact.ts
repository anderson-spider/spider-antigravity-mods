// Credential redaction and subprocess environment scrubbing for ACP child processes.

const STRIPPED_ENV_KEYS = new Set([
  'CLAUDECODE',
  'GITLAB_MCP_TOKENS',
  'GITLAB_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'NPM_CONFIG_TOKEN',
  'NODE_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTIGRAVITY_CSRF_TOKEN',
])

export function redactSecrets(text: string): string {
  if (!text) return text
  return text
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, 'sk-ant-***')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, 'gh_***')
    .replace(/\bglpat-[A-Za-z0-9_-]{12,}\b/g, 'glpat-***')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/((?:x-api-key|ANTHROPIC_API_KEY)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1***')
}

export function buildAcpEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== 'string') continue
    if (STRIPPED_ENV_KEYS.has(key)) continue
    clean[key] = value
  }
  if (!clean.npm_config_update_notifier) clean.npm_config_update_notifier = 'false'
  if (!clean.npm_config_fund) clean.npm_config_fund = 'false'
  if (!clean.npm_config_audit) clean.npm_config_audit = 'false'
  return clean
}
