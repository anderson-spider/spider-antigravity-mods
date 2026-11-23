// The wiring every tool shares: which GitLab a call goes to, with which token and project, then the tool itself. Pure:
// git, ssh, the network, the environment and the clock are injected (`Deps`), so the tests run it against fakes and
// main.ts against Node.
import { GitlabError, NoProjectError, gitlab, type Fetch } from './api.ts'
import { InputError, makeCtx, type Clock, type Ctx } from './context.ts'
import { errorText } from './errors.ts'
import { currentBranch, hostName, locate, projectPath, sshHostname, type Git, type Ssh } from './remote.ts'
import { ENV_NAME, configuredHosts, isSet, offText, resolveToken } from './tokens.ts'

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

export type Reply = { text: string; isError?: true }

/** A tool: what it answers for its input, through the context of its call. */
export type Tool = (ctx: Ctx, input: Record<string, unknown>) => Promise<string>

/** Shapes an answer: `isError` is set only when true. */
function reply(text: string, isError = false): Reply {
  return isError ? { text, isError: true } : { text }
}

/**
 * Where a call goes: the host, its token and, when the host is the remote's, the remote's project. `fallback` marks a
 * remote that names no GitLab with a token (not a git repo or a host missing from tokens), where a single configured
 * host can step in.
 */
type Target = { host: string; token: string; current?: string } | { error: string; fallback?: 'no-repo' | 'no-host' }

/** The remote's host (an SSH alias resolved through `ssh -G`) and its token. */
async function fromRemote(git: Git, ssh: Ssh, tokens: unknown): Promise<Target> {
  const where = await locate(git)
  if ('error' in where) return { error: where.error, fallback: 'no-repo' }
  let host = where.host
  let access = resolveToken(tokens, host)
  if (access.off === 'no-host' && where.ssh) {
    // an SSH remote may name a ~/.ssh/config alias (`git@work:group/app.git`): its token is the real host's
    const real = await sshHostname(ssh, host)
    if (real && real !== host) {
      access = resolveToken(tokens, real)
      if (access.off === 'no-host') {
        return { error: `The remote's host ${host} is an SSH alias for ${real}. ${offText('no-host', real, access.hosts)}`, fallback: 'no-host' }
      }
      host = real
    } else if (!host.includes('.')) {
      return {
        error: `${offText('no-host', host, access.hosts)} If ${host} is an SSH alias from ~/.ssh/config, ssh -G could not resolve it: give the remote the real host name.`,
        fallback: 'no-host',
      }
    }
  }
  if (access.off === 'no-host') return { error: offText(access.off, host, access.hosts), fallback: 'no-host' }
  if (access.off !== undefined) return { error: offText(access.off, host) }
  return { host, token: access.token, current: where.project }
}

/** A host named by the `host` input or single-host auto-default, and its token. */
async function onHost(git: Git, ssh: Ssh, tokens: unknown, host: string): Promise<Target> {
  const access = resolveToken(tokens, host)
  if (access.off !== undefined) return { error: offText(access.off, host, access.hosts) }
  const where = await locate(git)
  if ('error' in where) return { host, token: access.token }
  const same = where.host === host || (!!where.ssh && (await sshHostname(ssh, where.host)) === host)
  return { host, token: access.token, current: same ? where.project : undefined }
}

/**
 * Picks the host (`host` input, else the git remote's, else the sole configured host when only one host exists) and
 * its token, switches to `project` when given and runs the tool; the token is masked in every answer.
 */
export async function run(deps: Deps, tool: Tool, input: Record<string, unknown>, options: Options): Promise<Reply> {
  const { git, ssh } = deps
  const rawTokens = isSet(options.tokens) ? options.tokens : await deps.env(ENV_NAME)
  let target: Target
  if (input.host !== undefined) {
    const named = hostName(input.host)
    if (!named) return reply('host must be a GitLab host name (gitlab.example.com), not a URL.', true)
    target = await onHost(git, ssh, rawTokens, named)
  } else {
    target = await fromRemote(git, ssh, rawTokens)
    if ('error' in target && target.fallback) {
      const available = configuredHosts(rawTokens)
      if (available.off !== undefined) {
        target = { error: offText(available.off) }
      } else if (available.hosts.length === 1) {
        target = await onHost(git, ssh, rawTokens, available.hosts[0]!)
      } else if (target.fallback === 'no-repo') {
        target = {
          error: `${target.error} Pass host explicitly. Configured hosts: ${available.hosts.join(', ')}.`,
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
