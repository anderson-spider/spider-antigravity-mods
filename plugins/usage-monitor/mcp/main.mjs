#!/usr/bin/env node
/**
 * @fileoverview Stdio entrypoint for the Usage & Speed Monitor MCP App server.
 *
 * Ensures `stdout` carries exclusively JSON-RPC 2.0 frames (all diagnostics go to
 * `stderr`), shares the panel backend dispatcher (`dispatchBridgeApiRequest`), and
 * serves the self-contained MCP App bundle from `mcp/dist/dashboard.html`.
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

const [{ dispatchBridgeApiRequest }, { ensureLsEndpointDiscovered }, { createMcpServer }] =
  await Promise.all([
    import('../sidecars/panel/backend/api-actions.mjs'),
    import('../sidecars/panel/backend/ls-discovery.mjs'),
    import('./server.mjs'),
  ]);

// Warm up Language Server discovery in the background without blocking MCP initialize.
void ensureLsEndpointDiscovered({ force: false }).catch(() => {});

const mcp = createMcpServer({
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
  dispatchApi: (pathname, method, data) =>
    dispatchBridgeApiRequest(pathname, method, data, {
      // Never terminate the stdio MCP process on bundle mtime drift.
      onRestart: () => {},
    }),
  readDashboardHtml: () => readFile(DASHBOARD_HTML_PATH, 'utf8'),
  log: (msg) => {
    process.stderr.write(`${msg}\n`);
  },
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  void mcp.receive(line);
});
rl.on('close', () => {
  process.exit(0);
});
