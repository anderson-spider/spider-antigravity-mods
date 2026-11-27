// Scoped credential redaction for errors, stderr, and audit buffers, plus child-process env scrubbing.

const STRIPPED_EXACT_KEYS = new Set([
  'GH_TOKEN',
  'ANTIGRAVITY_CSRF_TOKEN',
  'RIPGREP_CONFIG_PATH',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'NPM_CONFIG_TOKEN',
  'CLAUDECODE',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
])

const STRIPPED_PREFIXES = [
  'AWS_',
  'GITLAB_',
  'GITHUB_',
  'NPM_',
  'GIT_CONFIG_',
]

const STRIPPED_SUFFIXES = [
  '_TOKEN',
  '_SECRET',
  '_KEY',
  '_PASSWORD',
]

/**
 * Redacts high-confidence credential patterns from error messages, stderr, and
 * audit/diff buffers. Never call this on raw source slices used for editing.
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, 'sk-ant-***')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, 'gh_***')
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/g, 'glpat-***')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1***:***@')
}

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (STRIPPED_EXACT_KEYS.has(upper)) return true
  for (const prefix of STRIPPED_PREFIXES) {
    if (upper.startsWith(prefix)) return true
  }
  for (const suffix of STRIPPED_SUFFIXES) {
    if (upper.endsWith(suffix)) return true
  }
  return false
}

/**
 * Returns a copy of `sourceEnv` with credential and tool-hijack variables
 * removed so spawned child processes (such as `rg`) never inherit secrets.
 */
export function scrubChildEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== 'string') continue
    if (isSensitiveEnvKey(key)) continue
    clean[key] = value
  }
  return clean
}
