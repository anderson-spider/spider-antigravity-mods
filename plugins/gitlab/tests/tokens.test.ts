import { expect, test } from './expect.ts'
import { DEFAULT_HOST_ENV, ENV_NAME, configuredHosts, offText, parseTokens, resolveToken, type Off } from '../server/tokens.ts'

const OPTION = 'gitlab.com=glpat-personal, gitlab.example.com=glpat-work'

test('parseTokens reads host=token pairs separated by commas or whitespace, hosts case-insensitive', () => {
  expect(parseTokens(` GitLab.com=glpat-a\ngitlab.example.com:8443=glpat-b `)).toEqual({
    tokens: new Map([
      ['gitlab.com', 'glpat-a'],
      ['gitlab.example.com:8443', 'glpat-b'],
    ]),
  })
})

test('parseTokens tells an absent value from a malformed one', () => {
  expect(parseTokens(undefined)).toEqual({ off: 'no-tokens' })
  expect(parseTokens(' , ')).toEqual({ off: 'no-tokens' })
  for (const bad of [5, 'glpat-only', '=glpat-x', 'gitlab.com=', 'gitlab.com=a=b', 'a b.com=x', 'h=x,h=y', 'h/x=t']) {
    expect(parseTokens(bad), String(bad)).toEqual({ off: 'bad-tokens' })
  }
})

test('configuredHosts returns only host names or the parse refusal', () => {
  expect(configuredHosts(OPTION)).toEqual({ hosts: ['gitlab.com', 'gitlab.example.com'] })
  expect(configuredHosts(undefined)).toEqual({ off: 'no-tokens' })
  expect(configuredHosts('bad')).toEqual({ off: 'bad-tokens' })
})

test('resolveToken picks the token of the remote host only and lists configured hosts on no-host', () => {
  expect(resolveToken(OPTION, 'gitlab.example.com')).toEqual({ token: 'glpat-work' })
  expect(resolveToken(OPTION, 'gitlab.com')).toEqual({ token: 'glpat-personal' })
  expect(resolveToken(OPTION, 'gitlab.other.org')).toEqual({ off: 'no-host', hosts: ['gitlab.com', 'gitlab.example.com'] })
  expect(resolveToken(undefined, 'gitlab.com')).toEqual({ off: 'no-tokens' })
  expect(resolveToken('glpat-only', 'gitlab.com')).toEqual({ off: 'bad-tokens' })
})

test('every refusal names GITLAB_MCP_TOKENS, never a token, and no-host names the host and configured hosts', () => {
  for (const off of ['no-tokens', 'bad-tokens', 'no-host'] as Off[]) {
    expect(offText(off, 'gitlab.other.org', ['gitlab.com', 'gitlab.example.com'])).toContain(ENV_NAME)
    expect(offText(off, 'gitlab.other.org', ['gitlab.com', 'gitlab.example.com'])).not.toContain('glpat-personal')
  }
  const noHost = offText('no-host', 'gitlab.other.org', ['gitlab.com', 'gitlab.example.com'])
  expect(noHost).toContain('Add gitlab.other.org=<token>')
  expect(noHost).toContain('Configured hosts: gitlab.com, gitlab.example.com.')
  expect(noHost).toContain(DEFAULT_HOST_ENV)
})
