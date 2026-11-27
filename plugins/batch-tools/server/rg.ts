// Hardened child-process execution for ripgrep (`rg`) with shell: false,
// scrubbed credential environments, bounded output capture, clean timeout kills,
// and redacted stderr/errors.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { redactSecrets, scrubChildEnv } from './redact.ts'

export interface ExecResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  error?: string
}

export interface ExecOptions {
  cwd: string
  timeoutMs: number
  maxOutputBytes?: number
  env?: NodeJS.ProcessEnv
}

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024 // 1 MiB

function stripTrailingIncompleteUtf8(buf: Buffer): Buffer {
  if (buf.length === 0) return buf
  let i = buf.length - 1
  const minIdx = Math.max(0, buf.length - 4)
  while (i >= minIdx && (buf[i]! & 0xc0) === 0x80) {
    i--
  }
  if (i < minIdx) return buf
  const lead = buf[i]!
  if ((lead & 0x80) === 0) return buf
  let expectedLen = 0
  if ((lead & 0xe0) === 0xc0) expectedLen = 2
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4
  else return buf
  return buf.length - i < expectedLen ? buf.subarray(0, i) : buf
}

function decodeUtf8Buffer(buf: Buffer, truncated: boolean): string {
  if (buf.length === 0) return ''
  const candidate = truncated ? stripTrailingIncompleteUtf8(buf) : buf
  return candidate.toString('utf8')
}

function killChildTree(pid: number | undefined, detached: boolean): NodeJS.Timeout | null {
  if (!pid) return null
  if (process.platform === 'win32') {
    const fallbackKill = (): void => {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Process already exited.
      }
    }
    try {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || ''
      const taskkillBin = systemRoot
        ? path.join(systemRoot, 'System32', 'taskkill.exe')
        : 'taskkill.exe'
      const killer = spawn(taskkillBin, ['/PID', String(pid), '/T', '/F'], {
        cwd: systemRoot || os.tmpdir(),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        env: scrubChildEnv(),
      })
      killer.on('error', fallbackKill)
      killer.unref()
    } catch {
      fallbackKill()
    }
    return null
  }

  try {
    process.kill(detached ? -pid : pid, 'SIGTERM')
  } catch {
    // Process already exited.
  }
  const sigkillTimer = setTimeout(() => {
    try {
      process.kill(detached ? -pid : pid, 'SIGKILL')
    } catch {
      // Process already exited.
    }
  }, 400)
  sigkillTimer.unref()
  return sigkillTimer
}

/**
 * Executes a binary directly without a shell (`shell: false`), scrubbing
 * sensitive environment variables, bounding captured stdout/stderr bytes,
 * killing the process tree cleanly on timeout, and redacting stderr/errors.
 */
export function execBinaryAsync(
  cmd: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const startMs = Date.now()
  const maxOutputBytes =
    options.maxOutputBytes !== undefined && Number.isFinite(options.maxOutputBytes)
      ? Math.max(0, Math.trunc(options.maxOutputBytes))
      : DEFAULT_MAX_OUTPUT_BYTES
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.max(50, Math.trunc(options.timeoutMs))
      : 50
  const detached = process.platform !== 'win32'
  const cleanEnv = scrubChildEnv(options.env)

  return new Promise<ExecResult>((resolve) => {
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let settled = false

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    let child
    try {
      child = spawn(cmd, [...args], {
        cwd: options.cwd,
        shell: false,
        detached,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cleanEnv,
      })
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startMs,
        stdout: '',
        stderr: '',
        truncated: false,
        error: redactSecrets(err instanceof Error ? err.message : String(err)),
      })
      return
    }

    let settleFallbackTimer: NodeJS.Timeout | null = null
    let sigkillTimer: NodeJS.Timeout | null = null

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer)
      const stdout = decodeUtf8Buffer(Buffer.concat(stdoutChunks), stdoutTruncated)
      const stderr = redactSecrets(
        decodeUtf8Buffer(Buffer.concat(stderrChunks), stderrTruncated),
      )
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout,
        stderr,
        truncated: stdoutTruncated || stderrTruncated,
        ...(error !== undefined ? { error: redactSecrets(error) } : {}),
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      sigkillTimer = killChildTree(child.pid, detached)
      settleFallbackTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null, 'SIGKILL')
      }, 1500)
      settleFallbackTimer.unref()
    }, timeoutMs)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) {
        stdoutTruncated = true
        return
      }
      const remaining = maxOutputBytes - stdoutBytes
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining))
        stdoutBytes += remaining
        stdoutTruncated = true
      } else {
        stdoutChunks.push(chunk)
        stdoutBytes += chunk.length
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxOutputBytes) {
        stderrTruncated = true
        return
      }
      const remaining = maxOutputBytes - stderrBytes
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining))
        stderrBytes += remaining
        stderrTruncated = true
      } else {
        stderrChunks.push(chunk)
        stderrBytes += chunk.length
      }
    })

    child.on('error', (err) => {
      finish(null, null, err.message)
    })

    child.on('close', (code, signal) => {
      finish(code, signal)
    })
  })
}

let cachedRgAvailable: boolean | null = null
let pendingRgProbe: Promise<boolean> | null = null

/**
 * Probes whether `rg` (ripgrep) is executable on PATH, caching the result
 * across calls (without caching transient timeouts).
 */
export async function isRipgrepAvailable(): Promise<boolean> {
  if (cachedRgAvailable !== null) return cachedRgAvailable
  if (pendingRgProbe) return pendingRgProbe

  let probe: Promise<boolean> | null = null
  probe = (async () => {
    try {
      const res = await execBinaryAsync('rg', ['--version'], {
        cwd: os.tmpdir(),
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      })
      const available = !res.error && !res.timedOut && res.exitCode === 0
      if (!res.timedOut && pendingRgProbe === probe) {
        cachedRgAvailable = available
      }
      return available
    } finally {
      if (pendingRgProbe === probe) {
        pendingRgProbe = null
      }
    }
  })()

  pendingRgProbe = probe
  return probe
}

/** Clears the cached ripgrep availability probe (for testing). */
export function resetRipgrepCache(): void {
  cachedRgAvailable = null
  pendingRgProbe = null
}
