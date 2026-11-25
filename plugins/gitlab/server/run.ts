// The wiring every tool shares: which GitLab a call goes to, with which token and project, then the tool itself. Pure:
// git, ssh, the network, the environment and the clock are injected (`Deps`), so the tests run it against fakes and
// main.ts against Node.
import { GitlabError, NoProjectError, gitlab, type Fetch } from './api.ts'
import { InputError, makeCtx, type Clock, type Ctx } from './context.ts'

export const ENV_NAME = 'GITLAB_MCP_TOKENS'

/** Runs `git <args>` in the session's directory. */
type Git = (args: string[]) => Promise<{ exitCode: number; stdout: string }>

/** Runs `ssh <args>`; only `ssh -G <host>`, which prints the resolved configuration and connects nowhere. */
type Ssh = (args: string[]) => Promise<{ exitCode: number; stdout: string }>

/** What a call needs from outside: processes, the network, the environment and the clock. */
export type Deps = {
  git: Git
  ssh: Ssh
  fetch: Fetch
  /** A variable of the server's environment. */
  env: (name: string) => Promise<string | undefined>
  clock: Clock
}

/** Configuration captured at startup (or injected in tests); unset fields fall back to `deps.env`. */
export type Options = { tokens?: unknown }

export type Reply = { text: string; structuredContent?: Record<string, unknown>; isError?: true }

/** Masks every secret string recursively across text, arrays, and plain objects so tokens never leak into replies. */
export function maskSecrets<T>(value: T, secrets: readonly string[]): T {
  const nonEmpty = secrets.filter(Boolean)
  if (nonEmpty.length === 0) return value
  const scrub = (text: string): string => nonEmpty.reduce((acc, secret) => acc.split(secret).join('[token]'), text)
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return scrub(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v)
      return out
    }
    return node
  }
  return walk(value) as T
}

export type WorkspaceInfo = { host: string; project: string; branch?: string }

export type ResolvedEnv =
  | { tokens: Map<string, string>; workspace?: WorkspaceInfo; error?: undefined }
  | { tokens?: undefined; workspace?: undefined; error: string }

/** Resolves all configured tokens plus the active git workspace (when its remote matches a configured GitLab host). */
export async function resolveEnv(deps: Deps, options: Options): Promise<ResolvedEnv> {
  const rawTokens = isSet(options.tokens) ? options.tokens : await deps.env(ENV_NAME)
  const parsed = parseTokens(rawTokens)
  if (parsed.tokens === undefined) return { error: offText(parsed.off) }
  const { tokens } = parsed
  let workspace: WorkspaceInfo | undefined
  const where = await locate(deps.git)
  if (!('error' in where)) {
    let host = where.host
    if (!tokens.has(host) && where.ssh) {
      const real = await sshHostname(deps.ssh, host)
      if (real && tokens.has(real)) host = real
    }
    if (tokens.has(host)) {
      const branch = await currentBranch(deps.git)
      workspace = { host, project: where.project, ...(branch ? { branch } : {}) }
    }
  }
  return { tokens, ...(workspace ? { workspace } : {}) }
}

/** Validates a GitLab host name (without scheme or path), returning normalized lowercase or undefined. */
export { hostName, projectPath, errorText }

/** A tool: what it answers for its input, through the context of its call. */
export type Tool = (ctx: Ctx, input: Record<string, unknown>) => Promise<string>

/** Where a remote points; `ssh` marks an SSH remote, whose host may be an alias from ~/.ssh/config. */
type Location = { host: string; project: string; ssh?: true }

type Off = 'no-tokens' | 'bad-tokens' | 'no-host'

