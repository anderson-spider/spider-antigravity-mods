import { useEffect, useMemo, useRef, useState } from 'react'
import { computeLineDiff } from '../lib/diff.ts'
import { MarkdownView } from '../lib/markdown.tsx'
import { buildTimelineEntries, formatToolTitle, stripCwdPrefix, summarizeToolGroup } from '../lib/timeline.ts'
import { basenameOf, formatPromptPreview } from '../lib/triggers.ts'
import type { PermissionRequestState, PlanEntry, SessionSnapshot, TimelineDiff, TimelineItem } from '../types.ts'
import { ArrowDownIcon, FileIcon, ShieldIcon } from './Icons.tsx'

type ChatThreadProps = {
  session: SessionSnapshot
  hasEarlierItems?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
  onOpenFile: (absPath: string) => void
  onOpenLink: (url: string) => void
  onResolvePermission: (requestId: string, outcome: 'selected' | 'cancelled', optionId?: string) => void
  permissionBusyId: string | null
}

function PlanBanner({ plan }: { plan: PlanEntry[] }) {
  if (plan.length === 0) return null
  const completed = plan.filter(p => p.status === 'completed').length

  return (
    <details className="plan-banner">
      <summary className="plan-banner-summary">
        <span className="plan-banner-title">Plan</span>
        <span className="meta-counter mono">{completed}/{plan.length}</span>
      </summary>
      <ul className="plan-list">
        {plan.map((step, idx) => (
          <li key={idx} className={`plan-step plan-${step.status}`}>
            <span className="plan-step-dot" />
            <span>{step.content}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function DiffBlock({ diff, onOpenFile }: { diff: TimelineDiff; onOpenFile: (absPath: string) => void }) {
  const lines = computeLineDiff(diff.oldText, diff.newText)
  return (
    <div className="diff-card">
      <div className="diff-header">
        <button type="button" className="file-chip" onClick={() => onOpenFile(diff.path)} title={diff.path}>
          <FileIcon size={12} />
          <span className="mono">{basenameOf(diff.path)}</span>
        </button>
      </div>
      <div className="diff-lines mono">
        {lines.map((line, idx) => (
          <div key={idx} className={`diff-line diff-${line.type}`}>
            <span className="diff-ln">{line.oldLine ?? ''}</span>
            <span className="diff-ln">{line.newLine ?? ''}</span>
            <span className="diff-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
            <span className="diff-code">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PromptDispatch({ item }: { item: TimelineItem }) {
  const text = item.text ?? ''
  const { isLong, lineCount } = formatPromptPreview(text)
  const firstLine = text.replace(/\r\n/g, '\n').trim().split('\n')[0] ?? ''

  if (!isLong) {
    return (
      <div className="prompt-block">
        <div className="prompt-eyebrow">Prompt</div>
        <div className="prompt-body">{text}</div>
      </div>
    )
  }

  return (
    <details className="prompt-block prompt-collapsible">
      <summary className="prompt-summary">
        <span className="prompt-summary-content">
          <span className="prompt-eyebrow">Prompt</span>
          <span className="prompt-preview-line truncate">{firstLine}</span>
        </span>
        <span className="meta-counter mono">{lineCount} lines</span>
      </summary>
      <div className="prompt-body prompt-body-expanded">{text}</div>
    </details>
  )
}

function ThoughtBlock({ item }: { item: TimelineItem }) {
  const isStreaming = Boolean(item.streaming)
  const [expanded, setExpanded] = useState(isStreaming)
  const prevStreamingRef = useRef(isStreaming)

  useEffect(() => {
    if (isStreaming && !prevStreamingRef.current) {
      setExpanded(true)
    } else if (!isStreaming && prevStreamingRef.current) {
      setExpanded(false)
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming])

  return (
    <details
      className="thought-details"
      open={expanded}
      onToggle={e => setExpanded(e.currentTarget.open)}
    >
      <summary className="thought-summary">
        <span>{isStreaming ? 'Thinking…' : 'Thought process'}</span>
      </summary>
      {item.text && <div className="thought-body">{item.text}</div>}
    </details>
  )
}

function ToolRowDetails({
  item,
  cwd,
  onOpenFile,
}: {
  item: TimelineItem
  cwd: string
  onOpenFile: (absPath: string) => void
}) {
  const status = item.status ?? 'pending'
  const { verb, detail } = formatToolTitle(item, cwd)
  const hasBody = Boolean(item.rawInput || item.rawOutput || (item.locations && item.locations.length > 0))
  const firstLoc = item.locations?.[0]

  if (!hasBody) {
    return (
      <div className={`tool-subrow tool-subrow-${status}`}>
        <span className={`tool-dot tool-dot-${status}`} aria-label={status} />
        <span className="tool-verb">{verb}</span>
        <span className="tool-detail mono truncate">{detail}</span>
      </div>
    )
  }

  return (
    <details className={`tool-subrow-details tool-subrow-${status}`}>
      <summary className="tool-subrow-summary">
        <span className={`tool-dot tool-dot-${status}`} aria-label={status} />
        <span className="tool-verb">{verb}</span>
        <span className="tool-detail mono truncate">{detail}</span>
        {firstLoc && (
          <button
            type="button"
            className="row-file-jump"
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
              onOpenFile(firstLoc.path)
            }}
            title={`Open ${firstLoc.path}`}
            aria-label={`Open ${basenameOf(firstLoc.path)}`}
          >
            <FileIcon size={11} />
          </button>
        )}
      </summary>
      <div className="tool-subrow-body">
        {item.locations && item.locations.length > 0 && (
          <div className="tool-locations">
            {item.locations.map(loc => (
              <button
                key={`${loc.path}:${loc.line ?? ''}`}
                type="button"
                className="file-chip"
                onClick={() => onOpenFile(loc.path)}
                title={loc.path}
              >
                <FileIcon size={11} />
                <span className="mono">
                  {stripCwdPrefix(loc.path, cwd)}
                  {loc.line ? `:${loc.line}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}
        {item.rawInput && (
          <div className="tool-io">
            <div className="tool-io-label">Input</div>
            <pre className="tool-io-pre mono">{item.rawInput}</pre>
          </div>
        )}
        {item.rawOutput && (
          <div className="tool-io">
            <div className="tool-io-label">Output</div>
            <pre className="tool-io-pre mono">{item.rawOutput}</pre>
          </div>
        )}
      </div>
    </details>
  )
}

function ToolActivityGroup({
  items,
  cwd,
  onOpenFile,
}: {
  items: TimelineItem[]
  cwd: string
  onOpenFile: (absPath: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const summary = summarizeToolGroup(items, cwd)
  const isRunning = summary.running > 0

  return (
    <details
      className={`tool-group ${isRunning ? 'is-running' : ''}`}
      open={expanded}
      onToggle={e => setExpanded(e.currentTarget.open)}
    >
      <summary className="tool-group-summary">
        <span className={`tool-dot ${isRunning ? 'tool-dot-in_progress' : 'tool-dot-completed'}`} />
        <span className="tool-group-label">{summary.label}</span>
        {summary.activeTitle && (
          <span className="tool-group-active mono truncate">{summary.activeTitle}</span>
        )}
        <span className="meta-counter mono">
          {isRunning ? `${summary.completed}/${summary.total}` : `${summary.completed}`}
        </span>
      </summary>
      <div className="tool-group-list">
        {items.map(item => (
          <ToolRowDetails key={item.id} item={item} cwd={cwd} onOpenFile={onOpenFile} />
        ))}
      </div>
    </details>
  )
}

function ToolCallCard({
  item,
  cwd,
  onOpenFile,
}: {
  item: TimelineItem
  cwd: string
  onOpenFile: (absPath: string) => void
}) {
  const hasDiffs = Boolean(item.diffs && item.diffs.length > 0)
  const status = item.status ?? 'pending'
  const [expanded, setExpanded] = useState(hasDiffs || status === 'failed')
  const { verb, detail } = formatToolTitle(item, cwd)

  return (
    <details
      className={`tool-card tool-status-${status}`}
      open={expanded}
      onToggle={e => setExpanded(e.currentTarget.open)}
    >
      <summary className="tool-card-summary">
        <span className={`tool-dot tool-dot-${status}`} aria-label={status} />
        <span className="tool-verb">{verb}</span>
        <span className="tool-title mono truncate">{detail || item.title || 'Tool call'}</span>
        {status !== 'completed' && <span className={`tool-status-label status-${status}`}>{status.replace('_', ' ')}</span>}
      </summary>

      <div className="tool-card-body">
        {item.locations && item.locations.length > 0 && (
          <div className="tool-locations">
            {item.locations.map(loc => (
              <button
                key={`${loc.path}:${loc.line ?? ''}`}
                type="button"
                className="file-chip"
                onClick={() => onOpenFile(loc.path)}
                title={loc.path}
              >
                <FileIcon size={11} />
                <span className="mono">
                  {stripCwdPrefix(loc.path, cwd)}
                  {loc.line ? `:${loc.line}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}
        {item.diffs && item.diffs.map((d, i) => <DiffBlock key={i} diff={d} onOpenFile={onOpenFile} />)}
        {item.rawInput && (
          <div className="tool-io">
            <div className="tool-io-label">Input</div>
            <pre className="tool-io-pre mono">{item.rawInput}</pre>
          </div>
        )}
        {item.rawOutput && (
          <div className="tool-io">
            <div className="tool-io-label">Output</div>
            <pre className="tool-io-pre mono">{item.rawOutput}</pre>
          </div>
        )}
      </div>
    </details>
  )
}

function PermissionCard({
  permission,
  busy,
  onOpenFile,
  onResolve,
}: {
  permission: PermissionRequestState
  busy: boolean
  onOpenFile: (absPath: string) => void
  onResolve: (requestId: string, outcome: 'selected' | 'cancelled', optionId?: string) => void
}) {
  return (
    <section className="permission-card" aria-label="Permission approval required">
      <div className="permission-header">
        <ShieldIcon size={15} />
        <strong>Permission Required</strong>
        {permission.kind && <span className="meta-counter mono">{permission.kind}</span>}
      </div>
      <div className="permission-title">{permission.title}</div>

      {permission.locations && permission.locations.length > 0 && (
        <div className="tool-locations">
          {permission.locations.map(loc => (
            <button
              key={loc.path}
              type="button"
              className="file-chip"
              onClick={() => onOpenFile(loc.path)}
              title={loc.path}
            >
              <FileIcon size={11} />
              <span className="mono">{basenameOf(loc.path)}</span>
            </button>
          ))}
        </div>
      )}

      {permission.diffs && permission.diffs.map((d, i) => <DiffBlock key={i} diff={d} onOpenFile={onOpenFile} />)}

      {permission.rawInput && <pre className="tool-io-pre mono">{permission.rawInput}</pre>}

      <div className="permission-actions">
        {permission.options.map(opt => {
          const isAllow = opt.kind.startsWith('allow')
          const isReject = opt.kind.startsWith('reject')
          return (
            <button
              key={opt.optionId}
              type="button"
              disabled={busy}
              className={`btn btn-sm ${isAllow ? 'btn-primary' : isReject ? 'btn-danger' : ''}`}
              onClick={() => onResolve(permission.requestId, 'selected', opt.optionId)}
            >
              {opt.name}
            </button>
          )
        })}
        <button
          type="button"
          disabled={busy}
          className="btn btn-sm btn-ghost"
          onClick={() => onResolve(permission.requestId, 'cancelled')}
        >
          Cancel
        </button>
      </div>
    </section>
  )
}

export function ChatThread({
  session,
  hasEarlierItems,
  loadingEarlier,
  onLoadEarlier,
  onOpenFile,
  onOpenLink,
  onResolvePermission,
  permissionBusyId,
}: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickBottomRef = useRef(true)
  const preserveScrollRef = useRef<{ prevHeight: number; prevTop: number } | null>(null)
  const [showJump, setShowJump] = useState(false)

  const entries = useMemo(() => buildTimelineEntries(session.items), [session.items])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const sticky = dist < 80
    stickBottomRef.current = sticky
    setShowJump(!sticky && el.scrollHeight > el.clientHeight + 120)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (preserveScrollRef.current) {
      const { prevHeight, prevTop } = preserveScrollRef.current
      preserveScrollRef.current = null
      el.scrollTop = prevTop + Math.max(0, el.scrollHeight - prevHeight)
      return
    }
    if (!stickBottomRef.current) return
    el.scrollTop = el.scrollHeight
    setShowJump(false)
  }, [session.items, session.pendingPermissions, session.status])

  const handleLoadEarlierClick = () => {
    if (!onLoadEarlier) return
    const el = scrollRef.current
    if (el) {
      stickBottomRef.current = false
      preserveScrollRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop }
    }
    onLoadEarlier()
  }

  const scrollToLatest = () => {
    const el = scrollRef.current
    if (!el) return
    stickBottomRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowJump(false)
  }

  return (
    <div className="thread-container">
      <PlanBanner plan={session.plan} />

      <div className="thread-scroll" ref={scrollRef} onScroll={handleScroll}>
        {session.items.length === 0 ? (
          <div className="empty-thread">
            <div className="empty-thread-title">Waiting for Antigravity task</div>
            <div className="empty-thread-sub mono">{session.cwd}</div>
            <p className="empty-thread-hint">
              This session is ready. Ask Antigravity to inspect, review, or modify code using Claude Agent.
            </p>
          </div>
        ) : (
          <div className="thread-flow">
            {hasEarlierItems && onLoadEarlier && (
              <div className="load-earlier-row">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={loadingEarlier}
                  onClick={handleLoadEarlierClick}
                >
                  {loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}
                </button>
              </div>
            )}
            {entries.map(entry => {
              if (entry.kind === 'tool_group') {
                return (
                  <ToolActivityGroup
                    key={entry.key}
                    items={entry.items}
                    cwd={session.cwd}
                    onOpenFile={onOpenFile}
                  />
                )
              }

              const item = entry.item
              if (item.kind === 'user') {
                return <PromptDispatch key={item.id} item={item} />
              }
              if (item.kind === 'assistant') {
                return (
                  <div key={item.id} className="msg-row msg-assistant">
                    <div className="assistant-prose">
                      <MarkdownView text={item.text ?? ''} onOpenLink={onOpenLink} />
                    </div>
                  </div>
                )
              }
              if (item.kind === 'thought') {
                return <ThoughtBlock key={item.id} item={item} />
              }
              if (item.kind === 'tool_call') {
                return <ToolCallCard key={item.id} item={item} cwd={session.cwd} onOpenFile={onOpenFile} />
              }
              return (
                <div key={item.id} className={`notice-banner notice-${item.kind}`}>
                  {item.text}
                </div>
              )
            })}

            {session.pendingPermissions.map(perm => (
              <PermissionCard
                key={perm.requestId}
                permission={perm}
                busy={permissionBusyId === perm.requestId}
                onOpenFile={onOpenFile}
                onResolve={onResolvePermission}
              />
            ))}

            {session.status === 'running' && (
              <div className="live-activity-row" role="status" aria-live="polite">
                <span className="live-dot" aria-hidden="true" />
                <span>Claude is working…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {showJump && (
        <button
          type="button"
          className="btn btn-sm jump-latest-btn"
          onClick={scrollToLatest}
          aria-label="Jump to latest output"
        >
          <ArrowDownIcon size={12} />
          <span>Latest</span>
        </button>
      )}
    </div>
  )
}
