import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgString, resolveAcpBinary } from '../server/binary.ts'

test('parseArgString handles quotes and escapes', () => {
  assert.deepEqual(parseArgString(undefined), [])
  assert.deepEqual(parseArgString('--flag "hello world" \'single arg\' plain\\ arg'), [
    '--flag',
    'hello world',
    'single arg',
    'plain arg',
  ])
})

test('resolveAcpBinary prefers CLAUDE_AGENT_ACP_BIN over PATH and npx', () => {
  const res = resolveAcpBinary({
    env: {
      CLAUDE_AGENT_ACP_BIN: '/custom/bin/claude-agent-acp',
      CLAUDE_AGENT_ACP_ARGS: '--stdio --verbose',
      PATH: '/usr/bin',
    },
    isExecutable: p => p === '/custom/bin/claude-agent-acp' || p === '/usr/bin/claude-agent-acp',
    platform: 'linux',
  })
  assert.equal(res.source, 'env')
  assert.equal(res.command, '/custom/bin/claude-agent-acp')
  assert.deepEqual(res.args, ['--stdio', '--verbose'])
})

test('resolveAcpBinary fails fast when CLAUDE_AGENT_ACP_BIN points to missing file', () => {
  assert.throws(
    () =>
      resolveAcpBinary({
        env: { CLAUDE_AGENT_ACP_BIN: '/nope/missing' },
        isExecutable: () => false,
      }),
    /CLAUDE_AGENT_ACP_BIN/,
  )
})

test('resolveAcpBinary finds claude-agent-acp on PATH before npx', () => {
  const res = resolveAcpBinary({
    env: { PATH: '/opt/bin:/usr/local/bin' },
    isExecutable: p => p === '/opt/bin/claude-agent-acp' || p === '/usr/local/bin/npx',
    platform: 'darwin',
  })
  assert.equal(res.source, 'path')
  assert.equal(res.command, '/opt/bin/claude-agent-acp')
  assert.deepEqual(res.args, [])
})

test('resolveAcpBinary falls back to npx -y @agentclientprotocol/claude-agent-acp', () => {
  const res = resolveAcpBinary({
    env: { PATH: '/usr/local/bin' },
    isExecutable: p => p === '/usr/local/bin/npx',
    platform: 'darwin',
    execPath: '/custom/node/bin/node',
  })
  assert.equal(res.source, 'npx')
  assert.equal(res.command, '/usr/local/bin/npx')
  assert.deepEqual(res.args, ['-y', '@agentclientprotocol/claude-agent-acp'])
})

test('resolveAcpBinary prefers sibling npx next to execPath ahead of PATH shims', () => {
  const res = resolveAcpBinary({
    env: { PATH: '/home/user/.local/share/mise/shims:/opt/homebrew/bin' },
    isExecutable: p =>
      p === '/home/user/.local/share/mise/shims/npx' || p === '/opt/homebrew/bin/npx',
    platform: 'darwin',
    execPath: '/opt/homebrew/bin/node',
  })
  assert.equal(res.source, 'npx')
  assert.equal(res.command, '/opt/homebrew/bin/npx')
})

test('resolveAcpBinary throws clear error when neither binary nor npx exists', () => {
  assert.throws(
    () =>
      resolveAcpBinary({
        env: { PATH: '/empty' },
        isExecutable: () => false,
        platform: 'linux',
      }),
    /Install @agentclientprotocol\/claude-agent-acp/,
  )
})
