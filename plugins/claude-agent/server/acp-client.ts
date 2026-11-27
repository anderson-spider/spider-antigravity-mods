// Decoupled JSON-RPC 2.0 over stdio client for ACP subprocesses (claude-agent-acp).
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { redactSecrets } from './redact.ts'

export type AcpClientDeps = {
  command: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  spawn?: typeof nodeSpawn
  defaultTimeoutMs?: number
  onNotification?: (method: string, params: Record<string, unknown>) => void
  onRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string[] }) => void
  onLog?: (line: string) => void
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

function formatErrorData(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined
  if (typeof data === 'string') {
    const trimmed = data.trim()
    return trimmed ? redactSecrets(trimmed.slice(0, 500)) : undefined
  }
  if (typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    for (const key of ['details', 'message', 'error', 'reason']) {
      const val = obj[key]
      if (typeof val === 'string' && val.trim()) {
        return redactSecrets(val.trim().slice(0, 500))
      }
    }
  }
  try {
    const json = JSON.stringify(data)
    return json ? redactSecrets(json.slice(0, 500)) : undefined
  } catch {
    return undefined
  }
}

export class AcpRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'AcpRpcError'
    this.code = code
    this.data = data
  }
}

export class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly defaultTimeoutMs: number
  private readonly pending = new Map<number, PendingRequest>()
  private readonly stderrLines: string[] = []
  private readonly deps: AcpClientDeps
  private nextId = 1
  private closed = false
  private disposed = false

  constructor(deps: AcpClientDeps) {
    this.deps = deps
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? 30_000
    const spawnFn = deps.spawn ?? nodeSpawn

    this.child = spawnFn(deps.command, [...deps.args], {
      cwd: deps.cwd,
      env: deps.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform === 'win32' && /\.(cmd|bat)$/i.test(deps.command) ? { shell: true } : {}),
    })

    this.child.stdin.on('error', err => {
      this.deps.onLog?.(`acp stdin error: ${redactSecrets(err.message)}`)
    })

    createInterface({ input: this.child.stdout }).on('line', line => {
      this.handleStdoutLine(line)
    })

    createInterface({ input: this.child.stderr }).on('line', line => {
      const masked = redactSecrets(line)
      this.stderrLines.push(masked)
      if (this.stderrLines.length > 50) this.stderrLines.shift()
      this.deps.onLog?.(`acp stderr: ${masked}`)
    })

    this.child.on('error', err => {
      this.closed = true
      const msg = redactSecrets(err.message)
      this.stderrLines.push(msg)
      if (this.stderrLines.length > 50) this.stderrLines.shift()
      this.failAllPending(new Error(`ACP process error: ${msg}`))
    })

    this.child.on('exit', (code, signal) => {
      this.closed = true
      const reason = `ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      this.failAllPending(new Error(reason))
      if (!this.disposed) {
        this.deps.onExit?.({ code, signal, stderrTail: [...this.stderrLines] })
      }
    })
  }

  get isAlive(): boolean {
    return !this.closed && !this.disposed
  }

  getStderrTail(): string[] {
    return [...this.stderrLines]
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.isAlive) {
      return Promise.reject(new Error('ACP process is not running.'))
    }
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      this.writeMessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.isAlive) return
    this.writeMessage({ jsonrpc: '2.0', method, params })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.failAllPending(new Error('ACP client disposed'))
    try {
      this.child.stdin.end()
    } catch {}
    if (this.closed) return
    await new Promise<void>(resolve => {
      const killTimer = setTimeout(() => {
        try {
          this.child.kill('SIGKILL')
        } catch {}
        resolve()
      }, 1_500)
      this.child.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      try {
        this.child.kill('SIGTERM')
      } catch {
        clearTimeout(killTimer)
        resolve()
      }
    })
  }

  private writeMessage(payload: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.onLog?.(`acp write failed: ${redactSecrets(msg)}`)
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.deps.onLog?.(`acp non-json stdout: ${redactSecrets(line.slice(0, 300))}`)
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const msg = raw as {
      id?: unknown
      method?: unknown
      params?: unknown
      result?: unknown
      error?: { code?: unknown; message?: unknown; data?: unknown }
    }

    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string'
    if (typeof msg.method !== 'string') {
      if (typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        if (entry.timer) clearTimeout(entry.timer)
        if (msg.error) {
          const code = typeof msg.error.code === 'number' ? msg.error.code : -32603
          const baseMessage = redactSecrets(typeof msg.error.message === 'string' ? msg.error.message : 'ACP error')
          const detail = formatErrorData(msg.error.data)
          const fullMessage = detail && !baseMessage.includes(detail) ? `${baseMessage}: ${detail}` : baseMessage
          entry.reject(new AcpRpcError(code, fullMessage, msg.error.data))
        } else {
          entry.resolve(msg.result)
        }
      }
      return
    }

    const params =
      msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
        ? (msg.params as Record<string, unknown>)
        : {}

    if (!hasId || msg.id === null) {
      this.deps.onNotification?.(msg.method, params)
      return
    }

    const requestId = msg.id as string | number
    if (!this.deps.onRequest) {
      this.writeMessage({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      })
      return
    }

    void this.deps
      .onRequest(msg.method, params)
      .then(result => {
        if (!this.disposed && !this.closed) {
          this.writeMessage({ jsonrpc: '2.0', id: requestId, result: result ?? {} })
        }
      })
      .catch(err => {
        if (!this.disposed && !this.closed) {
          const code = err instanceof AcpRpcError ? err.code : -32603
          const message = redactSecrets(err instanceof Error ? err.message : String(err))
          this.writeMessage({
            jsonrpc: '2.0',
            id: requestId,
            error: { code, message },
          })
        }
      })
  }
}
