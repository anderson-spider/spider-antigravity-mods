// Concurrency-capped MCP App bridge: Antigravity allows at most 4 in-flight `tools/call` requests per app.
import type { App } from '@modelcontextprotocol/ext-apps'

const MAX_IN_FLIGHT = 4
const UNADVERTISED_MESSAGE_TIMEOUT_MS = 5000

export type ToolCallResponse<T = Record<string, unknown>> = {
  ok: boolean
  text: string
  data?: T
}

export type SendMessageResult = {
  ok: boolean
  conversationId?: string
}

export class ServerBridge {
  private readonly app: App
  private active = 0
  private readonly queue: (() => void)[] = []
  private messageProbe: 'unknown' | 'supported' | 'rejected' = 'unknown'

  constructor(app: App) {
    this.app = app
  }

  get capabilities() {
    const caps = this.app.getHostCapabilities() as Record<string, unknown> | undefined
    return {
      canMessage: Boolean(caps?.message),
      canUpdateContext: Boolean(caps?.updateModelContext),
      canOpenLinks: Boolean(caps?.openLinks),
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_IN_FLIGHT) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) next()
  }

  async callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResponse<T>> {
    await this.acquire()
    try {
      const result = await this.app.callServerTool({ name, arguments: args })
      const text = (result.content ?? [])
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
      if (result.isError) {
        return { ok: false, text: text || `Tool ${name} failed.` }
      }
      return {
        ok: true,
        text,
        data: result.structuredContent as T | undefined,
      }
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) }
    } finally {
      this.release()
    }
  }

  async openLink(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return
    try {
      await this.app.openLink({ url })
    } catch {}
  }

  async sendMessage(text: string, opts?: { target?: 'new'; allowUnadvertised?: boolean }): Promise<SendMessageResult> {
    const unadvertised = !this.capabilities.canMessage
    if (unadvertised && (!opts?.allowUnadvertised || this.messageProbe === 'rejected')) {
      return { ok: false }
    }
    try {
      const payload: Record<string, unknown> = {
        role: 'user',
        content: [{ type: 'text', text }],
      }
      if (opts?.target === 'new') {
        payload._meta = { 'com.google.antigravity/message': { target: 'new' } }
      }
      const probing = unadvertised && this.messageProbe !== 'supported'
      const res = probing
        ? await this.app.sendMessage(payload as Parameters<App['sendMessage']>[0], { timeout: UNADVERTISED_MESSAGE_TIMEOUT_MS })
        : await this.app.sendMessage(payload as Parameters<App['sendMessage']>[0])
      if (res?.isError) {
        if (unadvertised) this.messageProbe = 'rejected'
        return { ok: false }
      }
      if (unadvertised) this.messageProbe = 'supported'
      const meta = (res as { _meta?: Record<string, unknown> } | undefined)?._meta?.['com.google.antigravity/message']
      const conversationId =
        meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>).conversationId === 'string'
          ? ((meta as Record<string, unknown>).conversationId as string)
          : undefined
      return { ok: true, ...(conversationId ? { conversationId } : {}) }
    } catch {
      if (unadvertised) this.messageProbe = 'rejected'
      return { ok: false }
    }
  }

  async updateContext(text: string): Promise<boolean> {
    if (!this.capabilities.canUpdateContext) return false
    try {
      await this.app.updateModelContext({ content: text ? [{ type: 'text', text }] : [] })
      return true
    } catch {
      return false
    }
  }
}
