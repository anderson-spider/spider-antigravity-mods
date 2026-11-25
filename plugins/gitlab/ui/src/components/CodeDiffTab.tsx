import { Fragment, useState } from 'react'
import { buildSplitPairs, parseUnifiedDiff, tokenizeCode, type DiffLine } from '../lib/diff.ts'
import type { DiffFile, DiffMode, MrDetail } from '../types.ts'
import { Avatar, ChevronIcon } from './Icons.tsx'
import { MarkdownView } from './MarkdownView.tsx'

function HighlightedCode({ text }: { text: string }) {
  const tokens = tokenizeCode(text)
  return (
    <>
      {tokens.map((t, idx) =>
        t.kind === 'plain' ? (
          <Fragment key={idx}>{t.text}</Fragment>
        ) : (
          <span key={idx} className={`tok-${t.kind}`}>
            {t.text}
          </span>
        ),
      )}
    </>
  )
}

type LineTarget = { path: string; line?: number; oldLine?: number }

export function CodeDiffTab({
  detail,
  files,
  loading,
  narrow,
  diffMode,
  showFileIndex,
  viewedPaths,
  busy,
  onChangeDiffMode,
  onToggleFileIndex,
  onSetFileViewed,
  onOpenLink,
  onRunAction,
}: {
  detail: MrDetail
  files: DiffFile[] | null
  loading: boolean
  narrow: boolean
  diffMode: DiffMode
  showFileIndex: boolean
  viewedPaths: ReadonlySet<string>
  busy: boolean
  onChangeDiffMode: (mode: DiffMode) => void
  onToggleFileIndex: () => void
  onSetFileViewed: (path: string, viewed: boolean) => void
  onOpenLink: (url: string) => void
  onRunAction: (action: string, extra?: Record<string, unknown>) => Promise<void>
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [composer, setComposer] = useState<LineTarget | null>(null)
  const [commentText, setCommentText] = useState('')

  if (loading && !files) {
    return <div className="empty-state">Loading merge request diff…</div>
  }
  if (!files || files.length === 0) {
    return <div className="empty-state">No changed files found for this merge request.</div>
  }

  const viewedCount = files.filter((f) => viewedPaths.has(f.newPath)).length
  const pct = Math.round((viewedCount / files.length) * 100)
  const showSidebar = showFileIndex && !narrow

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const submitLineComment = async (draft: boolean) => {
    const body = commentText.trim()
    if (!body || !composer) return
    await onRunAction('line_comment', {
      path: composer.path,
      ...(composer.line !== undefined ? { line: composer.line } : {}),
      ...(composer.oldLine !== undefined ? { oldLine: composer.oldLine } : {}),
      body,
      draft,
    })
    setCommentText('')
    setComposer(null)
  }

  const renderInlineRows = (filePath: string, lineNum: number | null, oldNum: number | null, colSpan: number) => {
    const matchesPos = (at?: { path: string; line?: number; oldLine?: number }) => {
      if (!at || at.path !== filePath) return false
      if (lineNum !== null && at.line === lineNum) return true
      if (lineNum === null && oldNum !== null && at.oldLine === oldNum) return true
      return false
    }
    const threads = detail.discussions.filter((d) => matchesPos(d.at))
    const drafts = detail.drafts.filter((d) => matchesPos(d.at))
    const isComposing =
      composer !== null &&
      composer.path === filePath &&
      ((lineNum !== null && composer.line === lineNum) || (lineNum === null && oldNum !== null && composer.oldLine === oldNum))

    if (threads.length === 0 && drafts.length === 0 && !isComposing) return null

    return (
      <tr>
        <td colSpan={colSpan} style={{ padding: '6px 12px', background: 'var(--bg-primary)', borderTop: '1px solid var(--bd-primary)', borderBottom: '1px solid var(--bd-primary)', fontFamily: 'var(--font-ui)' }}>
          <div className="stack" style={{ gap: 8 }}>
            {threads.map((th) => (
              <div key={th.id} className="card">
                <div className="card-header">
                  <span style={{ color: 'var(--fg-secondary)' }}>
                    Line {lineNum ?? oldNum} · {th.resolved ? 'Resolved' : 'Unresolved'}
                  </span>
                  {th.resolvable ? (
                    <button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => void onRunAction(th.resolved ? 'unresolve' : 'resolve', { discussionId: th.id })}
                    >
                      {th.resolved ? 'Unresolve' : 'Resolve'}
                    </button>
                  ) : null}
                </div>
                {th.notes.map((n) => (
                  <div key={n.id} className="card-pad stack" style={{ gap: 4, background: 'var(--bg-primary)' }}>
                    <div className="row" style={{ gap: 6 }}>
                      <Avatar username={n.author} size={14} />
                      <strong>{n.author}</strong>
                    </div>
                    <div style={{ paddingLeft: 20 }}>
                      <MarkdownView source={n.body} onOpenLink={onOpenLink} />
                    </div>
                  </div>
                ))}
              </div>
            ))}

            {drafts.map((dr) => (
              <div
                key={dr.id}
                className="row-between card-pad"
                style={{
                  borderRadius: 6,
                  border: '1px solid color-mix(in srgb, var(--fg-info) 45%, transparent)',
                  background: 'color-mix(in srgb, var(--fg-info) 8%, var(--bg-secondary))',
                }}
              >
                <div className="row" style={{ gap: 8 }}>
                  <span className="pill pill-info">Draft</span>
                  <MarkdownView source={dr.body} onOpenLink={onOpenLink} />
                </div>
                <button className="btn btn-sm" disabled={busy} onClick={() => void onRunAction('publish_draft', { noteId: dr.id })}>
                  Publish
                </button>
              </div>
            ))}

            {isComposing ? (
              <div className="card card-pad stack" style={{ gap: 8, borderColor: 'var(--ring-primary)' }}>
                <div style={{ color: 'var(--fg-secondary)', fontWeight: 500 }}>
                  Comment on <code className="mono">{filePath}:{lineNum ?? oldNum}</code>
                </div>
                <textarea
                  className="textarea"
                  rows={2}
                  autoFocus
                  placeholder="Write an inline review comment…"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                />
                <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setComposer(null)
                      setCommentText('')
                    }}
                  >
                    Cancel
                  </button>
                  <button className="btn btn-sm" disabled={busy || !commentText.trim()} onClick={() => void submitLineComment(true)}>
                    Save draft
                  </button>
                  <button className="btn btn-sm btn-primary" disabled={busy || !commentText.trim()} onClick={() => void submitLineComment(false)}>
                    Comment
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </td>
      </tr>
    )
  }

  const openLineComposer = (filePath: string, line: DiffLine) => {
    setCommentText('')
    if (line.type === 'del') setComposer({ path: filePath, oldLine: line.oldNum ?? undefined })
    else if (line.type === 'ctx') setComposer({ path: filePath, line: line.newNum ?? undefined, oldLine: line.oldNum ?? undefined })
    else setComposer({ path: filePath, line: line.newNum ?? undefined })
  }

  return (
    <div className="code-layout">
      <div className="code-toolbar">
        <div className="row" style={{ gap: 8 }}>
          {!narrow ? (
            <button className="btn btn-sm" onClick={onToggleFileIndex}>
              {showFileIndex ? 'Hide files' : 'Show files'}
            </button>
          ) : null}
          <div className="seg-group">
            <button className={`seg-btn ${diffMode === 'unified' ? 'active' : ''}`} onClick={() => onChangeDiffMode('unified')}>
              Unified
            </button>
            <button className={`seg-btn ${diffMode === 'split' ? 'active' : ''}`} onClick={() => onChangeDiffMode('split')}>
              Split
            </button>
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <div style={{ width: 90, height: 6, borderRadius: 999, background: 'var(--bd-primary)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--fg-success)', transition: 'width 150ms ease' }} />
          </div>
          <span className="mono" style={{ color: 'var(--fg-secondary)' }}>
            {viewedCount}/{files.length} viewed
          </span>
        </div>
      </div>

      <div className="code-body">
        {showSidebar ? (
          <div className="file-index">
            <div style={{ padding: '4px 7px', color: 'var(--fg-secondary)', fontWeight: 500 }}>Changed files</div>
            {files.map((f) => {
              const isViewed = viewedPaths.has(f.newPath)
              const statusColor = f.status === 'A' ? 'var(--fg-success)' : f.status === 'D' ? 'var(--fg-danger)' : 'var(--fg-warning)'
              return (
                <button
                  key={f.newPath}
                  className={`file-index-btn ${isViewed ? 'viewed' : ''}`}
                  title={f.newPath}
                  onClick={() => document.getElementById(`diff-file-${f.newPath}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  <span className="mono" style={{ fontWeight: 700, color: statusColor }}>
                    {f.status}
                  </span>
                  <span className="truncate" style={{ flex: 1 }}>
                    {f.newPath.split('/').pop()}
                  </span>
                  {isViewed ? (
                    <span style={{ color: 'var(--fg-success)' }}>✓</span>
                  ) : (
                    <span className="mono" style={{ color: 'var(--fg-success)' }}>
                      +{f.additions}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="diff-scroll">
          {files.map((file) => {
            const isViewed = viewedPaths.has(file.newPath)
            const isCollapsed = isViewed || collapsed.has(file.newPath)
            const hunks = isCollapsed ? [] : parseUnifiedDiff(file.diff)

            return (
              <div key={file.newPath} id={`diff-file-${file.newPath}`} className="card">
                <div className="card-header" style={{ borderBottom: isCollapsed ? 'none' : undefined }}>
                  <button
                    className="btn btn-ghost"
                    style={{ flex: 1, justifyContent: 'flex-start', padding: '1px 2px', minWidth: 0 }}
                    onClick={() => {
                      if (isViewed) onSetFileViewed(file.newPath, false)
                      else toggleCollapse(file.newPath)
                    }}
                  >
                    <ChevronIcon collapsed={isCollapsed} />
                    <span
                      className="mono truncate"
                      style={{
                        color: isViewed ? 'var(--fg-tertiary)' : 'var(--fg-primary)',
                        textDecoration: isViewed ? 'line-through' : undefined,
                      }}
                    >
                      {file.status === 'R' ? `${file.oldPath} → ${file.newPath}` : file.newPath}
                    </span>
                    <span className="mono" style={{ color: 'var(--fg-success)' }}>
                      +{file.additions}
                    </span>
                    <span className="mono" style={{ color: 'var(--fg-danger)' }}>
                      -{file.deletions}
                    </span>
                  </button>

                  <label className="row" style={{ gap: 5, cursor: 'pointer', color: 'var(--fg-secondary)', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={isViewed}
                      onChange={(e) => onSetFileViewed(file.newPath, e.target.checked)}
                    />
                    <span>Viewed</span>
                  </label>
                </div>

                {!isCollapsed ? (
                  <div style={{ overflowX: 'auto', background: 'var(--bg-primary)' }}>
                    {!file.diff && (file.tooLarge || file.collapsed) ? (
                      <div className="card-pad" style={{ color: 'var(--fg-secondary)' }}>
                        Diff omitted by GitLab ({file.tooLarge ? 'too large' : 'collapsed'}). Open the MR in GitLab to inspect this file.
                      </div>
                    ) : hunks.length === 0 ? (
                      <div className="card-pad" style={{ color: 'var(--fg-secondary)' }}>
                        No textual diff hunks (binary or mode-only change).
                      </div>
                    ) : diffMode === 'unified' ? (
                      <table className="diff-table">
                        <tbody>
                          {hunks.map((hunk, hi) => (
                            <Fragment key={hi}>
                              <tr className="diff-hunk">
                                <td colSpan={4}>{hunk.header}</td>
                              </tr>
                              {hunk.lines.map((line, li) => {
                                const rowCls = line.type === 'add' ? 'diff-add' : line.type === 'del' ? 'diff-del' : undefined
                                const numCls = line.type === 'add' ? 'diff-add-num' : line.type === 'del' ? 'diff-del-num' : ''
                                const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
                                return (
                                  <Fragment key={li}>
                                    <tr className={rowCls}>
                                      <td className={`diff-num ${numCls}`}>{line.oldNum ?? ''}</td>
                                      <td className={`diff-num ${numCls}`} style={{ borderRight: '1px solid var(--bd-primary)' }}>
                                        {line.newNum ?? ''}
                                      </td>
                                      <td style={{ width: 22, textAlign: 'center', padding: '1px 2px' }}>
                                        <button
                                          className="diff-add-btn"
                                          title="Add line comment"
                                          onClick={() => openLineComposer(file.newPath, line)}
                                        >
                                          +
                                        </button>
                                      </td>
                                      <td className="diff-code">
                                        <span style={{ opacity: 0.55, marginRight: 4, userSelect: 'none' }}>{prefix}</span>
                                        <HighlightedCode text={line.text} />
                                      </td>
                                    </tr>
                                    {renderInlineRows(file.newPath, line.newNum, line.oldNum, 4)}
                                  </Fragment>
                                )
                              })}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <table className="diff-table split">
                        <tbody>
                          {hunks.map((hunk, hi) => (
                            <Fragment key={hi}>
                              <tr className="diff-hunk">
                                <td colSpan={4}>{hunk.header}</td>
                              </tr>
                              {buildSplitPairs(hunk.lines).map((pair, pi) => (
                                <Fragment key={pi}>
                                  <tr>
                                    <td className={`diff-num ${pair.left?.type === 'del' ? 'diff-del-num' : ''}`}>
                                      {pair.left?.oldNum ?? ''}
                                    </td>
                                    <td
                                      className={`diff-split-cell ${pair.left?.type === 'del' ? 'diff-del' : ''}`}
                                      style={{ borderRight: '1px solid var(--bd-primary)' }}
                                    >
                                      {pair.left ? <HighlightedCode text={pair.left.text} /> : ''}
                                    </td>
                                    <td className={`diff-num ${pair.right?.type === 'add' ? 'diff-add-num' : ''}`}>
                                      {pair.right?.newNum ? (
                                        <button
                                          className="btn btn-ghost"
                                          style={{ padding: 0, fontSize: 11, fontFamily: 'var(--font-mono)' }}
                                          title={`Comment on line ${pair.right.newNum}`}
                                          onClick={() => openLineComposer(file.newPath, pair.right!)}
                                        >
                                          {pair.right.newNum}
                                        </button>
                                      ) : (
                                        ''
                                      )}
                                    </td>
                                    <td className={`diff-split-cell ${pair.right?.type === 'add' ? 'diff-add' : ''}`}>
                                      {pair.right ? <HighlightedCode text={pair.right.text} /> : ''}
                                    </td>
                                  </tr>
                                  {renderInlineRows(file.newPath, pair.right?.newNum ?? null, pair.left?.oldNum ?? null, 4)}
                                </Fragment>
                              ))}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
