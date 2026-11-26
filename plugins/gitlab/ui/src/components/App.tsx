import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ServerBridge } from '../bridge.ts'
import { formatRelativeTime } from '../lib/query.ts'
import type {
  ActiveRepo,
  BootstrapPayload,
  DashboardState,
  DetailTab,
  DiffFile,
  DiffMode,
  InvolvementFilter,
  MrDetail,
  MrListItem,
  MrStateFilter,
  SavedView,
  SortOrder,
  ToastMessage,
  WorkspaceInfo,
} from '../types.ts'
import { CodeDiffTab } from './CodeDiffTab.tsx'
import { DiscussionsTab } from './DiscussionsTab.tsx'
import { Avatar, BackIcon, CloseIcon, CopyIcon, ExternalLinkIcon, GitBranchIcon, MaximizeIcon, PipelineGlyph, SparkleIcon } from './Icons.tsx'
import { MergeModal } from './MergeModal.tsx'
import { MrListColumn } from './MrListColumn.tsx'
import { SummaryTab } from './SummaryTab.tsx'

type OpenTab = { id: string; host: string; project: string; iid: number; title?: string; state?: string; pipelineStatus?: string }

const NARROW_BREAKPOINT = 760

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)

  const { app, isConnected, error: connectError } = useApp({
    appInfo: { name: 'gitlab-mr-dashboard', version: '0.5.1' },
    capabilities: {},
    onAppCreated: (instance) => {
      instance.ontoolresult = (result) => {
        if (result.isError) {
          const msg = (result.content ?? [])
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
          setBootstrapError(msg || 'Failed to initialize dashboard.')
          return
        }
        const sc = result.structuredContent as BootstrapPayload | undefined
        if (sc) {
          setBootstrapError(sc.error ?? null)
          setBootstrap(sc)
        }
      }
    },
  })

  useHostStyles(app, app?.getHostContext())

  const bridge = useMemo(() => (app ? new ServerBridge(app) : null), [app])
  const caps = bridge?.capabilities ?? { canMessage: false, canUpdateContext: false, canOpenLinks: true }

  // Viewport width tracking for responsive split (Global) vs List <-> Detail (narrow Aux Pane)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [shellEl, setShellEl] = useState<HTMLDivElement | null>(null)
  const setShellNode = useCallback((el: HTMLDivElement | null) => {
    shellRef.current = el
    setShellEl(el)
  }, [])
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!shellEl) return
    const initialWidth = shellEl.getBoundingClientRect().width
    if (initialWidth > 0) setNarrow(initialWidth < NARROW_BREAKPOINT)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < NARROW_BREAKPOINT)
    })
    ro.observe(shellEl)
    return () => ro.disconnect()
  }, [shellEl])

  // Persisted UI state
  const [persisted, setPersisted] = useState<DashboardState | null>(null)
  const [q, setQ] = useState('')
  const [stateFilter, setStateFilter] = useState<MrStateFilter>('opened')
  const [involvement, setInvolvement] = useState<InvolvementFilter>('all')
  const [sort, setSort] = useState<SortOrder>('ready')
  const [hostOrProject, setHostOrProject] = useState('all')
  const [diffMode, setDiffMode] = useState<DiffMode>('unified')
  const [showFileIndex, setShowFileIndex] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [listWidthPct, setListWidthPct] = useState(40)
  const [activeViewId, setActiveViewId] = useState<string | null>(null)

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [workspaceScoped, setWorkspaceScoped] = useState(false)
  const [configuredHosts, setConfiguredHosts] = useState<string[]>([])
  const [registeredRepos, setRegisteredRepos] = useState<ActiveRepo[]>([])
  const [usedFallbackMine, setUsedFallbackMine] = useState(false)
  const [pendingForceRemove, setPendingForceRemove] = useState<{ key: string; message: string } | null>(null)

  // List state
  const [mrs, setMrs] = useState<MrListItem[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listEnriched, setListEnriched] = useState(true)
  const [listErrors, setListErrors] = useState<{ host: string; message: string }[]>([])
  const [countdown, setCountdown] = useState(60)

  // Multi-MR Tabs & Detail state
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('summary')
  const [maximized, setMaximized] = useState(false)
  const [narrowShowDetail, setNarrowShowDetail] = useState(false)
  const [detailsById, setDetailsById] = useState<Record<string, MrDetail>>({})
  const [diffsById, setDiffsById] = useState<Record<string, DiffFile[]>>({})
  const [detailLoading, setDetailLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const handoffBusyRef = useRef(false)
  const [mergeModalOpen, setMergeModalOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const pushToast = useCallback((title: string, detail?: string, tone: ToastMessage['tone'] = 'default') => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev.slice(-3), { id, title, detail, tone }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500)
  }, [])

  // Apply bootstrap payload when delivered by Antigravity
  const bootstrappedRef = useRef(false)
  useEffect(() => {
    if (!bootstrap) return
    setConfiguredHosts(bootstrap.configuredHosts ?? [])
    setWorkspace(bootstrap.workspace ?? null)
    if (bootstrap.registeredRepos) setRegisteredRepos(bootstrap.registeredRepos)
    if (bootstrap.state) {
      setPersisted(bootstrap.state)
      if (!bootstrappedRef.current) {
        const p = bootstrap.state.preferences
        setStateFilter(bootstrap.initialState ?? p.state)
        setInvolvement(bootstrap.initialInvolvement ?? p.involvement)
        setSort(p.sort)
        setHostOrProject(p.hostOrProject)
        setDiffMode(p.diffMode)
        setAutoRefresh(p.autoRefresh)
        setShowFileIndex(p.showFileIndex)
        setListWidthPct(p.listWidthPct)
        setWorkspaceScoped(bootstrap.initialScope === 'project' && Boolean(bootstrap.workspace))
        bootstrappedRef.current = true
      }
    }
    if (bootstrap.initialSelection) {
      const sel = bootstrap.initialSelection
      const id = `${sel.host}:${sel.project}:${sel.iid}`
      setOpenTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, ...sel }]))
      setActiveTabId(id)
      setNarrowShowDetail(true)
    }
  }, [bootstrap])

  // Fallback self-bootstrap if launched without an initial tool result
  useEffect(() => {
    if (!isConnected || !bridge || bootstrap || bootstrapError) return
    const timer = setTimeout(() => {
      void bridge.callTool<BootstrapPayload>('gitlab_mr_dashboard', {}).then((res) => {
        if (res.ok && res.data) setBootstrap(res.data)
        else if (!res.ok) setBootstrapError(res.text)
      })
    }, 350)
    return () => clearTimeout(timer)
  }, [isConnected, bridge, bootstrap, bootstrapError])

  const persistPrefs = useCallback(
    (patch: Record<string, unknown>) => {
      if (!bridge) return
      void bridge.callTool<{ state: DashboardState }>('gitlab_ui_state', { action: 'save_preferences', ...patch }).then((res) => {
        if (res.ok && res.data?.state) setPersisted(res.data.state)
      })
    },
    [bridge],
  )

  const listReqIdRef = useRef(0)
  const countdownRef = useRef(60)
  const detailsRef = useRef<Record<string, MrDetail>>({})
  const diffsRef = useRef<Record<string, DiffFile[]>>({})
  const detailInFlightRef = useRef<Map<string, number>>(new Map())
  const diffInFlightRef = useRef<Map<string, number>>(new Map())
  const detailReqSeqRef = useRef(0)
  const diffReqSeqRef = useRef(0)

  const fetchList = useCallback(
    async (silent = false) => {
      if (!bridge || configuredHosts.length === 0) return
      const reqId = ++listReqIdRef.current
      if (!silent) setListLoading(true)
      const args: Record<string, unknown> = { state: stateFilter }
      if (workspace && workspaceScoped) {
        args.host = workspace.host
        args.project = workspace.project
      } else if (hostOrProject === 'mine') {
        args.scope = 'mine'
      } else if (hostOrProject.startsWith('host:')) {
        args.host = hostOrProject.slice(5)
      } else if (hostOrProject.startsWith('proj:')) {
        const spec = hostOrProject.slice(5)
        const sep = spec.indexOf('|')
        if (sep > 0) {
          args.host = spec.slice(0, sep)
          args.project = spec.slice(sep + 1)
        }
      } else {
        args.scope = 'projects'
      }
      const res = await bridge.callTool<{
        mergeRequests: MrListItem[]
        enriched: boolean
        errors: { host: string; message: string }[]
        usedFallbackMine?: boolean
      }>('gitlab_ui_list', args)
      if (reqId !== listReqIdRef.current) return
      setListLoading(false)
      countdownRef.current = 60
      setCountdown(60)
      if (!res.ok) {
        setListErrors([{ host: 'gitlab', message: res.text }])
        return
      }
      if (res.data) {
        setMrs(res.data.mergeRequests ?? [])
        setListEnriched(Boolean(res.data.enriched))
        setListErrors(res.data.errors ?? [])
        setUsedFallbackMine(Boolean(res.data.usedFallbackMine))
      }
    },
    [bridge, configuredHosts.length, stateFilter, workspace, workspaceScoped, hostOrProject],
  )

  // Fetch list whenever connection/bootstrap/scope/state changes
  useEffect(() => {
    if (!isConnected || configuredHosts.length === 0) return
    void fetchList()
  }, [isConnected, configuredHosts.length, fetchList])

  // 60s visibility-aware auto-refresh timer
  useEffect(() => {
    if (!autoRefresh || !isConnected || configuredHosts.length === 0) return
    const id = setInterval(() => {
      if (document.hidden) return
      const next = countdownRef.current - 1
      if (next <= 0) {
        countdownRef.current = 60
        setCountdown(60)
        void fetchList(true)
      } else {
        countdownRef.current = next
        setCountdown(next)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [autoRefresh, isConnected, configuredHosts.length, fetchList])

  const loadDetail = useCallback(
    async (tab: { id: string; host: string; project: string; iid: number }, force = false) => {
      if (!bridge) return
      if (!force && (detailsRef.current[tab.id] || detailInFlightRef.current.has(tab.id))) return
      const reqId = ++detailReqSeqRef.current
      detailInFlightRef.current.set(tab.id, reqId)
      setDetailLoading(true)
      try {
        const res = await bridge.callTool<{ detail: MrDetail }>('gitlab_ui_detail', {
          host: tab.host,
          project: tab.project,
          iid: tab.iid,
        })
        if (detailInFlightRef.current.get(tab.id) !== reqId) return
        if (!res.ok) {
          pushToast('Failed to load MR detail', res.text, 'error')
          return
        }
        if (res.data?.detail) {
          const d = res.data.detail
          detailsRef.current = { ...detailsRef.current, [tab.id]: d }
          setDetailsById((prev) => ({ ...prev, [tab.id]: d }))
          setOpenTabs((prev) =>
            prev.map((t) => (t.id === tab.id ? { ...t, title: d.title, state: d.state, pipelineStatus: d.pipeline?.status } : t)),
          )
        }
      } finally {
        if (detailInFlightRef.current.get(tab.id) === reqId) detailInFlightRef.current.delete(tab.id)
        setDetailLoading(detailInFlightRef.current.size > 0)
      }
    },
    [bridge, pushToast],
  )

  const loadDiff = useCallback(
    async (tab: { id: string; host: string; project: string; iid: number }, force = false) => {
      if (!bridge) return
      if (!force && (diffsRef.current[tab.id] || diffInFlightRef.current.has(tab.id))) return
      const reqId = ++diffReqSeqRef.current
      diffInFlightRef.current.set(tab.id, reqId)
      setDiffLoading(true)
      try {
        const res = await bridge.callTool<{ files: DiffFile[] }>('gitlab_ui_diff', {
          host: tab.host,
          project: tab.project,
          iid: tab.iid,
        })
        if (diffInFlightRef.current.get(tab.id) !== reqId) return
        if (!res.ok) {
          pushToast('Failed to load diff', res.text, 'error')
          return
        }
        if (res.data?.files) {
          const files = res.data.files
          diffsRef.current = { ...diffsRef.current, [tab.id]: files }
          setDiffsById((prev) => ({ ...prev, [tab.id]: files }))
        }
      } finally {
        if (diffInFlightRef.current.get(tab.id) === reqId) diffInFlightRef.current.delete(tab.id)
        setDiffLoading(diffInFlightRef.current.size > 0)
      }
    },
    [bridge, pushToast],
  )

  const activeTab = useMemo(() => openTabs.find((t) => t.id === activeTabId) ?? null, [openTabs, activeTabId])
  const activeDetail = activeTab ? detailsById[activeTab.id] ?? null : null
  const activeDiff = activeTab ? diffsById[activeTab.id] ?? null : null

  useEffect(() => {
    setPendingForceRemove(null)
  }, [activeTabId])

  useEffect(() => {
    if (activeTab) void loadDetail(activeTab)
  }, [activeTab, loadDetail])

  useEffect(() => {
    if (activeTab && detailTab === 'code') void loadDiff(activeTab)
  }, [activeTab, detailTab, loadDiff])

  const selectMr = (mr: MrListItem) => {
    setOpenTabs((prev) =>
      prev.some((t) => t.id === mr.id)
        ? prev
        : [...prev, { id: mr.id, host: mr.host, project: mr.project, iid: mr.iid, title: mr.title, state: mr.state, pipelineStatus: mr.pipeline?.status }],
    )
    setActiveTabId(mr.id)
    setNarrowShowDetail(true)
  }

  const closeTab = (id: string) => {
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id)
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id) {
        const replacement = next[Math.max(0, idx - 1)]?.id ?? null
        setActiveTabId(replacement)
        if (!replacement) {
          setMaximized(false)
          setNarrowShowDetail(false)
        }
      }
      return next
    })
  }

  const runAction = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!bridge || !activeTab) return
    setActionBusy(true)
    const res = await bridge.callTool('gitlab_ui_action', {
      host: activeTab.host,
      project: activeTab.project,
      iid: activeTab.iid,
      action,
      ...extra,
    })
    setActionBusy(false)
    if (!res.ok) {
      pushToast(`Action "${action}" failed`, res.text, 'error')
      return
    }
    pushToast(res.text || `Completed ${action}`, undefined, 'success')
    await loadDetail(activeTab, true)
    void fetchList(true)
  }

  const loadJobLog = async (jobId: number, mode: 'errors' | 'tail' | 'full'): Promise<string | undefined> => {
    if (!bridge || !activeTab) return undefined
    const res = await bridge.callTool<{ text: string }>('gitlab_ui_job_log', {
      host: activeTab.host,
      project: activeTab.project,
      jobId,
      mode,
    })
    if (!res.ok) {
      pushToast('Failed to load job log', res.text, 'error')
      return undefined
    }
    return res.data?.text ?? res.text
  }

  // Viewed files for active MR (invalidated automatically when head SHA changes)
  const activeViewedPaths = useMemo(() => {
    if (!activeTab || !activeDetail?.sha || !persisted) return new Set<string>()
    const rec = persisted.filesViewed[activeTab.id]
    if (!rec || rec.sha !== activeDetail.sha) return new Set<string>()
    return new Set(rec.paths)
  }, [activeTab, activeDetail?.sha, persisted])

  const handleSetFileViewed = (path: string, viewed: boolean) => {
    if (!bridge || !activeTab || !activeDetail?.sha) return
    void bridge
      .callTool<{ state: DashboardState }>('gitlab_ui_state', {
        action: 'set_file_viewed',
        mrKey: activeTab.id,
        sha: activeDetail.sha,
        path,
        viewed,
      })
      .then((res) => {
        if (res.ok && res.data?.state) setPersisted(res.data.state)
      })
  }

  // Resizable split drag
  const [draggingSplit, setDraggingSplit] = useState(false)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    setDraggingSplit(true)
    let latestPct = listWidthPct
    const onMove = (ev: MouseEvent) => {
      const rect = shellRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      const pct = Math.min(64, Math.max(24, Math.round(((ev.clientX - rect.left) / rect.width) * 100)))
      latestPct = pct
      setListWidthPct(pct)
    }
    const onUp = () => {
      setDraggingSplit(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      persistPrefs({ listWidthPct: latestPct })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleAddRepo = async (path: string): Promise<string | undefined> => {
    if (!bridge) return 'Not connected to MCP server.'
    const res = await bridge.callTool<{ state: DashboardState; added?: { project: string }; registeredRepos?: ActiveRepo[] }>('gitlab_ui_state', {
      action: 'add_repo',
      path,
    })
    if (!res.ok) return res.text || 'Failed to add repository.'
    if (res.data?.state) setPersisted(res.data.state)
    if (res.data?.registeredRepos) setRegisteredRepos(res.data.registeredRepos)
    pushToast(`Added repository${res.data?.added ? ` ${res.data.added.project}` : ''}`, undefined, 'success')
    void fetchList(true)
    if (activeTab) void loadDetail(activeTab, true)
    return undefined
  }

  const handleRemoveRepo = async (target: string): Promise<void> => {
    if (!bridge) return
    const res = await bridge.callTool<{ state: DashboardState; registeredRepos?: ActiveRepo[] }>('gitlab_ui_state', {
      action: 'remove_repo',
      path: target,
    })
    if (!res.ok) {
      pushToast('Failed to remove repository', res.text, 'error')
      return
    }
    if (res.data?.state) setPersisted(res.data.state)
    if (res.data?.registeredRepos) setRegisteredRepos(res.data.registeredRepos)
    pushToast('Removed repository')
    void fetchList(true)
    if (activeTab) void loadDetail(activeTab, true)
  }

  const copyText = async (text: string): Promise<boolean> => {
    try {
      if (!navigator.clipboard?.writeText) return false
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  const handleCheckoutWorktree = async () => {
    if (!bridge || !activeTab) return
    setActionBusy(true)
    const res = await bridge.callTool<{ path: string; branch: string; reused: boolean; warnings?: string[] }>('gitlab_ui_action', {
      host: activeTab.host,
      project: activeTab.project,
      iid: activeTab.iid,
      action: 'checkout_worktree',
    })
    setActionBusy(false)
    if (!res.ok) {
      pushToast('Worktree checkout failed', res.text, 'error')
      return
    }
    setPendingForceRemove(null)
    const wtPath = res.data?.path
    const copied = wtPath ? await copyText(wtPath) : false
    const warnings = res.data?.warnings ?? []
    const title = res.data?.reused
      ? copied
        ? 'Worktree synced (path copied)'
        : 'Worktree synced'
      : copied
        ? 'Worktree ready (path copied)'
        : 'Worktree ready'
    const detail = warnings.length > 0 ? `${wtPath ?? ''}\n${warnings.join(' ')}`.trim() : wtPath
    pushToast(title, detail, warnings.length > 0 ? 'warning' : 'success')
    await loadDetail(activeTab, true)
  }

  const handleRemoveWorktree = async (worktreePath: string) => {
    if (!bridge || !activeTab) return
    const key = `${activeTab.id}:${worktreePath}`
    const force = pendingForceRemove?.key === key
    setActionBusy(true)
    const res = await bridge.callTool<{ removed?: boolean; needsForce?: boolean; message?: string; warnings?: string[] }>('gitlab_ui_action', {
      host: activeTab.host,
      project: activeTab.project,
      iid: activeTab.iid,
      action: 'remove_worktree',
      worktreePath,
      ...(force ? { force: true } : {}),
    })
    setActionBusy(false)
    if (!res.ok) {
      pushToast('Failed to remove worktree', res.text, 'error')
      return
    }
    if (res.data?.needsForce && !res.data.removed) {
      const msg = res.data.message || 'Worktree has uncommitted or unpushed changes. Click again to force remove.'
      setPendingForceRemove({ key, message: msg })
      pushToast('Confirm force removal', msg, 'warning')
      return
    }
    setPendingForceRemove(null)
    const warnings = res.data?.warnings ?? []
    pushToast('Worktree removed', warnings.join(' ') || undefined, warnings.length > 0 ? 'warning' : 'success')
    await loadDetail(activeTab, true)
  }

  // Agent handoff helpers (only rendered when host offers message/updateModelContext)
  const handoffToAgent = async (kind: 'review' | 'fix-ci' | 'threads' | 'attach') => {
    if (!bridge || !activeDetail || handoffBusyRef.current) return
    handoffBusyRef.current = true
    setHandoffBusy(true)
    try {
      const ref = `${activeDetail.project}!${activeDetail.iid} (${activeDetail.host})`
      const branches = `${activeDetail.source} -> ${activeDetail.target}`
      const wtNote = activeDetail.activeWorktree
        ? `\nLocal worktree: ${activeDetail.activeWorktree.path} (branch ${activeDetail.activeWorktree.branch})`
        : ''
      if (kind === 'attach') {
        const ctx = `GitLab MR ${ref}\nTitle: ${activeDetail.title}\nBranches: ${branches}${wtNote}\nURL: ${activeDetail.url}\nBlockers: ${activeDetail.blockers.join(', ') || 'none'}`
        const ok = await bridge.updateContext(ctx)
        pushToast(ok ? 'Attached MR context to next message' : 'Could not attach context', ref, ok ? 'success' : 'error')
        return
      }
      const prompts = {
        review: `Review GitLab MR !${activeDetail.iid} in ${activeDetail.project} on ${activeDetail.host} (${branches}, ${activeDetail.url})${wtNote} and save any findings as draft notes.`,
        'fix-ci': `Inspect the failing pipeline #${activeDetail.pipeline?.id ?? ''} jobs and logs for GitLab MR !${activeDetail.iid} in ${activeDetail.project} on ${activeDetail.host} (${branches}, ${activeDetail.url})${wtNote} and help fix the failure.`,
        threads: `Inspect all unresolved discussions on GitLab MR !${activeDetail.iid} in ${activeDetail.project} on ${activeDetail.host} (${branches}, ${activeDetail.url})${wtNote} and help address them.`,
      }
      const prompt = prompts[kind]
      const sent = await bridge.sendMessage(prompt, { target: 'new', allowUnadvertised: caps.canUpdateContext })
      if (sent.ok) {
        pushToast('Started new agent conversation', ref, 'success')
        return
      }
      const [attached, copied] = await Promise.all([
        caps.canUpdateContext ? bridge.updateContext(prompt) : Promise.resolve(false),
        copyText(prompt),
      ])
      if (attached && copied) {
        pushToast('Attached prompt to chat & copied', 'Send in this chat or paste into a new conversation.', 'success')
      } else if (attached) {
        pushToast('Attached prompt to next message', 'Send your next chat message to run it.', 'success')
      } else if (copied) {
        pushToast('Copied agent prompt', 'Paste into an agent conversation to run.', 'default')
      } else {
        pushToast('Could not start conversation', ref, 'error')
      }
    } finally {
      handoffBusyRef.current = false
      setHandoffBusy(false)
    }
  }

  if (connectError) {
    return (
      <div className="empty-state">
        <strong style={{ color: 'var(--fg-danger)' }}>MCP App connection failed</strong>
        <span>{connectError.message}</span>
      </div>
    )
  }

  if (!isConnected) {
    return <div className="empty-state">Connecting to GitLab MCP server…</div>
  }

  if (bootstrapError && configuredHosts.length === 0) {
    return (
      <div className="empty-state">
        <strong style={{ color: 'var(--fg-primary)' }}>GitLab credentials required</strong>
        <p style={{ maxWidth: 420 }}>{bootstrapError}</p>
      </div>
    )
  }

  const showList = narrow ? !narrowShowDetail : !maximized
  const showDetail = narrow ? narrowShowDetail && Boolean(activeTab) : Boolean(activeTab)
  const listWidthStyle = narrow ? '100%' : showDetail ? `${listWidthPct}%` : '100%'
  const unresolvedCount = activeDetail?.discussions.filter((d) => d.resolvable && !d.resolved).length ?? 0
  const iApproved = Boolean(
    activeDetail?.currentUser && activeDetail.approvals?.by.some((u) => u.toLowerCase() === activeDetail.currentUser!.toLowerCase()),
  )

  return (
    <div ref={setShellNode} className="app-shell">
      {showList ? (
        <MrListColumn
          mrs={mrs}
          loading={listLoading}
          enriched={listEnriched}
          errors={listErrors}
          configuredHosts={configuredHosts}
          registeredRepos={registeredRepos}
          usedFallbackMine={usedFallbackMine}
          workspace={workspace}
          workspaceScoped={workspaceScoped}
          selectedMrId={activeTabId}
          q={q}
          stateFilter={stateFilter}
          involvement={involvement}
          sort={sort}
          hostOrProject={hostOrProject}
          savedViews={persisted?.savedViews ?? []}
          activeViewId={activeViewId}
          autoRefresh={autoRefresh}
          countdown={countdown}
          widthStyle={listWidthStyle}
          onToggleWorkspaceScope={() => setWorkspaceScoped((v) => !v)}
          onChangeQ={(next) => {
            setQ(next)
            setActiveViewId(null)
          }}
          onChangeState={(next) => {
            setStateFilter(next)
            setActiveViewId(null)
            persistPrefs({ state: next })
          }}
          onChangeInvolvement={(next) => {
            setInvolvement(next)
            setActiveViewId(null)
            persistPrefs({ involvement: next })
          }}
          onChangeSort={(next) => {
            setSort(next)
            setActiveViewId(null)
            persistPrefs({ sort: next })
          }}
          onChangeHostOrProject={(next) => {
            setHostOrProject(next)
            setActiveViewId(null)
            persistPrefs({ hostOrProject: next })
          }}
          onApplyView={(v: SavedView) => {
            setQ(v.filters.q)
            setStateFilter(v.filters.state)
            setInvolvement(v.filters.involvement)
            setSort(v.filters.sort)
            setHostOrProject(v.filters.hostOrProject)
            setWorkspaceScoped(false)
            setActiveViewId(v.id)
            pushToast(`Loaded view "${v.name}"`)
          }}
          onSaveView={(name) => {
            if (!bridge) return
            void bridge
              .callTool<{ state: DashboardState }>('gitlab_ui_state', {
                action: 'save_view',
                name,
                q,
                state: stateFilter,
                involvement,
                sort,
                hostOrProject,
              })
              .then((res) => {
                if (res.ok && res.data?.state) {
                  setPersisted(res.data.state)
                  setActiveViewId(res.data.state.savedViews.at(-1)?.id ?? null)
                  pushToast(`Saved view "${name}"`, undefined, 'success')
                }
              })
          }}
          onDeleteView={(id) => {
            if (!bridge) return
            void bridge.callTool<{ state: DashboardState }>('gitlab_ui_state', { action: 'delete_view', id }).then((res) => {
              if (res.ok && res.data?.state) {
                setPersisted(res.data.state)
                if (activeViewId === id) setActiveViewId(null)
              }
            })
          }}
          onAddRepo={handleAddRepo}
          onRemoveRepo={handleRemoveRepo}
          onToggleAutoRefresh={() => {
            const next = !autoRefresh
            setAutoRefresh(next)
            persistPrefs({ autoRefresh: next })
          }}
          onRefresh={() => void fetchList()}
          onSelectMr={selectMr}
        />
      ) : null}

      {!narrow && showList && showDetail ? (
        <div className={`split-handle ${draggingSplit ? 'dragging' : ''}`} onMouseDown={startResize} />
      ) : null}

      {showDetail && activeTab ? (
        <main className="detail-pane">
          {/* Multi-MR Tab Strip */}
          <div className="tabstrip">
            {narrow ? (
              <button className="btn btn-sm" onClick={() => setNarrowShowDetail(false)}>
                <BackIcon />
                List
              </button>
            ) : null}

            <div className="tabs-scroll">
              {openTabs.map((tab) => {
                const isActive = tab.id === activeTab.id
                const dotColor =
                  tab.state === 'merged'
                    ? '#8b5cf6'
                    : tab.pipelineStatus?.toLowerCase() === 'failed'
                      ? 'var(--fg-danger)'
                      : 'var(--fg-success)'
                return (
                  <div
                    key={tab.id}
                    className={`mr-tab ${isActive ? 'active' : ''}`}
                    onClick={() => setActiveTabId(tab.id)}
                    title={`${tab.project}!${tab.iid}${tab.title ? ` — ${tab.title}` : ''}`}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: dotColor, flexShrink: 0 }} />
                    <span className="mono">!{tab.iid}</span>
                    <span className="truncate">{tab.project.split('/').pop()}</span>
                    <button
                      className="mr-tab-close"
                      aria-label="Close tab"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(tab.id)
                      }}
                    >
                      <CloseIcon size={11} />
                    </button>
                  </div>
                )
              })}
            </div>

            {!narrow ? (
              <div className="row" style={{ gap: 2, paddingLeft: 6, borderLeft: '1px solid var(--bd-primary)', flexShrink: 0 }}>
                <button className="btn btn-ghost btn-icon" onClick={() => setMaximized((m) => !m)} title="Maximize / restore detail">
                  <MaximizeIcon />
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => {
                    setOpenTabs([])
                    setActiveTabId(null)
                    setMaximized(false)
                  }}
                  title="Close all tabs"
                >
                  <CloseIcon />
                </button>
              </div>
            ) : null}
          </div>

          {/* Detail Body */}
          {detailLoading && !activeDetail ? (
            <div className="empty-state">Loading !{activeTab.iid}…</div>
          ) : !activeDetail ? (
            <div className="empty-state">Could not load merge request details.</div>
          ) : (
            <>
              {/* Header */}
              <div className="detail-header">
                <div className="row-between">
                  <div className="row" style={{ gap: 5, color: 'var(--fg-secondary)', minWidth: 0 }}>
                    <span className="truncate">{activeDetail.host}</span>
                    <span>/</span>
                    <span className="truncate" style={{ color: 'var(--fg-primary)', fontWeight: 500 }}>
                      {activeDetail.project}
                    </span>
                    <span className="mono">!{activeDetail.iid}</span>
                    {activeDetail.draft ? <span className="pill">Draft</span> : null}
                    {activeDetail.state === 'merged' ? <span className="pill pill-info">Merged</span> : null}
                    {activeDetail.isProtectedTarget ? <span className="pill pill-warning">Protected target</span> : null}
                  </div>

                  <div className="row" style={{ gap: 5, flexShrink: 0 }}>
                    {activeDetail.state === 'opened' ? (
                      <>
                        <button
                          className="btn btn-sm"
                          disabled={actionBusy}
                          title={activeDetail.draft ? 'Mark this MR as ready for review' : 'Convert this MR back to draft'}
                          onClick={() => void runAction('toggle_draft', { draft: !activeDetail.draft })}
                        >
                          {activeDetail.draft ? 'Mark ready' : 'Draft'}
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={actionBusy}
                          title="Rebase this MR's source branch onto its target branch on GitLab"
                          onClick={() => void runAction('rebase')}
                        >
                          Rebase
                        </button>
                        <button
                          className={`btn btn-sm ${iApproved ? 'btn-success' : ''}`}
                          disabled={actionBusy}
                          title={iApproved ? 'Remove your approval from this MR' : 'Approve this merge request'}
                          onClick={() => void runAction(iApproved ? 'unapprove' : 'approve')}
                        >
                          {iApproved ? '✓ Approved' : 'Approve'}
                        </button>
                        <button
                          className={`btn btn-sm ${activeDetail.blockers.length === 0 ? 'btn-primary' : ''}`}
                          disabled={actionBusy}
                          title="Open merge options and safety checks"
                          onClick={() => setMergeModalOpen(true)}
                        >
                          Merge…
                        </button>
                      </>
                    ) : null}
                    <button
                      className="btn btn-sm"
                      disabled={actionBusy || !activeDetail.localRepoPath}
                      title={
                        activeDetail.localRepoPath
                          ? activeDetail.activeWorktree
                            ? `Sync isolated worktree (${activeDetail.activeWorktree.branch}) and copy its path`
                            : 'Create an isolated git worktree for this MR and copy its path'
                          : 'Register this repository in Repos to enable local worktree checkout'
                      }
                      onClick={() => void handleCheckoutWorktree()}
                    >
                      <GitBranchIcon />
                      {activeDetail.activeWorktree ? 'Sync' : 'Checkout'}
                    </button>
                    {caps.canOpenLinks ? (
                      <button
                        className="btn btn-sm btn-icon"
                        onClick={() => void bridge?.openLink(activeDetail.url)}
                        title="Open this MR in GitLab"
                      >
                        <ExternalLinkIcon />
                      </button>
                    ) : null}
                  </div>
                </div>

                <h2 className="detail-title">{activeDetail.title}</h2>

                <div className="row-between" style={{ color: 'var(--fg-secondary)' }}>
                  <div className="row" style={{ gap: 6 }}>
                    {activeDetail.author ? <Avatar username={activeDetail.author} size={16} /> : null}
                    <span style={{ color: 'var(--fg-primary)' }}>{activeDetail.authorName ?? activeDetail.author ?? 'unknown'}</span>
                    <span>·</span>
                    <span>updated {formatRelativeTime(activeDetail.updatedAt)}</span>
                  </div>
                  <div className="row mono" style={{ gap: 5 }}>
                    <span className="pill truncate" style={{ maxWidth: 140 }}>
                      {activeDetail.target}
                    </span>
                    <span>←</span>
                    <span className="pill truncate" style={{ maxWidth: 170 }}>
                      {activeDetail.source}
                    </span>
                  </div>
                </div>
              </div>

              {/* Active Local Worktree Strip */}
              {activeDetail.activeWorktree ? (
                <div className="worktree-bar">
                  <div className="row" style={{ gap: 6, minWidth: 0, flex: 1 }}>
                    <span className="pill pill-info mono" style={{ flexShrink: 0 }}>
                      <GitBranchIcon />
                      {activeDetail.activeWorktree.branch}
                    </span>
                    <span className="mono truncate" style={{ color: 'var(--fg-secondary)' }} title={activeDetail.activeWorktree.path}>
                      {activeDetail.activeWorktree.path}
                    </span>
                  </div>
                  <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                    <button
                      className="btn btn-sm"
                      title="Copy worktree path to clipboard"
                      onClick={() => {
                        const wtPath = activeDetail.activeWorktree!.path
                        void copyText(wtPath).then((copied) => {
                          pushToast(copied ? 'Copied worktree path' : 'Could not copy worktree path', wtPath, copied ? 'default' : 'error')
                        })
                      }}
                    >
                      <CopyIcon />
                      Copy
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={actionBusy}
                      title="Fast-forward this worktree to the latest MR commit"
                      onClick={() => void handleCheckoutWorktree()}
                    >
                      Sync
                    </button>
                    <button
                      className={`btn btn-sm ${pendingForceRemove?.key === `${activeTab.id}:${activeDetail.activeWorktree.path}` ? 'btn-danger' : ''}`}
                      disabled={actionBusy}
                      title={
                        pendingForceRemove?.key === `${activeTab.id}:${activeDetail.activeWorktree.path}`
                          ? pendingForceRemove.message
                          : 'Remove this isolated review worktree'
                      }
                      onClick={() => void handleRemoveWorktree(activeDetail.activeWorktree!.path)}
                    >
                      {pendingForceRemove?.key === `${activeTab.id}:${activeDetail.activeWorktree.path}` ? 'Force remove?' : 'Remove'}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Agent Handoff Bar (strictly gated on host capabilities -> shown in aux_pane, hidden in global) */}
              {caps.canMessage || caps.canUpdateContext ? (
                <div className="agent-bar">
                  <span className="row" style={{ gap: 4, color: 'var(--fg-secondary)', fontWeight: 500 }}>
                    <SparkleIcon />
                    Agent:
                  </span>
                  <button
                    className="btn btn-sm"
                    disabled={handoffBusy}
                    title={
                      caps.canMessage
                        ? 'Start a new agent conversation to review this MR and save findings as draft notes'
                        : 'Start a new agent conversation to review this MR if supported, or attach the prompt to chat context and copy it'
                    }
                    onClick={() => void handoffToAgent('review')}
                  >
                    Review MR
                  </button>
                  {activeDetail.pipeline?.status?.toLowerCase() === 'failed' ? (
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={handoffBusy}
                      title={
                        caps.canMessage
                          ? 'Start a new agent conversation to inspect failing CI jobs and help fix the pipeline'
                          : 'Start a new agent conversation to inspect failing CI jobs if supported, or attach the prompt to chat context and copy it'
                      }
                      onClick={() => void handoffToAgent('fix-ci')}
                    >
                      Fix failing pipeline
                    </button>
                  ) : null}
                  {unresolvedCount > 0 ? (
                    <button
                      className="btn btn-sm"
                      disabled={handoffBusy}
                      title={
                        caps.canMessage
                          ? 'Start a new agent conversation to inspect and address unresolved review threads'
                          : 'Start a new agent conversation to inspect and address unresolved review threads if supported, or attach the prompt to chat context and copy it'
                      }
                      onClick={() => void handoffToAgent('threads')}
                    >
                      Address {unresolvedCount} thread{unresolvedCount === 1 ? '' : 's'}
                    </button>
                  ) : null}
                  {caps.canUpdateContext ? (
                    <button
                      className="btn btn-sm"
                      style={{ marginLeft: 'auto' }}
                      disabled={handoffBusy}
                      title="Attach this MR's summary to your next chat message without sending"
                      onClick={() => void handoffToAgent('attach')}
                    >
                      Attach context
                    </button>
                  ) : null}
                </div>
              ) : null}

              {/* Segmented Sub-tabs */}
              <div className="detail-tabs-bar">
                <div className="seg-group">
                  <button className={`seg-btn ${detailTab === 'summary' ? 'active' : ''}`} onClick={() => setDetailTab('summary')}>
                    Summary
                  </button>
                  <button className={`seg-btn ${detailTab === 'discussions' ? 'active' : ''}`} onClick={() => setDetailTab('discussions')}>
                    Discussions
                    {unresolvedCount > 0 ? <span className="pill pill-warning mono">{unresolvedCount}</span> : null}
                    {activeDetail.drafts.length > 0 ? <span className="pill pill-info mono">{activeDetail.drafts.length} draft</span> : null}
                  </button>
                  <button className={`seg-btn ${detailTab === 'code' ? 'active' : ''}`} onClick={() => setDetailTab('code')}>
                    Code
                    {activeDiff ? <span className="mono" style={{ color: 'var(--fg-tertiary)' }}>{activeDiff.length}</span> : null}
                  </button>
                </div>

                <PipelineGlyph status={activeDetail.pipeline?.status} withLabel />
              </div>

              {/* Active Detail Tab */}
              {detailTab === 'summary' ? (
                <SummaryTab
                  key={activeTab.id}
                  detail={activeDetail}
                  busy={actionBusy}
                  onOpenLink={(url) => void bridge?.openLink(url)}
                  onRunAction={runAction}
                  onLoadJobLog={loadJobLog}
                />
              ) : detailTab === 'discussions' ? (
                <DiscussionsTab
                  key={activeTab.id}
                  detail={activeDetail}
                  busy={actionBusy}
                  onOpenLink={(url) => void bridge?.openLink(url)}
                  onJumpToFile={(path) => {
                    setDetailTab('code')
                    setTimeout(() => document.getElementById(`diff-file-${path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
                  }}
                  onRunAction={runAction}
                />
              ) : (
                <CodeDiffTab
                  key={activeTab.id}
                  detail={activeDetail}
                  files={activeDiff}
                  loading={diffLoading}
                  narrow={narrow}
                  diffMode={diffMode}
                  showFileIndex={showFileIndex}
                  viewedPaths={activeViewedPaths}
                  busy={actionBusy}
                  onChangeDiffMode={(mode) => {
                    setDiffMode(mode)
                    persistPrefs({ diffMode: mode })
                  }}
                  onToggleFileIndex={() => {
                    const next = !showFileIndex
                    setShowFileIndex(next)
                    persistPrefs({ showFileIndex: next })
                  }}
                  onSetFileViewed={handleSetFileViewed}
                  onOpenLink={(url) => void bridge?.openLink(url)}
                  onRunAction={runAction}
                />
              )}
            </>
          )}
        </main>
      ) : null}

      {/* Guarded Merge Modal */}
      {mergeModalOpen && activeDetail ? (
        <MergeModal
          detail={activeDetail}
          busy={actionBusy}
          onClose={() => setMergeModalOpen(false)}
          onConfirm={(opts) => {
            void runAction('merge', { sha: activeDetail.sha, ...opts }).then(() => setMergeModalOpen(false))
          }}
        />
      ) : null}

      {/* Toast Stack */}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast"
            style={{
              borderColor:
                t.tone === 'success'
                  ? 'var(--fg-success)'
                  : t.tone === 'error'
                    ? 'var(--fg-danger)'
                    : t.tone === 'warning'
                      ? 'var(--fg-warning)'
                      : undefined,
            }}
          >
            <div style={{ fontWeight: 500 }}>{t.title}</div>
            {t.detail ? <div style={{ color: 'var(--fg-secondary)', marginTop: 2 }}>{t.detail}</div> : null}
          </div>
        ))}
      </div>
    </div>
  )
}
