// Tool definitions and request dispatcher for the `batch-tools` MCP server.
// All v1 tools are headless (no `_meta.ui`) and share a single PolicyGuard + AuditLog seam.
import { createAuditLog, type AuditLog } from './audit.ts'
import { DEFAULT_INLINE_MAX_BYTES } from './budget.ts'
import { APPLY_EDITS_TOOL_SPEC, runApplyEdits } from './edits.ts'
import type { CallContext, ToolReply, ToolSpec } from './mcp.ts'
import { createPolicyGuard } from './policy.ts'
import { redactSecrets } from './redact.ts'
import { MAX_CONTEXT_LINES, MAX_QUERIES, runBatchSearch } from './search.ts'
import {
  runQuickOutline,
  runReadSlices,
  type QuickOutlineInput,
  type ReadSlicesInput,
} from './slices.ts'

export const BATCH_SEARCH_TOOL_SPEC: ToolSpec = {
  name: 'batch_search',
  title: 'Batch Search',
  description:
    'Run up to 20 parallel file/code searches (text, regex, glob, fuzzy) in one call using ripgrep with pure-Node fallback. Strictly confined to workspace roots with secret-file exclusions and <= 8,800 UTF-8 byte inline output budgeting.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description:
          "Optional working directory inside the allowed workspace root. Pass the active project's absolute workspace path on hosts that do not report MCP roots.",
      },
      queries: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUERIES,
        description: 'Non-empty list of 1-20 search queries to execute in parallel.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['text', 'regex', 'glob', 'fuzzy'],
            },
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'string' },
            fileType: { type: 'string' },
            multiline: { type: 'boolean' },
            outputMode: {
              type: 'string',
              enum: ['content', 'files_with_matches', 'count'],
            },
            sortBy: {
              type: 'string',
              enum: ['path', 'mtime'],
            },
            caseSensitive: { type: 'boolean' },
            contextLines: { type: 'integer', minimum: 0, maximum: MAX_CONTEXT_LINES },
            maxResults: { type: 'integer', minimum: 1, maximum: 200 },
          },
          required: ['type', 'pattern'],
          additionalProperties: false,
        },
      },
      maxChars: {
        type: 'integer',
        minimum: 500,
        maximum: DEFAULT_INLINE_MAX_BYTES,
        description: 'Optional character budget (500-8800, default 8500; hard UTF-8 cap 8800 bytes).',
      },
    },
    required: ['queries'],
    additionalProperties: false,
  },
}

export const QUICK_OUTLINE_TOOL_SPEC: ToolSpec = {
  name: 'quick_outline',
  title: 'Quick Outline',
  description:
    'Extract structural symbol and section line-range outlines for up to 40 workspace files in one call (TS/JS, Python, Go, Rust, C/C++/Java/Kotlin/C#/Swift, HTML/Vue/Svelte, CSS, Shell, Markdown, JSON, YAML). Output is water-filled to <= 8,800 UTF-8 bytes.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description:
          "Optional working directory inside the allowed workspace root. Pass the active project's absolute workspace path on hosts that do not report MCP roots.",
      },
      paths: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        description: 'List of 1-40 workspace file paths to outline.',
        items: { type: 'string' },
      },
      maxChars: {
        type: 'integer',
        minimum: 500,
        maximum: DEFAULT_INLINE_MAX_BYTES,
        description: 'Optional character budget (500-8800, default 8500; hard UTF-8 cap 8800 bytes).',
      },
    },
    required: ['paths'],
    additionalProperties: false,
  },
}

export const READ_SLICES_TOOL_SPEC: ToolSpec = {
  name: 'read_slices',
  title: 'Read Slices',
  description:
    'Batch structural symbol outlines (up to 40 files) and targeted 1-based line-range slices (up to 30 files via `slices` or `lineRanges` shorthand like "src/app.ts:10-40,80-110") in one call. For >150 known lines, prefer built-in read_file. Output is water-filled to <= 8,800 UTF-8 bytes.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description:
          "Optional working directory inside the allowed workspace root. Pass the active project's absolute workspace path on hosts that do not report MCP roots.",
      },
      outlines: {
        type: 'array',
        maxItems: 40,
        items: { type: 'string' },
      },
      slices: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            ranges: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: { type: 'integer', minimum: 1 },
              },
            },
          },
          required: ['path', 'ranges'],
          additionalProperties: false,
        },
      },
      lineRanges: {
        type: 'array',
        maxItems: 30,
        description: 'Shorthand line ranges such as "src/app.ts:1-40,80-120".',
        items: { type: 'string' },
      },
      maxChars: {
        type: 'integer',
        minimum: 500,
        maximum: DEFAULT_INLINE_MAX_BYTES,
        description: 'Optional character budget (500-8800, default 8500; hard UTF-8 cap 8800 bytes).',
      },
    },
    additionalProperties: false,
  },
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  BATCH_SEARCH_TOOL_SPEC,
  QUICK_OUTLINE_TOOL_SPEC,
  READ_SLICES_TOOL_SPEC,
  APPLY_EDITS_TOOL_SPEC,
]

export type BatchToolName = 'batch_search' | 'quick_outline' | 'read_slices' | 'apply_edits'

export interface ToolDispatcherOptions {
  audit?: AuditLog
  env?: NodeJS.ProcessEnv
  processCwd?: () => string
  pluginRoot?: string
  platform?: NodeJS.Platform
}

export interface ToolDispatcher {
  readonly audit: AuditLog
  call: (
    name: string,
    input: Record<string, unknown>,
    context: CallContext,
  ) => Promise<ToolReply>
}

export function createToolDispatcher(options: ToolDispatcherOptions = {}): ToolDispatcher {
  const audit = options.audit ?? createAuditLog()

  return {
    audit,
    async call(name, input, context) {
      const policy = createPolicyGuard({
        mcpRoots: context.cwds.length > 0 ? context.cwds : undefined,
        explicitCwd: typeof input.cwd === 'string' ? input.cwd : undefined,
        env: options.env,
        processCwd: options.processCwd,
        pluginRoot: options.pluginRoot,
        platform: options.platform,
        audit,
      })

      switch (name as BatchToolName) {
        case 'batch_search':
          return runBatchSearch(input, { policy, audit })
        case 'quick_outline':
          return runQuickOutline(input as unknown as QuickOutlineInput, { policy, audit })
        case 'read_slices':
          return runReadSlices(input as unknown as ReadSlicesInput, { policy, audit })
        case 'apply_edits':
          return runApplyEdits(input, { policy, audit })
        default:
          return {
            text: redactSecrets(`Unknown tool: ${name}`),
            isError: true,
          }
      }
    },
  }
}
