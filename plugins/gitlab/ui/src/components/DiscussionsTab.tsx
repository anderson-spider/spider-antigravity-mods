import { useState } from 'react'
import { formatRelativeTime } from '../lib/query.ts'
import type { MrDetail } from '../types.ts'
import { Avatar } from './Icons.tsx'
import { MarkdownView } from './MarkdownView.tsx'

export function DiscussionsTab({
  detail,
  busy,
  onOpenLink,
  onJumpToFile,
  onRunAction,
}: {
  detail: MrDetail
  busy: boolean
  onOpenLink: (url: string) => void
  onJumpToFile: (path: string) => void
  onRunAction: (action: string, extra?: Record<string, unknown>) => Promise<void>
}) {
  const [filter, setFilter] = useState<'unresolved' | 'all'>('unresolved')
  const [replyingId, setReplyingId] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [newComment, setNewComment] = useState('')

  const unresolvedCount = detail.discussions.filter((d) => d.resolvable && !d.resolved).length
  const visible = detail.discussions.filter((d) => filter === 'all' || (d.resolvable && !d.resolved))

  const submitReply = async (discussionId: string, draft: boolean) => {
    const body = replyText.trim()
    if (!body) return
    await onRunAction('reply', { discussionId, body, draft })
    setReplyText('')
    setReplyingId(null)
  }

  const submitComment = async (draft: boolean) => {
    const body = newComment.trim()
    if (!body) return
    await onRunAction('comment', { body, draft })
    setNewComment('')
  }

  return (
    <div className="detail-scroll scroller">
      <div className="stack" style={{ maxWidth: 920 }}>
        {/* Pending private draft notes */}
        {detail.drafts.length > 0 ? (
          <section
            className="card"
            style={{
              borderColor: 'color-mix(in srgb, var(--fg-info) 45%, transparent)',
              background: 'color-mix(in srgb, var(--fg-info) 6%, var(--bg-secondary))',
            }}
          >
            <div className="card-header" style={{ background: 'color-mix(in srgb, var(--fg-info) 10%, var(--bg-secondary))' }}>
              <div className="row" style={{ gap: 7 }}>
                <span className="pill pill-info">Draft review</span>
                <strong>
                  {detail.drafts.length} private draft note{detail.drafts.length === 1 ? '' : 's'}
                </strong>
              </div>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void onRunAction('publish_all_drafts')}>
                Publish all drafts
              </button>
            </div>
            <div>
              {detail.drafts.map((dr, idx) => (
                <div
                  key={dr.id}
                  className="row-between card-pad"
                  style={{
                    background: 'var(--bg-primary)',
                    borderTop: idx > 0 ? '1px solid var(--bd-subtle)' : undefined,
                    alignItems: 'flex-start',
                  }}
                >
                  <div className="stack" style={{ gap: 4, minWidth: 0, flex: 1 }}>
                    {dr.at?.path ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs mono"
                        style={{ padding: 0, justifyContent: 'flex-start', color: 'var(--fg-info)' }}
                        onClick={() => onJumpToFile(dr.at!.path)}
                      >
                        {dr.at.path}
                        {dr.at.line ? `:${dr.at.line}` : dr.at.oldLine ? `:L${dr.at.oldLine}` : ''}
                      </button>
                    ) : null}
                    <MarkdownView source={dr.body} onOpenLink={onOpenLink} />
                  </div>
                  <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void onRunAction('publish_draft', { noteId: dr.id })}>
                    Publish
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Filter bar */}
        <div className="row-between">
          <div className="seg-group" role="group" aria-label="Filter discussions">
            <button type="button" className={`seg-btn ${filter === 'unresolved' ? 'active' : ''}`} onClick={() => setFilter('unresolved')}>
              Unresolved ({unresolvedCount})
            </button>
            <button type="button" className={`seg-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
              All ({detail.discussions.length})
            </button>
          </div>
        </div>

        {/* Threads */}
        {visible.length === 0 ? (
          <div className="card card-pad" style={{ textAlign: 'center', color: 'var(--fg-secondary)', padding: 28 }}>
            {filter === 'unresolved' ? 'No unresolved discussions.' : 'No discussions on this merge request yet.'}
          </div>
        ) : (
          visible.map((th) => (
            <article key={th.id} className="card">
              <div className="card-header">
                <div className="row" style={{ gap: 8, minWidth: 0 }}>
                  {th.at?.path ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs mono truncate"
                      style={{ padding: 0, color: 'var(--fg-info)', maxWidth: 460 }}
                      onClick={() => onJumpToFile(th.at!.path)}
                      title={`Jump to ${th.at.path} in Code tab`}
                    >
                      {th.at.path}
                      {th.at.line ? `:${th.at.line}` : th.at.oldLine ? `:L${th.at.oldLine}` : ''}
                    </button>
                  ) : (
                    <span style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>General discussion</span>
                  )}
                  {th.resolvable ? (
                    <span className={`pill ${th.resolved ? 'pill-success' : 'pill-warning'}`}>
                      {th.resolved ? 'Resolved' : 'Unresolved'}
                    </span>
                  ) : null}
                </div>
                {th.resolvable ? (
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={busy}
                    onClick={() => void onRunAction(th.resolved ? 'unresolve' : 'resolve', { discussionId: th.id })}
                  >
                    {th.resolved ? 'Unresolve' : 'Resolve thread'}
                  </button>
                ) : null}
              </div>

              <div>
                {th.notes.map((n, idx) => (
                  <div
                    key={n.id}
                    className="card-pad stack"
                    style={{
                      gap: 5,
                      borderTop: idx > 0 ? '1px solid var(--bd-subtle)' : undefined,
                      background: 'var(--bg-primary)',
                    }}
                  >
                    <div className="row" style={{ gap: 6 }}>
                      <Avatar username={n.author} size={18} />
                      <strong>{n.author}</strong>
                      <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--text-xs)' }}>{formatRelativeTime(n.createdAt)}</span>
                    </div>
                    <div style={{ paddingLeft: 24 }}>
                      <MarkdownView source={n.body} onOpenLink={onOpenLink} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="card-pad" style={{ borderTop: '1px solid var(--bd-subtle)' }}>
                {replyingId === th.id ? (
                  <div className="stack" style={{ gap: 8 }}>
                    <textarea
                      className="textarea"
                      rows={2}
                      autoFocus
                      placeholder="Write a reply… (Cmd/Ctrl+Enter to post)"
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && replyText.trim() && !busy) {
                          e.preventDefault()
                          void submitReply(th.id, false)
                        } else if (e.key === 'Escape') {
                          setReplyingId(null)
                          setReplyText('')
                        }
                      }}
                    />
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setReplyingId(null)
                          setReplyText('')
                        }}
                      >
                        Cancel
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy || !replyText.trim()} onClick={() => void submitReply(th.id, true)}>
                        Save draft
                      </button>
                      <button type="button" className="btn btn-sm btn-primary" disabled={busy || !replyText.trim()} onClick={() => void submitReply(th.id, false)}>
                        Reply
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '2px 4px' }}
                    onClick={() => {
                      setReplyingId(th.id)
                      setReplyText('')
                    }}
                  >
                    Reply to thread…
                  </button>
                )}
              </div>
            </article>
          ))
        )}

        {/* New general comment */}
        <section className="card card-pad stack" style={{ gap: 8 }}>
          <h3 className="section-heading">New comment</h3>
          <textarea
            className="textarea"
            rows={3}
            placeholder="Leave a general review comment (Markdown supported · Cmd/Ctrl+Enter to post)…"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && newComment.trim() && !busy) {
                e.preventDefault()
                void submitComment(false)
              }
            }}
          />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <button type="button" className="btn btn-sm" disabled={busy || !newComment.trim()} onClick={() => void submitComment(true)}>
              Save as draft
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !newComment.trim()} onClick={() => void submitComment(false)}>
              Post comment
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
