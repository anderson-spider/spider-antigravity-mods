import { useState } from 'react'
import { toggleMarkdownCheckbox } from '../lib/markdown.ts'
import type { MrDetail, PipelineJob } from '../types.ts'
import { Avatar, ExternalLinkIcon, LabelBadge, PipelineGlyph } from './Icons.tsx'
import { MarkdownView } from './MarkdownView.tsx'

export function SummaryTab({
  detail,
  busy,
  onOpenLink,
  onRunAction,
  onLoadJobLog,
}: {
  detail: MrDetail
  busy: boolean
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

  const toggleJob = (job: PipelineJob) => {
    if (expandedJobId === job.id) {
      setExpandedJobId(null)
      return
    }
    void fetchLog(job.id, logMode)
  }

  return (
    <div className="detail-scroll">
      <div className="stack" style={{ maxWidth: 880 }}>
        {/* Merge Readiness & Blockers */}
        <div
          className="card card-pad stack"
          style={{
            gap: 10,
            borderColor: ready ? 'color-mix(in srgb, var(--fg-success) 45%, transparent)' : undefined,
          }}
        >
          <div className="row-between">
            <div className="row" style={{ gap: 7 }}>
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
              <span className="mono" style={{ color: 'var(--fg-secondary)' }} title={detail.sha}>
                SHA {detail.sha.slice(0, 8)}
              </span>
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
            <div className="rules-grid" style={{ paddingTop: 8, borderTop: '1px solid var(--bd-primary)' }}>
              {detail.rules.map((r) => (
                <div
                  key={r.name}
                  className="row-between"
                  style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--bd-primary)',
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{r.name}</span>
                  <span className="mono" style={{ color: r.approved ? 'var(--fg-success)' : 'var(--fg-secondary)' }}>
                    {r.by.length}/{r.required ?? 0} {r.approved ? '✓' : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : detail.approvals ? (
            <div style={{ paddingTop: 6, borderTop: '1px solid var(--bd-primary)', color: 'var(--fg-secondary)' }}>
              Approvals:{' '}
              <strong style={{ color: detail.approvals.approved ? 'var(--fg-success)' : 'var(--fg-primary)' }}>
                {detail.approvals.by.length} approved
              </strong>
              {detail.approvals.left ? ` (${detail.approvals.left} left)` : ''}
              {detail.approvals.by.length > 0 ? ` — ${detail.approvals.by.map((u) => `@${u}`).join(', ')}` : ''}
            </div>
          ) : null}
        </div>

        {/* Reviewers, Assignees, Labels */}
        <div className="card card-pad meta-grid">
          <div className="stack" style={{ gap: 4 }}>
            <span style={{ color: 'var(--fg-secondary)' }}>Reviewers</span>
            <div className="row" style={{ gap: 5 }}>
              {detail.reviewers.length > 0 ? (
                detail.reviewers.map((u) => (
                  <span key={u} className="pill">
                    <Avatar username={u} size={14} />
                    <span>{u}</span>
                    {detail.approvals?.by.includes(u) ? <span style={{ color: 'var(--fg-success)' }}>✓</span> : null}
                  </span>
                ))
              ) : (
                <span style={{ color: 'var(--fg-tertiary)' }}>None</span>
              )}
            </div>
          </div>

          <div className="stack" style={{ gap: 4 }}>
            <span style={{ color: 'var(--fg-secondary)' }}>Assignees</span>
            <div className="row" style={{ gap: 5 }}>
              {detail.assignees.length > 0 ? (
                detail.assignees.map((u) => (
                  <span key={u} className="pill">
                    <Avatar username={u} size={14} />
                    <span>{u}</span>
                  </span>
                ))
              ) : (
                <span style={{ color: 'var(--fg-tertiary)' }}>None</span>
              )}
            </div>
          </div>

          <div className="stack" style={{ gap: 4 }}>
            <span style={{ color: 'var(--fg-secondary)' }}>Labels</span>
            <div className="row" style={{ gap: 4 }}>
              {detail.labels.length > 0 ? (
                detail.labels.map((l) => <LabelBadge key={l.name} name={l.name} color={l.color} />)
              ) : (
                <span style={{ color: 'var(--fg-tertiary)' }}>None</span>
              )}
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <div style={{ color: 'var(--fg-secondary)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Description
          </div>
          <MarkdownView
            source={detail.description}
            onOpenLink={onOpenLink}
            onToggleCheckbox={(lineIndex, checked) => {
              const next = toggleMarkdownCheckbox(detail.description, lineIndex, checked)
              void onRunAction('update_description', { description: next })
            }}
          />
        </div>

        {/* Pipeline & Jobs + Inline Log Viewer */}
        <div className="card">
          <div className="card-header">
            <div className="row" style={{ gap: 8 }}>
              {detail.pipeline ? (
                <>
                  <PipelineGlyph status={detail.pipeline.status} />
                  <strong>Pipeline #{detail.pipeline.id}</strong>
                  <span className="pill">{detail.pipeline.status}</span>
                </>
              ) : (
                <strong>Pipeline</strong>
              )}
            </div>
            <div className="row" style={{ gap: 6 }}>
              {detail.pipeline ? (
                <>
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void onRunAction('retry_pipeline', { pipelineId: detail.pipeline!.id })}
                  >
                    Retry failed
                  </button>
                  {detail.pipeline.status === 'running' || detail.pipeline.status === 'pending' ? (
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => void onRunAction('cancel_pipeline', { pipelineId: detail.pipeline!.id })}
                    >
                      Cancel
                    </button>
                  ) : null}
                  {detail.pipeline.url ? (
                    <button className="btn btn-sm btn-icon" onClick={() => onOpenLink(detail.pipeline!.url!)} title="Open pipeline in GitLab">
                      <ExternalLinkIcon />
                    </button>
                  ) : null}
                </>
              ) : (
                <button className="btn btn-sm" disabled={busy} onClick={() => void onRunAction('run_pipeline')}>
                  Run pipeline
                </button>
              )}
            </div>
          </div>

          {!detail.pipeline ? (
            <div className="card-pad" style={{ color: 'var(--fg-secondary)' }}>
              No pipeline recorded for this merge request yet.
            </div>
          ) : detail.pipeline.jobs.length === 0 ? (
            <div className="card-pad" style={{ color: 'var(--fg-secondary)' }}>
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
                        className="btn btn-ghost"
                        style={{ flex: 1, justifyContent: 'flex-start', padding: '2px 4px', minWidth: 0 }}
                        onClick={() => toggleJob(job)}
                      >
                        <PipelineGlyph status={job.status} />
                        <span className="pill mono">{job.stage}</span>
                        <span className="truncate" style={{ fontWeight: 500, color: 'var(--fg-primary)' }}>
                          {job.name}
                        </span>
                        {job.allowFailure ? <span className="pill">allow failure</span> : null}
                        <span className="mono" style={{ marginLeft: 'auto', color: 'var(--fg-tertiary)' }}>
                          {job.seconds !== undefined ? `${job.seconds}s` : '—'}
                        </span>
                      </button>

                      <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                        <button className="btn btn-sm" onClick={() => toggleJob(job)}>
                          {isExpanded ? 'Hide log' : 'Log'}
                        </button>
                        {job.status === 'failed' || job.status === 'canceled' ? (
                          <button className="btn btn-sm" disabled={busy} onClick={() => void onRunAction('retry_job', { jobId: job.id })}>
                            Retry
                          </button>
                        ) : null}
                        {job.status === 'manual' ? (
                          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void onRunAction('play_job', { jobId: job.id })}>
                            Play
                          </button>
                        ) : null}
                        {job.status === 'running' || job.status === 'pending' ? (
                          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void onRunAction('cancel_job', { jobId: job.id })}>
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {isExpanded ? (
                      <div className="log-box">
                        <div className="row-between">
                          <span className="mono" style={{ color: 'var(--fg-secondary)' }}>
                            Job #{job.id} · {job.name}
                          </span>
                          <div className="seg-group">
                            {(['errors', 'tail', 'full'] as const).map((m) => (
                              <button
                                key={m}
                                className={`seg-btn ${logMode === m ? 'active' : ''}`}
                                onClick={() => void fetchLog(job.id, m)}
                              >
                                {m[0]!.toUpperCase() + m.slice(1)}
                              </button>
                            ))}
                          </div>
                        </div>
                        <pre className="log-pre">{isLoading ? 'Loading job log…' : logText ?? 'Click a mode above to load the log.'}</pre>
                      </div>
                    ) : null}
                  </div>
                )
              })}

              {detail.pipeline.downstream.length > 0 ? (
                <div className="card-pad" style={{ borderTop: '1px solid var(--bd-primary)' }}>
                  <div style={{ color: 'var(--fg-secondary)', marginBottom: 6, fontWeight: 500 }}>Downstream pipelines</div>
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
        </div>
      </div>
    </div>
  )
}
