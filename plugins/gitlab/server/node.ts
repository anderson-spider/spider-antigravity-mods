// What a call needs from outside, on Node: git and ssh as processes in the session's folder, fetch, the environment,
// and a clock whose waits keep the call alive.
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Fetch, FetchResponse } from './api.ts'
import { ENV_NAME, type Deps } from './run.ts'

const SCRUBBED_CHILD_ENV = [
  ENV_NAME,
  'GITLAB_TOKEN',
  'GITLAB_PRIVATE_TOKEN',
  'GL_TOKEN',
] as const

/** Environment for git/ssh child processes, stripped of GitLab credentials. */
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...source }
  for (const name of SCRUBBED_CHILD_ENV) delete clean[name]
  return clean
}

/** A process's exit code and output; one that cannot start or times out exits non-zero with what it printed. */
function processRun(command: string, timeoutMs: number, cwd?: string) {
  return (args: string[]) => new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolvePromise => {
    execFile(command, args, { cwd, env: childEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolvePromise({ exitCode: code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** Runs `git <args>` in an explicit directory with credential environment variables scrubbed. */
export function gitAt(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return processRun('git', 60_000, cwd)(args)
}

const REDIRECTS = 3

/**
 * fetch, its headers as a lowercase map (where `x-next-page` is read). A redirect (a job log in object storage) is
 * followed by hand, a few hops at most: once a redirect leaves the configured origin, the token stays dropped.
 */
export const nodeFetch = async (url: string, init: Parameters<Fetch>[1], fetcher: typeof fetch = fetch): Promise<FetchResponse> => {
  const origin = new URL(url).origin
  let at = url
  let sameOrigin = true
  let response = await fetcher(at, { method: init.method, headers: init.headers, body: init.body, redirect: 'manual' })
  for (let hop = 0; hop < REDIRECTS && response.status >= 300 && response.status < 400 && response.headers.get('location'); hop++) {
    const location = response.headers.get('location')!
    await response.body?.cancel().catch(() => {})
    at = new URL(location, at).toString()
    sameOrigin = sameOrigin && new URL(at).origin === origin
    const headers = sameOrigin ? init.headers : Object.fromEntries(Object.entries(init.headers).filter(([name]) => name.toLowerCase() !== 'private-token'))
    response = await fetcher(at, { method: 'GET', headers, redirect: 'manual' })
  }
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key] = value })
  return { status: response.status, ok: response.ok, text: await response.text(), headers }
}

/** Validates an optional `cwd` tool argument, falling back to `fallbackCwd` when omitted. */
export async function resolveCwd(
  inputCwd: unknown,
  fallbackCwd: string,
  isDir: (path: string) => Promise<boolean> = async path => {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  },
): Promise<{ cwd: string; error?: undefined } | { cwd?: undefined; error: string }> {
  if (inputCwd === undefined || inputCwd === null) return { cwd: fallbackCwd }
  if (typeof inputCwd !== 'string' || !inputCwd.trim()) return { error: 'cwd must be a non-empty absolute directory path.' }
  const dir = inputCwd.trim()
  if (!isAbsolute(dir)) return { error: 'cwd must be an absolute directory path.' }
  if (!(await isDir(dir))) return { error: `cwd is not an existing directory: ${dir}` }
  return { cwd: resolve(dir) }
}

/** The deps of one call in `cwd`; `beat` runs before each wait, which keeps a long call alive. */
export function nodeDeps(cwd: string, beat: () => void): Deps {
  return {
    git: processRun('git', 10_000, cwd),
    ssh: processRun('ssh', 5_000, cwd),
    fetch: nodeFetch,
    env: async name => process.env[name],
    clock: {
      now: () => Date.now(),
      sleep: ms => {
        beat()
        return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
      },
    },
  }
}
