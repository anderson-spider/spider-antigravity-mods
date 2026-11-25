import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DASHBOARD_MIME,
  DASHBOARD_URI,
  SERVER_VERSION,
  createMcpServer,
  formatDashboardSummary,
} from '../server.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = dirname(TEST_DIR);
const PLUGIN_DIR = dirname(MCP_DIR);

async function sendRpc(server, messages, msg) {
  const before = messages.length;
  await server.receive(JSON.stringify(msg));
  // Async tool/resource handlers resolve on microtasks; flush once.
  for (let i = 0; i < 10 && messages.length === before; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return messages.slice(before).map((line) => JSON.parse(line));
}

describe('Usage Monitor MCP App server', () => {
  it('completes initialize and ping handshakes', async () => {
    const out = [];
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async () => ({ status: 200, body: '{}' }),
      readDashboardHtml: async () => '<html></html>',
    });

    const [init] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} });
    assert.deepEqual(init.result.serverInfo, {
      name: 'usage-monitor',
      version: SERVER_VERSION,
    });

    const [pong] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    });
    assert.deepEqual(pong.result, {});
  });

  it('exposes global-only entrypoint on usage_monitor_dashboard and app-only visibility on usage_monitor_api', async () => {
    const out = [];
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async () => ({ status: 200, body: '{}' }),
      readDashboardHtml: async () => '<html></html>',
    });

    const [listed] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const tools = listed.result.tools;
    assert.equal(tools.length, 2);

    const dashboard = tools.find((t) => t.name === 'usage_monitor_dashboard');
    assert.ok(dashboard);
    assert.deepEqual(dashboard.inputSchema.required, []);
    assert.equal(dashboard._meta.ui.resourceUri, DASHBOARD_URI);
    assert.deepEqual(dashboard._meta['com.google.antigravity/ui'].entrypoints, [
      { type: 'global', title: 'Usage Monitor' },
    ]);

    const api = tools.find((t) => t.name === 'usage_monitor_api');
    assert.ok(api);
    assert.deepEqual(api._meta.ui.visibility, ['app']);
  });

  it('lists and serves the ui:// dashboard resource with MCP App MIME type', async () => {
    const out = [];
    const fakeHtml = '<!DOCTYPE html><html data-mcp-app="true"><body>ok</body></html>';
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async () => ({ status: 200, body: '{}' }),
      readDashboardHtml: async () => fakeHtml,
    });

    const [listed] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/list',
    });
    assert.equal(listed.result.resources.length, 1);
    assert.equal(listed.result.resources[0].uri, DASHBOARD_URI);
    assert.equal(listed.result.resources[0].mimeType, DASHBOARD_MIME);
    assert.equal(listed.result.resources[0]._meta.ui.prefersBorder, false);

    const [read] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: DASHBOARD_URI },
    });
    assert.equal(read.result.contents[0].uri, DASHBOARD_URI);
    assert.equal(read.result.contents[0].mimeType, DASHBOARD_MIME);
    assert.equal(read.result.contents[0].text, fakeHtml);
  });

  it('answers usage_monitor_dashboard with concise summary and tiny structuredContent', async () => {
    const out = [];
    const calls = [];
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async (pathname, method, data) => {
        calls.push({ pathname, method, data });
        return {
          status: 200,
          body: JSON.stringify({
            activeConversation: {
              title: 'Refactor sidebar',
              totalTokens: 48200,
              stepCount: 6,
              sessionCostUsd: 0.12,
              latestTokPerSec: 84.5,
              latestTtftSec: 0.72,
              context: { totalTokens: 64000, compactionLimitTokens: 256000 },
            },
            quotas: {
              pools: [{ label: 'Gemini', remainingPct: 76 }],
            },
          }),
        };
      },
      readDashboardHtml: async () => '<html></html>',
    });

    const [reply] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'usage_monitor_dashboard', arguments: {} },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/api/telemetry');
    assert.equal(calls[0].method, 'GET');
    assert.deepEqual(reply.result.structuredContent, { surface: 'global' });
    const text = reply.result.content[0].text;
    assert.match(text, /Refactor sidebar/);
    assert.match(text, /48\.2k tokens/);
    assert.match(text, /\$0\.12/);
    assert.match(text, /84\.5 tok\/s/);
    assert.match(text, /context 25\.0%/);
    assert.match(text, /Gemini: 76% left/);
  });

  it('dispatches usage_monitor_api routes and rejects unsupported routes', async () => {
    const out = [];
    const calls = [];
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async (pathname, method, data) => {
        calls.push({ pathname, method, data });
        return { status: 200, body: JSON.stringify({ saved: true, echo: data }) };
      },
      readDashboardHtml: async () => '<html></html>',
    });

    const [getRes] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'usage_monitor_api',
        arguments: {
          path: '/api/telemetry',
          method: 'GET',
          query: { range: '7d', stepDetails: 'display' },
        },
      },
    });
    assert.equal(getRes.result.structuredContent.status, 200);
    assert.equal(getRes.result.structuredContent.ok, true);
    assert.deepEqual(calls[0], {
      pathname: '/api/telemetry',
      method: 'GET',
      data: { range: '7d', stepDetails: 'display' },
    });

    const [postRes] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'usage_monitor_api',
        arguments: {
          path: '/api/settings',
          method: 'POST',
          body: { language: 'pt-BR' },
        },
      },
    });
    assert.equal(postRes.result.structuredContent.status, 200);
    assert.deepEqual(calls[1], {
      pathname: '/api/settings',
      method: 'POST',
      data: { language: 'pt-BR' },
    });

    const [badRes] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'usage_monitor_api',
        arguments: { path: '/api/evil', method: 'GET' },
      },
    });
    assert.equal(badRes.result.isError, true);
    assert.equal(badRes.result.structuredContent.status, 404);
  });

  it('formats empty telemetry gracefully', () => {
    assert.match(formatDashboardSummary(null), /unavailable/i);
    assert.match(formatDashboardSummary({}), /No active session telemetry/i);
  });

  it('ships a portable mcp_config.json and a self-contained dashboard.html under 10 MiB', () => {
    const mcpConfigPath = join(PLUGIN_DIR, 'mcp_config.json');
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    const entry = mcpConfig.mcpServers['usage-monitor'];
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, ['${PLUGIN_ROOT}/mcp/main.mjs']);
    assert.equal(entry.env.USAGE_MONITOR_PLUGIN_DATA, '${PLUGIN_DATA}');

    const htmlPath = join(MCP_DIR, 'dist', 'dashboard.html');
    assert.ok(existsSync(htmlPath), 'mcp/dist/dashboard.html must exist (run build)');
    const html = readFileSync(htmlPath, 'utf8');
    const bytes = Buffer.byteLength(html, 'utf8');
    assert.ok(bytes > 10_000, 'dashboard.html should contain the bundled panel UI');
    assert.ok(bytes < 10 * 1024 * 1024, 'dashboard.html must stay under 10 MiB');
    assert.match(html, /data-mcp-app="true"/);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet["']/i);
  });
});
