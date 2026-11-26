import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DASHBOARD_MIME,
  DASHBOARD_URI,
  HEALTH_CARD_URI,
  SERVER_VERSION,
  createMcpServer,
  formatDashboardSummary,
  formatSessionHealthSummary,
} from '../mcp/server.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = dirname(TEST_DIR);
const MCP_DIR = join(PLUGIN_DIR, 'mcp');

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
  it('completes initialize and ping handshakes with v2.0.0', async () => {
    const out = [];
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async () => ({ status: 200, body: '{}' }),
      readDashboardHtml: async () => '<html></html>',
      readHealthCardHtml: async () => '<html></html>',
    });

    assert.equal(SERVER_VERSION, '2.0.0');

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
      version: '2.0.0',
    });

    const [pong] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    });
    assert.deepEqual(pong.result, {});
  });

  it('exposes dual aux_pane+global entrypoints on dashboard, inline-only session_health, and app-only api with /api/session-health', async () => {
    const out = [];
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async () => ({ status: 200, body: '{}' }),
      readDashboardHtml: async () => '<html></html>',
      readHealthCardHtml: async () => '<html></html>',
    });

    const [listed] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const tools = listed.result.tools;
    assert.equal(tools.length, 3);

    const dashboard = tools.find((t) => t.name === 'usage_monitor_dashboard');
    assert.ok(dashboard);
    assert.deepEqual(dashboard.inputSchema.required, []);
    assert.equal(dashboard.inputSchema.properties.conversationId.type, 'string');
    assert.deepEqual(dashboard.inputSchema.properties.tab.enum, [
      'overview',
      'consumption',
      'steps',
      'settings',
    ]);
    assert.equal(dashboard._meta.ui.resourceUri, DASHBOARD_URI);
    assert.deepEqual(dashboard._meta['com.google.antigravity/ui'].entrypoints, [
      { type: 'aux_pane', title: 'Usage Monitor' },
      { type: 'global', title: 'Usage Monitor' },
    ]);

    const health = tools.find((t) => t.name === 'usage_monitor_session_health');
    assert.ok(health);
    assert.deepEqual(health.inputSchema.required, []);
    assert.equal(health.inputSchema.properties.conversationId.type, 'string');
    assert.equal(health._meta.ui.resourceUri, HEALTH_CARD_URI);
    assert.equal(health._meta['com.google.antigravity/ui'], undefined);

    const api = tools.find((t) => t.name === 'usage_monitor_api');
    assert.ok(api);
    assert.deepEqual(api._meta.ui.visibility, ['app']);
    assert.ok(api.inputSchema.properties.path.enum.includes('/api/session-health'));
    assert.equal(api.inputSchema.properties.path.enum.includes('/api/context-window'), false);
  });

  it('lists and serves both ui:// dashboard and health-card resources with proper prefersBorder metadata', async () => {
    const out = [];
    const fakeDash = '<!DOCTYPE html><html data-mcp-app="true"><body>dash</body></html>';
    const fakeHealth = '<!DOCTYPE html><html data-mcp-app="true"><body>health</body></html>';
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async () => ({ status: 200, body: '{}' }),
      readDashboardHtml: async () => fakeDash,
      readHealthCardHtml: async () => fakeHealth,
    });

    const [listed] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/list',
    });
    assert.equal(listed.result.resources.length, 2);

    const dashRes = listed.result.resources.find((r) => r.uri === DASHBOARD_URI);
    const healthRes = listed.result.resources.find((r) => r.uri === HEALTH_CARD_URI);
    assert.ok(dashRes);
    assert.ok(healthRes);
    assert.equal(dashRes.mimeType, DASHBOARD_MIME);
    assert.equal(dashRes._meta.ui.prefersBorder, false);
    assert.equal(healthRes.mimeType, DASHBOARD_MIME);
    assert.equal(healthRes._meta.ui.prefersBorder, true);

    const [readDash] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: DASHBOARD_URI },
    });
    assert.equal(readDash.result.contents[0].uri, DASHBOARD_URI);
    assert.equal(readDash.result.contents[0].mimeType, DASHBOARD_MIME);
    assert.equal(readDash.result.contents[0].text, fakeDash);
    assert.equal(readDash.result.contents[0]._meta.ui.prefersBorder, false);

    const [readHealth] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: HEALTH_CARD_URI },
    });
    assert.equal(readHealth.result.contents[0].uri, HEALTH_CARD_URI);
    assert.equal(readHealth.result.contents[0].mimeType, DASHBOARD_MIME);
    assert.equal(readHealth.result.contents[0].text, fakeHealth);
    assert.equal(readHealth.result.contents[0]._meta.ui.prefersBorder, true);
  });

  it('keeps conversationId: null on {} launch and forwards explicit conversationId + tab when provided', async () => {
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
              cascadeId: 'conv-latest-1',
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
      readHealthCardHtml: async () => '<html></html>',
    });

    // Empty {} entrypoint launch must preserve auto-follow-latest mode (conversationId: null)
    const [replyEmpty] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'usage_monitor_dashboard', arguments: {} },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, '/api/telemetry');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].data.conversationId, undefined);
    assert.deepEqual(replyEmpty.result.structuredContent, {
      conversationId: null,
      tab: null,
    });
    const text = replyEmpty.result.content[0].text;
    assert.match(text, /Refactor sidebar/);
    assert.match(text, /48\.2k tokens/);
    assert.match(text, /\$0\.12/);
    assert.match(text, /84\.5 tok\/s/);
    assert.match(text, /context 25\.0%/);
    assert.match(text, /Gemini: 76% left/);

    // Explicit conversationId + tab navigation
    const [replyNav] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'usage_monitor_dashboard',
        arguments: { conversationId: 'conv-pin-9', tab: 'steps' },
      },
    });
    assert.equal(calls[1].data.conversationId, 'conv-pin-9');
    assert.deepEqual(replyNav.result.structuredContent, {
      conversationId: 'conv-pin-9',
      tab: 'steps',
    });

    // Invalid tab is sanitized to null
    const [replyBadTab] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'usage_monitor_dashboard',
        arguments: { tab: 'nonexistent' },
      },
    });
    assert.deepEqual(replyBadTab.result.structuredContent, {
      conversationId: null,
      tab: null,
    });
  });

  it('answers usage_monitor_session_health with structuredContent and concise plain-text summary', async () => {
    const out = [];
    const calls = [];
    const sampleHealthPayload = {
      generatedAtMs: 1_760_000_000_000,
      conversation: {
        cascadeId: 'conv-health-1',
        title: 'Debug cache collapse',
        status: 'IDLE',
        isRunning: false,
        stepCount: 18,
        totalStepsAllAgents: 18,
        subagentCount: 0,
        activeModelShort: 'carbon-4-high',
        activeModelLabel: 'Gemini 4 Carbon (High)',
      },
      context: {
        totalTokens: 162000,
        limitTokens: 256000,
        usedPct: 63.3,
        latestCacheHitPct: 24.0,
        sessionCacheHitPct: 48.5,
      },
      sessionHealth: {
        status: 'degraded',
        evaluatedSteps: 18,
        cacheHitPct: 48.5,
        cacheMissAttribution: {
          total: 7,
          eligibleTransitions: 15,
          planModeSwitch: 1,
          modelSwitch: 0,
          errorRetry: 1,
          idleOrWaitGap: 1,
          activeSlowGap: 2,
          asyncWakeupFast: 0,
          prefixOrReplicaMiss: 2,
          compactionResets: 0,
          contextDilutionTurns: 1,
          sustainedCollapse: { runs: 1, turns: 4, maxStreak: 4, activeStreak: 3 },
        },
        timing: {
          llmTimeSec: 84.2,
          toolExecTimeSec: 45.8,
          activeTimeSec: 130.0,
          llmSharePct: 64.8,
          toolSharePct: 35.2,
          totalOutputTokens: 15600,
          effectiveTps: 120.0,
          activeGapsTotal: 10,
          gapsOver60s: 3,
          over60sGapPct: 30.0,
          hasToolTimingTelemetry: true,
        },
        hygiene: {
          over150kTurns: 6,
          over150kRatioPct: 33.3,
          mediaTurns: 1,
          multimodalHighCtxTurns: 2,
          multimodalOver180kTurns: 0,
          toolTurns: 8,
          totalToolCalls: 10,
          singleToolTurns: 6,
          singleToolTurnPct: 75.0,
          avgToolsPerToolTurn: 1.3,
          hasToolBatchTelemetry: true,
        },
        findings: [
          {
            code: 'sustained_cache_collapse',
            severity: 'degraded',
            params: { runs: 1, turns: 4, maxStreak: 4, activeStreak: 3 },
          },
          {
            code: 'active_slow_gaps',
            severity: 'degraded',
            params: { gapsOver60s: 3, activeGapsTotal: 10, over60sGapPct: 30 },
          },
        ],
      },
    };

    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async (pathname, method, data) => {
        calls.push({ pathname, method, data });
        return { status: 200, body: JSON.stringify(sampleHealthPayload) };
      },
      readDashboardHtml: async () => '<html></html>',
      readHealthCardHtml: async () => '<html></html>',
    });

    const [reply] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'usage_monitor_session_health',
        arguments: { conversationId: 'conv-health-1' },
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      pathname: '/api/session-health',
      method: 'GET',
      data: { conversationId: 'conv-health-1' },
    });
    assert.deepEqual(reply.result.structuredContent, sampleHealthPayload);
    const summaryText = reply.result.content[0].text;
    assert.match(summaryText, /Session Health: DEGRADED/);
    assert.match(summaryText, /Debug cache collapse/);
    assert.match(summaryText, /48\.5% hit/);
    assert.match(summaryText, /active collapse 3x/);
    assert.match(summaryText, /Eff\. 120\.0 tok\/s/);
    assert.match(summaryText, /Gaps >60s: 3\/10/);
    assert.match(summaryText, /sustained_cache_collapse/);
    assert.match(formatSessionHealthSummary(null), /unavailable/i);
  });

  it('dispatches usage_monitor_api routes including /api/session-health and rejects unsupported routes', async () => {
    const out = [];
    const calls = [];
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async (pathname, method, data) => {
        calls.push({ pathname, method, data });
        return { status: 200, body: JSON.stringify({ saved: true, echo: data }) };
      },
      readDashboardHtml: async () => '<html></html>',
      readHealthCardHtml: async () => '<html></html>',
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

    const [healthApiRes] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'usage_monitor_api',
        arguments: {
          path: '/api/session-health',
          method: 'GET',
          query: { conversationId: 'conv-42' },
        },
      },
    });
    assert.equal(healthApiRes.result.structuredContent.status, 200);
    assert.equal(healthApiRes.result.structuredContent.ok, true);
    assert.deepEqual(calls[1], {
      pathname: '/api/session-health',
      method: 'GET',
      data: { conversationId: 'conv-42' },
    });

    const [postRes] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 3,
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
    assert.deepEqual(calls[2], {
      pathname: '/api/settings',
      method: 'POST',
      data: { language: 'pt-BR' },
    });

    const [badRes] = await sendRpc(srv, out, {
      jsonrpc: '2.0',
      id: 4,
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

  it('formats poolLabel, 5h, weekly-only, and unavailable pools accurately', () => {
    const summary = formatDashboardSummary({
      quotas: {
        pools: [
          { poolKey: 'Gemini', poolLabel: 'Gemini', remainingPct: 93.1, weeklyRemainingPct: 83.9 },
          { poolKey: 'Argon', poolLabel: 'Gemini 4 Argon', remainingPct: null, weeklyRemainingPct: 42 },
          { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', remainingPct: null, weeklyRemainingPct: null },
        ],
      },
    });
    assert.match(summary, /Gemini: 93% left \(5h\) · 84% left \(weekly\)/);
    assert.match(summary, /Gemini 4 Argon: 42% left \(weekly\)/);
    assert.match(summary, /Claude & GPT: unavailable/);
  });

  it('awaits async tools/call and resources/read promises from receive() so stdio EOF drains cleanly', async () => {
    const out = [];
    const srv = createMcpServer({
      write: (line) => out.push(line),
      dispatchApi: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return { status: 200, body: JSON.stringify({ ok: true }) };
      },
      readDashboardHtml: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return '<html>dash</html>';
      },
      readHealthCardHtml: async () => '<html>health</html>',
    });

    await srv.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/call',
        params: { name: 'usage_monitor_api', arguments: { path: '/api/telemetry', method: 'GET' } },
      })
    );
    await srv.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'resources/read',
        params: { uri: DASHBOARD_URI },
      })
    );
    assert.equal(out.length, 2, 'receive() must settle only after async responses are written');
    assert.equal(JSON.parse(out[0]).id, 100);
    assert.equal(JSON.parse(out[1]).id, 101);
  });

  it('ships portable mcp_config.json and self-contained dashboard.html + health-card.html under 10 MiB', () => {
    const mcpConfigPath = join(PLUGIN_DIR, 'mcp_config.json');
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    const entry = mcpConfig.mcpServers['usage-monitor'];
    assert.equal(entry.command, 'node');
    assert.deepEqual(entry.args, ['${PLUGIN_ROOT}/mcp/main.mjs']);
    assert.equal(entry.env.USAGE_MONITOR_PLUGIN_DATA, '${PLUGIN_DATA}');

    for (const [fileName, minBytes] of [
      ['dashboard.html', 10_000],
      ['health-card.html', 4_000],
    ]) {
      const htmlPath = join(MCP_DIR, 'dist', fileName);
      assert.ok(existsSync(htmlPath), `mcp/dist/${fileName} must exist (run build)`);
      const html = readFileSync(htmlPath, 'utf8');
      const bytes = Buffer.byteLength(html, 'utf8');
      assert.ok(bytes > minBytes, `${fileName} should contain bundled UI (${bytes} bytes)`);
      assert.ok(bytes < 10 * 1024 * 1024, `${fileName} must stay under 10 MiB`);
      assert.match(html, /data-mcp-app="true"/);
      assert.doesNotMatch(html, /<script[^>]+src=/i);
      assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet["']/i);
    }
  });
});
