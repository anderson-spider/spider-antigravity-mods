// Concurrency-capped MCP App bridge: Antigravity allows at most 4 in-flight `tools/call` requests per app.
import type { App } from '@modelcontextprotocol/ext-apps'

const MAX_IN_FLIGHT = 4

export type ToolCallResponse<T = Record<string, unknown>> = {
  ok: boolean
  text: string
  data?: T
}

export class ServerBridge {
  private readonly app: App
  private active = 0
  private readonly queue: (() => void)[] = []

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

  async sendMessage(text: string): Promise<boolean> {
    if (!this.capabilities.canMessage) return false
    try {
      const res = await this.app.sendMessage({ role: 'user', content: [{ type: 'text', text }] })
      return !res.isError
    } catch {
      return false
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
