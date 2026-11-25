import { useState } from 'react'
import type { MrDetail } from '../types.ts'
import { CloseIcon } from './Icons.tsx'

export function MergeModal({
  detail,
  busy,
  onClose,
  onConfirm,
}: {
  detail: MrDetail
  busy: boolean
  onClose: () => void
  onConfirm: (opts: {
    squash: boolean
    removeSourceBranch: boolean
    whenPipelineSucceeds: boolean
    confirmProtectedTarget: boolean
    confirmOthers: boolean
  }) => void
}) {
  const isRunning = detail.pipeline?.status === 'running' || detail.pipeline?.status === 'pending'
  const [squash, setSquash] = useState(true)
  const [removeSourceBranch, setRemoveSourceBranch] = useState(true)
  const [whenPipelineSucceeds, setWhenPipelineSucceeds] = useState(isRunning)
  const [extraAck, setExtraAck] = useState(false)

  const isColleague = Boolean(detail.currentUser && detail.author && detail.currentUser.toLowerCase() !== detail.author.toLowerCase())
  const isProtected = Boolean(detail.isProtectedTarget)
  const needsExtraAck = isColleague || isProtected
  const hardBlockers = detail.blockers.filter((b) => !b.includes('ci_still_running'))
  const missingSha = !detail.sha
  const disabled = busy || hardBlockers.length > 0 || missingSha || (needsExtraAck && !extraAck)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <strong style={{ fontSize: 13 }}>Confirm Merge</strong>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="card-pad stack">
          <div className="banner">
            <div style={{ fontWeight: 600 }}>
              !{detail.iid} · {detail.title}
            </div>
            <div className="mono" style={{ color: 'var(--fg-secondary)', marginTop: 4 }}>
              {detail.source} → <strong style={{ color: 'var(--fg-primary)' }}>{detail.target}</strong>
            </div>
            <div className="mono" style={{ color: 'var(--fg-secondary)', marginTop: 2 }}>
              Pinned head SHA: <span style={{ color: 'var(--fg-primary)' }}>{detail.sha ? detail.sha.slice(0, 12) : 'unavailable'}</span>
            </div>
          </div>

          {hardBlockers.length > 0 ? (
            <div className="banner banner-danger">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Merge refused by guards:</div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {hardBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {needsExtraAck ? (
            <div className="banner banner-warning stack" style={{ gap: 6 }}>
              <div style={{ fontWeight: 600, color: 'var(--fg-warning)' }}>Extra confirmation required</div>
              <div>
                {isProtected ? (
                  <>
                    Target <code className="mono">{detail.target}</code> is a protected or release branch.{' '}
                  </>
                ) : null}
                {isColleague ? (
                  <>
                    This MR was authored by <code className="mono">@{detail.author}</code>.
                  </>
                ) : null}
              </div>
              <label className="row" style={{ gap: 6, cursor: 'pointer', fontWeight: 500 }}>
                <input type="checkbox" checked={extraAck} onChange={(e) => setExtraAck(e.target.checked)} />
                <span>I explicitly confirm merging this MR</span>
              </label>
            </div>
          ) : null}

          <div className="stack" style={{ gap: 6 }}>
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} />
              <span>Squash commits when merging</span>
            </label>
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={removeSourceBranch} onChange={(e) => setRemoveSourceBranch(e.target.checked)} />
              <span>
                Delete source branch (<code className="mono">{detail.source}</code>)
              </span>
            </label>
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={whenPipelineSucceeds} onChange={(e) => setWhenPipelineSucceeds(e.target.checked)} />
              <span>Auto-merge when pipeline succeeds</span>
            </label>
          </div>
        </div>

        <div className="card-header" style={{ borderTop: '1px solid var(--bd-primary)', borderBottom: 'none', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={disabled}
            onClick={() =>
              onConfirm({
                squash,
                removeSourceBranch,
                whenPipelineSucceeds,
                confirmProtectedTarget: isProtected && extraAck,
                confirmOthers: isColleague && extraAck,
              })
            }
          >
            {busy ? 'Merging…' : whenPipelineSucceeds && isRunning ? 'Set Auto-Merge' : 'Confirm Merge'}
          </button>
        </div>
      </div>
    </div>
  )
}
