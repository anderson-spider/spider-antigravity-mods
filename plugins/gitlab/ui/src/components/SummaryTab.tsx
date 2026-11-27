import { useEffect, useRef, useState } from 'react'
import { toggleMarkdownCheckbox } from '../lib/markdown.ts'
import type { MrDetail, PipelineJob } from '../types.ts'
import { Avatar, CheckIcon, CopyIcon, ExternalLinkIcon, LabelBadge, PipelineGlyph } from './Icons.tsx'
import { MarkdownView } from './MarkdownView.tsx'

export function SummaryTab({
  detail,
  busy,
  onCopyText,
  onOpenLink,
  onRunAction,
  onLoadJobLog,
}: {
  detail: MrDetail
  busy: boolean
  onCopyText?: (text: string, label: string) => void
  onOpenLink: (url: string) => void
  onRunAction: (action: string, extra?: Record<string, unknown>) => Promise<void>
  onLoadJobLog: (jobId: number, mode: 'errors' | 'tail' | 'full') => Promise<string | undefined>
}) {
  const [expandedJobId, setExpandedJobId] = useState<number | null>(() => {
    const failed = detail.pipeline?.jobs.find((j) => j.status === 'failed')
    return failed ? failed.id : null
  })
  const [logMode, setLogMode] = useState<'errors' | 'tail' | 'full'>('errors')
  const [logs, setLogs] = useState<Record<string, string>>({})
  const [loadingLogKey, setLoadingLogKey] = useState<string | null>(null)
  const autoLoadedRef = useRef<number | null>(null)

  const ready = detail.blockers.length === 0 && detail.state === 'opened'

  const fetchLog = async (jobId: number, mode: 'errors' | 'tail' | 'full') => {
    const key = `${jobId}:${mode}`
    setExpandedJobId(jobId)
    setLogMode(mode)
    if (logs[key] !== undefined) return
    setLoadingLogKey(key)
    const text = await onLoadJobLog(jobId, mode)
    setLoadingLogKey(null)
    if (text !== undefined) setLogs((prev) => ({ ...prev, [key]: text }))
  }

  useEffect(() => {
    if (expandedJobId === null || autoLoadedRef.current === expandedJobId) return
    autoLoadedRef.current = expandedJobId
    void fetchLog(expandedJobId, 'errors')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedJobId])

  const toggleJob = (job: PipelineJob) => {
    if (expandedJobId === job.id) {
      setExpandedJobId(null)
      return
    }
    void fetchLog(job.id, logMode)
  }

  return (
    <div className="detail-scroll scroller">
      <div className="stack" style={{ maxWidth: 920 }}>
        {/* Merge Readiness & Blockers */}
        <section
          className="card card-pad stack"
          style={{
            gap: 10,
            borderColor: ready ? 'color-mix(in srgb, var(--fg-success) 45%, transparent)' : undefined,
          }}
        >
          <div className="row-between">
            <div className="row" style={{ gap: 8 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: ready
                    ? 'var(--fg-success)'
                    : detail.state === 'merged'
                      ? '#8b5cf6'
                      : 'var(--fg-warning)',
                }}
              />
              <strong>
                {ready
                  ? 'Ready to merge'
                  : detail.state === 'merged'
                    ? `Merged into ${detail.target}`
                    : `Merge blocked (${detail.blockers.length})`}
              </strong>
            </div>
            {detail.sha ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs mono"
                title={`Copy commit SHA: ${detail.sha}`}
                onClick={() => onCopyText?.(detail.sha!, 'Copied commit SHA')}
              >
                <span>{detail.sha.slice(0, 8)}</span>
                <CopyIcon />
              </button>
            ) : null}
          </div>

          {detail.blockers.length > 0 ? (
            <div className="row" style={{ gap: 6 }}>
              {detail.blockers.map((b) => (
                <span key={b} className="pill pill-warning">
                  {b}
                </span>
              ))}
            </div>
          ) : null}

          {detail.rules && detail.rules.length > 0 ? (
            <div style={{ paddingTop: 6, borderTop: '1px solid var(--bd-subtle)' }}>
              {detail.rules.map((r) => (
                <div key={r.name} className="rule-row">
                  <span style={{ fontWeight: 500 }}>{r.name}</span>
                  <span className="row-nowrap mono" style={{ gap: 5, color: r.approved ? 'var(--fg-success)' : 'var(--fg-secondary)' }}>
                    <span>
                      {r.by.length}/{r.required ?? 0}
                    </span>
                    {r.approved ? <CheckIcon size={12} /> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : detail.approvals ? (
            <div style={{ paddingTop: 6, borderTop: '1px solid var(--bd-subtle)', color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)' }}>
              Approvals:{' '}
              <strong style={{ color: detail.approvals.approved ? 'var(--fg-success)' : 'var(--fg-primary)' }}>
                {detail.approvals.by.length} approved
              </strong>
              {detail.approvals.left ? ` (${detail.approvals.left} left)` : ''}
              {detail.approvals.by.length > 0 ? ` · ${detail.approvals.by.map((u) => `@${u}`).join(', ')}` : ''}
            </div>
          ) : null}
        </section>

        {/* Reviewers, Assignees, Labels */}
        <section className="card meta-strip">
          <div className="meta-cell">
            <span className="section-heading">Reviewers</span>
            <div className="row" style={{ gap: 5 }}>
              {detail.reviewers.length > 0 ? (
                detail.reviewers.map((u) => (
                  <span key={u} className="row-nowrap" style={{ gap: 5, fontSize: 'var(--text-sm)' }}>
                    <Avatar username={u} size={16} />
                    <span>{u}</span>
                    {detail.approvals?.by.includes(u) ? (
                      <span style={{ color: 'var(--fg-success)', display: 'inline-flex' }} title="Approved">
                        <CheckIcon size={12} />
                      </span>
                    ) : null}
                  </span>
                ))
              ) : (
                <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--text-sm)' }}>None</span>
              )}
            </div>
          </div>

          <div className="meta-cell">
            <span className="section-heading">Assignees</span>
            <div className="row" style={{ gap: 6 }}>
              {detail.assignees.length > 0 ? (
                detail.assignees.map((u) => (
                  <span key={u} className="row-nowrap" style={{ gap: 5, fontSize: 'var(--text-sm)' }}>
                    <Avatar username={u} size={16} />
                    <span>{u}</span>
                  </span>
                ))
              ) : (
                <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--text-sm)' }}>None</span>
              )}
            </div>
          </div>

          <div className="meta-cell">
            <span className="section-heading">Labels</span>
            <div className="row" style={{ gap: 4 }}>
              {detail.labels.length > 0 ? (
                detail.labels.map((l) => <LabelBadge key={l.name} name={l.name} color={l.color} />)
              ) : (
                <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--text-sm)' }}>None</span>
              )}
            </div>
          </div>
        </section>

        {/* Description */}
        <section className="card card-pad stack" style={{ gap: 8 }}>
          <h3 className="section-heading">Description</h3>
          <MarkdownView
            source={detail.description}
            onOpenLink={onOpenLink}
            onToggleCheckbox={(lineIndex, checked) => {
              const next = toggleMarkdownCheckbox(detail.description, lineIndex, checked)
              void onRunAction('update_description', { description: next })
            }}
          />
        </section>

        {/* Pipeline & Jobs + Inline Log Viewer */}
        <section id="summary-pipeline" className="card">
          <div className="card-header">
            <div className="row" style={{ gap: 8 }}>
              {detail.pipeline ? (
                <>
                  <PipelineGlyph status={detail.pipeline.status} />
                  <strong>Pipeline #{detail.pipeline.id}</strong>
                  <span style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)' }}>{detail.pipeline.status}</span>
                </>
              ) : (
                <strong>Pipeline</strong>
              )}
            </div>
            <div className="row" style={{ gap: 6 }}>
              {detail.pipeline ? (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void onRunAction('retry_pipeline', { pipelineId: detail.pipeline!.id })}
                  >
                    Retry failed
                  </button>
                  {detail.pipeline.status === 'running' || detail.pipeline.status === 'pending' ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => void onRunAction('cancel_pipeline', { pipelineId: detail.pipeline!.id })}
                    >
                      Cancel
                    </button>
                  ) : null}
                  {detail.pipeline.url ? (
                    <button type="button" className="btn btn-sm btn-icon" onClick={() => onOpenLink(detail.pipeline!.url!)} title="Open pipeline in GitLab">
                      <ExternalLinkIcon />
                    </button>
                  ) : null}
                </>
              ) : (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void onRunAction('run_pipeline')}>
                  Run pipeline
                </button>
              )}
            </div>
          </div>

          {!detail.pipeline ? (
            <div className="card-pad" style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)' }}>
              No pipeline recorded for this merge request yet.
            </div>
          ) : detail.pipeline.jobs.length === 0 ? (
            <div className="card-pad" style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)' }}>
              No jobs found for pipeline #{detail.pipeline.id}.
            </div>
          ) : (
            <div>
              {detail.pipeline.jobs.map((job) => {
                const isExpanded = expandedJobId === job.id
                const logKey = `${job.id}:${logMode}`
                const logText = logs[logKey]
                const isLoading = loadingLogKey === logKey
                return (
                  <div key={job.id}>
                    <div className="job-row">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ flex: 1, justifyContent: 'flex-start', padding: '2px 4px', minWidth: 0 }}
                        onClick={() => toggleJob(job)}
                      >
                        <PipelineGlyph status={job.status} />
                        <span className="job-stage">{job.stage}</span>
                        <span className="truncate" style={{ fontWeight: 500, color: 'var(--fg-primary)' }}>
                          {job.name}
                        </span>
                        {job.allowFailure ? (
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-tertiary)' }}>allow failure</span>
                        ) : null}
                        <span className="mono" style={{ marginLeft: 'auto', color: 'var(--fg-tertiary)', fontSize: 'var(--text-xs)' }}>
                          {job.seconds !== undefined ? `${job.seconds}s` : '—'}
                        </span>
                      </button>

                      <div className="row-nowrap" style={{ gap: 4, flexShrink: 0 }}>
                        <button type="button" className={`btn btn-xs ${isExpanded ? 'btn-active' : ''}`} onClick={() => toggleJob(job)}>
                          {isExpanded ? 'Hide log' : 'Log'}
                        </button>
                        {job.status === 'failed' || job.status === 'canceled' ? (
                          <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void onRunAction('retry_job', { jobId: job.id })}>
                            Retry
                          </button>
                        ) : null}
                        {job.status === 'manual' ? (
                          <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={() => void onRunAction('play_job', { jobId: job.id })}>
                            Play
                          </button>
                        ) : null}
                        {job.status === 'running' || job.status === 'pending' ? (
                          <button type="button" className="btn btn-xs btn-danger" disabled={busy} onClick={() => void onRunAction('cancel_job', { jobId: job.id })}>
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {isExpanded ? (
                      <div className="log-box">
                        <div className="row-between">
                          <span className="mono" style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-xs)' }}>
                            Job #{job.id} · {job.name}
                          </span>
                          <div className="row" style={{ gap: 6 }}>
                            {logText && onCopyText ? (
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={() => onCopyText(logText, 'Copied job log')}
                                title="Copy visible log excerpt"
                              >
                                <CopyIcon />
                                Copy log
                              </button>
                            ) : null}
                            <div className="seg-group">
                              {(['errors', 'tail', 'full'] as const).map((m) => (
                                <button
                                  type="button"
                                  key={m}
                                  className={`seg-btn ${logMode === m ? 'active' : ''}`}
                                  onClick={() => void fetchLog(job.id, m)}
                                >
                                  {m[0]!.toUpperCase() + m.slice(1)}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                        <pre className="log-pre scroller">{isLoading ? 'Loading job log…' : logText ?? 'Select a mode above to load the log.'}</pre>
                      </div>
                    ) : null}
                  </div>
                )
              })}

              {detail.pipeline.downstream.length > 0 ? (
                <div className="card-pad" style={{ borderTop: '1px solid var(--bd-primary)' }}>
                  <div className="section-heading" style={{ marginBottom: 6 }}>
                    Downstream pipelines
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {detail.pipeline.downstream.map((d) => (
                      <span key={`${d.stage}-${d.name}`} className="pill">
                        <PipelineGlyph status={d.pipelineStatus ?? d.status} />
                        <span>{d.name}</span>
                        {d.pipeline ? <span className="mono">#{d.pipeline}</span> : null}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
