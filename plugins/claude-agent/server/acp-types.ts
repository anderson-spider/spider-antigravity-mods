// Agent Client Protocol (ACP) JSON-RPC 2.0 wire types used by claude-agent-acp.

export type AcpAuthMethod = {
  id: string
  name: string
  description?: string | null
  _meta?: Record<string, unknown>
}

export type AcpAgentCapabilities = {
  loadSession?: boolean
  sessionCapabilities?: {
    list?: Record<string, unknown>
    fork?: Record<string, unknown>
    resume?: Record<string, unknown>
  }
  promptCapabilities?: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  mcpCapabilities?: {
    http?: boolean
    sse?: boolean
  }
}

export type AcpAgentInfo = {
  name: string
  title?: string | null
  version?: string
}

export type AcpInitializeResult = {
  protocolVersion: number | string
  agentInfo?: AcpAgentInfo | null
  agentCapabilities?: AcpAgentCapabilities
  authMethods?: AcpAuthMethod[]
}

export type AcpModeOption = {
  id: string
  name: string
  description?: string | null
}

export type AcpModesState = {
  currentModeId: string
  availableModes: AcpModeOption[]
}

export type AcpModelOption = {
  modelId: string
  name: string
  description?: string | null
}

export type AcpModelsState = {
  currentModelId: string
  availableModels: AcpModelOption[]
}

export type AcpConfigOptionValue = {
  value: string
  name: string
  description?: string | null
}

export type AcpConfigOptionGroup = {
  group: string
  name: string
  options: AcpConfigOptionValue[]
}

export type AcpConfigOption = {
  id: string
  name: string
  description?: string | null
  category?: string | null
  type: 'select'
  currentValue: string
  options: (AcpConfigOptionValue | AcpConfigOptionGroup)[]
}

export type AcpAvailableCommand = {
  name: string
  description: string
  input?: {
    hint?: string | null
  } | null
}

export type AcpPlanEntry = {
  content: string
  priority?: 'high' | 'medium' | 'low' | string
  status: 'pending' | 'in_progress' | 'completed' | string
}

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; title?: string; description?: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }

export type AcpToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other'
  | string

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | string

export type AcpToolCallLocation = {
  path: string
  line?: number | null
}

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string

export type AcpPermissionOption = {
  optionId: string
  name: string
  kind: AcpPermissionOptionKind
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

export type AcpRequestPermissionParams = {
  sessionId: string
  toolCall: {
    toolCallId: string
    title?: string | null
    kind?: AcpToolCallKind | null
    status?: AcpToolCallStatus | null
    rawInput?: unknown
    rawOutput?: unknown
    content?: AcpToolCallContent[] | null
    locations?: AcpToolCallLocation[] | null
  }
  options: AcpPermissionOption[]
}

export type AcpRequestPermissionResult = {
  outcome: AcpPermissionOutcome
}

export type AcpUsageCost =
  | number
  | {
      amount?: number
      currency?: string
    }

export type AcpSessionUpdate =
  | {
      sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk'
      content: AcpContentBlock
      messageId?: string
    }
  | {
      sessionUpdate: 'tool_call'
      toolCallId: string
      title: string
      kind?: AcpToolCallKind
      status?: AcpToolCallStatus
      content?: AcpToolCallContent[]
      locations?: AcpToolCallLocation[]
      rawInput?: unknown
      rawOutput?: unknown
    }
  | {
      sessionUpdate: 'tool_call_update'
      toolCallId: string
      title?: string | null
      kind?: AcpToolCallKind | null
      status?: AcpToolCallStatus | null
      content?: AcpToolCallContent[] | null
      locations?: AcpToolCallLocation[] | null
      rawInput?: unknown
      rawOutput?: unknown
    }
  | {
      sessionUpdate: 'plan'
      entries: AcpPlanEntry[]
    }
  | {
      sessionUpdate: 'available_commands_update'
      availableCommands: AcpAvailableCommand[]
    }
  | {
      sessionUpdate: 'current_mode_update'
      currentModeId: string
    }
  | {
      sessionUpdate: 'config_option_update'
      configOptions: AcpConfigOption[]
    }
  | {
      sessionUpdate: 'usage_update'
      used?: number
      size?: number
      cost?: AcpUsageCost | null
      currency?: string
    }
  | {
      sessionUpdate: 'session_info_update'
      title?: string | null
      updatedAt?: string | null
    }

export type AcpSessionNotificationParams = {
  sessionId: string
  update: AcpSessionUpdate
}

export type AcpSessionNewResult = {
  sessionId: string
  modes?: AcpModesState | null
  models?: AcpModelsState | null
  configOptions?: AcpConfigOption[] | null
}

export type AcpSessionLoadResult = {
  modes?: AcpModesState | null
  models?: AcpModelsState | null
  configOptions?: AcpConfigOption[] | null
}

export type AcpSessionListEntry = {
  sessionId: string
  cwd?: string
  title?: string | null
  updatedAt?: string | null
}

export type AcpSessionListResult = {
  sessions: AcpSessionListEntry[]
  nextCursor?: string | null
}

export type AcpPromptResult = {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    thoughtTokens?: number
    cachedReadTokens?: number
    cachedWriteTokens?: number
    totalTokens?: number
  } | null
  _meta?: Record<string, unknown>
}
