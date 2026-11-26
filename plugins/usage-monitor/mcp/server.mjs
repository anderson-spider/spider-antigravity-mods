/**
 * @fileoverview Pure, zero-dependency JSON-RPC 2.0 MCP server for Usage & Speed Monitor.
 *
 * Exposes:
 * - Resources:
 *   - `ui://usage-monitor/dashboard.html` (`text/html;profile=mcp-app`, `prefersBorder: false`)
 *   - `ui://usage-monitor/health-card.html` (`text/html;profile=mcp-app`, `prefersBorder: true`)
 * - Tools:
 *   - `usage_monitor_dashboard` with Antigravity `aux_pane` + `global` entrypoints
 *   - `usage_monitor_session_health` (inline chat card only, no entrypoints)
 *   - `usage_monitor_api` (`visibility: ['app']`) delegating to the shared backend API dispatcher
 */

import {
  BRIDGE_API_PATHS,
  BRIDGE_API_ROUTE_DEFS,
} from '../shared/api-protocol.mjs';

export const PROTOCOL = '2025-06-18';
export const SERVER_VERSION = '2.0.0';
export const DASHBOARD_URI = 'ui://usage-monitor/dashboard.html';
export const HEALTH_CARD_URI = 'ui://usage-monitor/health-card.html';
export const DASHBOARD_MIME = 'text/html;profile=mcp-app';

const VALID_TABS = new Set(['overview', 'consumption', 'steps', 'settings']);

const ALLOWED_ROUTES = new Set(
  BRIDGE_API_ROUTE_DEFS.map((route) => `${route.method}:${route.path}`)
);

export const TOOL_SPECS = Object.freeze([
  {
    name: 'usage_monitor_dashboard',
    title: 'Usage Monitor',
    description:
      'Open the Usage & Speed Monitor dashboard (side pane or full-page sidebar view) and return a concise summary of current session token usage, throughput, context allocation, and quota pools.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Optional conversation ID to inspect (omit to follow the latest session).',
        },
        tab: {
          type: 'string',
          enum: ['overview', 'consumption', 'steps', 'settings'],
          description: 'Optional dashboard tab to open.',
        },
      },
      required: [],
    },
    _meta: {
      ui: { resourceUri: DASHBOARD_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Usage Monitor' },
          { type: 'global', title: 'Usage Monitor' },
        ],
      },
    },
  },
  {
    name: 'usage_monitor_session_health',
    title: 'Session Health',
    description:
      'Diagnose prompt cache hit/miss attribution, sustained cache collapse, LLM vs. tool active time, effective throughput, active >60s gaps, and context hygiene for the current or specified session.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: 'Optional conversation ID to inspect (defaults to the latest active session).',
        },
      },
      required: [],
    },
    _meta: {
      ui: { resourceUri: HEALTH_CARD_URI },
    },
  },
  {
    name: 'usage_monitor_api',
    description:
      'App-only: execute a Usage & Speed Monitor panel API action (telemetry, session health, settings, or cache rebuild).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          enum: [...BRIDGE_API_PATHS],
          description: 'Panel API route path.',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST'],
          description: 'HTTP method for the route.',
        },
        query: {
          type: 'object',
          description: 'Optional query parameters for GET routes.',
        },
        body: {
          type: 'object',
          description: 'Optional JSON body for POST routes.',
        },
      },
      required: ['path', 'method'],
    },
    _meta: {
      ui: { visibility: ['app'] },
    },
  },
]);

const TOOL_NAMES = new Set(TOOL_SPECS.map((spec) => spec.name));

const REASON_LABELS = Object.freeze([
  ['planModeSwitch', 'plan_mode_switch'],
  ['modelSwitch', 'model_switch'],
  ['errorRetry', 'error_retry'],
  ['idleOrWaitGap', 'idle_or_wait_gap'],
  ['activeSlowGap', 'active_slow_gap'],
  ['asyncWakeupFast', 'async_wakeup_fast'],
  ['prefixOrReplicaMiss', 'prefix_or_replica_miss'],
  ['compactionResets', 'compaction'],
  ['contextDilutionTurns', 'context_dilution'],
]);

function formatCompactTokens(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '0';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(Math.round(num));
}

function formatUsd(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '$0.00';
  return num < 0.01 ? `$${num.toFixed(4)}` : `$${num.toFixed(2)}`;
}

