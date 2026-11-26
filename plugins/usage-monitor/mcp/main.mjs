#!/usr/bin/env node
/**
 * @fileoverview Stdio entrypoint for the Usage & Speed Monitor MCP App server.
 *
 * Ensures `stdout` carries exclusively JSON-RPC 2.0 frames (all diagnostics go to
 * `stderr`), shares the panel backend dispatcher (`dispatchBridgeApiRequest`), serves
 * both self-contained MCP App HTML bundles (`dashboard.html` and `health-card.html`),
 * runs non-blocking CLI statusLine setup when enabled, and refreshes `cli-status-snapshot.json`
 * on a lightweight 60s `.unref()` timer when CLI status bar is enabled and LS is discovered.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Guardrail: never let any transitive console.log/info corrupt JSON-RPC on stdout.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

const MCP_DIR = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = join(MCP_DIR, 'dist', 'dashboard.html');
const HEALTH_CARD_HTML_PATH = join(MCP_DIR, 'dist', 'health-card.html');
const CLI_SNAPSHOT_REFRESH_MS = 60_000;

const [
  { dispatchBridgeApiRequest },
  { loadSettings, lsRuntimeEndpoint },
  { ensureLsEndpointDiscovered },
  { ensureCliStatusLineConfigured },
  { createMcpServer },
] = await Promise.all([
  import('../backend/api-actions.mjs'),
  import('../backend/config.mjs'),
  import('../backend/ls-discovery.mjs'),
  import('../cli/statusline-config.mjs'),
  import('./server.mjs'),
]);

let shuttingDown = false;
let snapshotRefreshTimer = null;
let snapshotRefreshInFlight = false;

function safeWriteStdout(line) {
  if (shuttingDown || process.stdout.destroyed || process.stdout.writableEnded) {
    return;
  }
  try {
    process.stdout.write(`${line}\n`);
  } catch (err) {
    if (err?.code === 'EPIPE') {
      shutdown(0);
    }
  }
}

const mcp = createMcpServer({
  write: safeWriteStdout,
  dispatchApi: (pathname, method, data) =>
    dispatchBridgeApiRequest(pathname, method, data, {
      // Never terminate the stdio MCP process on bundle mtime drift.
      onRestart: () => {},
    }),
  readDashboardHtml: () => readFile(DASHBOARD_HTML_PATH, 'utf8'),
  readHealthCardHtml: () => readFile(HEALTH_CARD_HTML_PATH, 'utf8'),
  log: (msg) => {
    process.stderr.write(`${msg}\n`);
  },
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const inFlightRequests = new Set();

function shutdown(exitCode = 0, { drainStdout = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (snapshotRefreshTimer) {
    clearInterval(snapshotRefreshTimer);
    snapshotRefreshTimer = null;
  }
  try {
    rl.close();
  } catch {
    // ignore readline close errors
  }
  if (drainStdout && !process.stdout.destroyed && !process.stdout.writableEnded) {
    const forceTimer = setTimeout(() => process.exit(exitCode), 2000);
    forceTimer.unref?.();
    process.stdout.end(() => {
      clearTimeout(forceTimer);
      process.exit(exitCode);
    });
    return;
  }
  process.exit(exitCode);
}

rl.on('line', (line) => {
  const pending = Promise.resolve(mcp.receive(line))
    .catch((err) => {
      process.stderr.write(`usage-monitor: unhandled receive error: ${err?.message || String(err)}\n`);
    })
    .finally(() => {
      inFlightRequests.delete(pending);
    });
  inFlightRequests.add(pending);
});
rl.on('close', () => {
  void Promise.allSettled([...inFlightRequests]).finally(() => {
    shutdown(0, { drainStdout: true });
  });
});
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') {
    shutdown(0);
  }
});
process.on('SIGINT', () => {
  shutdown(0);
});
process.on('SIGTERM', () => {
  shutdown(0);
});

// Warm up LS discovery and run CLI statusLine migration without blocking MCP initialize.
setImmediate(() => {
  if (shuttingDown) return;
  try {
    const settings = loadSettings();
    if (settings.enableCliStatusLine !== false) {
      ensureCliStatusLineConfigured({ enabled: true });
    }
  } catch {
    // Non-fatal: never interrupt stdio MCP startup
  }

  void ensureLsEndpointDiscovered({ force: false }).catch(() => {});

  snapshotRefreshTimer = setInterval(() => {
    if (shuttingDown || snapshotRefreshInFlight) return;
    let enabled = false;
    try {
      enabled = loadSettings().enableCliStatusLine !== false;
    } catch {
      enabled = false;
    }
    const lsDiscovered = Boolean(lsRuntimeEndpoint?.addr || lsRuntimeEndpoint?.baseUrl);
    if (!enabled || !lsDiscovered) return;

    snapshotRefreshInFlight = true;
    void dispatchBridgeApiRequest(
      '/api/telemetry',
      'GET',
      { range: 'today', stepDetails: 'display' },
      { onRestart: () => {} }
    )
      .catch(() => {})
      .finally(() => {
        snapshotRefreshInFlight = false;
      });
  }, CLI_SNAPSHOT_REFRESH_MS);

  if (typeof snapshotRefreshTimer.unref === 'function') {
    snapshotRefreshTimer.unref();
  }
});
