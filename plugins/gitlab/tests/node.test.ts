import { childEnv, nodeFetch, resolveCwd } from '../server/node.ts'
import { expect, test } from './expect.ts'

const TOKEN = 'glpat-work-123'
const HEADERS = { 'PRIVATE-TOKEN': TOKEN, Accept: 'application/json' }

/** A fetch that answers `answers[url]` and records each request's url and token. */
function network(answers: Record<string, { status: number; location?: string; body?: string }>) {
  const seen: { url: string; token?: string }[] = []
  const fetcher = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, token: init.headers['PRIVATE-TOKEN'] })
    const answer = answers[url] ?? { status: 404 }
    return new Response(answer.body ?? '', { status: answer.status, headers: answer.location ? { location: answer.location, 'X-Next-Page': '2' } : { 'X-Next-Page': '2' } })
  }) as unknown as typeof fetch
  return { seen, fetcher }
}

test('a redirect on the same host keeps the token, one to another host drops it, and headers come back lowercase', async () => {
  const { seen, fetcher } = network({
    'https://gitlab.example.com/api/v4/projects/1/jobs/2/trace': { status: 302, location: '/raw/2' },
    'https://gitlab.example.com/raw/2': { status: 302, location: 'https://storage.example.net/log?sig=x' },
    'https://storage.example.net/log?sig=x': { status: 200, body: 'log text' },
  })
  const response = await nodeFetch('https://gitlab.example.com/api/v4/projects/1/jobs/2/trace', { method: 'GET', headers: HEADERS }, fetcher)

  expect(response).toMatchObject({ status: 200, ok: true, text: 'log text', headers: { 'x-next-page': '2' } })
  expect(seen).toEqual([
    { url: 'https://gitlab.example.com/api/v4/projects/1/jobs/2/trace', token: TOKEN },
    { url: 'https://gitlab.example.com/raw/2', token: TOKEN },
    { url: 'https://storage.example.net/log?sig=x' },
  ])
})

test('redirects stop after three hops, answering the last one as it came', async () => {
  const hop = (n: number) => ({ status: 302, location: `https://gitlab.example.com/${n + 1}` })
  const { seen, fetcher } = network({ 'https://gitlab.example.com/0': hop(0), 'https://gitlab.example.com/1': hop(1), 'https://gitlab.example.com/2': hop(2), 'https://gitlab.example.com/3': hop(3) })
  const response = await nodeFetch('https://gitlab.example.com/0', { method: 'GET', headers: HEADERS }, fetcher)
  expect(response.status).toBe(302)
  expect(seen).toHaveLength(4)
})

test('a cross-origin redirect bounce back to the original host does not re-attach the token', async () => {
  const { seen, fetcher } = network({
    'https://gitlab.example.com/start': { status: 302, location: 'https://evil.example.net/bounce' },
    'https://evil.example.net/bounce': { status: 302, location: 'https://gitlab.example.com/secret' },
    'https://gitlab.example.com/secret': { status: 200, body: 'ok' },
  })
  const response = await nodeFetch('https://gitlab.example.com/start', { method: 'GET', headers: HEADERS }, fetcher)
  expect(response.status).toBe(200)
  expect(seen).toEqual([
    { url: 'https://gitlab.example.com/start', token: TOKEN },
    { url: 'https://evil.example.net/bounce' },
    { url: 'https://gitlab.example.com/secret' },
  ])
})

test('childEnv scrubs GitLab tokens while keeping normal environment variables', () => {
  const clean = childEnv({
    PATH: '/usr/bin',
    HOME: '/Users/example',
    GITLAB_MCP_TOKENS: 'gitlab.example.com=secret',
    GITLAB_TOKEN: 'glpat-1',
    GITLAB_PRIVATE_TOKEN: 'glpat-2',
    GL_TOKEN: 'glpat-3',
  })
  expect(clean).toEqual({
    PATH: '/usr/bin',
    HOME: '/Users/example',
  })
})

test('resolveCwd validates optional cwd and falls back when omitted', async () => {
  const isDir = async (p: string) => p === '/work/repo'
  expect(await resolveCwd(undefined, '/fallback', isDir)).toEqual({ cwd: '/fallback' })
  expect(await resolveCwd('/work/repo', '/fallback', isDir)).toEqual({ cwd: '/work/repo' })
  expect(await resolveCwd('relative/path', '/fallback', isDir)).toEqual({ error: 'cwd must be an absolute directory path.' })
  expect(await resolveCwd('   ', '/fallback', isDir)).toEqual({ error: 'cwd must be a non-empty absolute directory path.' })
  expect(await resolveCwd(123, '/fallback', isDir)).toEqual({ error: 'cwd must be a non-empty absolute directory path.' })
  expect(await resolveCwd('/missing/dir', '/fallback', isDir)).toEqual({ error: 'cwd is not an existing directory: /missing/dir' })
})