function formatDurationCompact(sec) {
  const num = Number(sec);
  if (!Number.isFinite(num) || num <= 0) return '0s';
  if (num < 60) return `${num < 10 ? num.toFixed(1) : Math.round(num)}s`;
  const m = Math.floor(num / 60);
  const s = Math.round(num % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Formats a concise plain-text summary for non-UI MCP clients and trajectory text.
 *
 * @param {object | null | undefined} payload
 * @returns {string}
 */
export function formatDashboardSummary(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Usage & Speed Monitor dashboard opened. Telemetry data is currently unavailable.';
  }

  const lines = ['Usage & Speed Monitor'];
  const active = payload.activeConversation || {};
  const agg = active.aggregated || active;
  const ctx = active.context || {};
  const title = String(active.title || active.cascadeId || '').trim();
  const totalTokens = Number(agg.totalTokens ?? active.totalTokens ?? 0);
  const stepCount = Number(agg.stepCount ?? active.stepCount ?? 0);
  const costUsd = agg.sessionCostUsd ?? active.sessionCostUsd ?? 0;
  const speed = agg.latestTokPerSec ?? active.latestTokPerSec ?? agg.avgTokPerSec ?? null;
  const ttft = agg.latestTtftSec ?? active.latestTtftSec ?? null;
  const ctxTotal = Number(ctx.totalTokens || 0);
  const ctxLimit = Number(ctx.compactionLimitTokens || ctx.limitTokens || 0);

  if (title || stepCount > 0 || totalTokens > 0) {
    const parts = [
      title ? `Session: ${title}` : 'Session: latest',
      `${formatCompactTokens(totalTokens)} tokens`,
      `${stepCount} steps`,
      formatUsd(costUsd),
    ];
    if (Number.isFinite(Number(speed)) && Number(speed) > 0) {
      parts.push(`${Number(speed).toFixed(1)} tok/s`);
    }
    if (Number.isFinite(Number(ttft)) && Number(ttft) > 0) {
      parts.push(`TTFT ${Number(ttft).toFixed(2)}s`);
    }
    if (ctxLimit > 0 && ctxTotal > 0) {
      const pct = Math.min(100, (ctxTotal / ctxLimit) * 100);
      parts.push(`context ${pct.toFixed(1)}%`);
    }
    lines.push(parts.join(' · '));
  } else {
    lines.push('No active session telemetry recorded yet.');
  }

  const pools = Array.isArray(payload.quotas?.pools) ? payload.quotas.pools : [];
  if (pools.length > 0) {
    const poolSummary = pools
      .slice(0, 4)
      .map((pool) => {
        const label = String(
          pool?.poolLabel || pool?.poolKey || pool?.label || pool?.name || pool?.id || 'Pool'
        );
        const pct5hRaw =
          pool?.remainingPct ??
          (pool?.remainingFraction != null ? Number(pool.remainingFraction) * 100 : null);
        const pctWkRaw = pool?.weeklyRemainingPct;
        const pct5h = pct5hRaw != null && pct5hRaw !== '' ? Number(pct5hRaw) : Number.NaN;
        const pctWk = pctWkRaw != null && pctWkRaw !== '' ? Number(pctWkRaw) : Number.NaN;
        const has5h = Number.isFinite(pct5h);
        const hasWk = Number.isFinite(pctWk);
        if (has5h && hasWk) {
          return `${label}: ${Math.round(pct5h)}% left (5h) · ${Math.round(pctWk)}% left (weekly)`;
        }
        if (has5h) {
          return `${label}: ${Math.round(pct5h)}% left`;
        }
        if (hasWk) {
          return `${label}: ${Math.round(pctWk)}% left (weekly)`;
        }
        return `${label}: unavailable`;
      })
      .join(' | ');
    if (poolSummary) {
      lines.push(`Quotas: ${poolSummary}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats a concise 4-5 line plain-text summary for `usage_monitor_session_health`.
 *
 * @param {object | null | undefined} payload
 * @returns {string}
 */
export function formatSessionHealthSummary(payload) {
  if (!payload || typeof payload !== 'object' || !payload.sessionHealth) {
    return 'Session Health: unavailable (no session telemetry recorded yet).';
  }

  const conv = payload.conversation || {};
  const ctx = payload.context || {};
  const health = payload.sessionHealth;
  const attr = health.cacheMissAttribution || {};
  const collapse = attr.sustainedCollapse || {};
  const timing = health.timing || {};
  const hygiene = health.hygiene || {};

  const status = String(health.status || 'healthy').toUpperCase();
  const title = String(conv.title || conv.cascadeId || 'latest session').trim();
  const model = String(conv.activeModelShort || conv.activeModelLabel || 'unknown model').trim();
  const steps = Number(health.evaluatedSteps ?? conv.stepCount ?? 0);

  const lines = [`Session Health: ${status} · ${title} (${model}, ${steps} steps)`];

  // Line 2: Cache Hit + Miss Breakdown + Collapse
  const hitPct = Number(health.cacheHitPct || 0).toFixed(1);
  const misses = Number(attr.total || 0);
  const eligible = Number(attr.eligibleTransitions || 0);
  const reasonParts = REASON_LABELS.filter(([field]) => Number(attr[field] || 0) > 0).map(
    ([field, label]) => `${label}=${attr[field]}`
  );
  const collapseParts = [];
  if (Number(collapse.activeStreak || 0) >= 3) {
    collapseParts.push(`active collapse ${collapse.activeStreak}x`);
  } else if (Number(collapse.runs || 0) >= 1) {
    collapseParts.push(
      `collapse ${collapse.runs} run(s) / ${collapse.turns} turns (max ${collapse.maxStreak}x)`
    );
  }
  lines.push(
    `Cache: ${hitPct}% hit · ${misses}/${eligible} misses${reasonParts.length > 0 ? ` (${reasonParts.join(', ')})` : ''}${collapseParts.length > 0 ? ` · ${collapseParts.join(', ')}` : ''}`
  );

  // Line 3: Active Time + Effective TPS + Gaps >60s
  const effTps =
    timing.effectiveTps != null && Number.isFinite(Number(timing.effectiveTps))
      ? `${Number(timing.effectiveTps).toFixed(1)} tok/s`
      : 'N/A';
  lines.push(
    `Active time: ${formatDurationCompact(timing.activeTimeSec)} (LLM ${Math.round(Number(timing.llmSharePct || 0))}% / Tools ${Math.round(Number(timing.toolSharePct || 0))}%) · Eff. ${effTps} · Gaps >60s: ${Number(timing.gapsOver60s || 0)}/${Number(timing.activeGapsTotal || 0)} (${Number(timing.over60sGapPct || 0).toFixed(1)}%)`
  );

  // Line 4: Context + Hygiene
  const usedPct = Number(ctx.usedPct || 0).toFixed(1);
  const batchPart =
    hygiene.singleToolTurnPct != null && Number.isFinite(Number(hygiene.singleToolTurnPct))
      ? `${Number(hygiene.singleToolTurnPct).toFixed(0)}% 1-tool`
      : 'batching N/A';
  lines.push(
    `Context: ${formatCompactTokens(ctx.totalTokens)}/${formatCompactTokens(ctx.limitTokens)} (${usedPct}%) · >150k: ${Number(hygiene.over150kTurns || 0)} · Media >=150k: ${Number(hygiene.multimodalHighCtxTurns || 0)} · ${batchPart}`
  );

  // Line 5: Findings (if any)
  const findings = Array.isArray(health.findings) ? health.findings : [];
  if (findings.length > 0) {
    const summaryFindings = findings
      .slice(0, 5)
      .map((f) => `${f.code} (${f.severity})`)
      .join('; ');
    lines.push(`Findings: ${summaryFindings}`);
  }

  return lines.join('\n');
}

function safeParseJson(body) {
  if (typeof body !== 'string') return body ?? {};
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Creates a pure JSON-RPC 2.0 MCP server instance.
 *
 * @param {{
 *   write: (line: string) => void,
 *   dispatchApi: (pathname: string, method: string, data?: unknown) => Promise<{ status?: number, body?: string | object }>,
 *   readDashboardHtml: () => Promise<string>,
 *   readHealthCardHtml?: () => Promise<string>,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createMcpServer(deps) {
  const send = (message) => deps.write(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const answer = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });

  async function handleToolCall(id, params) {
    const name = params.name;
    if (typeof name !== 'string' || !TOOL_NAMES.has(name)) {
      return fail(id, -32602, `Unknown tool: ${String(name)}`);
    }
    const rawArgs = params.arguments;
    const args = isPlainObject(rawArgs) ? rawArgs : {};

    try {
      if (name === 'usage_monitor_dashboard') {
        const rawConvId = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
        const explicitConvId = rawConvId || null;
        const rawTab = typeof args.tab === 'string' ? args.tab.trim() : '';
        const explicitTab = VALID_TABS.has(rawTab) ? rawTab : null;

        let summaryText = 'Usage & Speed Monitor dashboard opened.';
        try {
          const query = {
            range: 'today',
            stepDetails: 'display',
            ...(explicitConvId ? { conversationId: explicitConvId } : {}),
          };
          const out = await deps.dispatchApi('/api/telemetry', 'GET', query);
          if (Number(out?.status || 200) < 400) {
            summaryText = formatDashboardSummary(safeParseJson(out?.body));
          }
        } catch (err) {
          deps.log?.(`usage-monitor: dashboard summary failed: ${err?.message || String(err)}`);
        }
        return answer(id, {
          content: [{ type: 'text', text: summaryText }],
          structuredContent: {
            conversationId: explicitConvId,
            tab: explicitTab,
          },
        });
      }

      if (name === 'usage_monitor_session_health') {
        const rawConvId = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
        const query = rawConvId ? { conversationId: rawConvId } : undefined;
        const out = await deps.dispatchApi('/api/session-health', 'GET', query);
        const status = Number(out?.status || 200);
        const data = safeParseJson(out?.body);
        if (status >= 400) {
          return answer(id, {
            content: [
              {
                type: 'text',
                text: data?.error || `Failed to inspect session health (HTTP ${status}).`,
              },
            ],
            isError: true,
          });
        }
        return answer(id, {
          content: [{ type: 'text', text: formatSessionHealthSummary(data) }],
          structuredContent: data,
        });
      }

      if (name === 'usage_monitor_api') {
        const pathname = String(args.path || '');
        const method = String(args.method || 'GET').toUpperCase();
        if (!ALLOWED_ROUTES.has(`${method}:${pathname}`)) {
          return answer(id, {
            content: [{ type: 'text', text: `Unsupported route: ${method} ${pathname}` }],
            structuredContent: {
              status: 404,
              ok: false,
              data: { error: `Unsupported route: ${method} ${pathname}` },
            },
            isError: true,
          });
        }
        const payloadArg =
          method === 'GET'
            ? isPlainObject(args.query)
              ? args.query
              : undefined
            : isPlainObject(args.body)
              ? args.body
              : undefined;
        const out = await deps.dispatchApi(pathname, method, payloadArg);
        const status = Number(out?.status || 200);
        const data = safeParseJson(out?.body);
        return answer(id, {
          content: [{ type: 'text', text: '' }],
          structuredContent: {
            status,
            ok: status >= 200 && status < 300,
            data,
          },
        });
      }
    } catch (err) {
      deps.log?.(`usage-monitor: ${name} failed: ${err?.stack || err?.message || String(err)}`);
      return answer(id, {
        content: [{ type: 'text', text: err?.message || 'Usage monitor tool call failed.' }],
        isError: true,
      });
    }
  }

  async function handleReadResource(id, params) {
    const uri = params.uri;
    if (typeof uri !== 'string') {
      return fail(id, -32602, 'resources/read requires a string uri.');
    }
    if (uri !== DASHBOARD_URI && uri !== HEALTH_CARD_URI) {
      return fail(id, -32602, `Unknown resource: ${uri}`);
    }
    try {
      const isHealthCard = uri === HEALTH_CARD_URI;
      const reader = isHealthCard ? deps.readHealthCardHtml : deps.readDashboardHtml;
      if (typeof reader !== 'function') {
        return fail(id, -32603, `Resource reader unavailable: ${uri}`);
      }
      const html = await reader();
      return answer(id, {
        contents: [
          {
            uri,
            mimeType: DASHBOARD_MIME,
            text: html,
            _meta: { ui: { prefersBorder: isHealthCard } },
          },
        ],
      });
    } catch (err) {
      deps.log?.(`usage-monitor: resource ${uri} failed: ${err?.stack || err?.message || String(err)}`);
      return fail(id, -32603, `Failed to read resource: ${uri}`);
    }
  }

  return {
    async receive(line) {
      if (!line || !line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return send({ id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (!isPlainObject(message)) {
        return send({ id: null, error: { code: -32600, message: 'Invalid Request' } });
      }
      const { id, method } = message;
      if (method === undefined || id === undefined || id === null) {
        // Notification or response to a server-initiated request; no reply needed.
        return;
      }
      const params = isPlainObject(message.params) ? message.params : {};
      switch (method) {
        case 'initialize': {
          const asked = params.protocolVersion;
          return answer(id, {
            protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'usage-monitor', version: SERVER_VERSION },
          });
        }
        case 'ping':
          return answer(id, {});
        case 'tools/list':
          return answer(id, {
            tools: TOOL_SPECS.map((spec) => ({
              name: spec.name,
              ...(spec.title ? { title: spec.title } : {}),
              description: spec.description,
              inputSchema: spec.inputSchema,
              ...(spec._meta ? { _meta: spec._meta } : {}),
            })),
          });
        case 'tools/call':
          return handleToolCall(id, params);
        case 'resources/list':
          return answer(id, {
            resources: [
              {
                uri: DASHBOARD_URI,
                name: 'Usage Monitor Dashboard',
                description: 'Interactive Usage & Speed Monitor MCP App view (side pane and sidebar).',
                mimeType: DASHBOARD_MIME,
                _meta: { ui: { prefersBorder: false } },
              },
              {
                uri: HEALTH_CARD_URI,
                name: 'Session Health Card',
                description: 'Compact inline chat card for Session Health diagnostics.',
                mimeType: DASHBOARD_MIME,
                _meta: { ui: { prefersBorder: true } },
              },
            ],
          });
        case 'resources/read':
          return handleReadResource(id, params);
        default:
          return fail(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}
