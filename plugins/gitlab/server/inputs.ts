// The inputs of every tool exposed by the GitLab MCP server (model tools plus the MCP App dashboard entrypoint and
// app-only UI tools), as their inputSchema in tools.ts declares them (`SchemaFor` checks the two agree).
// Types only: Node strips the imports of this file.
export interface ToolInputs {
  gitlab_mr: {
    action: 'list' | 'get' | 'status' | 'create' | 'update' | 'diff' | 'commits' | 'approve' | 'unapprove' | 'rebase' | 'merge'
    cwd?: string
    host?: string
    project?: string | number
    iid?: number
    state?: 'opened' | 'merged' | 'closed' | 'all'
    scope?: 'created_by_me' | 'assigned_to_me' | 'all'
    author?: string
    assignee?: string
    reviewer?: string
    search?: string
    allProjects?: boolean
    page?: number
    perPage?: number
    title?: string
    description?: string
    sourceBranch?: string
    targetBranch?: string
    labels?: string[]
    addLabels?: string[]
    removeLabels?: string[]
    createMissingLabels?: boolean
    assignees?: string[]
    reviewers?: string[]
    draft?: boolean
    stateEvent?: 'close' | 'reopen'
    removeSourceBranch?: boolean
    squash?: boolean
    files?: string[]
    sha?: string
    whenPipelineSucceeds?: boolean
    allowOthers?: boolean
    allowProtectedTarget?: boolean
  }
  gitlab_mr_comment: {
    action: 'list' | 'unresolved' | 'drafts' | 'comment' | 'reply' | 'line' | 'edit' | 'resolve' | 'unresolve' | 'publish'
    cwd?: string
    host?: string
    project?: string | number
    iid?: number
    body?: string
    discussionId?: string
    noteId?: number
    draft?: boolean
    path?: string
    line?: number
    oldLine?: number
    unresolvedOnly?: boolean
    page?: number
    perPage?: number
    allowOthers?: boolean
  }
  gitlab_pipeline: {
    action: 'list' | 'jobs' | 'wait' | 'run' | 'retry' | 'cancel' | 'play' | 'artifacts'
    cwd?: string
    host?: string
    project?: string | number
    iid?: number
    ref?: string
    pipelineId?: number
    jobId?: number
    failedOnly?: boolean
    minutes?: number
    variables?: string[]
    page?: number
    perPage?: number
    allowOthers?: boolean
  }
  gitlab_job_log: {
    jobId: number
    cwd?: string
    host?: string
    project?: string | number
    mode?: 'errors' | 'tail' | 'full'
    lines?: number
    pattern?: string
  }
  gitlab_label: {
    action: 'list' | 'create'
    cwd?: string
    host?: string
    project?: string | number
    name?: string
    color?: string
    description?: string
    search?: string
    page?: number
    perPage?: number
  }
  gitlab_user: {
    cwd?: string
    host?: string
    username?: string
  }
  gitlab_mr_dashboard: {
    cwd?: string
    host?: string
    project?: string | number
    iid?: number
    state?: 'opened' | 'merged' | 'closed' | 'all'
    involvement?: 'all' | 'waiting' | 'reviewing' | 'authored' | 'others'
  }
  gitlab_ui_list: {
    host?: string
    project?: string | number
    state?: 'opened' | 'merged' | 'closed' | 'all'
    involvement?: 'all' | 'waiting' | 'reviewing' | 'authored' | 'others'
    scope?: 'projects' | 'mine'
  }
  gitlab_ui_detail: {
    host: string
    project: string | number
    iid: number
  }
  gitlab_ui_diff: {
    host: string
    project: string | number
    iid: number
    page?: number
    perPage?: number
  }
  gitlab_ui_job_log: {
    host: string
    project: string | number
    jobId: number
    mode?: 'errors' | 'tail' | 'full'
    lines?: number
    pattern?: string
  }
  gitlab_ui_action: {
    host: string
    project: string | number
    action:
      | 'approve'
      | 'unapprove'
      | 'rebase'
      | 'toggle_draft'
      | 'close'
      | 'reopen'
      | 'update_description'
      | 'merge'
      | 'comment'
      | 'reply'
      | 'line_comment'
      | 'edit_note'
      | 'resolve'
      | 'unresolve'
      | 'publish_draft'
      | 'publish_all_drafts'
      | 'retry_job'
      | 'cancel_job'
      | 'play_job'
      | 'retry_pipeline'
      | 'cancel_pipeline'
      | 'run_pipeline'
      | 'checkout_worktree'
      | 'remove_worktree'
    iid?: number
    draft?: boolean
    description?: string
    sha?: string
    squash?: boolean
    removeSourceBranch?: boolean
    whenPipelineSucceeds?: boolean
    confirmOthers?: boolean
    confirmProtectedTarget?: boolean
    body?: string
    discussionId?: string
    noteId?: number
    path?: string
    line?: number
    oldLine?: number
    jobId?: number
    pipelineId?: number
    force?: boolean
    worktreePath?: string
  }
  gitlab_ui_state: {
    action: 'get' | 'save_preferences' | 'save_view' | 'delete_view' | 'set_file_viewed' | 'add_repo' | 'remove_repo'
    id?: string
    name?: string
    q?: string
    state?: 'opened' | 'merged' | 'closed' | 'all'
    involvement?: 'all' | 'waiting' | 'reviewing' | 'authored' | 'others'
    sort?: 'ready' | 'updated' | 'newest' | 'oldest' | 'largest'
    hostOrProject?: string
    diffMode?: 'unified' | 'split'
    autoRefresh?: boolean
    showFileIndex?: boolean
    listWidthPct?: number
    mrKey?: string
    sha?: string
    path?: string
    viewed?: boolean
  }
}
