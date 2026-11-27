// Concurrency-capped MCP App bridge: Antigravity enforces <= 4 in-flight `tools/call` requests per view.
// We reserve 1 dedicated slot for `claude_ui_poll` and 3 slots for interactive user actions so polling never starves clicks.
import type { App } from '@modelcontextprotocol/ext-apps'
import { z } from 'zod'
import { pathToFileUri } from './lib/triggers.ts'

const MAX_INTERACTIVE_IN_FLIGHT = 3
const ToggleAuxPaneResult = z.object({ isError: z.boolean().optional() }).passthrough()

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
  private readonly clientId: string
  private interactiveActive = 0
  private readonly interactiveQueue: (() => void)[] = []
  private pollInFlightCount = 0
  private activePollSessionId: string | null = null

  constructor(app: App) {
    this.app = app
    this.clientId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  get id(): string {
    return this.clientId
  }

  get capabilities() {
    const caps = this.app.getHostCapabilities() as Record<string, unknown> | undefined
    return {
      canMessage: Boolean(caps?.message),
      canUpdateContext: Boolean(caps?.updateModelContext),
      canOpenLinks: Boolean(caps?.openLinks),
    }
  }

  private async acquireInteractive(): Promise<void> {
    if (this.interactiveActive < MAX_INTERACTIVE_IN_FLIGHT) {
      this.interactiveActive++
      return
    }
    await new Promise<void>(resolve => this.interactiveQueue.push(resolve))
    this.interactiveActive++
  }

  private releaseInteractive(): void {
    this.interactiveActive = Math.max(0, this.interactiveActive - 1)
    const next = this.interactiveQueue.shift()
    if (next) next()
  }

  async callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResponse<T>> {
    await this.acquireInteractive()
    try {
      const result = await this.app.callServerTool({ name, arguments: args })
      const text = (result.content ?? [])
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
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
      this.releaseInteractive()
    }
  }

  async pollTool<T = Record<string, unknown>>(args: {
    sessionId?: string
    afterSeq?: number
    afterCatalogVersion?: number
    waitMs?: number
  }): Promise<ToolCallResponse<T>> {
    const pollKey = args.sessionId ?? '__catalog__'
    if (this.pollInFlightCount > 0 && (this.activePollSessionId === pollKey || this.pollInFlightCount >= 2)) {
      return { ok: false, text: 'Poll already active' }
    }
    this.pollInFlightCount++
    this.activePollSessionId = pollKey
    try {
      const result = await this.app.callServerTool({
        name: 'claude_ui_poll',
        arguments: { ...args, clientId: this.clientId },
      })
      const text = (result.content ?? [])
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n')
      if (result.isError) {
        return { ok: false, text: text || 'Poll failed.' }
      }
      return {
        ok: true,
        text,
        data: result.structuredContent as T | undefined,
      }
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) }
    } finally {
      this.pollInFlightCount = Math.max(0, this.pollInFlightCount - 1)
      if (this.pollInFlightCount === 0) this.activePollSessionId = null
    }
  }

  async openFile(absPath: string): Promise<boolean> {
    try {
      const uri = pathToFileUri(absPath)
      const res = await this.app.request(
        {
          method: 'com.google.antigravity/toggle-aux-pane',
          params: { tabType: 'fileView', uri },
        },
        ToggleAuxPaneResult,
      )
      return !res?.isError
    } catch {
      return false
    }
  }

  async sendMessage(text: string, opts?: { target?: 'new' }): Promise<SendMessageResult> {
    if (!this.capabilities.canMessage) return { ok: false }
    try {
      const payload: Record<string, unknown> = {
        role: 'user',
        content: [{ type: 'text', text }],
      }
      if (opts?.target === 'new') {
        payload._meta = { 'com.google.antigravity/message': { target: 'new' } }
      }
      const res = await this.app.sendMessage(payload as Parameters<App['sendMessage']>[0])
      if (res?.isError) return { ok: false }
      const meta = (res as { _meta?: Record<string, unknown> } | undefined)?._meta?.['com.google.antigravity/message']
      const conversationId =
        meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>).conversationId === 'string'
          ? ((meta as Record<string, unknown>).conversationId as string)
          : undefined
      return { ok: true, ...(conversationId ? { conversationId } : {}) }
    } catch {
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

  async openLink(url: string): Promise<void> {
    if (!this.capabilities.canOpenLinks || !/^https?:\/\//i.test(url)) return
    try {
      await this.app.openLink({ url })
    } catch {}
  }
}
