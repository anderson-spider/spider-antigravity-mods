/**
 * @fileoverview Pure, zero-dependency JSON-RPC 2.0 MCP server for Usage & Speed Monitor.
 *
 * Exposes:
 * - Resource `ui://usage-monitor/dashboard.html` (`text/html;profile=mcp-app`)
 * - Tool `usage_monitor_dashboard` with Antigravity `global` (left sidebar) entrypoint
 * - App-only tool `usage_monitor_api` (`visibility: ['app']`) delegating to the shared
 *   panel API dispatcher (`dispatchBridgeApiRequest`).
 */

import {
  BRIDGE_API_PATHS,
  BRIDGE_API_ROUTE_DEFS,
} from '../sidecars/panel/shared/window-bridge-protocol.mjs';

export const PROTOCOL = '2025-06-18';
export const SERVER_VERSION = '1.2.1';
export const DASHBOARD_URI = 'ui://usage-monitor/dashboard.html';
export const DASHBOARD_MIME = 'text/html;profile=mcp-app';

const ALLOWED_ROUTES = new Set(
  BRIDGE_API_ROUTE_DEFS.map((route) => `${route.method}:${route.path}`)
);

export const TOOL_SPECS = Object.freeze([
  {
    name: 'usage_monitor_dashboard',
    title: 'Usage Monitor',
    description:
      'Open the full-page Usage & Speed Monitor dashboard (sidebar global view) and return a concise summary of current session token usage, throughput, context allocation, and quota pools.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    _meta: {
      ui: { resourceUri: DASHBOARD_URI },
      'com.google.antigravity/ui': {
        entrypoints: [{ type: 'global', title: 'Usage Monitor' }],
      },
    },
  },
  {
    name: 'usage_monitor_api',
    description:
      'App-only: execute a Usage & Speed Monitor panel API action (telemetry, settings, context window, or cache rebuild).',
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
        let summaryText = 'Usage & Speed Monitor dashboard opened.';
        try {
          const out = await deps.dispatchApi('/api/telemetry', 'GET', {
            range: 'today',
            stepDetails: 'display',
          });
          if (Number(out?.status || 200) < 400) {
            summaryText = formatDashboardSummary(safeParseJson(out?.body));
          }
        } catch (err) {
          deps.log?.(`usage-monitor: dashboard summary failed: ${err?.message || String(err)}`);
        }
        return answer(id, {
          content: [{ type: 'text', text: summaryText }],
          structuredContent: { surface: 'global' },
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
    if (uri !== DASHBOARD_URI) {
      return fail(id, -32602, `Unknown resource: ${uri}`);
    }
    try {
      const html = await deps.readDashboardHtml();
      return answer(id, {
        contents: [
          {
            uri: DASHBOARD_URI,
            mimeType: DASHBOARD_MIME,
            text: html,
            _meta: { ui: { prefersBorder: false } },
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
          void handleToolCall(id, params);
          return;
        case 'resources/list':
          return answer(id, {
            resources: [
              {
                uri: DASHBOARD_URI,
                name: 'Usage Monitor Dashboard',
                description: 'Full-page interactive Usage & Speed Monitor MCP App view.',
                mimeType: DASHBOARD_MIME,
                _meta: { ui: { prefersBorder: false } },
              },
            ],
          });
        case 'resources/read':
          void handleReadResource(id, params);
          return;
        default:
          return fail(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}