/** A host name (an https remote or token key may carry a port): what may follow `https://` without changing the host. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
/** `group/sub/project`: at least two segments of GitLab path characters, no dot-only segment. */
const PROJECT = /^[\w.-]+(\/[\w.-]+)+$/
/** Printable ASCII with no space, comma or `=`, so the header cannot be broken by what was pasted. */
const TOKEN = /^[\x21-\x2b\x2d-\x3c\x3e-\x7e]{1,512}$/
/** Unexpanded Antigravity variable placeholder (for example `${GITLAB_MCP_TOKENS}` when enabled before filling variables). */
const UNEXPANDED_PLACEHOLDER = /^\$\{[A-Z0-9_]+\}$/
const NO_REMOTE =
  'This directory is not a git repository with a GitLab remote. Pass cwd (the repository path), or host and project.'

/** Present: a string with something other than whitespace. */
const isSet = (value: unknown): boolean => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())

/** Shapes an answer: `isError` is set only when true. */
function reply(text: string, isError = false): Reply {
  return isError ? { text, isError: true } : { text }
}

/**
 * The host and project path of a remote URL: `git@host:group/proj.git`, `ssh://git@host:22/group/proj.git` or
 * `https://host/group/proj.git`. An SSH port is dropped (the API is https); an https port is kept.
 */
function parseRemote(url: string): Location | undefined {
  const text = url.trim()
  let host: string
  let path: string
  let ssh = false
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return undefined
    }
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
    if (scheme === 'https' || scheme === 'http') host = parsed.host
    else if (scheme === 'ssh' || scheme === 'git+ssh') {
      host = parsed.hostname
      ssh = true
    } else return undefined
    path = decodeURIComponent(parsed.pathname)
  } else if (scp) {
    host = scp[1]!
    path = scp[2]!
    ssh = true
  } else {
    return undefined
  }
  host = host.toLowerCase()
  const project = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  if (!HOST.test(host) || !PROJECT.test(project) || project.split('/').some((s) => /^\.+$/.test(s))) return undefined
  return ssh ? { host, project, ssh: true } : { host, project }
}

/**
 * A project the model names: a path (`group/sub/project`, the same shape as a remote's) or GitLab's numeric project id;
 * never a URL or another host.
 */
function projectPath(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
  if (typeof value !== 'string') return undefined
  const project = value.trim().replace(/^\/+|\/+$/g, '')
  if (/^[1-9]\d{0,15}$/.test(project)) return project
  return PROJECT.test(project) && !project.split('/').some((s) => /^\.+$/.test(s)) ? project : undefined
}

/** A host name a tool input gives (`gitlab.example.com` or `localhost:8080`, with an optional port), lower-cased; never a URL. */
function hostName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const host = value.trim().toLowerCase()
  return HOST.test(host) ? host : undefined
}

/**
 * The real host an SSH alias names (`Host work` with `HostName gitlab.example.com` in ~/.ssh/config), read from
 * `ssh -G`; undefined when ssh fails or names no valid host. The alias itself comes back for a host with no alias.
 */
async function sshHostname(ssh: Ssh, alias: string): Promise<string | undefined> {
  if (!HOST.test(alias) || alias.includes(':')) return undefined
  const out = await ssh(['-G', alias]).catch(() => undefined)
  if (!out || out.exitCode !== 0) return undefined
  const line = out.stdout.split('\n').find((l) => /^hostname\s/i.test(l))
  const name = line?.replace(/^hostname\s+/i, '').trim().toLowerCase()
  return name && HOST.test(name) && !name.includes(':') ? name : undefined
}

/** The `origin` remote, or the first remote when there is no `origin`. */
async function locate(git: Git): Promise<Location | { error: string }> {
  let url = await git(['remote', 'get-url', 'origin']).catch(() => undefined)
  if (!url || url.exitCode !== 0) {
    const names = await git(['remote']).catch(() => undefined)
    const first = names?.exitCode === 0 ? names.stdout.split('\n').map((s) => s.trim()).find(Boolean) : undefined
    if (!first) return { error: NO_REMOTE }
    url = await git(['remote', 'get-url', first]).catch(() => undefined)
    if (!url || url.exitCode !== 0) return { error: NO_REMOTE }
  }
  const where = parseRemote(url.stdout)
  // the URL itself is not echoed: an https remote may carry a user and password
  return where ?? { error: 'The git remote is not a GitLab project URL this plugin can read (host and group/project).' }
}

