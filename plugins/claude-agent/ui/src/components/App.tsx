import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ServerBridge, type ToolCallResponse } from '../bridge.ts'
import { applyPollEvents, extractLatestTurnResponse, stripCwdPrefix } from '../lib/timeline.ts'
import { basenameOf } from '../lib/triggers.ts'
import type {
  BootstrapPayload,
  DiagnosticsInfo,
  PendingChatReplyRef,
  PollResponse,
  SessionSnapshot,
  SessionSummary,
  ToastMessage,
} from '../types.ts'
import { ChatThread } from './ChatThread.tsx'
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx'
import { ChevronDownIcon, FileIcon, FolderIcon, SettingsIcon, SidebarIcon, UnarchiveIcon } from './Icons.tsx'
import { SessionControlBar } from './SessionControlBar.tsx'
import { SessionSidebar } from './SessionSidebar.tsx'

const NARROW_BREAKPOINT = 720
const TOUCHED_FILES_POPOVER_ID = 'touched-files-popover'

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)

  const { app, isConnected, error: connectError } = useApp({
    appInfo: { name: 'claude-agent-ui', version: '0.3.2' },
    capabilities: {},
    onAppCreated: instance => {
      instance.ontoolresult = result => {
        if (result.isError) {
          const msg = (result.content ?? [])
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map(c => c.text)
            .join('\n')
          setBootstrapError(msg || 'Failed to initialize Claude Agent.')
          return
        }
        const sc = result.structuredContent as BootstrapPayload | undefined
        if (sc) {
          setBootstrapError(null)
          setBootstrap(sc)
        }
      }
    },
  })

  useHostStyles(app, app?.getHostContext())

  const bridge = useMemo(() => (app ? new ServerBridge(app) : null), [app])
  const caps = bridge?.capabilities ?? { canMessage: false, canUpdateContext: false, canOpenLinks: false }

  const [shellEl, setShellEl] = useState<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const filesPopoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!shellEl) return
    const w = shellEl.getBoundingClientRect().width
    if (w > 0) setNarrow(w < NARROW_BREAKPOINT)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < NARROW_BREAKPOINT)
    })
    ro.observe(shellEl)
    return () => ro.disconnect()
  }, [shellEl])

  useEffect(() => {
    if (!narrow || !drawerOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [narrow, drawerOpen])

  const [diagnostics, setDiagnostics] = useState<DiagnosticsInfo>({
    status: 'idle',
    authMethods: [],
    authRequired: false,
    stderrTail: [],
  })
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSession, setActiveSession] = useState<SessionSnapshot | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [diagOpen, setDiagOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [permissionBusyId, setPermissionBusyId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const pushToast = useCallback((title: string, detail?: string, tone: ToastMessage['tone'] = 'default') => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev.slice(-3), { id, title, detail, tone }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500)
  }, [])

  const deliveringReplyIdsRef = useRef(new Set<string>())
  const failedReplyIdsRef = useRef(new Set<string>())

  const deliverPendingReplies = useCallback(
    async (refs: readonly PendingChatReplyRef[] | undefined) => {
      if (!bridge || !refs || refs.length === 0) return
      if (!bridge.capabilities.canMessage) return
      for (const ref of refs) {
        if (deliveringReplyIdsRef.current.has(ref.replyId) || failedReplyIdsRef.current.has(ref.replyId)) continue
        deliveringReplyIdsRef.current.add(ref.replyId)
        try {
          const claimRes = await bridge.callTool<{ claimed: boolean; text?: string }>('claude_ui_session', {
            action: 'claim_reply',
            sessionId: ref.sessionId,
            replyId: ref.replyId,
            clientId: bridge.id,
          })
          if (!claimRes.ok || !claimRes.data?.claimed || !claimRes.data.text) continue

          const sendRes = await bridge.sendMessage(claimRes.data.text)
          if (sendRes.ok) {
            await bridge.callTool('claude_ui_session', {
              action: 'ack_reply',
              sessionId: ref.sessionId,
              replyId: ref.replyId,
              clientId: bridge.id,
            })
            pushToast('Reply delivered to Antigravity chat', undefined, 'success')
          } else {
            failedReplyIdsRef.current.add(ref.replyId)
            await bridge.callTool('claude_ui_session', {
              action: 'release_reply',
              sessionId: ref.sessionId,
              replyId: ref.replyId,
              clientId: bridge.id,
            })
            pushToast('Auto-reply failed', 'Use "To Chat" to send manually.', 'error')
          }
        } finally {
          deliveringReplyIdsRef.current.delete(ref.replyId)
        }
      }
    },
    [bridge, pushToast],
  )

  const catalogVersionRef = useRef(0)

  const applyBootstrap = useCallback((payload: BootstrapPayload) => {
    setDiagnostics(payload.diagnostics)
    setSessions(payload.sessions ?? [])
    if (typeof payload.catalogVersion === 'number') {
      catalogVersionRef.current = Math.max(catalogVersionRef.current, payload.catalogVersion)
    }
    if (payload.activeSession) {
      setActiveSession(payload.activeSession)
    }
    if (payload.pendingReplies?.length) {
      void deliverPendingReplies(payload.pendingReplies)
    }
  }, [deliverPendingReplies])

  useEffect(() => {
    if (!isConnected || !bridge || !caps.canMessage) return
    if (bootstrap?.pendingReplies?.length) {
      void deliverPendingReplies(bootstrap.pendingReplies)
    }
  }, [isConnected, bridge, caps.canMessage, bootstrap?.pendingReplies, deliverPendingReplies])

  const didAutoConnectRef = useRef(false)
  const diagGenRef = useRef(0)
  useEffect(() => {
    if (!bootstrap) return
    applyBootstrap(bootstrap)
    if (!didAutoConnectRef.current && bootstrap.diagnostics.status === 'idle' && bridge) {
      didAutoConnectRef.current = true
      const gen = ++diagGenRef.current
      setBusy(true)
      setDiagnostics(prev => ({ ...prev, status: 'connecting', lastError: undefined }))
      void bridge
        .callTool<BootstrapPayload>('claude_ui_session', { action: 'connect', sessionId: bootstrap.activeSession?.sessionId })
        .then(res => {
          if (gen !== diagGenRef.current) return
          setBusy(false)
          if (res.ok && res.data) applyBootstrap(res.data)
        })
    }
  }, [bootstrap, bridge, applyBootstrap])

  // Fallback self-bootstrap if launched in a context without initial ontoolresult payload
  useEffect(() => {
    if (!isConnected || !bridge || bootstrap || bootstrapError) return
    void bridge.callTool<BootstrapPayload>('claude_ui_bootstrap').then(res => {
      if (res.ok && res.data) {
        setBootstrap(res.data)
      } else if (!res.ok) {
        setBootstrapError(res.text)
      }
    })
  }, [isConnected, bridge, bootstrap, bootstrapError])

  const updateSessionSnapshot = useCallback((snap: SessionSnapshot) => {
    setActiveSession(snap)
    setSessions(prev => {
      const idx = prev.findIndex(s => s.sessionId === snap.sessionId)
      const summary: SessionSummary = {
        sessionId: snap.sessionId,
        title: snap.title,
        cwd: snap.cwd,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
        ...(snap.archivedAt ? { archivedAt: snap.archivedAt } : {}),
        status: snap.status,
        loadedInProcess: snap.loadedInProcess,
        pendingPermissionCount: snap.pendingPermissions.length,
        touchedFilesCount: snap.touchedFiles.length,
        ...(snap.modeId ? { modeId: snap.modeId } : {}),
        ...(snap.modelId ? { modelId: snap.modelId } : {}),
        ...(snap.usage ? { usage: snap.usage } : {}),
        ...(snap.replyToChat ? { replyToChat: snap.replyToChat } : {}),
        ...(snap.pendingChatReplyId ? { pendingChatReplyId: snap.pendingChatReplyId } : {}),
      }
      if (idx >= 0) {
        const copy = [...prev]
        copy[idx] = summary
        return copy
      }
      return [summary, ...prev]
    })
  }, [])

  // Dedicated long-polling loop for both active session events and global catalog updates
  const activeId = activeSession?.sessionId ?? null
  const activeSeqRef = useRef(0)
  useEffect(() => {
    if (activeSession) activeSeqRef.current = activeSession.latestSeq
  }, [activeSession])

  useEffect(() => {
    if (!isConnected || !bridge) return
    let cancelled = false

    const loop = async () => {
      while (!cancelled) {
        const startedAt = Date.now()
        const res: ToolCallResponse<PollResponse> = await bridge.pollTool<PollResponse>({
          ...(activeId ? { sessionId: activeId, afterSeq: activeSeqRef.current } : {}),
          afterCatalogVersion: catalogVersionRef.current,
          waitMs: 12_000,
        })
        if (cancelled) break
        if (!res.ok || !res.data) {
          if (activeId && /Unknown session/i.test(res.text)) {
            setActiveSession(null)
            break
          }
          await new Promise(r => setTimeout(r, 800))
          continue
        }
        const data: PollResponse = res.data
        if (typeof data.catalogVersion === 'number') {
          catalogVersionRef.current = Math.max(catalogVersionRef.current, data.catalogVersion)
        }
        if (Array.isArray(data.sessions)) {
          setSessions(data.sessions)
        }
        if (data.pendingReplies?.length) {
          void deliverPendingReplies(data.pendingReplies)
        }
        if (data.focusSessionId && data.focusSessionId !== activeId) {
          const got = await bridge.callTool<{ session: SessionSnapshot }>('claude_ui_session', {
            action: 'get',
            sessionId: data.focusSessionId,
          })
          if (!cancelled && got.ok && got.data?.session) {
            updateSessionSnapshot(got.data.session)
            break
          }
        }
        if (!activeId || data.sessionId !== activeId) {
          if (!Array.isArray(data.sessions) && Date.now() - startedAt < 300) {
            await new Promise(r => setTimeout(r, 250))
          }
          continue
        }
        if (data.resync && data.snapshot) {
          activeSeqRef.current = data.snapshot.latestSeq
          updateSessionSnapshot(data.snapshot)
        } else if (data.events.length > 0) {
          activeSeqRef.current = Math.max(activeSeqRef.current, data.latestSeq)
          let latestUpdated: SessionSnapshot | null = null
          setActiveSession(prev => {
            if (!prev || prev.sessionId !== activeId) return prev
            latestUpdated = applyPollEvents(prev, data.events, data.latestSeq)
            return latestUpdated
          })
          if (latestUpdated) {
            const snap: SessionSnapshot = latestUpdated
            setSessions(list =>
              list.map(item =>
                item.sessionId === snap.sessionId
                  ? {
                      ...item,
                      title: snap.title,
                      status: snap.status,
                      updatedAt: snap.updatedAt,
                      archivedAt: snap.archivedAt,
                      pendingPermissionCount: snap.pendingPermissions.length,
                      touchedFilesCount: snap.touchedFiles.length,
                      modeId: snap.modeId,
                      modelId: snap.modelId,
                      usage: snap.usage,
                      replyToChat: snap.replyToChat,
                      pendingChatReplyId: snap.pendingChatReplyId,
                    }
                  : item,
              ),
            )
          }
        } else if (!Array.isArray(data.sessions) && Date.now() - startedAt < 300) {
          // Guard against rapid empty-poll wakeups when another view polls a different session
          await new Promise(r => setTimeout(r, 250))
        }
      }
    }

    void loop()
    return () => {
      cancelled = true
    }
  }, [isConnected, bridge, activeId, updateSessionSnapshot, deliverPendingReplies])

  const selectGenRef = useRef(0)

  const handleSelectSession = async (sessionId: string) => {
    if (!bridge) return
    const gen = ++selectGenRef.current
    setDrawerOpen(false)
    setBusy(true)
    const getRes = await bridge.callTool<{ session: SessionSnapshot }>('claude_ui_session', {
      action: 'get',
      sessionId,
    })
    if (gen !== selectGenRef.current) return
    if (getRes.ok && getRes.data?.session) {
      updateSessionSnapshot(getRes.data.session)
    } else if (!getRes.ok) {
      setBusy(false)
      pushToast('Failed to open session', getRes.text, 'error')
      return
    }

    if (!getRes.data?.session || getRes.data.session.loadedInProcess || diagnostics.status !== 'ready') {
      setBusy(false)
      return
    }

    const loadRes = await bridge.callTool<{
      session: SessionSnapshot
      diagnostics?: DiagnosticsInfo
      replacedSessionId?: string
      sessions?: SessionSummary[]
    }>('claude_ui_session', {
      action: 'load',
      sessionId,
    })
    if (gen !== selectGenRef.current) return
    setBusy(false)
    if (loadRes.ok && loadRes.data?.session) {
      if (loadRes.data.sessions) setSessions(loadRes.data.sessions)
      updateSessionSnapshot(loadRes.data.session)
      if (loadRes.data.diagnostics) setDiagnostics(loadRes.data.diagnostics)
    } else if (!loadRes.ok) {
      pushToast('Could not resume ACP session', loadRes.text, 'error')
    }
  }

  const handleArchiveSession = async (sessionId: string, archived: boolean) => {
    if (!bridge) return
    const res = await bridge.callTool<{ session: SessionSnapshot; sessions: SessionSummary[] }>('claude_ui_session', {
      action: archived ? 'archive' : 'unarchive',
      sessionId,
    })
    if (res.ok && res.data) {
      if (res.data.sessions) setSessions(res.data.sessions)
      const updated = res.data.session
      if (updated) {
        setActiveSession(prev => (prev?.sessionId === sessionId ? updated : prev))
      }
    } else if (!res.ok) {
      pushToast(archived ? 'Archive failed' : 'Restore failed', res.text, 'error')
    }
  }

  const handleDeleteSession = async (sessionId: string) => {
    if (!bridge) return
    const res = await bridge.callTool<{ sessions: SessionSummary[] }>('claude_ui_session', {
      action: 'delete',
      sessionId,
    })
    if (res.ok && res.data?.sessions) {
      setSessions(res.data.sessions)
      setActiveSession(prev => (prev?.sessionId === sessionId ? null : prev))
    }
  }

  const handleCancel = async () => {
    if (!bridge || !activeSession) return
    const res = await bridge.callTool<{ session: SessionSnapshot }>('claude_ui_prompt', {
      action: 'cancel',
      sessionId: activeSession.sessionId,
    })
    if (res.ok && res.data?.session) updateSessionSnapshot(res.data.session)
  }

  const handleSetMode = async (modeId: string) => {
    if (!bridge || !activeSession) return
    const res = await bridge.callTool<{ session: SessionSnapshot }>('claude_ui_session', {
      action: 'set_mode',
      sessionId: activeSession.sessionId,
      modeId,
    })
    if (res.ok && res.data?.session) updateSessionSnapshot(res.data.session)
    else if (!res.ok) pushToast('Mode switch failed', res.text, 'error')
  }

  const handleSetModel = async (modelId: string) => {
    if (!bridge || !activeSession) return
    const res = await bridge.callTool<{ session: SessionSnapshot }>('claude_ui_session', {
      action: 'set_model',
      sessionId: activeSession.sessionId,
      modelId,
    })
    if (res.ok && res.data?.session) updateSessionSnapshot(res.data.session)
    else if (!res.ok) pushToast('Model switch failed', res.text, 'error')
  }

  const handleSetConfig = async (configId: string, value: string) => {
    if (!bridge || !activeSession) return
    const res = await bridge.callTool<{ session: SessionSnapshot }>('claude_ui_session', {
      action: 'set_config',
      sessionId: activeSession.sessionId,
      configId,
      value,
    })
    if (res.ok && res.data?.session) updateSessionSnapshot(res.data.session)
  }

  const handleResolvePermission = async (requestId: string, outcome: 'selected' | 'cancelled', optionId?: string) => {
    if (!bridge || !activeSession) return
    setPermissionBusyId(requestId)
    const res = await bridge.callTool<{ session: SessionSnapshot }>('claude_ui_permission', {
      sessionId: activeSession.sessionId,
      requestId,
      outcome,
      ...(optionId ? { optionId } : {}),
    })
    setPermissionBusyId(null)
    if (res.ok && res.data?.session) {
      updateSessionSnapshot(res.data.session)
    } else if (!res.ok) {
      pushToast('Permission error', res.text, 'error')
    }
  }

  const handleOpenFile = async (absPath: string) => {
    if (!bridge) return
    filesPopoverRef.current?.hidePopover?.()
    const opened = await bridge.openFile(absPath)
    if (!opened) {
      pushToast('File preview unavailable on this view', absPath, 'default')
    }
  }

  const buildSessionSummaryText = (session: SessionSnapshot): string => {
    const latestTurnText = extractLatestTurnResponse(session.items)
    const clipped =
      latestTurnText.length > 24_000
        ? `${latestTurnText.slice(0, 24_000)}\n\n… [truncated at 24000 chars]`
        : latestTurnText
    return [
      `[Claude Agent reply · "${session.title}" · session ${session.sessionId} · cwd: ${session.cwd}]`,
      session.touchedFiles.length > 0 ? `Touched files: ${session.touchedFiles.join(', ')}` : undefined,
      clipped ? `\n${clipped}` : undefined,
    ]
      .filter(Boolean)
      .join('\n')
  }

  const handleAttachContext = async () => {
    if (!bridge || !activeSession) return
    const ok = await bridge.updateContext(buildSessionSummaryText(activeSession))
    pushToast(ok ? 'Context attached to next message' : 'Could not attach context', undefined, ok ? 'success' : 'error')
  }

  const handleSendToHostChat = async () => {
    if (!bridge || !activeSession) return
    const res = await bridge.sendMessage(buildSessionSummaryText(activeSession))
    pushToast(res.ok ? 'Sent summary to Antigravity chat' : 'Could not send to chat', undefined, res.ok ? 'success' : 'error')
  }

  const handleReconnect = async () => {
    if (!bridge) return
    const gen = ++diagGenRef.current
    setBusy(true)
    setDiagnostics(prev => ({ ...prev, status: 'connecting', lastError: undefined }))
    const res = await bridge.callTool<BootstrapPayload>('claude_ui_session', {
      action: 'reconnect',
      sessionId: activeSession?.sessionId,
    })
    if (gen !== diagGenRef.current) return
    setBusy(false)
    if (res.ok && res.data) applyBootstrap(res.data)
    else if (!res.ok) pushToast('Reconnect failed', res.text, 'error')
  }

  const handleAuthenticate = async (methodId: string) => {
    if (!bridge) return
    setBusy(true)
    const res = await bridge.callTool<{ diagnostics: DiagnosticsInfo }>('claude_ui_session', {
      action: 'authenticate',
      methodId,
    })
    setBusy(false)
    if (res.ok && res.data?.diagnostics) {
      setDiagnostics(res.data.diagnostics)
      pushToast('Authenticated', undefined, 'success')
    } else if (!res.ok) {
      pushToast('Authentication failed', res.text, 'error')
    }
  }

  if (connectError) {
    return <div className="fatal-state">Failed to connect to Antigravity host: {connectError.message}</div>
  }
  if (bootstrapError) {
    return <div className="fatal-state">{bootstrapError}</div>
  }

  return (
    <div className={`app-shell ${narrow ? 'is-narrow' : 'is-wide'}`} ref={setShellEl}>
      {(!narrow || drawerOpen) && (
        <div className={narrow ? 'drawer-overlay' : 'sidebar-container'} onClick={() => narrow && setDrawerOpen(false)}>
          <div className="sidebar-inner" onClick={e => e.stopPropagation()}>
            <SessionSidebar
              sessions={sessions}
              activeSessionId={activeSession?.sessionId ?? null}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onSelectSession={id => void handleSelectSession(id)}
              onArchiveSession={(id, archived) => void handleArchiveSession(id, archived)}
              onDeleteSession={id => void handleDeleteSession(id)}
              onOpenSettings={() => setDiagOpen(true)}
              diagStatus={diagnostics.status}
            />
          </div>
        </div>
      )}

      <main className="main-pane">
        <header className="pane-header">
          <div className="main-header-left">
            {narrow && (
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                onClick={() => setDrawerOpen(v => !v)}
                aria-label="Toggle sessions list"
                aria-expanded={drawerOpen}
                title="Sessions"
              >
                <SidebarIcon size={15} />
              </button>
            )}
            {activeSession ? (
              <div className="session-header-info">
                <h1 className="pane-title truncate">{activeSession.title}</h1>
                <span className="session-cwd-chip mono" title={activeSession.cwd}>
                  <FolderIcon size={11} />
                  <span className="truncate">{basenameOf(activeSession.cwd)}</span>
                </span>
              </div>
            ) : (
              <h1 className="pane-title">Claude Agent</h1>
            )}
          </div>

          <div className="header-actions">
            {activeSession?.archivedAt && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void handleArchiveSession(activeSession.sessionId, false)}
                title="Restore archived session to active list"
              >
                <UnarchiveIcon size={12} />
                <span>Restore</span>
              </button>
            )}
            {activeSession && activeSession.touchedFiles.length > 0 && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost touched-trigger"
                  popoverTarget={TOUCHED_FILES_POPOVER_ID}
                  title="Inspect touched files"
                >
                  <FileIcon size={12} />
                  <span className="mono">{activeSession.touchedFiles.length}</span>
                  <span className="touched-label-word">
                    {activeSession.touchedFiles.length === 1 ? 'file' : 'files'}
                  </span>
                  <ChevronDownIcon size={11} />
                </button>
                <div
                  id={TOUCHED_FILES_POPOVER_ID}
                  ref={filesPopoverRef}
                  popover="auto"
                  className="anchored-popover files-popover"
                  aria-label="Touched files"
                >
                  <div className="popover-header">
                    <span className="popover-title">Touched Files ({activeSession.touchedFiles.length})</span>
                  </div>
                  <ul className="touched-file-list">
                    {activeSession.touchedFiles.map(path => (
                      <li key={path}>
                        <button
                          type="button"
                          className="touched-file-item"
                          onClick={() => void handleOpenFile(path)}
                          title={path}
                        >
                          <FileIcon size={12} />
                          <span className="touched-file-name mono truncate">{basenameOf(path)}</span>
                          <span className="touched-file-path mono truncate">
                            {stripCwdPrefix(path, activeSession.cwd)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {narrow && (
              <button
                type="button"
                className="btn btn-icon btn-ghost"
                onClick={() => setDiagOpen(true)}
                aria-label={`ACP diagnostics (${diagnostics.status})`}
                title={`ACP diagnostics (${diagnostics.status})`}
              >
                <span className={`status-dot status-${diagnostics.status}`} />
                <SettingsIcon size={14} />
              </button>
            )}
          </div>
        </header>

        {(diagnostics.status === 'error' || diagnostics.authRequired) && (
          <div className="diag-alert-bar" role="alert">
            <span className="truncate">
              {diagnostics.authRequired
                ? 'Claude authentication required. Run `claude /login` or open Diagnostics.'
                : diagnostics.lastError || 'ACP connection error.'}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setDiagOpen(true)}>
              Diagnostics
            </button>
          </div>
        )}

        {activeSession ? (
          <>
            <ChatThread
              session={activeSession}
              onOpenFile={path => void handleOpenFile(path)}
              onOpenLink={url => void bridge?.openLink(url)}
              onResolvePermission={(reqId, outcome, optId) => void handleResolvePermission(reqId, outcome, optId)}
              permissionBusyId={permissionBusyId}
            />
            <SessionControlBar
              session={activeSession}
              busy={busy}
              canMessage={caps.canMessage}
              canUpdateContext={caps.canUpdateContext}
              onCancel={() => void handleCancel()}
              onSetMode={modeId => void handleSetMode(modeId)}
              onSetModel={modelId => void handleSetModel(modelId)}
              onSetConfig={(cfgId, val) => void handleSetConfig(cfgId, val)}
              onAttachContext={() => void handleAttachContext()}
              onSendToHostChat={() => void handleSendToHostChat()}
            />
          </>
        ) : (
          <div className="welcome-empty">
            <h2>Claude Code Monitor</h2>
            <p>
              Antigravity dispatches Claude Code tasks, reviews, and edits here. Inspect live tool activity, diffs, and
              permission requests without leaving your workspace.
            </p>
            <div className="welcome-actions">
              <button type="button" className="btn" onClick={() => setDiagOpen(true)}>
                <SettingsIcon size={14} />
                <span>ACP Diagnostics</span>
              </button>
            </div>
          </div>
        )}
      </main>

      <DiagnosticsPanel
        open={diagOpen}
        diagnostics={diagnostics}
        busy={busy}
        onReconnect={() => void handleReconnect()}
        onAuthenticate={methodId => void handleAuthenticate(methodId)}
        onClose={() => setDiagOpen(false)}
      />

      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map(t => (
            <div key={t.id} className={`toast toast-${t.tone}`}>
              <div className="toast-title">{t.title}</div>
              {t.detail && <div className="toast-detail truncate mono">{t.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
