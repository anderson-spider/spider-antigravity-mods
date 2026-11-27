import { useEffect, useRef } from 'react'
import type { DiagnosticsInfo } from '../types.ts'
import { CloseIcon, RefreshIcon, SettingsIcon } from './Icons.tsx'

type DiagnosticsPanelProps = {
  open: boolean
  diagnostics: DiagnosticsInfo
  busy: boolean
  onReconnect: () => void
  onAuthenticate: (methodId: string) => void
  onClose: () => void
}

export function DiagnosticsPanel({
  open,
  diagnostics,
  busy,
  onReconnect,
  onAuthenticate,
  onClose,
}: DiagnosticsPanelProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  // Fallback light-dismiss for browsers without <dialog closedby="any">
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) return

    let pressedOutside = false
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect()
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    }

    const onDown = (e: PointerEvent) => {
      pressedOutside = dialog.open && isOutside(e)
    }
    const onUp = (e: PointerEvent) => {
      if (pressedOutside && dialog.open && isOutside(e)) {
        dialog.close()
      }
      pressedOutside = false
    }

    dialog.addEventListener('pointerdown', onDown)
    dialog.addEventListener('pointerup', onUp)
    return () => {
      dialog.removeEventListener('pointerdown', onDown)
      dialog.removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="diag-dialog modal-card modal-wide"
      closedby="any"
      aria-labelledby="diag-dialog-title"
      onClose={onClose}
    >
      <div className="modal-header">
        <div className="modal-title-row">
          <SettingsIcon size={15} />
          <h1 id="diag-dialog-title">Claude Agent ACP Diagnostics</h1>
        </div>
        <button type="button" className="btn btn-icon btn-ghost" aria-label="Close diagnostics" onClick={onClose}>
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="modal-body diag-body">
        <div className="diag-grid">
          <div className="diag-row">
            <span className="diag-label">Status</span>
            <span className={`badge diag-badge-${diagnostics.status}`}>{diagnostics.status}</span>
          </div>
          <div className="diag-row">
            <span className="diag-label">Binary source</span>
            <span className="mono">{diagnostics.binarySource ?? 'not found'}</span>
          </div>
          <div className="diag-row">
            <span className="diag-label">Command</span>
            <span className="mono diag-value">{diagnostics.binaryDisplay ?? '—'}</span>
          </div>
          {diagnostics.agentInfo && (
            <div className="diag-row">
              <span className="diag-label">Agent</span>
              <span className="mono">
                {diagnostics.agentInfo.title || diagnostics.agentInfo.name}{' '}
                {diagnostics.agentInfo.version ? `v${diagnostics.agentInfo.version}` : ''}
              </span>
            </div>
          )}
        </div>

        {diagnostics.status === 'connecting' && diagnostics.binarySource === 'npx' && (
          <div className="notice-banner">
            Starting via <code>npx</code> — the first launch downloads <code>@agentclientprotocol/claude-agent-acp</code> and may take up to a minute.
          </div>
        )}

        {diagnostics.lastError && <div className="notice-banner notice-error">{diagnostics.lastError}</div>}

        {(diagnostics.authRequired || diagnostics.authMethods.length > 0) && (
          <div className="diag-auth-box">
            <div className="picker-section-title">Authentication</div>
            <p className="diag-hint">
              Claude Code uses your local Claude subscription login (<code>claude /login</code>) by default, or{' '}
              <code>ANTHROPIC_API_KEY</code> from the environment if set.
            </p>
            <div className="diag-auth-actions">
              {diagnostics.authMethods.map(m => (
                <button
                  key={m.id}
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => onAuthenticate(m.id)}
                  title={m.description ?? m.id}
                >
                  Authenticate: {m.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {diagnostics.stderrTail.length > 0 && (
          <div className="diag-logs">
            <div className="picker-section-title">Recent ACP stderr (secrets masked)</div>
            <pre className="tool-io-pre mono">{diagnostics.stderrTail.join('\n')}</pre>
          </div>
        )}

        <div className="modal-footer">
          <button type="button" className="btn" onClick={onReconnect} disabled={busy}>
            <RefreshIcon size={13} />
            <span>{busy ? 'Connecting…' : 'Reconnect ACP'}</span>
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
