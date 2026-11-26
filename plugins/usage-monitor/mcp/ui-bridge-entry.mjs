/**
 * @fileoverview Browser-side MCP App bridge for Usage & Speed Monitor.
 *
 * Bundled into `mcp/dist/dashboard.html` and executed synchronously before `app.js`.
 * - Performs the official `@modelcontextprotocol/ext-apps` handshake & live theme sync.
 * - Exposes a `window.sidecar.fetch` shim backed by `app.callServerTool('usage_monitor_api')`
 *   with an Antigravity-safe concurrency limit of 4 in-flight calls and `AbortSignal` support.
 */

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const MAX_IN_FLIGHT = 4;
const MCP_APP_VERSION = '1.2.1';

if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.setAttribute('data-mcp-app', 'true');
  document.documentElement.setAttribute('data-surface', 'global');
}

const app = new App({ name: 'Usage Monitor', version: MCP_APP_VERSION }, {});

function applyHostContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('data-theme', ctx.theme);
      document.documentElement.style.colorScheme = ctx.theme;
    }
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

// Register lifecycle handlers BEFORE connect() so initial notifications are never missed.
app.ontoolinput = () => {};
app.ontoolresult = () => {};
app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
};

const readyPromise = app
  .connect()
  .then(() => {
    applyHostContext(app.getHostContext());
  })
  .catch((err) => {
    console.error('[usage-monitor-mcp] Failed to connect MCP App bridge:', err);
    throw err;
  });

let activeCalls = 0;
const waitQueue = [];

function createAbortError() {
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

function acquireSlot(signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (activeCalls < MAX_IN_FLIGHT) {
    activeCalls += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = {
      resolve: () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        activeCalls += 1;
        resolve();
      },
      reject,
    };
    const onAbort = () => {
      const idx = waitQueue.indexOf(entry);
      if (idx >= 0) waitQueue.splice(idx, 1);
      reject(createAbortError());
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    waitQueue.push(entry);
  });
}

function releaseSlot() {
  activeCalls = Math.max(0, activeCalls - 1);
  const next = waitQueue.shift();
  if (next) next.resolve();
}

function parseApiRequest(input, init = {}) {
  const url = new URL(String(input || '/'), 'http://127.0.0.1');
  const method = String(init?.method || 'GET').toUpperCase();
  const query = {};
  let hasQuery = false;
  for (const [k, v] of url.searchParams.entries()) {
    query[k] = v;
    hasQuery = true;
  }
  let body;
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    } else if (typeof init.body === 'object') {
      body = init.body;
    }
  }
  return {
    path: url.pathname,
    method,
    ...(hasQuery ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

async function mcpAppFetch(input, init = {}) {
  const signal = init?.signal;
  if (signal?.aborted) {
    throw createAbortError();
  }

  await readyPromise;
  if (signal?.aborted) {
    throw createAbortError();
  }

  await acquireSlot(signal);
  try {
    if (signal?.aborted) {
      throw createAbortError();
    }
    const args = parseApiRequest(input, init);
    const result = await app.callServerTool({
      name: 'usage_monitor_api',
      arguments: args,
    });
    if (signal?.aborted) {
      throw createAbortError();
    }

    const structured = result?.structuredContent;
    if (structured && typeof structured === 'object' && 'status' in structured) {
      const status = Number(structured.status || 200);
      const ok = Boolean(structured.ok ?? (status >= 200 && status < 300));
      const data = structured.data ?? {};
      return {
        ok,
        status,
        async json() {
          return data;
        },
      };
    }

    const errorText = Array.isArray(result?.content)
      ? result.content
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
      : '';
    return {
      ok: !result?.isError,
      status: result?.isError ? 500 : 200,
      async json() {
        return result?.isError ? { error: errorText || 'MCP tool call failed' } : {};
      },
    };
  } finally {
    releaseSlot();
  }
}

if (typeof window !== 'undefined') {
  window.sidecar = {
    fetch: mcpAppFetch,
    conversationId: '',
  };
}
