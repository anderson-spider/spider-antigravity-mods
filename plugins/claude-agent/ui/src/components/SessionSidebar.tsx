import { useState } from 'react'
import { basenameOf, formatRelativeTime } from '../lib/triggers.ts'
import type { DiagnosticsInfo, SessionSummary } from '../types.ts'
import { ArchiveIcon, ClaudeMark, SettingsIcon, TrashIcon, UnarchiveIcon } from './Icons.tsx'

type SessionSidebarProps = {
  sessions: SessionSummary[]
  activeSessionId: string | null
  searchQuery: string
  onSearchChange: (q: string) => void
  onSelectSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string, archived: boolean) => void
  onDeleteSession: (sessionId: string) => void
  onOpenSettings: () => void
  diagStatus: DiagnosticsInfo['status']
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  searchQuery,
  onSearchChange,
  onSelectSession,
  onArchiveSession,
  onDeleteSession,
  onOpenSettings,
  diagStatus,
}: SessionSidebarProps) {
  const [archivedOpen, setArchivedOpen] = useState(false)
  const needle = searchQuery.trim().toLowerCase()
  const filtered = needle
    ? sessions.filter(s => s.title.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle))
    : sessions
  const activeSessions = filtered.filter(s => !s.archivedAt)
  const archivedSessions = filtered.filter(s => Boolean(s.archivedAt))
  const isArchivedExpanded = Boolean(needle && archivedSessions.length > 0) || archivedOpen

  const renderSessionItem = (s: SessionSummary, isArchived: boolean) => {
    const active = s.sessionId === activeSessionId
    const archiveDisabled = !isArchived && s.status === 'running'
    return (
      <li key={s.sessionId} className={`session-item ${active ? 'active' : ''} ${isArchived ? 'is-archived' : ''}`}>
        <button
          type="button"
          className="session-item-btn"
          onClick={() => onSelectSession(s.sessionId)}
          aria-current={active ? 'true' : undefined}
        >
          <div className="session-item-top">
            <span className={`session-state-dot state-${s.status}`} title={s.status} />
            <span className="session-item-title truncate">{s.title}</span>
            {s.pendingPermissionCount > 0 && (
              <span className="badge badge-warn" title="Pending permission approval">
                {s.pendingPermissionCount}
              </span>
            )}
          </div>
          <div className="session-item-meta">
            <span className="truncate mono">{basenameOf(s.cwd)}</span>
            <span>{formatRelativeTime(s.updatedAt)}</span>
          </div>
        </button>
        <div className="session-item-actions">
          <button
            type="button"
            className="btn-inline-action"
            disabled={archiveDisabled}
            aria-label={isArchived ? `Unarchive session ${s.title}` : `Archive session ${s.title}`}
            title={
              archiveDisabled
                ? 'Cannot archive while running'
                : isArchived
                  ? 'Restore session'
                  : 'Archive session'
            }
            onClick={() => onArchiveSession(s.sessionId, !isArchived)}
          >
            {isArchived ? <UnarchiveIcon size={12} /> : <ArchiveIcon size={12} />}
          </button>
          <button
            type="button"
            className="btn-inline-action btn-inline-delete"
            aria-label={`Delete session ${s.title}`}
            title="Delete session"
            onClick={() => onDeleteSession(s.sessionId)}
          >
            <TrashIcon size={12} />
          </button>
        </div>
      </li>
    )
  }

  return (
    <aside className="sidebar-pane" aria-label="Sessions">
      <div className="pane-header">
        <div className="brand-title">
          <span className="brand-badge">
            <ClaudeMark size={14} />
          </span>
          <span className="pane-title">Claude Agent</span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={onOpenSettings}
            aria-label={`ACP diagnostics (${diagStatus})`}
            title={`ACP diagnostics (${diagStatus})`}
          >
            <span className={`status-dot status-${diagStatus}`} />
            <SettingsIcon size={14} />
          </button>
        </div>
      </div>

      <div className="sidebar-search">
        <label className="visually-hidden" htmlFor="session-filter">
          Filter sessions or folders
        </label>
        <input
          id="session-filter"
          type="search"
          className="input sidebar-search-input"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Filter sessions or folders…"
        />
      </div>

      <div className="session-list-wrap">
        {activeSessions.length === 0 && archivedSessions.length === 0 ? (
          <div className="empty-sidebar">
            {sessions.length === 0
              ? 'No sessions yet. Ask Antigravity to dispatch a task to Claude Agent.'
              : 'No matching sessions.'}
          </div>
        ) : (
          <>
            {activeSessions.length > 0 ? (
              <ul className="session-list">
                {activeSessions.map(s => renderSessionItem(s, false))}
              </ul>
            ) : (
              <div className="empty-sidebar empty-sidebar-compact">No active sessions.</div>
            )}

            {archivedSessions.length > 0 && (
              <details
                className="archived-section"
                open={isArchivedExpanded}
                onToggle={e => {
                  if (!needle) setArchivedOpen(e.currentTarget.open)
                }}
              >
                <summary className="archived-summary">
                  <span>Archived</span>
                  <span className="archived-count mono">{archivedSessions.length}</span>
                </summary>
                <ul className="session-list archived-list">
                  {archivedSessions.map(s => renderSessionItem(s, true))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
