// Binary discovery cascade for @agentclientprotocol/claude-agent-acp.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { redactSecrets } from './redact.ts'

export type BinarySource = 'env' | 'path' | 'npx'

export type BinaryResolution = {
  command: string
  args: readonly string[]
  source: BinarySource
  display: string
}

export type BinaryDeps = {
  env?: Record<string, string | undefined>
  isExecutable?: (filePath: string) => boolean
  platform?: NodeJS.Platform
  execPath?: string
}

function defaultIsExecutable(filePath: string): boolean {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Splits a shell-style argument override string into individual args. */
export function parseArgString(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return []
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const ch of raw) {
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch
      continue
    }
    if (quote && ch === quote) {
      quote = null
      continue
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) args.push(current)
  return args
}

function findOnPath(
  name: string,
  pathEnv: string | undefined,
  isExecutable: (filePath: string) => boolean,
  platform: NodeJS.Platform,
): string | undefined {
  if (!pathEnv) return undefined
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of pathEnv.split(delimiter)) {
    const trimmed = dir.trim()
    if (!trimmed) continue
    for (const ext of exts) {
      const candidate = join(trimmed, `${name}${ext}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

function findSiblingBin(
  name: string,
  execPath: string,
  isExecutable: (filePath: string) => boolean,
  platform: NodeJS.Platform,
): string | undefined {
  const dir = dirname(execPath)
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const ext of exts) {
    const candidate = join(dir, `${name}${ext}`)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

export function resolveAcpBinary(deps: BinaryDeps = {}): BinaryResolution {
  const env = deps.env ?? process.env
  const isExecutable = deps.isExecutable ?? defaultIsExecutable
  const platform = deps.platform ?? process.platform
  const execPath = deps.execPath ?? process.execPath

  const envBin = env.CLAUDE_AGENT_ACP_BIN?.trim()
  const extraArgs = parseArgString(env.CLAUDE_AGENT_ACP_ARGS)

  if (envBin) {
    const hasSeparator = envBin.includes('/') || envBin.includes('\\')
    if (hasSeparator || isAbsolute(envBin)) {
      if (!isExecutable(envBin)) {
        throw new Error(`CLAUDE_AGENT_ACP_BIN points to a missing or non-executable file: ${envBin}`)
      }
      const args = extraArgs
      return {
        command: envBin,
        args,
        source: 'env',
        display: redactSecrets([envBin, ...args].join(' ')),
      }
    }
    const found = findOnPath(envBin, env.PATH, isExecutable, platform)
    if (!found) {
      throw new Error(`CLAUDE_AGENT_ACP_BIN command "${envBin}" was not found on PATH.`)
    }
    return {
      command: found,
      args: extraArgs,
      source: 'env',
      display: redactSecrets([found, ...extraArgs].join(' ')),
    }
  }

  const onPath = findOnPath('claude-agent-acp', env.PATH, isExecutable, platform)
  if (onPath) {
    return {
      command: onPath,
      args: extraArgs,
      source: 'path',
      display: redactSecrets([onPath, ...extraArgs].join(' ')),
    }
  }

  const npxBin =
    findSiblingBin('npx', execPath, isExecutable, platform) ??
    findOnPath('npx', env.PATH, isExecutable, platform)
  if (npxBin) {
    const args = ['-y', '@agentclientprotocol/claude-agent-acp', ...extraArgs]
    return {
      command: npxBin,
      args,
      source: 'npx',
      display: redactSecrets([npxBin, ...args].join(' ')),
    }
  }

  throw new Error(
    'Could not locate claude-agent-acp or npx on PATH. Install @agentclientprotocol/claude-agent-acp globally or set CLAUDE_AGENT_ACP_BIN.',
  )
}
