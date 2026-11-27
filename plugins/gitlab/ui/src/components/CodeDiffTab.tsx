import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { buildSplitPairs, parseUnifiedDiff, tokenizeCode, type DiffLine } from '../lib/diff.ts'
import { buildDiffFileTree, filterDiffFiles, splitFilePath, type DiffTreeNode } from '../lib/fileTree.ts'
import type { DiffFile, DiffMode, MrDetail } from '../types.ts'
import {
  Avatar,
  CheckIcon,
  ChevronIcon,
  ChevronsUpDownIcon,
  CloseIcon,
  CommentIcon,
  CopyIcon,
  FolderIcon,
  SearchIcon,
  SidebarIcon,
  WrapTextIcon,
} from './Icons.tsx'
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
  jumpTarget,
  onChangeDiffMode,
  onToggleFileIndex,
  onSetFileViewed,
  onCopyText,
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
  jumpTarget?: { path: string; seq: number } | null
  onChangeDiffMode: (mode: DiffMode) => void
  onToggleFileIndex: () => void
  onSetFileViewed: (path: string, viewed: boolean) => void
  onCopyText?: (text: string, label: string) => void
  onOpenLink: (url: string) => void
  onRunAction: (action: string, extra?: Record<string, unknown>) => Promise<void>
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set())
  const [fileQuery, setFileQuery] = useState('')
  const [wrapLines, setWrapLines] = useState(false)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null)
  const [composer, setComposer] = useState<LineTarget | null>(null)
  const [commentText, setCommentText] = useState('')
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    }
  }, [])

  const jumpToFile = (path: string) => {
    setActivePath(path)
    setCollapsed((prev) => {
      if (!prev.has(path)) return prev
      const next = new Set(prev)
      next.delete(path)
      return next
    })
    requestAnimationFrame(() => {
      const el = document.getElementById(`diff-file-${path}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    setHighlightedPath(path)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => setHighlightedPath(null), 1600)
  }

  useEffect(() => {
    if (!jumpTarget || !files || files.length === 0) return
    if (files.some((f) => f.newPath === jumpTarget.path || f.oldPath === jumpTarget.path)) {
      const match = files.find((f) => f.newPath === jumpTarget.path) ?? files.find((f) => f.oldPath === jumpTarget.path)
      if (match) jumpToFile(match.newPath)
    }
  }, [jumpTarget, files])

  // Count threads & drafts per file path for quick indicators in file tree and headers
  const commentCountsByPath = useMemo(() => {
    const map = new Map<string, number>()
    for (const d of detail.discussions) {
      if (d.at?.path) map.set(d.at.path, (map.get(d.at.path) ?? 0) + 1)
    }
    for (const dr of detail.drafts) {
      if (dr.at?.path) map.set(dr.at.path, (map.get(dr.at.path) ?? 0) + 1)
    }
    return map
  }, [detail.discussions, detail.drafts])

  const filteredFiles = useMemo(() => (files ? filterDiffFiles(files, fileQuery) : []), [files, fileQuery])
  const fileTree = useMemo(() => buildDiffFileTree(filteredFiles), [filteredFiles])

  const totals = useMemo(() => {
    if (!files) return { additions: 0, deletions: 0 }
    return files.reduce(
      (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
      { additions: 0, deletions: 0 },
    )
  }, [files])

  if (loading && !files) {
    return <div className="empty-state">Loading merge request diff…</div>
  }
  if (!files || files.length === 0) {
    return <div className="empty-state">No changed files found for this merge request.</div>
  }

  const viewedCount = files.filter((f) => viewedPaths.has(f.newPath)).length
  const pct = Math.round((viewedCount / files.length) * 100)
  const showSidebar = showFileIndex && !narrow
  const unviewedFiles = files.filter((f) => !viewedPaths.has(f.newPath))
  const allUnviewedCollapsed = unviewedFiles.length > 0 && unviewedFiles.every((f) => collapsed.has(f.newPath))

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAllCollapsed = () => {
    if (allUnviewedCollapsed) {
      setCollapsed(new Set())
    } else {
      setCollapsed(new Set(unviewedFiles.map((f) => f.newPath)))
    }
  }

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
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

  const renderTreeNodes = (nodes: readonly DiffTreeNode[], depth: number) =>
    nodes.map((node) => {
      if (node.kind === 'dir') {
        const isDirCollapsed = collapsedDirs.has(node.path)
        return (
          <div key={`dir:${node.path}`}>
            <button
              type="button"
              className="tree-dir-btn"
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => toggleDir(node.path)}
              title={node.path}
            >
              <ChevronIcon collapsed={isDirCollapsed} size={12} />
              <FolderIcon size={12} />
              <span className="truncate" style={{ flex: 1 }}>
                {node.name}
              </span>
              <span className="mono" style={{ opacity: 0.55, fontSize: 10 }}>
                {node.fileCount}
              </span>
            </button>
            {!isDirCollapsed ? renderTreeNodes(node.children, depth + 1) : null}
          </div>
        )
      }

      const f = node.file
      const isViewed = viewedPaths.has(f.newPath)
      const isActive = activePath === f.newPath
      const commentCount = commentCountsByPath.get(f.newPath) ?? 0
      return (
        <button
          key={f.newPath}
          type="button"
          className={`file-index-btn ${isActive ? 'active' : ''} ${isViewed ? 'viewed' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={f.status === 'R' ? `${f.oldPath} → ${f.newPath}` : f.newPath}
          onClick={() => jumpToFile(f.newPath)}
        >
          <span className={`file-status file-status-${f.status}`}>{f.status}</span>
          <span className="truncate" style={{ flex: 1 }}>
            {node.name}
          </span>
          {commentCount > 0 ? (
            <span className="row-nowrap mono" style={{ gap: 2, color: 'var(--fg-info)', fontSize: 10.5, flexShrink: 0 }} title={`${commentCount} comment thread(s)`}>
              <CommentIcon size={10} />
              {commentCount}
            </span>
          ) : null}
          {isViewed ? (
            <span style={{ color: 'var(--fg-success)', display: 'inline-flex', flexShrink: 0 }} title="Viewed">
              <CheckIcon size={12} />
            </span>
          ) : (
            <span className="mono" style={{ fontSize: 10.5, display: 'inline-flex', gap: 3, flexShrink: 0 }}>
              {f.additions > 0 ? <span style={{ color: 'var(--fg-success)' }}>+{f.additions}</span> : null}
              {f.deletions > 0 ? <span style={{ color: 'var(--fg-danger)' }}>-{f.deletions}</span> : null}
            </span>
          )}
        </button>
      )
    })

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
        <td
          colSpan={colSpan}
          style={{
            padding: '8px 14px',
            background: 'var(--bg-secondary)',
            borderTop: '1px solid var(--bd-primary)',
            borderBottom: '1px solid var(--bd-primary)',
            fontFamily: 'var(--font-ui)',
          }}
        >
          <div className="stack diff-inline-panel" style={{ gap: 8 }}>
            {threads.map((th) => (
              <div key={th.id} className="card">
                <div className="card-header">
                  <span style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)' }}>
                    Line {lineNum ?? oldNum} · {th.resolved ? 'Resolved' : 'Unresolved'}
                  </span>
                  {th.resolvable ? (
                    <button
                      type="button"
                      className="btn btn-xs"
                      disabled={busy}
                      onClick={() => void onRunAction(th.resolved ? 'unresolve' : 'resolve', { discussionId: th.id })}
                    >
                      {th.resolved ? 'Unresolve' : 'Resolve'}
                    </button>
                  ) : null}
                </div>
                {th.notes.map((n, ni) => (
                  <div
                    key={n.id}
                    className="card-pad stack"
                    style={{
                      gap: 4,
                      background: 'var(--bg-primary)',
                      borderTop: ni > 0 ? '1px solid var(--bd-subtle)' : undefined,
                    }}
                  >
                    <div className="row" style={{ gap: 6 }}>
                      <Avatar username={n.author} size={16} />
                      <strong>{n.author}</strong>
                    </div>
                    <div style={{ paddingLeft: 22 }}>
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
                  borderRadius: 7,
                  border: '1px solid color-mix(in srgb, var(--fg-info) 45%, transparent)',
                  background: 'color-mix(in srgb, var(--fg-info) 8%, var(--bg-primary))',
                }}
              >
                <div className="row" style={{ gap: 8, minWidth: 0, flex: 1 }}>
                  <span className="pill pill-info">Draft</span>
                  <MarkdownView source={dr.body} onOpenLink={onOpenLink} />
                </div>
                <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void onRunAction('publish_draft', { noteId: dr.id })}>
                  Publish
                </button>
              </div>
            ))}

            {isComposing ? (
              <div className="card card-pad stack" style={{ gap: 8, borderColor: 'var(--ring-primary)', background: 'var(--bg-primary)' }}>
                <div style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>
                  Comment on <code className="mono">{filePath}:{lineNum ?? oldNum}</code>
                </div>
                <textarea
                  className="textarea"
                  rows={2}
                  autoFocus
                  placeholder="Write an inline review comment… (Cmd/Ctrl+Enter to submit)"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && commentText.trim() && !busy) {
                      e.preventDefault()
                      void submitLineComment(false)
                    } else if (e.key === 'Escape') {
                      setComposer(null)
                      setCommentText('')
                    }
                  }}
                />
                <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setComposer(null)
                      setCommentText('')
                    }}
                  >
                    Cancel
                  </button>
                  <button type="button" className="btn btn-sm" disabled={busy || !commentText.trim()} onClick={() => void submitLineComment(true)}>
                    Save draft
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy || !commentText.trim()} onClick={() => void submitLineComment(false)}>
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
        <div className="row" style={{ gap: 6 }}>
          {!narrow ? (
            <button
              type="button"
              className={`btn btn-sm ${showFileIndex ? 'btn-active' : ''}`}
              onClick={onToggleFileIndex}
              title={showFileIndex ? 'Hide changed files tree' : 'Show changed files tree'}
            >
              <SidebarIcon />
              <span>Files</span>
              <span className="mono" style={{ opacity: 0.7 }}>{files.length}</span>
            </button>
          ) : null}

          <div className="seg-group" role="group" aria-label="Diff view mode">
            <button type="button" className={`seg-btn ${diffMode === 'unified' ? 'active' : ''}`} onClick={() => onChangeDiffMode('unified')}>
              Unified
            </button>
            <button type="button" className={`seg-btn ${diffMode === 'split' ? 'active' : ''}`} onClick={() => onChangeDiffMode('split')}>
              Split
            </button>
          </div>

          {diffMode === 'unified' ? (
            <button
              type="button"
              className={`btn btn-sm ${wrapLines ? 'btn-active' : ''}`}
              onClick={() => setWrapLines((w) => !w)}
              title={wrapLines ? 'Disable soft line wrapping' : 'Wrap long diff lines'}
            >
              <WrapTextIcon />
              <span>Wrap</span>
            </button>
          ) : null}

          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={toggleAllCollapsed}
            title={allUnviewedCollapsed ? 'Expand all unviewed files' : 'Collapse all files'}
          >
            <ChevronsUpDownIcon />
            <span>{allUnviewedCollapsed ? 'Expand all' : 'Collapse all'}</span>
          </button>
        </div>

        <div className="row" style={{ gap: 10 }}>
          <span className="mono" style={{ fontSize: 'var(--text-xs)', display: 'inline-flex', gap: 5 }}>
            <span style={{ color: 'var(--fg-success)' }}>+{totals.additions}</span>
            <span style={{ color: 'var(--fg-danger)' }}>-{totals.deletions}</span>
          </span>
          <div className="row" style={{ gap: 7 }}>
            <div style={{ width: 84, height: 6, borderRadius: 999, background: 'var(--bd-primary)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: 'var(--fg-success)',
                  transition: 'width 180ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              />
            </div>
            <span className="mono" style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-xs)' }}>
              {viewedCount}/{files.length} viewed
            </span>
          </div>
        </div>
      </div>

      <div className="code-body">
        {showSidebar ? (
          <aside className="file-index" aria-label="Changed files">
            {files.length > 5 ? (
              <div className="file-index-search">
                <div className="search-wrap">
                  <span className="search-icon">
                    <SearchIcon />
                  </span>
                  <input
                    className="input search-input"
                    style={{ padding: '4px 24px 4px 27px', fontSize: 'var(--text-xs)' }}
                    type="text"
                    placeholder={`Filter ${files.length} files…`}
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    aria-label="Filter changed files"
                  />
                  {fileQuery ? (
                    <button type="button" className="search-clear" onClick={() => setFileQuery('')} aria-label="Clear file filter">
                      <CloseIcon size={11} />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="file-index-scroll scroller">
              {fileTree.length === 0 ? (
                <div style={{ padding: '14px 8px', color: 'var(--fg-tertiary)', fontSize: 'var(--text-xs)', textAlign: 'center' }}>
                  No files match “{fileQuery}”.
                </div>
              ) : (
                renderTreeNodes(fileTree, 0)
              )}
            </div>
          </aside>
        ) : null}

        <div className="diff-scroll scroller">
          {files.map((file, fileIdx) => {
            const isViewed = viewedPaths.has(file.newPath)
            const isCollapsed = isViewed || collapsed.has(file.newPath)
            const hunks = isCollapsed ? [] : parseUnifiedDiff(file.diff)
            const { dir, name } = splitFilePath(file.newPath)
            const commentCount = commentCountsByPath.get(file.newPath) ?? 0
            const isHighlighted = highlightedPath === file.newPath
            const deferOffscreen = fileIdx >= 2 && !isHighlighted

            return (
              <section
                key={file.newPath}
                id={`diff-file-${file.newPath}`}
                className={`diff-file-card ${deferOffscreen ? 'diff-file-deferred' : ''} ${isHighlighted ? 'highlighted' : ''}`}
              >
                <div className={`diff-file-header ${isCollapsed ? 'collapsed' : ''}`}>
                  <button
                    type="button"
                    className="diff-file-path-btn"
                    onClick={() => {
                      setActivePath(file.newPath)
                      if (isViewed) onSetFileViewed(file.newPath, false)
                      else toggleCollapse(file.newPath)
                    }}
                    title={file.status === 'R' ? `${file.oldPath} → ${file.newPath}` : file.newPath}
                  >
                    <ChevronIcon collapsed={isCollapsed} />
                    <span className={`file-status file-status-${file.status}`}>{file.status}</span>
                    <span className={`mono truncate ${isViewed ? 'diff-file-viewed-text' : ''}`} style={{ fontSize: 'var(--text-sm)' }}>
                      {file.status === 'R' ? (
                        <>
                          <span className="diff-file-dir">{file.oldPath} → </span>
                          <span className="diff-file-name">{file.newPath}</span>
                        </>
                      ) : (
                        <>
                          {dir ? <span className="diff-file-dir">{dir}</span> : null}
                          <span className="diff-file-name">{name}</span>
                        </>
                      )}
                    </span>
                    <span className="mono" style={{ fontSize: 'var(--text-xs)', display: 'inline-flex', gap: 4, flexShrink: 0, marginLeft: 4 }}>
                      {file.additions > 0 ? <span style={{ color: 'var(--fg-success)' }}>+{file.additions}</span> : null}
                      {file.deletions > 0 ? <span style={{ color: 'var(--fg-danger)' }}>-{file.deletions}</span> : null}
                    </span>
                    {commentCount > 0 ? (
                      <span className="pill pill-info mono" style={{ flexShrink: 0 }}>
                        <CommentIcon size={10} />
                        {commentCount}
                      </span>
                    ) : null}
                  </button>

                  <div className="row-nowrap" style={{ gap: 6, flexShrink: 0 }}>
                    {onCopyText ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        title={`Copy path: ${file.newPath}`}
                        onClick={() => onCopyText(file.newPath, 'Copied file path')}
                      >
                        <CopyIcon />
                      </button>
                    ) : null}

                    <label className={`diff-viewed-toggle ${isViewed ? 'checked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={isViewed}
                        onChange={(e) => onSetFileViewed(file.newPath, e.target.checked)}
                      />
                      <span>Viewed</span>
                    </label>
                  </div>
                </div>

                {!isCollapsed ? (
                  <div className="diff-table-wrap scroller">
                    {!file.diff && (file.tooLarge || file.collapsed) ? (
                      <div className="card-pad" style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)' }}>
                        Diff omitted by GitLab ({file.tooLarge ? 'too large' : 'collapsed'}). Open the MR in GitLab to inspect this file.
                      </div>
                    ) : hunks.length === 0 ? (
                      <div className="card-pad" style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)' }}>
                        No textual diff hunks (binary or mode-only change).
                      </div>
                    ) : diffMode === 'unified' ? (
                      <table className={`diff-table ${wrapLines ? 'wrap' : ''}`}>
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
                                      <td className={`diff-num ${numCls}`} style={{ borderRight: '1px solid var(--bd-subtle)' }}>
                                        {line.newNum ?? ''}
                                      </td>
                                      <td style={{ width: 24, textAlign: 'center', padding: '1px 2px' }}>
                                        <button
                                          type="button"
                                          className="diff-add-btn"
                                          title="Add line comment"
                                          onClick={() => openLineComposer(file.newPath, line)}
                                        >
                                          +
                                        </button>
                                      </td>
                                      <td className="diff-code">
                                        <span style={{ opacity: 0.5, marginRight: 5, userSelect: 'none' }}>{prefix}</span>
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
                      <table className={`diff-table split ${wrapLines ? 'wrap' : ''}`}>
                        <colgroup>
                          <col style={{ width: 46 }} />
                          <col />
                          <col style={{ width: 46 }} />
                          <col />
                        </colgroup>
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
                                      {pair.left?.oldNum ? (
                                        <button
                                          type="button"
                                          className="diff-num-btn"
                                          title={`Comment on old line ${pair.left.oldNum}`}
                                          onClick={() => openLineComposer(file.newPath, pair.left!)}
                                        >
                                          {pair.left.oldNum}
                                        </button>
                                      ) : (
                                        ''
                                      )}
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
                                          type="button"
                                          className="diff-num-btn"
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
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
