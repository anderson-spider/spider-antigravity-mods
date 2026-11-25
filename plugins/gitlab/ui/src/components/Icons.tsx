// Inline SVG icons & deterministic monogram avatars (zero external font/image requests -> strict default CSP safe).
import type { CSSProperties } from 'react'

export function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

export function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg className={spinning ? 'spin' : undefined} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

export function CloseIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

export function ChevronIcon({ collapsed = false }: { collapsed?: boolean }) {
  const style: CSSProperties = { transform: collapsed ? 'rotate(-90deg)' : undefined, transition: 'transform 120ms ease' }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={style} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

export function ExternalLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

export function MaximizeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  )
}

export function BookmarkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </svg>
  )
}

export function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function PenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

export function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  )
}

export function MrStateGlyph({ state, draft, conflicts }: { state: string; draft?: boolean; conflicts?: boolean }) {
  let color = 'var(--fg-success)'
  let svg = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={draft ? '3 2' : undefined}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  )
  if (state === 'merged') {
    color = '#8b5cf6'
    svg = (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M6 21V9a9 9 0 0 0 9 9" />
      </svg>
    )
  } else if (state === 'closed') {
    color = 'var(--fg-danger)'
    svg = (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M18 9v6M6 9v12M15 6l6 6m0-6-6 6" />
      </svg>
    )
  } else if (draft) {
    color = 'var(--fg-tertiary)'
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', color, marginTop: 2, flexShrink: 0 }} title={draft ? 'Draft' : state}>
      {svg}
      {conflicts && state === 'opened' ? (
        <span
          title="Merge conflicts"
          style={{
            position: 'absolute',
            right: -3,
            bottom: -3,
            width: 10,
            height: 10,
            borderRadius: 999,
            background: 'var(--bg-primary)',
            color: 'var(--fg-warning)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            fontWeight: 700,
          }}
        >
          !
        </span>
      ) : null}
    </span>
  )
}

export function PipelineGlyph({ status, withLabel = false }: { status?: string; withLabel?: boolean }) {
  if (!status) return null
  const s = status.toLowerCase()
  let color = 'var(--fg-tertiary)'
  let label = status
  let icon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </svg>
  )
  if (s === 'success') {
    color = 'var(--fg-success)'
    label = 'Passed'
    icon = (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="12" cy="12" r="9" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    )
  } else if (s === 'failed') {
    color = 'var(--fg-danger)'
    label = 'Failed'
    icon = (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="12" cy="12" r="9" />
        <path d="m15 9-6 6M9 9l6 6" />
      </svg>
    )
  } else if (s === 'running' || s === 'pending' || s === 'created' || s === 'preparing') {
    color = 'var(--fg-info)'
    label = s === 'running' ? 'Running' : 'Pending'
    icon = (
      <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    )
  } else if (s === 'manual') {
    color = 'var(--fg-secondary)'
    label = 'Manual'
    icon = (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
      </svg>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color, flexShrink: 0 }} title={`Pipeline: ${label}`}>
      {icon}
      {withLabel ? <span>{label}</span> : null}
    </span>
  )
}

const PALETTE = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2']

export function Avatar({ username, size = 16 }: { username: string; size?: number }) {
  let hash = 0
  for (let i = 0; i < username.length; i++) hash = (hash * 31 + username.charCodeAt(i)) >>> 0
  const bg = PALETTE[hash % PALETTE.length]!
  const initials =
    username
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  return (
    <span
      className="avatar"
      title={`@${username}`}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.floor(size * 0.56)), background: bg }}
    >
      {initials}
    </span>
  )
}

export function LabelBadge({ name, color }: { name: string; color?: string }) {
  const safe = color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#6b7280'
  return (
    <span
      className="label-chip"
      style={{
        borderColor: `${safe}55`,
        background: `${safe}1a`,
        color: 'var(--fg-primary)',
      }}
      title={name}
    >
      <span className="label-dot" style={{ background: safe }} />
      <span className="truncate">{name}</span>
    </span>
  )
}
