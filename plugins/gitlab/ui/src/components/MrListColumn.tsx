import { useEffect, useMemo, useRef, useState } from 'react'
import { filterAndSortMrs, formatRelativeTime, groupMrs, parseSearchQuery } from '../lib/query.ts'
import type { ActiveRepo, InvolvementFilter, MrListItem, MrStateFilter, SavedView, SortOrder, WorkspaceInfo } from '../types.ts'
import { Avatar, BookmarkIcon, CloseIcon, EyeIcon, FolderIcon, LabelBadge, MrStateGlyph, PenIcon, PipelineGlyph, RefreshIcon, SearchIcon } from './Icons.tsx'

export function MrListColumn({
  mrs,
  loading,
  enriched,
  errors,
  configuredHosts,
  registeredRepos,
  usedFallbackMine,
  workspace,
  workspaceScoped,
  selectedMrId,
  q,
  stateFilter,
  involvement,
  sort,
  hostOrProject,
  savedViews,
  activeViewId,
  autoRefresh,
  countdown,
  widthStyle,
  onToggleWorkspaceScope,
  onChangeQ,
  onChangeState,
  onChangeInvolvement,
  onChangeSort,
  onChangeHostOrProject,
  onApplyView,
  onSaveView,
  onDeleteView,
  onAddRepo,
  onRemoveRepo,
  onToggleAutoRefresh,
  onRefresh,
  onSelectMr,
}: {
  mrs: readonly MrListItem[]
  loading: boolean
  enriched: boolean
  errors: readonly { host: string; message: string }[]
  configuredHosts: readonly string[]
  registeredRepos: readonly ActiveRepo[]
  usedFallbackMine: boolean
  workspace: WorkspaceInfo | null
  workspaceScoped: boolean
  selectedMrId: string | null
  q: string
  stateFilter: MrStateFilter
  involvement: InvolvementFilter
  sort: SortOrder
  hostOrProject: string
  savedViews: readonly SavedView[]
  activeViewId: string | null
  autoRefresh: boolean
  countdown: number
  widthStyle?: string
  onToggleWorkspaceScope: () => void
  onChangeQ: (q: string) => void
  onChangeState: (s: MrStateFilter) => void
  onChangeInvolvement: (i: InvolvementFilter) => void
  onChangeSort: (s: SortOrder) => void
  onChangeHostOrProject: (v: string) => void
  onApplyView: (v: SavedView) => void
  onSaveView: (name: string) => void
  onDeleteView: (id: string) => void
  onAddRepo: (path: string) => Promise<string | undefined>
  onRemoveRepo: (target: string) => Promise<void>
  onToggleAutoRefresh: () => void
  onRefresh: () => void
  onSelectMr: (mr: MrListItem) => void
}) {
  const [viewsOpen, setViewsOpen] = useState(false)
  const [reposOpen, setReposOpen] = useState(false)
  const [repoInput, setRepoInput] = useState('')
  const [repoError, setRepoError] = useState<string | null>(null)
  const [repoBusy, setRepoBusy] = useState(false)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const viewsWrapRef = useRef<HTMLDivElement | null>(null)
  const reposWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!viewsOpen && !reposOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (viewsOpen && viewsWrapRef.current && !viewsWrapRef.current.contains(target)) {
        setViewsOpen(false)
      }
      if (reposOpen && reposWrapRef.current && !reposWrapRef.current.contains(target)) {
        setReposOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setViewsOpen(false)
        setReposOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [viewsOpen, reposOpen])

  const submitAddRepo = async () => {
    const trimmed = repoInput.trim()
    if (!trimmed || repoBusy) return
    setRepoBusy(true)
    setRepoError(null)
    const err = await onAddRepo(trimmed)
    setRepoBusy(false)
    if (err) {
      setRepoError(err)
    } else {
      setRepoInput('')
    }
  }

  const effectiveHostOrProject = workspace && workspaceScoped ? `proj:${workspace.host}|${workspace.project}` : hostOrProject

  const filtered = useMemo(
    () =>
      filterAndSortMrs(mrs, {
        q,
        state: stateFilter,
        involvement,
        sort,
        hostOrProject: effectiveHostOrProject,
      }),
    [mrs, q, stateFilter, involvement, sort, effectiveHostOrProject],
  )

  const groups = useMemo(() => groupMrs(filtered, involvement), [filtered, involvement])
  const parsed = useMemo(() => parseSearchQuery(q), [q])

  const projectOptions = useMemo(() => {
    const map = new Map<string, { key: string; label: string }>()
    for (const r of registeredRepos) {
      const key = `proj:${r.host}|${r.project}`
      if (!map.has(key)) map.set(key, { key, label: r.project })
    }
    for (const m of mrs) {
      const key = `proj:${m.host}|${m.project}`
      if (!map.has(key)) map.set(key, { key, label: m.project })
    }
    if (hostOrProject.startsWith('proj:') && !map.has(hostOrProject)) {
      const spec = hostOrProject.slice(5)
      const sep = spec.indexOf('|')
      const label = sep >= 0 ? spec.slice(sep + 1) : spec
      if (label) map.set(hostOrProject, { key: hostOrProject, label })
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [registeredRepos, mrs, hostOrProject])

  const activeView = savedViews.find((v) => v.id === activeViewId)

  return (
    <aside className="list-pane" style={{ width: widthStyle ?? '100%' }}>
      {/* Header */}
      <div className="pane-header">
        <div className="row" style={{ gap: 6, minWidth: 0 }}>
          <h1 className="pane-title truncate">Merge requests</h1>
          {workspace ? (
            <button
              className="btn btn-sm truncate"
              style={{ maxWidth: 185 }}
              onClick={onToggleWorkspaceScope}
              title={workspaceScoped ? 'Click to show MRs from all projects' : `Click to focus on ${workspace.project}`}
            >
              {workspaceScoped ? `${workspace.project} ▾` : 'All projects ▾'}
            </button>
          ) : null}
        </div>

        <div className="row" style={{ gap: 5, flexShrink: 0 }}>
          <button
            className="btn btn-sm"
            onClick={onToggleAutoRefresh}
            title="Toggle 60s auto-refresh"
            style={{ color: 'var(--fg-secondary)' }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: autoRefresh ? 'var(--fg-success)' : 'var(--fg-tertiary)',
                opacity: autoRefresh ? 1 : 0.45,
              }}
            />
            <span className="mono">{autoRefresh ? `${countdown}s` : 'Paused'}</span>
          </button>
          <button className="btn btn-icon" onClick={onRefresh} disabled={loading} title="Refresh merge requests">
            <RefreshIcon spinning={loading} />
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="toolbar">
        <div className="search-wrap">
          <span className="search-icon">
            <SearchIcon />
          </span>
          <input
            className="input search-input"
            type="text"
            placeholder="Search MRs, or label:bug author:name checks:failing draft:yes"
            value={q}
            onChange={(e) => onChangeQ(e.target.value)}
          />
          {q ? (
            <button className="search-clear" onClick={() => onChangeQ('')} aria-label="Clear search">
              <CloseIcon />
            </button>
          ) : null}
        </div>

        <div className="filter-row">
          <select className="select" value={stateFilter} onChange={(e) => onChangeState(e.target.value as MrStateFilter)} aria-label="MR state">
            <option value="opened">Open</option>
            <option value="merged">Merged</option>
            <option value="closed">Closed</option>
            <option value="all">All states</option>
          </select>

          <select className="select" value={involvement} onChange={(e) => onChangeInvolvement(e.target.value as InvolvementFilter)} aria-label="Involvement">
            <option value="all">All</option>
            <option value="waiting">Waiting on me</option>
            <option value="reviewing">Reviewing</option>
            <option value="authored">Authored</option>
            <option value="others">Others</option>
          </select>

          <select className="select" value={sort} onChange={(e) => onChangeSort(e.target.value as SortOrder)} aria-label="Sort order">
            <option value="ready">Sort: Merge readiness</option>
            <option value="updated">Sort: Recently updated</option>
            <option value="newest">Sort: Newest</option>
            <option value="oldest">Sort: Oldest</option>
            <option value="largest">Sort: Largest diff</option>
          </select>

          {!(workspace && workspaceScoped) ? (
            <select
              className="select"
              value={hostOrProject}
              onChange={(e) => onChangeHostOrProject(e.target.value)}
              aria-label="Host or project"
            >
              <option value="all">All projects</option>
              <option value="mine">My MRs (all hosts)</option>
              {configuredHosts.map((h) => (
                <option key={h} value={`host:${h}`}>
                  {h}
                </option>
              ))}
              {projectOptions.length > 0 ? <option disabled>──────────</option> : null}
              {projectOptions.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          ) : null}

          <div className="row" style={{ gap: 5, marginLeft: 'auto' }}>
            <div ref={reposWrapRef} className="popover-wrap">
              <button
                className="btn btn-sm"
                title="Manage local GitLab repositories tracked by the dashboard and enabled for worktree checkout"
                onClick={() => {
                  setViewsOpen(false)
                  setRepoError(null)
                  setReposOpen((o) => !o)
                }}
              >
                <FolderIcon />
                <span>Repos</span>
                {registeredRepos.length > 0 ? <span className="mono" style={{ opacity: 0.7 }}>{registeredRepos.length}</span> : null}
              </button>

              {reposOpen ? (
                <div className="popover-menu" style={{ width: 290 }}>
                  <div className="card-header" style={{ padding: '6px 10px', fontSize: 11, color: 'var(--fg-secondary)' }}>
                    Local Repositories
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', padding: 4 }}>
                    {registeredRepos.length === 0 ? (
                      <div style={{ padding: '8px 8px', color: 'var(--fg-tertiary)' }}>
                        No local repositories tracked yet. Add a clone path below to browse all its MRs and enable worktree checkout.
                      </div>
                    ) : (
                      registeredRepos.map((r) => (
                        <div key={`${r.host}|${r.project}`} className="row-between" style={{ padding: '4px 6px', borderRadius: 5, gap: 6 }}>
                          <div style={{ minWidth: 0, flex: 1 }} title={`${r.host}/${r.project}\n${r.path}`}>
                            <div className="truncate" style={{ fontWeight: 500 }}>{r.project}</div>
                            <div className="row" style={{ gap: 4, color: 'var(--fg-tertiary)', fontSize: 10.5 }}>
                              <span className="truncate">{r.host}</span>
                              <span className="pill" style={{ padding: '0 4px', fontSize: 10 }}>
                                {r.source}
                              </span>
                            </div>
                          </div>
                          {r.source === 'registered' ? (
                            <button
                              className="btn btn-ghost btn-icon"
                              title={`Remove ${r.project}`}
                              onClick={() => void onRemoveRepo(r.path)}
                            >
                              <CloseIcon size={11} />
                            </button>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>
                  <div style={{ borderTop: '1px solid var(--bd-primary)', padding: 6 }} className="stack">
                    <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 0, padding: '4px 7px' }}
                        placeholder="~/path/to/repo"
                        value={repoInput}
                        disabled={repoBusy}
                        onChange={(e) => {
                          setRepoInput(e.target.value)
                          if (repoError) setRepoError(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void submitAddRepo()
                        }}
                      />
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={repoBusy || !repoInput.trim()}
                        onClick={() => void submitAddRepo()}
                      >
                        {repoBusy ? '…' : 'Add'}
                      </button>
                    </div>
                    {repoError ? (
                      <div style={{ color: 'var(--fg-danger)', fontSize: 11, lineHeight: 1.35 }}>{repoError}</div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div ref={viewsWrapRef} className="popover-wrap">
              <button
                className="btn btn-sm"
                title="Load or save filter views"
                onClick={() => {
                  setReposOpen(false)
                  setViewsOpen((o) => !o)
                }}
              >
                <BookmarkIcon />
                <span className="truncate" style={{ maxWidth: 96 }}>
                  {activeView ? activeView.name : 'Views'}
                </span>
              </button>

              {viewsOpen ? (
                <div className="popover-menu">
                  <div className="card-header" style={{ padding: '6px 10px', fontSize: 11, color: 'var(--fg-secondary)' }}>
                    Saved Views
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', padding: 4 }}>
                    {savedViews.length === 0 ? (
                      <div style={{ padding: '8px 8px', color: 'var(--fg-tertiary)' }}>No saved views yet.</div>
                    ) : (
                      savedViews.map((v) => (
                        <div key={v.id} className="row-between" style={{ padding: '3px 6px', borderRadius: 5 }}>
                          <button
                            className="btn btn-ghost btn-sm truncate"
                            style={{
                              flex: 1,
                              justifyContent: 'flex-start',
                              padding: '2px 4px',
                              color: v.id === activeViewId ? 'var(--fg-info)' : 'var(--fg-primary)',
                              fontWeight: v.id === activeViewId ? 600 : 400,
                            }}
                            onClick={() => {
                              onApplyView(v)
                              setViewsOpen(false)
                            }}
                          >
                            {v.name}
                          </button>
                          <button
                            className="btn btn-ghost btn-icon"
                            title="Delete view"
                            onClick={() => onDeleteView(v.id)}
                          >
                            <CloseIcon size={11} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  <div style={{ borderTop: '1px solid var(--bd-primary)', padding: 6 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--fg-info)' }}
                      onClick={() => {
                        setViewsOpen(false)
                        setViewName('')
                        setSaveModalOpen(true)
                      }}
                    >
                      + Save current view…
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {parsed.chips.length > 0 ? (
          <div className="row" style={{ gap: 5 }}>
            {parsed.chips.map((c) => (
              <span key={c} className="pill mono">
                {c}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Fallback banner when no repos are registered yet */}
      {usedFallbackMine && registeredRepos.length === 0 ? (
        <div style={{ padding: '8px 10px 0' }}>
          <div className="banner row-between" style={{ padding: '6px 10px', gap: 8 }}>
            <span style={{ color: 'var(--fg-secondary)' }}>
              Showing your MRs. Add local repos to track all project MRs and enable worktree checkout.
            </span>
            <button
              className="btn btn-sm"
              onClick={() => {
                setViewsOpen(false)
                setRepoError(null)
                setReposOpen(true)
              }}
            >
              Add repo
            </button>
          </div>
        </div>
      ) : null}

      {/* Host errors banner */}
      {errors.length > 0 ? (
        <div style={{ padding: '8px 10px 0' }}>
          {errors.map((e) => (
            <div key={e.host} className="banner banner-danger" style={{ marginBottom: 4 }}>
              <strong>{e.host}:</strong> {e.message}
            </div>
          ))}
        </div>
      ) : null}

      {/* MR List */}
      <div className="list-scroll">
        {loading && mrs.length === 0 ? (
          <div className="empty-state">Loading merge requests…</div>
        ) : groups.length === 0 ? (
          <div className="empty-state">
            <strong style={{ color: 'var(--fg-primary)' }}>No merge requests match</strong>
            <span>Try clearing search qualifiers or switching state / scope filters.</span>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key}>
              {group.label ? (
                <div className="group-header">
                  {group.key === 'reviewing' ? <EyeIcon /> : group.key === 'authored' ? <PenIcon /> : null}
                  <span>{group.label}</span>
                  <span className="mono" style={{ opacity: 0.65 }}>
                    {group.entries.length}
                  </span>
                  <div className="group-divider" />
                </div>
              ) : null}

              <div className="stack" style={{ gap: 2 }}>
                {group.entries.map((mr) => {
                  const selected = mr.id === selectedMrId
                  const approvedOk = mr.approvals?.approved === true
                  const approvedCount = mr.approvals
                    ? `${mr.approvals.by.length}/${mr.approvals.required ?? mr.approvals.by.length + (mr.approvals.left ?? 0)}`
                    : null

                  return (
                    <button
                      key={mr.id}
                      className={`mr-row ${selected ? 'selected' : ''}`}
                      onClick={() => onSelectMr(mr)}
                    >
                      <MrStateGlyph state={mr.state} draft={mr.draft} conflicts={mr.conflicts} />
                      <div className="mr-row-body">
                        <div className="mr-row-line">
                          <span className="mono" style={{ color: 'var(--fg-tertiary)', flexShrink: 0 }}>
                            !{mr.iid}
                          </span>
                          <span className="mr-row-title truncate">{mr.title}</span>
                          {mr.isWaitingOnMe ? (
                            <span className="pill pill-info" style={{ padding: '0 5px', fontSize: 10, flexShrink: 0 }} title="Waiting on your review">
                              you
                            </span>
                          ) : null}
                          <PipelineGlyph status={mr.pipeline?.status} />
                          {approvedOk ? (
                            <span style={{ color: 'var(--fg-success)', fontWeight: 700, flexShrink: 0 }} title="Approved">
                              ✓
                            </span>
                          ) : approvedCount && mr.approvals?.required ? (
                            <span className="mono" style={{ color: 'var(--fg-tertiary)', flexShrink: 0 }} title="Approvals">
                              {approvedCount}
                            </span>
                          ) : null}
                          {mr.additions !== undefined && mr.deletions !== undefined ? (
                            <span className="mono" style={{ flexShrink: 0, display: 'inline-flex', gap: 3 }}>
                              <span style={{ color: 'var(--fg-success)' }}>+{mr.additions}</span>
                              <span style={{ color: 'var(--fg-danger)' }}>-{mr.deletions}</span>
                            </span>
                          ) : null}
                        </div>

                        <div className="mr-row-meta">
                          <span className="row" style={{ gap: 4, flexWrap: 'nowrap', flexShrink: 0 }}>
                            <Avatar username={mr.author.username} size={14} />
                            <span className="truncate" style={{ maxWidth: 85 }}>
                              {mr.author.username}
                            </span>
                          </span>
                          <span className="truncate" style={{ maxWidth: 145 }} title={`${mr.host}/${mr.project}`}>
                            {mr.project}
                          </span>
                          {mr.labels.slice(0, 2).map((l) => (
                            <LabelBadge key={l.name} name={l.name} color={l.color} />
                          ))}
                          {mr.labels.length > 2 ? <span style={{ opacity: 0.7 }}>+{mr.labels.length - 2}</span> : null}
                          <span className="mono" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                            {formatRelativeTime(mr.updatedAt)}
                          </span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="list-footer">
        <span>
          {filtered.length} merge request{filtered.length === 1 ? '' : 's'} · {enriched ? 'GraphQL' : 'REST'}
        </span>
        <span className="mono">
          {configuredHosts.length} host{configuredHosts.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Save View Modal */}
      {saveModalOpen ? (
        <div className="modal-backdrop" onClick={() => setSaveModalOpen(false)}>
          <div className="modal-card" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <strong>Save Current View</strong>
              <button className="btn btn-ghost btn-icon" onClick={() => setSaveModalOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <div className="card-pad stack">
              <label className="stack" style={{ gap: 4 }}>
                <span style={{ color: 'var(--fg-secondary)' }}>View name</span>
                <input
                  className="input"
                  style={{ padding: '6px 8px' }}
                  autoFocus
                  placeholder="e.g. Needs my review"
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && viewName.trim()) {
                      onSaveView(viewName.trim())
                      setSaveModalOpen(false)
                    }
                  }}
                />
              </label>
            </div>
            <div className="card-header" style={{ borderTop: '1px solid var(--bd-primary)', borderBottom: 'none', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setSaveModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={!viewName.trim()}
                onClick={() => {
                  onSaveView(viewName.trim())
                  setSaveModalOpen(false)
                }}
              >
                Save View
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  )
}