/** The checked-out branch, or undefined on a detached HEAD or outside a repository. */
async function currentBranch(git: Git): Promise<string | undefined> {
  const out = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined)
  const name = out?.exitCode === 0 ? out.stdout.trim() : ''
  return name && name !== 'HEAD' ? name : undefined
}

/** The host-to-token map: pairs separated by commas or whitespace. Any malformed pair refuses the whole value. */
function parseTokens(value: unknown): { tokens: Map<string, string>; off?: undefined } | { tokens?: undefined; off: 'no-tokens' | 'bad-tokens' } {
  if (value === undefined || value === null) return { off: 'no-tokens' }
  if (typeof value !== 'string') return { off: 'bad-tokens' }
  if (UNEXPANDED_PLACEHOLDER.test(value.trim())) return { off: 'no-tokens' }
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

/** What each refusal tells the user: where to set the variable, never a token value. */
function offText(off: Off, host?: string, configured?: readonly string[]): string {
  switch (off) {
    case 'no-tokens':
      return `${ENV_NAME} is not set. Configure ${ENV_NAME} as host=token pairs (for example gitlab.com=glpat-...) in Antigravity's plugin settings (/plugin or Customizations) or your environment and reload MCP.`
    case 'bad-tokens':
      return `${ENV_NAME} is not a valid list of host=token pairs (comma- or whitespace-separated).`
    case 'no-host': {
      const base = `No token configured for ${host ?? 'this host'}. Add ${host ?? '<host>'}=<token> to ${ENV_NAME}.`
      if (configured && configured.length > 0) {
        return `${base} Configured hosts: ${configured.join(', ')}. Pass host explicitly to target one of them.`
      }
      return base
    }
  }
}

/** A hint for the status (and, for 403, whether the request wrote), or undefined when GitLab's message says enough. */
function hint(err: GitlabError, project: string, host: string): string | undefined {
  switch (err.status) {
    case 401:
      return `The token for ${host} was refused (expired or revoked?). Replace it in ${ENV_NAME}.`
    case 403:
      return err.method === 'GET'
        ? `The token's user may have no access to ${project}.`
        : `The token may lack the api scope (read_api only reads), or the user's role in ${project} does not allow this.`
    case 404:
      return `${project} may not exist or the token's user cannot see it; check the project path and the iid or id.`
    case 405:
    case 406:
      return 'GitLab refused the action in the current state (for a merge: not mergeable yet, or merging is not allowed).'
    case 409:
      return 'Something changed meanwhile (for a merge: the head moved; read status again).'
    default:
      return undefined
  }
}

function errorText(err: GitlabError, project: string, host: string): string {
  const more = hint(err, project, host)
  const said = err.message.replace(/[.\s]+$/, '')
  return `GitLab answered ${err.status} for ${project}: ${said}${more ? `. ${more}` : ''}`
}

/**
 * Where a call goes: the host, its token and, when the host is the remote's, the remote's project. `fallback` marks a
 * remote that names no GitLab with a token (not a git repo or a host missing from tokens), where a single configured
 * host can step in.
 */
type Target =
  | { host: string; token: string; current?: string }
  | { error: string; fallback?: 'no-repo' | 'no-host'; where?: Location; resolvedHost?: string }

/** The remote's host (an SSH alias resolved through `ssh -G`) and its token. */
async function fromRemote(git: Git, ssh: Ssh, tokens: Map<string, string>): Promise<Target> {
  const where = await locate(git)
  if ('error' in where) return { error: where.error, fallback: 'no-repo' }
  const hosts = [...tokens.keys()]
  let host = where.host
  let token = tokens.get(host)
  let resolvedHost: string | undefined
  if (token === undefined && where.ssh) {
    // an SSH remote may name a ~/.ssh/config alias (`git@work:group/app.git`): its token is the real host's
    const real = await sshHostname(ssh, host)
    resolvedHost = real
    if (real && real !== host) {
      token = tokens.get(real)
      if (token === undefined) {
        return {
          error: `The remote's host ${host} is an SSH alias for ${real}. ${offText('no-host', real, hosts)}`,
          fallback: 'no-host',
          where,
          resolvedHost,
        }
      }
      host = real
    } else if (!host.includes('.')) {
      return {
        error: `${offText('no-host', host, hosts)} If ${host} is an SSH alias from ~/.ssh/config, ssh -G could not resolve it: give the remote the real host name.`,
        fallback: 'no-host',
        where,
        resolvedHost,
      }
    }
  }
  if (token === undefined) return { error: offText('no-host', host, hosts), fallback: 'no-host', where, resolvedHost }
  return { host, token, current: where.project }
}

/** A host named by the `host` input or single-host auto-default, and its token. */
async function onHost(git: Git, ssh: Ssh, tokens: Map<string, string>, host: string): Promise<Target> {
  const token = tokens.get(host)
  if (token === undefined) return { error: offText('no-host', host, [...tokens.keys()]) }
  const where = await locate(git)
  if ('error' in where) return { host, token }
  const same = where.host === host || (!!where.ssh && (await sshHostname(ssh, where.host)) === host)
  return { host, token, current: same ? where.project : undefined }
}

/**
 * Picks the host (`host` input, else the git remote's, else the sole configured host when only one host exists) and
 * its token, switches to `project` when given and runs the tool; the token is masked in every answer.
 */
export async function run(deps: Deps, tool: Tool, input: Record<string, unknown>, options: Options): Promise<Reply> {
  const { git, ssh } = deps
  const namedHost = input.host !== undefined ? hostName(input.host) : undefined
  if (input.host !== undefined && !namedHost) {
    return reply('host must be a GitLab host name (gitlab.example.com), not a URL.', true)
  }
  const rawTokens = isSet(options.tokens) ? options.tokens : await deps.env(ENV_NAME)
  const parsed = parseTokens(rawTokens)
  if (parsed.tokens === undefined) return reply(offText(parsed.off), true)
  const tokens = parsed.tokens

  let target: Target
  if (namedHost !== undefined) {
    target = await onHost(git, ssh, tokens, namedHost)
  } else {
    target = await fromRemote(git, ssh, tokens)
    if ('error' in target && target.fallback) {
      const hosts = [...tokens.keys()]
      if (hosts.length === 1) {
        const sole = hosts[0]!
        const token = tokens.get(sole)!
        const same =
          target.where !== undefined &&
          (target.where.host === sole || (!!target.where.ssh && target.resolvedHost === sole))
        target = { host: sole, token, current: same ? target.where?.project : undefined }
      } else if (target.fallback === 'no-repo') {
        target = {
          error: `${target.error} Pass host explicitly. Configured hosts: ${hosts.join(', ')}.`,
        }
      }
    }
  }
  if ('error' in target) return reply(target.error, true)
  const { host, token, current } = target
  let project = current
  if (input.project !== undefined) {
    const named = projectPath(input.project)
    if (!named) return reply(`project must be a project path (group/project) or numeric id on ${host}, not a URL: name another GitLab with host.`, true)
    project = named
  }
  const api = gitlab(deps.fetch, host, project, token)
  // an answer can echo what the request carried (a proxy's error page, a fetch error), so the token is masked in every output
  const masked = (text: string, isError = false) => reply(text.split(token).join('[token]'), isError)
  const foreign = project === undefined || current === undefined || project.toLowerCase() !== current.toLowerCase()
  try {
    return masked(await tool(makeCtx(api, () => currentBranch(git), deps.clock, foreign), input))
  } catch (err) {
    if (err instanceof NoProjectError) return masked(`Name the project (group/project or its numeric id): the repository's remote is not on ${host}.`, true)
    if (err instanceof InputError) return masked(err.message, true)
    if (err instanceof GitlabError) return masked(errorText(err, project ?? host, host), true)
    return masked(`Call to ${host} failed: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}
