// Tool input interfaces validated against JSON Schemas at compile time via SchemaFor<T>.

export type OpenMode = 'auto' | 'bypassPermissions'
export type AllMode = OpenMode

export type ToolInputs = {
  claude_open: {
    cwd?: string
    sessionId?: string
    prompt?: string
    mode?: OpenMode
    model?: string
    effort?: string
    replyToChat?: boolean
  }
  claude_ask: {
    prompt: string
    cwd?: string
    sessionId?: string
    model?: string
    effort?: string
    timeoutSeconds?: number
  }
  claude_session: {
    action: 'list' | 'get' | 'wait' | 'cancel'
    sessionId?: string
    cwd?: string
    includeArchived?: boolean
    timeoutSeconds?: number
  }
  claude_ui_bootstrap: {
    cwd?: string
    sessionId?: string
  }
  claude_ui_session: {
    action:
      | 'connect'
      | 'reconnect'
      | 'create'
      | 'get'
      | 'load'
      | 'delete'
      | 'rename'
      | 'archive'
      | 'unarchive'
      | 'set_mode'
      | 'set_model'
      | 'set_config'
      | 'authenticate'
      | 'claim_reply'
      | 'ack_reply'
      | 'release_reply'
    sessionId?: string
    cwd?: string
    title?: string
    modeId?: string
    modelId?: string
    configId?: string
    value?: string
    methodId?: string
    replyId?: string
    clientId?: string
  }
  claude_ui_prompt: {
    action: 'send' | 'cancel'
    sessionId: string
    prompt?: string
    files?: readonly string[]
  }
  claude_ui_permission: {
    sessionId: string
    requestId: string
    outcome: 'selected' | 'cancelled'
    optionId?: string
  }
  claude_ui_poll: {
    sessionId?: string
    afterSeq?: number
    afterCatalogVersion?: number
    waitMs?: number
    clientId?: string
  }
  claude_ui_fs: {
    action: 'list_dirs' | 'search_files' | 'save_prefs'
    query?: string
    cwd?: string
    sidebarWidthPct?: number
    lastCwd?: string
    defaultModeId?: string
    defaultModelId?: string
    defaultEffort?: string
  }
}
