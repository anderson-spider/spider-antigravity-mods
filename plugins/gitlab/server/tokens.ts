// Which token goes to which GitLab. Pure: values are passed in.
// GITLAB_MCP_TOKENS holds comma- or whitespace-separated `host=token` pairs so one plugin serves gitlab.com and any
// self-managed instance. A token is sent only to the host it is paired with and is never echoed in any message.
// The variable name intentionally avoids GITLAB_TOKEN and other host-less names that unrelated CLI tools read.

export const ENV_NAME = 'GITLAB_MCP_TOKENS'

/** Optional fallback host when running outside a repository with a configured GitLab remote. */
export const DEFAULT_HOST_ENV = 'GITLAB_MCP_DEFAULT_HOST'

export type Off = 'no-tokens' | 'bad-tokens' | 'no-host'

/** Printable ASCII with no space, comma or `=`, so the header cannot be broken by what was pasted. */
const TOKEN = /^[\x21-\x2b\x2d-\x3c\x3e-\x7e]{1,512}$/
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/

/** Present: a string with something other than whitespace. */
export const isSet = (value: unknown): boolean => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())

/** The host-to-token map: pairs separated by commas or whitespace. Any malformed pair refuses the whole value. */
export function parseTokens(value: unknown): { tokens: Map<string, string>; off?: undefined } | { tokens?: undefined; off: 'no-tokens' | 'bad-tokens' } {
  if (value === undefined || value === null) return { off: 'no-tokens' }
  if (typeof value !== 'string') return { off: 'bad-tokens' }
  const pairs = value.split(/[\s,]+/).filter(Boolean)
  if (pairs.length === 0) return { off: 'no-tokens' }
  const tokens = new Map<string, string>()
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    const host = pair.slice(0, at).toLowerCase()
    const token = pair.slice(at + 1)
    if (at <= 0 || !HOST.test(host) || !TOKEN.test(token) || tokens.has(host)) return { off: 'bad-tokens' }
    tokens.set(host, token)
  }
  return { tokens }
}

/** The configured host names (never the tokens), or why the token list cannot be used. */
export function configuredHosts(value: unknown): { hosts: string[]; off?: undefined } | { hosts?: undefined; off: 'no-tokens' | 'bad-tokens' } {
  const parsed = parseTokens(value)
  if (parsed.tokens === undefined) return { off: parsed.off }
  return { hosts: [...parsed.tokens.keys()] }
}

/** The token for `host`, or why there is none (along with the configured host names on `no-host`). */
export function resolveToken(
  value: unknown,
  host: string,
): { token: string; off?: undefined } | { token?: undefined; off: Off; hosts?: string[] } {
  const parsed = parseTokens(value)
  if (parsed.tokens === undefined) return { off: parsed.off }
  const token = parsed.tokens.get(host)
  if (token === undefined) return { off: 'no-host', hosts: [...parsed.tokens.keys()] }
  return { token }
}

/** What each refusal tells the user: where to set the variable, never a token value. */
export function offText(off: Off, host?: string, configured?: readonly string[]): string {
  switch (off) {
    case 'no-tokens':
      return `${ENV_NAME} is not set. Export ${ENV_NAME} as host=token pairs (for example gitlab.com=glpat-...) in your environment or plugin mcp_config.json and reload MCP.`
    case 'bad-tokens':
      return `${ENV_NAME} is not a valid list of host=token pairs (comma- or whitespace-separated).`
    case 'no-host': {
      const base = `No token configured for ${host ?? 'this host'}. Add ${host ?? '<host>'}=<token> to ${ENV_NAME}.`
      if (configured && configured.length > 0) {
        return `${base} Configured hosts: ${configured.join(', ')}. Pass host explicitly or set ${DEFAULT_HOST_ENV} to target one of them.`
      }
      return base
    }
  }
}
