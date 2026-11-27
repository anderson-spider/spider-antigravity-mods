import { formatUsage } from '../lib/triggers.ts'
import type { SessionSnapshot, UiPreferences } from '../types.ts'
import { ArrowUpRightIcon, ChevronDownIcon, SlidersIcon, StopIcon } from './Icons.tsx'

type SessionControlBarProps = {
  session: SessionSnapshot
  preferences?: UiPreferences
  busy: boolean
  canMessage: boolean
  canUpdateContext: boolean
  onCancel: () => void
  onSetMode: (modeId: string) => void
  onSetModel: (modelId: string) => void
  onSetConfig: (configId: string, value: string) => void
  onSaveDefaults: (modeId: string, modelId?: string) => void
  onAttachContext: () => void
  onSendToHostChat: () => void
}

const POPOVER_ID = 'session-options-popover'

export function SessionControlBar({
  session,
  preferences,
  busy,
  canMessage,
  canUpdateContext,
  onCancel,
  onSetMode,
  onSetModel,
  onSetConfig,
  onSaveDefaults,
  onAttachContext,
  onSendToHostChat,
}: SessionControlBarProps) {
  const modes =
    session.availableModes.length > 0
      ? session.availableModes
      : [
          { id: 'auto', name: 'Auto' },
          { id: 'default', name: 'Default' },
          { id: 'acceptEdits', name: 'Accept Edits' },
          { id: 'plan', name: 'Plan (Read-Only)' },
        ]

  const currentModeId = session.modeId ?? modes.find(m => m.id === 'auto')?.id ?? modes[0]?.id ?? 'auto'
  const currentModeLabel = modes.find(m => m.id === currentModeId)?.name ?? currentModeId
  const modelConfigOpt = session.configOptions.find(c => c.category === 'model')
  const models =
    session.availableModels.length > 0
      ? session.availableModels
      : modelConfigOpt
        ? modelConfigOpt.options
            .flatMap(opt => ('group' in opt ? opt.options : [opt]))
            .map(opt => ({ modelId: opt.value, name: opt.name }))
        : []
  const currentModelId = session.modelId ?? models[0]?.modelId ?? ''
  const currentModelLabel = models.find(m => m.modelId === currentModelId)?.name ?? (currentModelId || undefined)
  const extraConfigs = session.configOptions.filter(c => c.category !== 'mode' && c.category !== 'model')

  const isRunning = session.status === 'running'
  const isError = session.status === 'error'
  const hasPermissions = session.pendingPermissions.length > 0
  const isBypass = currentModeId === 'bypassPermissions'
  const isCurrentDefault =
    preferences?.defaultModeId === currentModeId &&
    (!currentModelId || preferences?.defaultModelId === currentModelId)

  const statusTone = hasPermissions ? 'warn' : isError ? 'error' : isRunning ? 'running' : 'idle'
  const statusLabel = hasPermissions ? 'Approval needed' : isError ? 'Error' : isRunning ? 'Working' : 'Idle'

  const usageLabel = formatUsage(session.usage)
  const usagePct =
    session.usage && session.usage.size > 0
      ? Math.min(100, Math.round((session.usage.used / session.usage.size) * 100))
      : null

  return (
    <footer className="control-bar" aria-label="Session controls">
      <div className="control-bar-left">
        <div className={`session-status-chip status-chip-${statusTone}`}>
          <span className={`session-state-dot state-${isRunning ? 'running' : isError ? 'error' : hasPermissions ? 'warn' : 'idle'}`} />
          <span>{statusLabel}</span>
        </div>

        {isRunning && session.replyToChat && canMessage && (
          <span
            className="auto-reply-chip"
            title="Claude's final response will be posted back to Antigravity chat automatically when this turn finishes"
          >
            Auto-reply
          </span>
        )}

        <button
          type="button"
          className={`btn btn-sm btn-ghost control-options-btn ${isBypass ? 'control-options-warn' : ''}`}
          popoverTarget={POPOVER_ID}
          title={isBypass ? 'Warning: bypassPermissions active' : 'Session mode, model, and options'}
        >
          <SlidersIcon size={12} />
          <span className="truncate">{currentModeLabel}</span>
          {currentModelLabel && <span className="control-model-hint truncate">· {currentModelLabel}</span>}
          <ChevronDownIcon size={11} />
        </button>

        <div id={POPOVER_ID} popover="auto" className="anchored-popover options-popover" aria-label="Session options">
          <div className="popover-header">
            <span className="popover-title">Session Options</span>
            {isRunning && <span className="popover-note">Turn running</span>}
          </div>

          <div className="options-grid">
            <div className="option-field">
              <label className="option-label" htmlFor="opt-mode">Permission mode</label>
              <select
                id="opt-mode"
                className={`select ${isBypass ? 'select-warn' : ''}`}
                value={currentModeId}
                disabled={isRunning || busy}
                onChange={e => onSetMode(e.target.value)}
              >
                {modes.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.id === 'bypassPermissions' ? `⚠ ${m.name}` : m.name}
                  </option>
                ))}
              </select>
            </div>

            {models.length > 0 && (
              <div className="option-field">
                <label className="option-label" htmlFor="opt-model">Model</label>
                <select
                  id="opt-model"
                  className="select"
                  value={currentModelId}
                  disabled={busy}
                  onChange={e => onSetModel(e.target.value)}
                >
                  {models.map(m => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {extraConfigs.map(cfg => {
              const flat = cfg.options.flatMap(opt => ('group' in opt ? opt.options : [opt]))
              const inputId = `opt-cfg-${cfg.id}`
              return (
                <div key={cfg.id} className="option-field">
                  <label className="option-label" htmlFor={inputId}>{cfg.name}</label>
                  <select
                    id={inputId}
                    className="select"
                    value={cfg.currentValue}
                    disabled={busy}
                    onChange={e => onSetConfig(cfg.id, e.target.value)}
                  >
                    {flat.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>

          <div className="options-popover-footer">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy || isBypass || isCurrentDefault}
              title={
                isBypass
                  ? 'bypassPermissions cannot be saved as the global default'
                  : isCurrentDefault
                    ? 'Current mode and model are already saved as default'
                    : 'Save current mode and model as default for new sessions'
              }
              onClick={() => onSaveDefaults(currentModeId, currentModelId || undefined)}
            >
              {isCurrentDefault ? 'Saved as default' : 'Save as default'}
            </button>
          </div>
        </div>

        {usageLabel && (
          <div className="usage-meter" title={usageLabel}>
            {usagePct !== null && (
              <progress className="usage-progress" max={100} value={usagePct} aria-label="Context window usage" />
            )}
            <span className="usage-text mono">{usageLabel}</span>
          </div>
        )}
      </div>

      <div className="control-bar-right">
        {canUpdateContext && session.items.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onAttachContext}
            title="Attach Claude session summary to your next Antigravity message"
          >
            Attach
          </button>
        )}
        {canMessage && session.items.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onSendToHostChat}
            title="Send Claude response summary to Antigravity chat"
          >
            <span>To Chat</span>
            <ArrowUpRightIcon size={12} />
          </button>
        )}
        {isRunning && (
          <button type="button" className="btn btn-sm btn-danger" onClick={onCancel}>
            <StopIcon size={12} />
            <span>Stop</span>
          </button>
        )}
      </div>
    </footer>
  )
}
