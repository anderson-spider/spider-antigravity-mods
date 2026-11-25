// All tools listed by the MCP server: name, optional title and _meta, description and inputSchema (checked against
// `ToolInputs` by `SchemaFor`). The six core GitLab tools plus `gitlab_mr_dashboard` are visible to the model;
// `gitlab_ui_*` tools carry `visibility: ['app']` so only the MCP App iframe can invoke them.
import { comment } from './comments.ts'
import { DASHBOARD_URI, type DashboardToolName } from './dashboard.ts'
import type { ToolInputs } from './inputs.ts'
import { jobLog } from './joblog.ts'
import { label } from './labels.ts'
import { mr } from './mr.ts'
import { pipeline } from './pipelines.ts'
import type { Tool } from './run.ts'
import { allOf, type SchemaFor } from './schema.ts'
import { user } from './users.ts'

type Inputs = ToolInputs

const MR_ACTIONS = allOf<Inputs['gitlab_mr']['action']>()(
  'list', 'get', 'status', 'create', 'update', 'diff', 'commits', 'approve', 'unapprove', 'rebase', 'merge',
)
const COMMENT_ACTIONS = allOf<Inputs['gitlab_mr_comment']['action']>()(
  'list', 'unresolved', 'drafts', 'comment', 'reply', 'line', 'edit', 'resolve', 'unresolve', 'publish',
)
const PIPELINE_ACTIONS = allOf<Inputs['gitlab_pipeline']['action']>()(
  'list', 'jobs', 'wait', 'run', 'retry', 'cancel', 'play', 'artifacts',
)
const UI_ACTIONS = allOf<Inputs['gitlab_ui_action']['action']>()(
  'approve', 'unapprove', 'rebase', 'toggle_draft', 'close', 'reopen', 'update_description', 'merge',
  'comment', 'reply', 'line_comment', 'edit_note', 'resolve', 'unresolve', 'publish_draft', 'publish_all_drafts',
  'retry_job', 'cancel_job', 'play_job', 'retry_pipeline', 'cancel_pipeline', 'run_pipeline',
)
const STATE_ACTIONS = allOf<Inputs['gitlab_ui_state']['action']>()(
  'get', 'save_preferences', 'save_view', 'delete_view', 'set_file_viewed',
)

const IID = { type: 'integer', description: 'MR !iid. Default: the open MR of the current branch.' } as const
const NAMES = { type: 'array', items: { type: 'string' } } as const
const PROJECT = { type: ['string', 'integer'], description: 'group/project or numeric id.' } as const
const HOST = { type: 'string', description: "Default: the remote's host." } as const
const CWD = { type: 'string', description: 'Local repo path.' } as const
const PAGE = { type: 'integer' } as const
const PER_PAGE = { type: 'integer', description: 'Max 100.' } as const
const ALLOW_OTHERS = { type: 'boolean', description: "Write on someone else's MR; only when the user asked." } as const
const MR_STATES = allOf<'opened' | 'merged' | 'closed' | 'all'>()('opened', 'merged', 'closed', 'all')
const INVOLVEMENTS = allOf<'all' | 'reviewing' | 'authored'>()('all', 'reviewing', 'authored')

const APP_ONLY_META = { ui: { visibility: ['app'] } } as const
const DASHBOARD_META = {
  ui: { resourceUri: DASHBOARD_URI },
  'com.google.antigravity/ui': {
    entrypoints: [
      { type: 'aux_pane', title: 'GitLab MRs' },
      { type: 'global', title: 'GitLab MRs' },
    ],
  },
} as const

export type ToolSpec = {
  name: keyof ToolInputs
  title?: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: readonly string[] }
  _meta?: Record<string, unknown>
}

