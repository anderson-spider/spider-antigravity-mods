/**
 * @fileoverview Browser-side MCP App bridge for Usage & Speed Monitor.
 *
 * Bundled into `mcp/dist/dashboard.html` and executed synchronously before `ui/dashboard/main.js`.
 * - Performs the official `@modelcontextprotocol/ext-apps` handshake, full HostContext
 *   sync (theme, CSS variables, host fonts, locale), and surface detection (`aux_pane` vs `global`).
 * - Captures `ontoolinput` / `ontoolresult` navigation payloads (`{ conversationId, tab }`)
 *   with deduplication and replay buffering for late subscribers.
 * - Exposes `window.mcpBridge` (plus `window.sidecar` compatibility alias) backed by
 *   `app.callServerTool('usage_monitor_api')` with a 4 in-flight concurrency limit and `AbortSignal`.
 */

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const MAX_IN_FLIGHT = 4;
const MCP_APP_VERSION = '2.0.0';
const VALID_TABS = new Set(['overview', 'consumption', 'steps', 'settings']);

if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.setAttribute('data-mcp-app', 'true');
  document.documentElement.setAttribute('data-surface', 'global');
}

const app = new App({ name: 'Usage Monitor', version: MCP_APP_VERSION }, {});

let currentHostContext = null;
let currentHostCapabilities = {};
let currentSurface = 'global';
let latestHostLocale = '';

const hostLocaleListeners = new Set();
const toolNavListeners = new Set();
let bufferedNavigation = null;
let pendingInputNavSig = '';

function extractNavigation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawConv = typeof raw.conversationId === 'string' ? raw.conversationId.trim() : '';
  const rawTab = typeof raw.tab === 'string' ? raw.tab.trim() : '';
  const conversationId = rawConv || null;
  const tab = VALID_TABS.has(rawTab) ? rawTab : null;
  if (!conversationId && !tab) return null;
  return { conversationId, tab };
}

function navSignature(nav) {
  return nav ? `${nav.conversationId || ''}|${nav.tab || ''}` : '';
}

function emitToolNavigation(nav) {
  if (!nav) return;
  if (nav.conversationId && typeof window !== 'undefined' && window.mcpBridge) {
    window.mcpBridge.conversationId = nav.conversationId;
  }
  if (toolNavListeners.size === 0) {
    bufferedNavigation = nav;
    return;
  }
  for (const cb of [...toolNavListeners]) {
    try {
      cb(nav);
    } catch {
      // Isolate listener errors
    }
  }
}

function applyHostContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  currentHostContext = { ...(currentHostContext || {}), ...ctx };
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
  if (ctx.styles?.css?.fonts && typeof applyHostFonts === 'function') {
    applyHostFonts(ctx.styles.css.fonts);
  }
  if (typeof ctx.locale === 'string' && ctx.locale.trim()) {
    const nextLocale = ctx.locale.trim();
    if (nextLocale !== latestHostLocale) {
      latestHostLocale = nextLocale;
      for (const cb of [...hostLocaleListeners]) {
        try {
          cb(latestHostLocale);
        } catch {
          // Isolate listener errors
        }
      }
    }
  }
}

// Register lifecycle handlers BEFORE connect() so initial notifications are never missed.
app.ontoolinput = ({ arguments: args } = {}) => {
  const nav = extractNavigation(args);
  if (nav) {
    pendingInputNavSig = navSignature(nav);
    emitToolNavigation(nav);
  } else {
    pendingInputNavSig = '';
  }
};

app.ontoolresult = (result) => {
  const nav = extractNavigation(result?.structuredContent);
  const sig = navSignature(nav);
  if (nav && sig === pendingInputNavSig) {
    pendingInputNavSig = '';
    return;
  }
  pendingInputNavSig = '';
  if (nav) {
    emitToolNavigation(nav);
  }
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
};

const readyPromise = app
  .connect()
  .then(() => {
    currentHostCapabilities = app.getHostCapabilities() || {};
    currentSurface =
      currentHostCapabilities.message || currentHostCapabilities.updateModelContext
        ? 'aux_pane'
        : 'global';
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('data-surface', currentSurface);
    }
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

function onToolNavigation(cb) {
  if (typeof cb !== 'function') return () => {};
  toolNavListeners.add(cb);
  if (bufferedNavigation) {
    const replay = bufferedNavigation;
    bufferedNavigation = null;
    try {
      cb(replay);
    } catch {
      // Isolate subscriber errors
    }
  }
  return () => {
    toolNavListeners.delete(cb);
  };
}

function onHostLocaleChange(cb) {
  if (typeof cb !== 'function') return () => {};
  hostLocaleListeners.add(cb);
  if (latestHostLocale) {
    try {
      cb(latestHostLocale);
    } catch {
      // Isolate subscriber errors
    }
  }
  return () => {
    hostLocaleListeners.delete(cb);
  };
}

if (typeof window !== 'undefined') {
  const bridge = {
    fetch: mcpAppFetch,
    conversationId: '',
    getHostCapabilities: () => currentHostCapabilities,
    getHostContext: () => currentHostContext,
    getSurface: () => currentSurface,
    onToolNavigation,
    onHostLocaleChange,
  };
  window.mcpBridge = bridge;
  window.sidecar = {
    fetch: mcpAppFetch,
    get conversationId() {
      return bridge.conversationId;
    },
    set conversationId(val) {
      bridge.conversationId = String(val || '');
    },
  };
}
