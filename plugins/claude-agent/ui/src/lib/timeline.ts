import { basenameOf } from './triggers.ts'
import type { PollEvent, SessionSnapshot, TimelineItem } from '../types.ts'

export type TimelineEntry =
  | { kind: 'item'; key: string; item: TimelineItem }
  | { kind: 'tool_group'; key: string; items: TimelineItem[] }

export function stripCwdPrefix(text: string, cwd?: string): string {
  if (!cwd) return text
  const normalizedCwd = cwd.replace(/\/+$/, '')
  if (!normalizedCwd) return text
  // Replace occurrences of `/abs/cwd/` with empty string so relative paths read cleanly
  const withSlash = `${normalizedCwd}/`
  return text.split(withSlash).join('').split(normalizedCwd).join('.')
}

const TOOL_KIND_VERBS: Record<string, string> = {
  read: 'Read',
  search: 'Search',
  edit: 'Edit',
  write: 'Write',
  delete: 'Delete',
  move: 'Move',
  execute: 'Run',
  fetch: 'Fetch',
  think: 'Think',
}

export function formatToolTitle(item: TimelineItem, cwd?: string): { verb: string; detail: string } {
  const cleaned = stripCwdPrefix((item.title || 'Tool call').trim(), cwd)
  const kindKey = (item.toolKind ?? '').toLowerCase()

  const verbMatch = cleaned.match(/^(Read|Search|Edit|Write|Execute|Run|Delete|Move|Fetch|List|Glob|Grep)\b[:\s-]*(.*)$/i)
  if (verbMatch && verbMatch[1]) {
    const verb = verbMatch[1][0]!.toUpperCase() + verbMatch[1].slice(1).toLowerCase()
    const detail = (verbMatch[2] ?? '').trim() || (item.locations?.[0] ? stripCwdPrefix(item.locations[0].path, cwd) : '')
    return { verb, detail }
  }

  const mappedVerb = TOOL_KIND_VERBS[kindKey] ?? (kindKey ? kindKey[0]!.toUpperCase() + kindKey.slice(1) : 'Tool')
  return {
    verb: mappedVerb,
    detail: cleaned || (item.locations?.[0] ? basenameOf(item.locations[0].path) : ''),
  }
}

export type ToolGroupSummary = {
  label: string
  activeTitle?: string
  total: number
  running: number
  completed: number
}

export function summarizeToolGroup(items: TimelineItem[], cwd?: string): ToolGroupSummary {
  const total = items.length
  let running = 0
  let completed = 0
  let activeItem: TimelineItem | undefined
  const kinds = new Set<string>()

  for (const item of items) {
    const st = item.status ?? 'pending'
    if (st === 'completed') {
      completed++
    } else if (st === 'in_progress' || st === 'pending') {
      running++
      activeItem = item
    }
    const { verb } = formatToolTitle(item, cwd)
    kinds.add((item.toolKind || verb).toLowerCase())
  }

  let label: string
  if (kinds.size === 1) {
    const only = [...kinds][0]!
    if (only === 'read') label = `Read ${total} files`
    else if (only === 'search' || only === 'grep' || only === 'glob') label = `Searched ${total} targets`
    else if (only === 'execute' || only === 'run') label = `Ran ${total} commands`
    else if (only === 'fetch') label = `Fetched ${total} resources`
    else if (only === 'edit' || only === 'write') label = `Updated ${total} files`
    else label = `${total} ${only} calls`
  } else {
    const allPassive = [...kinds].every(k => k === 'read' || k === 'search' || k === 'grep' || k === 'glob' || k === 'list')
    label = allPassive ? `Inspected ${total} items` : `Ran ${total} tool calls`
  }

  const activeTitle = activeItem
    ? (() => {
        const formatted = formatToolTitle(activeItem, cwd)
        return formatted.detail ? `${formatted.verb} ${formatted.detail}` : formatted.verb
      })()
    : undefined

  return {
    label,
    ...(activeTitle ? { activeTitle } : {}),
    total,
    running,
    completed,
  }
}

function isGroupableToolCall(item: TimelineItem): boolean {
  if (item.kind !== 'tool_call') return false
  if (item.diffs && item.diffs.length > 0) return false
  if (item.status === 'failed') return false
  return true
}

export function buildTimelineEntries(items: TimelineItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let buffer: TimelineItem[] = []

  const flush = () => {
    if (buffer.length === 0) return
    if (buffer.length === 1) {
      const only = buffer[0]!
      entries.push({ kind: 'item', key: only.id, item: only })
    } else {
      entries.push({
        kind: 'tool_group',
        key: `group:${buffer[0]!.id}`,
        items: buffer,
      })
    }
    buffer = []
  }

  for (const item of items) {
    if (isGroupableToolCall(item)) {
      buffer.push(item)
    } else {
      flush()
      entries.push({ kind: 'item', key: item.id, item })
    }
  }
  flush()

  return entries
}

export function applyPollEvents(prev: SessionSnapshot, events: PollEvent[], latestSeq: number): SessionSnapshot {
  let next: SessionSnapshot = {
    ...prev,
    items: [...prev.items],
    pendingPermissions: [...prev.pendingPermissions],
    latestSeq: Math.max(prev.latestSeq, latestSeq),
  }

  for (const ev of events) {
    if (ev.sessionId !== next.sessionId) continue
    switch (ev.type) {
      case 'timeline_upsert': {
        const idx = next.items.findIndex(i => i.id === ev.item.id)
        if (idx >= 0) {
          next.items[idx] = ev.item
        } else {
          next.items.push(ev.item)
        }
        break
      }
      case 'plan_update':
        next.plan = ev.plan
        break
      case 'commands_update':
        next.availableCommands = ev.commands
        break
      case 'session_meta':
        next = {
          ...next,
          ...ev.summary,
          // Explicitly sync optional fields that may be cleared (omitted) in ev.summary
          archivedAt: ev.summary.archivedAt,
          modeId: ev.summary.modeId,
          modelId: ev.summary.modelId,
          usage: ev.summary.usage,
          ...(ev.availableModes ? { availableModes: ev.availableModes } : {}),
          ...(ev.availableModels ? { availableModels: ev.availableModels } : {}),
          ...(ev.configOptions ? { configOptions: ev.configOptions } : {}),
          ...(ev.touchedFiles ? { touchedFiles: ev.touchedFiles } : {}),
        }
        break
      case 'permission_request':
        if (!next.pendingPermissions.some(p => p.requestId === ev.permission.requestId)) {
          next.pendingPermissions.push(ev.permission)
          next.pendingPermissionCount = next.pendingPermissions.length
        }
        break
      case 'permission_resolved':
        next.pendingPermissions = next.pendingPermissions.filter(p => p.requestId !== ev.requestId)
        next.pendingPermissionCount = next.pendingPermissions.length
        break
      case 'turn_finished':
        next.status = ev.error ? 'error' : 'idle'
        next.items = next.items.map(item => (item.streaming ? { ...item, streaming: false } : item))
        break
    }
  }
  return next
}