export const SPECS: readonly ToolSpec[] = [
  {
    name: 'gitlab_mr',
    description:
      "Merge requests of the repo's GitLab project. list (allProjects: every project; next = more " +
      'pages), get, status (pipeline, approvals, discussions, conflicts, blockers), diff, commits, create, update, ' +
      'approve, unapprove, rebase, merge (only when the user asks; iid and head sha required; refused for drafts, ' +
      'conflicts, blocking discussions, release* or protected targets besides main/master/develop unless ' +
      'allowProtectedTarget). Labels must exist unless createMissingLabels. Writes on MRs by others are refused without allowOthers.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: MR_ACTIONS },
        cwd: CWD,
        host: HOST,
        project: PROJECT,
        iid: IID,
        state: { type: 'string', enum: MR_STATES },
        scope: { type: 'string', enum: allOf<'created_by_me' | 'assigned_to_me' | 'all'>()('created_by_me', 'assigned_to_me', 'all') },
        author: { type: 'string', description: 'list: username or @me.' },
        assignee: { type: 'string' },
        reviewer: { type: 'string' },
        search: { type: 'string' },
        allProjects: { type: 'boolean' },
        page: PAGE,
        perPage: PER_PAGE,
        title: { type: 'string' },
        description: { type: 'string' },
        sourceBranch: { type: 'string' },
        targetBranch: { type: 'string' },
        labels: { ...NAMES, description: 'list filter; create/update: all labels.' },
        addLabels: NAMES,
        removeLabels: NAMES,
        createMissingLabels: { type: 'boolean' },
        assignees: { ...NAMES, description: '@me=owner; create default' },
        reviewers: NAMES,
        draft: { type: 'boolean' },
        stateEvent: { type: 'string', enum: allOf<'close' | 'reopen'>()('close', 'reopen') },
        removeSourceBranch: { type: 'boolean' },
        squash: { type: 'boolean' },
        files: { ...NAMES, description: 'diff: paths with these.' },
        sha: { type: 'string', description: 'merge: full head sha from status.' },
        whenPipelineSucceeds: { type: 'boolean', description: 'merge: auto-merge on pipeline success.' },
        allowOthers: ALLOW_OTHERS,
        allowProtectedTarget: { type: 'boolean' },
      },
      required: ['action'],
    } satisfies SchemaFor<Inputs['gitlab_mr']>,
  },
  {
    name: 'gitlab_mr_comment',
    description:
      'Discussions of a merge request: list (ids, authors, file/line, resolved; next = more pages), unresolved (open ' +
      'threads: place, author, ask, last reply; up to 2,000 discussions), comment, reply ' +
      'to a discussion, line (a diff comment on path at line, or oldLine for a removed line), edit a note, resolve, ' +
      'unresolve; draft: true does these as private draft notes, drafts lists them, publish posts one (noteId) or ' +
      'all. Writes on MRs by others are refused without allowOthers.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: COMMENT_ACTIONS },
        cwd: CWD,
        host: HOST,
        project: PROJECT,
        iid: IID,
        body: { type: 'string', description: 'Markdown text.' },
        discussionId: { type: 'string' },
        noteId: { type: 'integer', description: 'edit; publish: one draft, default all.' },
        draft: { type: 'boolean', description: 'comment, reply, line, edit: a draft note.' },
        path: { type: 'string', description: 'line: file path as in the diff.' },
        line: { type: 'integer', description: 'line: new-side line number.' },
        oldLine: { type: 'integer', description: 'line: old-side line number (both for an unchanged line).' },
        unresolvedOnly: { type: 'boolean' },
        page: PAGE,
        perPage: PER_PAGE,
        allowOthers: ALLOW_OTHERS,
      },
      required: ['action'],
    } satisfies SchemaFor<Inputs['gitlab_mr_comment']>,
  },
  {
    name: 'gitlab_pipeline',
    description:
      "Pipelines of a merge request (iid, or the current branch's MR) or of a ref: list; jobs of a pipeline " +
      '(default the latest) with downstream pipelines; wait for one to end (at most minutes; failed jobs with log ' +
      'excerpts); run (an MR pipeline, or a ref pipeline with variables); ' +
      'retry or cancel a job or pipeline; play a manual job; artifacts of a job (names, sizes, URL). ' +
      'Read a failed job with gitlab_job_log.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: PIPELINE_ACTIONS },
        cwd: CWD,
        host: HOST,
        project: PROJECT,
        iid: IID,
        ref: { type: 'string', description: 'Branch or tag instead of an MR.' },
        pipelineId: { type: 'integer' },
        jobId: { type: 'integer' },
        failedOnly: { type: 'boolean', description: 'jobs: only failed jobs.' },
        minutes: { type: 'integer', description: 'wait: at most this long (default 10, max 30).' },
        variables: { ...NAMES, description: 'run with ref: KEY=value.' },
        page: PAGE,
        perPage: PER_PAGE,
        allowOthers: ALLOW_OTHERS,
      },
      required: ['action'],
    } satisfies SchemaFor<Inputs['gitlab_pipeline']>,
  },
  {
    name: 'gitlab_job_log',
    description:
      "A CI job's log without terminal codes. errors (default): lines matching error words or pattern, with " +
      'context, then the last 30 lines; tail: the last lines; full: everything, cut at 60k characters.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'integer' },
        cwd: CWD,
        host: HOST,
        project: PROJECT,
        mode: { type: 'string', enum: allOf<'errors' | 'tail' | 'full'>()('errors', 'tail', 'full') },
        lines: { type: 'integer', description: 'tail: how many lines (default 100).' },
        pattern: { type: 'string', description: 'errors: a case-insensitive regex instead of the error words.' },
      },
      required: ['jobId'],
    } satisfies SchemaFor<Inputs['gitlab_job_log']>,
  },
  {
    name: 'gitlab_label',
    description:
      "Labels of the current repo's GitLab project (its own and its groups'): list (name, colour, description; " +
      'search; next = more pages); create (name, color default #428BCA, description), which answers the existing ' +
      'label when the name is taken.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: allOf<Inputs['gitlab_label']['action']>()('list', 'create') },
        cwd: CWD,
        host: HOST,
        project: PROJECT,
        name: { type: 'string' },
        color: { type: 'string', description: 'Hex, like #428BCA.' },
        description: { type: 'string' },
        search: { type: 'string' },
        page: PAGE,
        perPage: PER_PAGE,
      },
      required: ['action'],
    } satisfies SchemaFor<Inputs['gitlab_label']>,
  },
  {
    name: 'gitlab_user',
    description: "A user of the current repo's GitLab host: the token's own user by default (or @me), else the one with username.",
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD,
        host: HOST,
        username: { type: 'string', description: 'Default: the token owner.' },
      },
      required: [],
    } satisfies SchemaFor<Inputs['gitlab_user']>,
  },
  {
    name: 'gitlab_mr_dashboard',
    title: 'GitLab MRs',
    description:
      'Open the interactive GitLab Merge Requests dashboard (side pane or full-page sidebar) to browse, filter, ' +
      'review diffs, inspect pipelines/job logs, manage discussions/draft notes, and merge MRs.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD,
        host: HOST,
        project: PROJECT,
        iid: IID,
        state: { type: 'string', enum: MR_STATES },
        involvement: { type: 'string', enum: INVOLVEMENTS },
      },
      required: [],
    } satisfies SchemaFor<Inputs['gitlab_mr_dashboard']>,
    _meta: DASHBOARD_META,
  },
  // App-only UI tools (hidden from the LLM via `visibility: ['app']`)
  {
    name: 'gitlab_ui_list',
    description: 'App-only: list merge requests across configured GitLab hosts with GraphQL enrichment and REST fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        project: PROJECT,
        state: { type: 'string', enum: MR_STATES },
        involvement: { type: 'string', enum: INVOLVEMENTS },
      },
      required: [],
    } satisfies SchemaFor<Inputs['gitlab_ui_list']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'gitlab_ui_detail',
    description: 'App-only: load full merge request detail, approvals, pipeline jobs, discussions, and draft notes.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        project: PROJECT,
        iid: { type: 'integer' },
      },
      required: ['host', 'project', 'iid'],
    } satisfies SchemaFor<Inputs['gitlab_ui_detail']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'gitlab_ui_diff',
    description: 'App-only: load structured file diffs for a merge request.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        project: PROJECT,
        iid: { type: 'integer' },
        page: PAGE,
        perPage: PER_PAGE,
      },
      required: ['host', 'project', 'iid'],
    } satisfies SchemaFor<Inputs['gitlab_ui_diff']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'gitlab_ui_job_log',
    description: 'App-only: read a CI job log for inline display in the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        project: PROJECT,
        jobId: { type: 'integer' },
        mode: { type: 'string', enum: allOf<'errors' | 'tail' | 'full'>()('errors', 'tail', 'full') },
        lines: { type: 'integer' },
        pattern: { type: 'string' },
      },
      required: ['host', 'project', 'jobId'],
    } satisfies SchemaFor<Inputs['gitlab_ui_job_log']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'gitlab_ui_action',
    description: 'App-only: execute an explicit user-triggered write action from the GitLab MR dashboard UI.',
    inputSchema: {
      type: 'object',
      properties: {
        host: HOST,
        project: PROJECT,
        action: { type: 'string', enum: UI_ACTIONS },
        iid: { type: 'integer' },
        draft: { type: 'boolean' },
        description: { type: 'string' },
        sha: { type: 'string' },
        squash: { type: 'boolean' },
        removeSourceBranch: { type: 'boolean' },
        whenPipelineSucceeds: { type: 'boolean' },
        confirmOthers: { type: 'boolean' },
        confirmProtectedTarget: { type: 'boolean' },
        body: { type: 'string' },
        discussionId: { type: 'string' },
        noteId: { type: 'integer' },
        path: { type: 'string' },
        line: { type: 'integer' },
        oldLine: { type: 'integer' },
        jobId: { type: 'integer' },
        pipelineId: { type: 'integer' },
      },
      required: ['host', 'project', 'action'],
    } satisfies SchemaFor<Inputs['gitlab_ui_action']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'gitlab_ui_state',
    description: 'App-only: load or persist dashboard preferences, saved views, and files-viewed state in PLUGIN_DATA.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: STATE_ACTIONS },
        id: { type: 'string' },
        name: { type: 'string' },
        q: { type: 'string' },
        state: { type: 'string', enum: MR_STATES },
        involvement: { type: 'string', enum: INVOLVEMENTS },
        sort: { type: 'string', enum: allOf<'ready' | 'updated' | 'newest' | 'oldest' | 'largest'>()('ready', 'updated', 'newest', 'oldest', 'largest') },
        hostOrProject: { type: 'string' },
        diffMode: { type: 'string', enum: allOf<'unified' | 'split'>()('unified', 'split') },
        autoRefresh: { type: 'boolean' },
        showFileIndex: { type: 'boolean' },
        listWidthPct: { type: 'integer' },
        mrKey: { type: 'string' },
        sha: { type: 'string' },
        path: { type: 'string' },
        viewed: { type: 'boolean' },
      },
      required: ['action'],
    } satisfies SchemaFor<Inputs['gitlab_ui_state']>,
    _meta: APP_ONLY_META,
  },
]

export type CoreToolName = Exclude<keyof ToolInputs, DashboardToolName>

/** What answers each of the six core GitLab tools. */
export const TOOLS: Readonly<Record<CoreToolName, Tool>> = {
  gitlab_mr: mr,
  gitlab_mr_comment: comment,
  gitlab_pipeline: pipeline,
  gitlab_job_log: jobLog,
  gitlab_label: label,
  gitlab_user: user,
}

export const DASHBOARD_TOOLS: ReadonlySet<string> = new Set<DashboardToolName>([
  'gitlab_mr_dashboard',
  'gitlab_ui_list',
  'gitlab_ui_detail',
  'gitlab_ui_diff',
  'gitlab_ui_job_log',
  'gitlab_ui_action',
  'gitlab_ui_state',
])
