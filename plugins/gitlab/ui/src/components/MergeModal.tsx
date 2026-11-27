import { useState } from 'react'
import type { MrDetail } from '../types.ts'
import { ModalDialog } from './ModalDialog.tsx'

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
    <ModalDialog
      open
      title="Confirm merge"
      maxWidth={450}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </button>
          <button
            type="button"
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
            {busy ? 'Merging…' : whenPipelineSucceeds && isRunning ? 'Set auto-merge' : 'Confirm merge'}
          </button>
        </>
      }
    >
      <div className="banner">
        <div style={{ fontWeight: 600 }}>
          !{detail.iid} · {detail.title}
        </div>
        <div className="mono" style={{ color: 'var(--fg-secondary)', marginTop: 5, fontSize: 'var(--text-xs)' }}>
          {detail.source} → <strong style={{ color: 'var(--fg-primary)' }}>{detail.target}</strong>
        </div>
        <div className="mono" style={{ color: 'var(--fg-secondary)', marginTop: 2, fontSize: 'var(--text-xs)' }}>
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

      <div className="stack" style={{ gap: 7, fontSize: 'var(--text-sm)' }}>
        <label className="row" style={{ gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} />
          <span>Squash commits when merging</span>
        </label>
        <label className="row" style={{ gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={removeSourceBranch} onChange={(e) => setRemoveSourceBranch(e.target.checked)} />
          <span>
            Delete source branch (<code className="mono">{detail.source}</code>)
          </span>
        </label>
        <label className="row" style={{ gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={whenPipelineSucceeds} onChange={(e) => setWhenPipelineSucceeds(e.target.checked)} />
          <span>Auto-merge when pipeline succeeds</span>
        </label>
      </div>
    </ModalDialog>
  )
}
