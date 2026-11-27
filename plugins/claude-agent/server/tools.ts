// MCP tool catalog: 3 model-visible tools (`claude_open` owns both aux_pane and global entrypoints)
// and 6 app-only tools (`visibility: ['app']`) driving the interactive MCP App UI.
import type { ToolInputs } from './inputs.ts'
import { allOf, type SchemaFor } from './schema.ts'
import { APP_URI } from './session-manager.ts'

type Inputs = ToolInputs

const APP_ONLY_META = { ui: { visibility: ['app'] } } as const
const OPEN_META = {
  ui: { resourceUri: APP_URI },
  'com.google.antigravity/ui': {
    entrypoints: [
      { type: 'aux_pane', title: 'Claude Agent' },
      { type: 'global', title: 'Claude Agent' },
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

const OPEN_MODES = allOf<'default' | 'auto' | 'acceptEdits' | 'plan'>()('default', 'auto', 'acceptEdits', 'plan')
const SESSION_ACTIONS = allOf<Inputs['claude_session']['action']>()('list', 'get', 'cancel')
const UI_SESSION_ACTIONS = allOf<Inputs['claude_ui_session']['action']>()(
  'connect',
  'reconnect',
  'create',
  'get',
  'load',
  'delete',
  'rename',
  'archive',
  'unarchive',
  'set_mode',
  'set_model',
  'set_config',
  'authenticate',
)
const UI_PROMPT_ACTIONS = allOf<Inputs['claude_ui_prompt']['action']>()('send', 'cancel')
const PERMISSION_OUTCOMES = allOf<Inputs['claude_ui_permission']['outcome']>()('selected', 'cancelled')
const FS_ACTIONS = allOf<Inputs['claude_ui_fs']['action']>()('list_dirs', 'search_files', 'save_prefs')

export const SPECS: readonly ToolSpec[] = [
  {
    name: 'claude_open',
    title: 'Claude Agent',
    description:
      'Open the interactive Claude Agent MCP App (side pane or full-page sidebar). When `prompt` is provided, ' +
      'starts an asynchronous Claude Code turn in the chosen workspace (`cwd`) and opens the side pane so the user ' +
      'can watch streaming output and approve permissions live. Leave all arguments empty to open the panel.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Workspace directory path. Default: current Antigravity workspace root.' },
        sessionId: { type: 'string', description: 'Existing session ID to focus or continue.' },
        prompt: { type: 'string', description: 'Optional task prompt to dispatch asynchronously to Claude.' },
        mode: { type: 'string', enum: OPEN_MODES, description: 'Initial permission mode (default, auto, acceptEdits, or plan). Defaults to auto when supported.' },
        model: { type: 'string', description: 'Optional model ID override. Defaults to opus when supported.' },
      },
      required: [],
    } satisfies SchemaFor<Inputs['claude_open']>,
    _meta: OPEN_META,
  },
  {
    name: 'claude_ask',
    title: 'Ask Claude (Read-Only)',
    description:
      'Synchronously consult Claude Code in read-only `plan` mode for code reviews, architecture questions, or second ' +
      'opinions. Any write/execute permission prompt is automatically declined so this call never blocks on UI approval.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Question or review request for Claude.' },
        cwd: { type: 'string', description: 'Workspace directory path. Default: current workspace root.' },
        sessionId: { type: 'string', description: 'Optional existing session ID to reuse.' },
        model: { type: 'string', description: 'Optional model ID override. Defaults to opus when supported.' },
        timeoutSeconds: { type: 'integer', description: 'Timeout in seconds (10-300, default 120).' },
      },
      required: ['prompt'],
    } satisfies SchemaFor<Inputs['claude_ask']>,
  },
  {
    name: 'claude_session',
    title: 'Claude Sessions',
    description:
      'List Claude Agent sessions, inspect a dispatched session status/latest response/touched files (`get`), or cancel an in-flight turn (`cancel`).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: SESSION_ACTIONS },
        sessionId: { type: 'string', description: 'Target session ID (required for get and cancel).' },
        cwd: { type: 'string', description: 'Optional directory filter for list.' },
        includeArchived: { type: 'boolean', description: 'Include archived sessions when listing (default false).' },
      },
      required: ['action'],
    } satisfies SchemaFor<Inputs['claude_session']>,
  },
  // App-only UI tools (hidden from the model)
  {
    name: 'claude_ui_bootstrap',
    description: 'App-only: fetch initial diagnostics, preferences, workspace roots, sessions, and active snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: [],
    } satisfies SchemaFor<Inputs['claude_ui_bootstrap']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'claude_ui_session',
    description: 'App-only: manage ACP connection, authentication, and session lifecycle/configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: UI_SESSION_ACTIONS },
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        title: { type: 'string' },
        modeId: { type: 'string' },
        modelId: { type: 'string' },
        configId: { type: 'string' },
        value: { type: 'string' },
        methodId: { type: 'string' },
      },
      required: ['action'],
    } satisfies SchemaFor<Inputs['claude_ui_session']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'claude_ui_prompt',
    description: 'App-only: send a prompt (with optional @file paths) or cancel the active turn.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: UI_PROMPT_ACTIONS },
        sessionId: { type: 'string' },
        prompt: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
      },
      required: ['action', 'sessionId'],
    } satisfies SchemaFor<Inputs['claude_ui_prompt']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'claude_ui_permission',
    description: 'App-only: approve or cancel a pending ACP session/request_permission prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        requestId: { type: 'string' },
        outcome: { type: 'string', enum: PERMISSION_OUTCOMES },
        optionId: { type: 'string' },
      },
      required: ['sessionId', 'requestId', 'outcome'],
    } satisfies SchemaFor<Inputs['claude_ui_permission']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'claude_ui_poll',
    description: 'App-only: long-poll session events after a given sequence number.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        afterSeq: { type: 'integer' },
        waitMs: { type: 'integer' },
        clientId: { type: 'string' },
      },
      required: ['sessionId', 'afterSeq'],
    } satisfies SchemaFor<Inputs['claude_ui_poll']>,
    _meta: APP_ONLY_META,
  },
  {
    name: 'claude_ui_fs',
    description: 'App-only: autocomplete directories, search workspace files for @mentions, and persist UI preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: FS_ACTIONS },
        query: { type: 'string' },
        cwd: { type: 'string' },
        sidebarWidthPct: { type: 'integer' },
        lastCwd: { type: 'string' },
        defaultModeId: { type: 'string' },
        defaultModelId: { type: 'string' },
      },
      required: ['action'],
    } satisfies SchemaFor<Inputs['claude_ui_fs']>,
    _meta: APP_ONLY_META,
  },
]
