// Pure query parsing, filtering, Merge readiness sorting, and Reviewing/Authored grouping for the MR list.
import type { InvolvementFilter, MrListItem, MrStateFilter, SortOrder } from '../types.ts'

export type ParsedQuery = {
  labels: string[]
  author?: string
  draft?: boolean
  checks?: string
  free: string
  chips: string[]
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const labels: string[] = []
  let author: string | undefined
  let draft: boolean | undefined
  let checks: string | undefined
  const free: string[] = []
  const chips: string[] = []

  for (const token of tokens) {
    const colon = token.indexOf(':')
    if (colon > 0) {
      const key = token.slice(0, colon).toLowerCase()
      const val = token.slice(colon + 1).toLowerCase()
      if (key === 'label' && val) {
        labels.push(val)
        chips.push(`label:${val}`)
        continue
      }
      if (key === 'author' && val) {
        author = val.replace(/^@/, '')
        chips.push(`author:${author}`)
        continue
      }
      if (key === 'draft' && (val === 'yes' || val === 'true' || val === 'no' || val === 'false')) {
        draft = val === 'yes' || val === 'true'
        chips.push(`draft:${draft ? 'yes' : 'no'}`)
        continue
      }
      if (key === 'checks' && val) {
        checks = val
        chips.push(`checks:${val}`)
        continue
      }
    }
    free.push(token.toLowerCase())
  }

  return { labels, author, draft, checks, free: free.join(' '), chips }
}

/** Lower score sorts higher in "Merge readiness" order (mergeable, green CI, approved first; drafts/conflicts last). */
export function readinessScore(mr: MrListItem): number {
  if (mr.state !== 'opened') return 200
  let score = 0
  if (mr.draft) score += 60
  if (mr.conflicts) score += 50
  const ci = mr.pipeline?.status
  if (ci === 'failed' || ci === 'canceled') score += 35
  else if (ci === 'running' || ci === 'pending' || ci === 'created') score += 15
  if (mr.approvals) {
    if (mr.approvals.approved === false || (mr.approvals.left ?? 0) > 0) score += 20
  }
  if (mr.mergeStatus && mr.mergeStatus !== 'mergeable' && mr.mergeStatus !== 'can_be_merged') {
    score += 10
  }
  return score
}

function toEpoch(iso: string | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

export type FilterOptions = {
  q: string
  state: MrStateFilter
  involvement: InvolvementFilter
  sort: SortOrder
  hostOrProject: string
}

export function filterAndSortMrs(mrs: readonly MrListItem[], opts: FilterOptions): MrListItem[] {
  const parsed = parseSearchQuery(opts.q)
  const filtered = mrs.filter((mr) => {
    if (opts.state !== 'all' && mr.state !== opts.state) return false
    if (opts.involvement === 'waiting' && !mr.isWaitingOnMe) return false
    if (opts.involvement === 'authored' && !mr.isAuthored) return false
    if (opts.involvement === 'reviewing' && !mr.isReviewing) return false
    if (opts.involvement === 'others' && (mr.isAuthored || mr.isReviewing)) return false

    if (opts.hostOrProject && opts.hostOrProject !== 'all' && opts.hostOrProject !== 'mine') {
      if (opts.hostOrProject.startsWith('host:')) {
        if (mr.host !== opts.hostOrProject.slice(5)) return false
      } else if (opts.hostOrProject.startsWith('proj:')) {
        const spec = opts.hostOrProject.slice(5)
        const slashHost = spec.indexOf('|')
        if (slashHost > 0) {
          const h = spec.slice(0, slashHost)
          const p = spec.slice(slashHost + 1)
          if (mr.host !== h || mr.project !== p) return false
        } else if (mr.project !== spec) {
          return false
        }
      }
    }

    if (parsed.labels.length > 0) {
      const names = mr.labels.map((l) => l.name.toLowerCase())
      if (!parsed.labels.every((want) => names.some((n) => n.includes(want)))) return false
    }
    if (parsed.author && !mr.author.username.toLowerCase().includes(parsed.author)) return false
    if (parsed.draft !== undefined && mr.draft !== parsed.draft) return false
    if (parsed.checks) {
      const st = mr.pipeline?.status ?? 'none'
      if (parsed.checks === 'passing' && st !== 'success') return false
      if (parsed.checks === 'failing' && st !== 'failed') return false
      if (parsed.checks === 'running' && st !== 'running' && st !== 'pending') return false
    }
    if (parsed.free) {
      const hay = `!${mr.iid} ${mr.title} ${mr.project} ${mr.host} ${mr.sourceBranch} ${mr.targetBranch} ${mr.author.username} ${mr.labels.map((l) => l.name).join(' ')}`.toLowerCase()
      if (!hay.includes(parsed.free)) return false
    }
    return true
  })

  return filtered.sort((a, b) => {
    switch (opts.sort) {
      case 'ready':
        return readinessScore(a) - readinessScore(b) || toEpoch(b.updatedAt) - toEpoch(a.updatedAt)
      case 'updated':
        return toEpoch(b.updatedAt) - toEpoch(a.updatedAt)
      case 'newest':
        return toEpoch(b.createdAt ?? b.updatedAt) - toEpoch(a.createdAt ?? a.updatedAt)
      case 'oldest':
        return toEpoch(a.createdAt ?? a.updatedAt) - toEpoch(b.createdAt ?? b.updatedAt)
      case 'largest':
        return ((b.additions ?? 0) + (b.deletions ?? 0)) - ((a.additions ?? 0) + (a.deletions ?? 0))
      default:
        return 0
    }
  })
}

export type MrGroup = {
  key: 'reviewing' | 'authored' | 'others' | 'flat'
  label: string | null
  entries: MrListItem[]
}

export function groupMrs(mrs: readonly MrListItem[], involvement: InvolvementFilter): MrGroup[] {
  if (involvement !== 'all') {
    return mrs.length > 0 ? [{ key: 'flat', label: null, entries: [...mrs] }] : []
  }
  const reviewing = mrs.filter((m) => m.isReviewing)
  const authored = mrs.filter((m) => m.isAuthored)
  const others = mrs.filter((m) => !m.isReviewing && !m.isAuthored)
  const groups: MrGroup[] = []
  if (reviewing.length > 0) groups.push({ key: 'reviewing', label: 'Reviewing', entries: reviewing })
  if (authored.length > 0) groups.push({ key: 'authored', label: 'Authored', entries: authored })
  if (others.length > 0) groups.push({ key: 'others', label: 'Other MRs', entries: others })
  return groups
}

export function formatRelativeTime(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso
  const diffSec = Math.max(0, Math.floor((nowMs - then) / 1000))
  if (diffSec < 60) return 'just now'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  return `${months}mo`
}
