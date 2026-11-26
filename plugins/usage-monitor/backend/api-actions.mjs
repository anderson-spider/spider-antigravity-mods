/**
 * @fileoverview Shared backend API route dispatcher for Usage & Speed Monitor
 * (used by the MCP App server and unit tests).
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BRIDGE_API_ROUTE_DEFS, LOCAL_ENDPOINT_ID } from '../shared/api-protocol.mjs';
import {
  clearRemoteEndpointCaches,
  resolveEndpointContext,
  trackEndpointRequestEnd,
  trackEndpointRequestStart,
} from './endpoint-registry.mjs';
import { clearScannerRuntimeMemos } from './local-scanner.mjs';
import {
  createDefaultSettingsObject,
  mergeSettingsPatch,
} from '../shared/settings-normalization.mjs';
import {
  SETTINGS_FILE,
  clearRuntimeCaches,
  inFlightRequests,
  isPlainObject,
  loadSettings,
  lsRuntimeEndpoint,
  saveJson,
} from './config.mjs';
import { ensureLsEndpointDiscovered } from './ls-discovery.mjs';
import { isTestRuntime } from './runtime-env.mjs';
import { analyzeSessionHealth } from './session-health.mjs';
import { buildTelemetryPayload, clearTelemetryBuilderMemo } from './telemetry-builder.mjs';
import { ensureCliStatusLineConfigured } from '../cli/statusline-config.mjs';

const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;

function sanitizePositiveFiniteMs(val) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 && num <= MAX_SAFE_DATE_MS ? Math.floor(num) : 0;
}

function projectDisplayStep(st) {
  const {
    stepIndex, createdAtMs, isCompactionStep, modelKey, modelShort, modelLabel,
    modelUpstream, responseModel, modelSource, tokPerSec, ttftSec, totalDurationSec,
    streamDurationSec, selectedSpeedReason, anomaly, anomalySig, contextTokens, inputTokens, cacheReadTokens,
    outputTokens, thinkingTokens, responseTokens, cacheHitPct, costUsd, inCostUsd,
    cacheCostUsd, outCostUsd, agentId, agentCascadeId, agentKind, agentOrdinal,
    agentCustomRole, agentLabel, agentBadge, agentRole, agentIndex, isSubagent,
    isSideQuestion, sideIndex, turnIndex, isTurnStart, isLatestTurn, turnPrompt,
    turnPromptClean, turnHasMedia, turnMediaOnly, rootTurnIndex, isRootTurnStart,
    isRootLatestTurn, rootTurnPrompt, rootTurnPromptClean, rootTurnHasMedia,
    rootTurnMediaOnly,
  } = st;
  return {
    stepIndex, createdAtMs, isCompactionStep, modelKey, modelShort, modelLabel,
    modelUpstream, responseModel, modelSource, tokPerSec, ttftSec, totalDurationSec,
    streamDurationSec, selectedSpeedReason,
    ...(anomaly ? { anomaly, anomalySig } : {}),
    contextTokens, inputTokens, cacheReadTokens,
    outputTokens, thinkingTokens, responseTokens, cacheHitPct, costUsd, inCostUsd,
    cacheCostUsd, outCostUsd, agentId, agentCascadeId, agentKind, agentOrdinal,
    agentCustomRole, agentLabel, agentBadge, agentRole, agentIndex, isSubagent,
    isSideQuestion, sideIndex, turnIndex, isTurnStart, isLatestTurn, turnPrompt,
    turnPromptClean, turnHasMedia, turnMediaOnly, rootTurnIndex, isRootTurnStart,
    isRootLatestTurn, rootTurnPrompt, rootTurnPromptClean, rootTurnHasMedia,
    rootTurnMediaOnly,
    cacheMissReason: st.cacheMissReason ?? null,
    gapSec: st.gapSec ?? null,
    isOver60sGap: Boolean(st.isOver60sGap),
    toolCallCount: typeof st.toolCallCount === 'number' ? st.toolCallCount : null,
  };
}

const MAX_DISPLAY_STEP_CACHE_ENTRIES = 16;
const displayStepsCache = new Map();
const displayStepFields = Object.keys(projectDisplayStep({ anomaly: true, anomalySig: '' })).filter(
  (k) => k !== 'anomaly'
);

function buildEndpointErrorResponse(epCtx) {
  return {
    status: Number(epCtx?.status || 400),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      error: epCtx?.error || 'Invalid endpointId',
      ...(epCtx?.retryable ? { retryable: true } : {}),
    }),
  };
}

function resolveActionEndpoint(data, opts) {
  const rawId =
    opts && opts.endpointId !== undefined
      ? opts.endpointId
      : isPlainObject(data) && data.endpointId !== undefined
        ? data.endpointId
        : undefined;
  return resolveEndpointContext(rawId);
}

function stripEndpointField(data) {
  if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, 'endpointId')) {
    return data;
  }
  const { endpointId: _ignored, ...rest } = data;
  return rest;
}

function haveSameDisplaySteps(previous, current) {
  if (!previous || !current) return previous === current;
  if (previous.length !== current.length) return false;
  for (let i = 0; i < current.length; i++) {
    const before = previous[i];
    const after = current[i];
    for (const key of displayStepFields) {
      if (before[key] !== after[key]) return false;
    }
  }
  return true;
}

function projectDisplayTelemetry(payload, requestedRevision) {
  const active = payload.activeConversation;
  const agents = active.agents;
  const endpointKey = payload.endpoint?.id || LOCAL_ENDPOINT_ID;
  const sourceSteps = [active.recentSteps, ...agents.map((agent) => agent.recentSteps)];
  let projected;
  let revision;
  if (typeof requestedRevision === 'string') {
    const cacheKey = `${endpointKey}::${active.cascadeId || '__empty__'}`;
    const scope = [
      endpointKey,
      payload.account?.status,
      payload.account?.email || payload.account?.name || '',
      active.cascadeId,
      ...agents.map((agent) => agent.agentId),
    ];
    const previous = displayStepsCache.get(cacheKey);
    if (previous && isDeepStrictEqual(scope, previous.scope) &&
        sourceSteps.every((steps, index) => (steps && previous.sources[index]?.deref() === steps) ||
          haveSameDisplaySteps(previous.steps[index], steps))) {
      ({ revision, steps: projected } = previous);
      previous.sources = sourceSteps.map((steps) => steps ? new WeakRef(steps) : undefined);
      displayStepsCache.delete(cacheKey);
      displayStepsCache.set(cacheKey, previous);
    } else {
      revision = randomUUID();
      projected = sourceSteps.map((steps) => steps?.map(projectDisplayStep));
      if (!displayStepsCache.has(cacheKey) && displayStepsCache.size >= MAX_DISPLAY_STEP_CACHE_ENTRIES) {
        displayStepsCache.delete(displayStepsCache.keys().next().value);
      }
      displayStepsCache.delete(cacheKey);
      displayStepsCache.set(cacheKey, {
        scope,
        steps: projected,
        revision,
        sources: sourceSteps.map((steps) => steps ? new WeakRef(steps) : undefined),
      });
    }
  }
  projected ||= sourceSteps.map((steps) => steps?.map(projectDisplayStep));
  const stepsUnchanged = revision !== undefined && requestedRevision === revision;
  return {
    ...payload,
    ...(revision ? { stepRevision: revision, stepsUnchanged } : {}),
    activeConversation: {
      ...active,
      recentSteps: stepsUnchanged ? undefined : projected[0],
      agents: agents.map((agent, index) => projected[index + 1]
        ? { ...agent, recentSteps: stepsUnchanged ? undefined : projected[index + 1] }
        : agent),
    },
  };
}

export async function executeTelemetryAction(data, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const isRemote = epCtx.isRemote;
  const rawConvId = String(
    data?.conversationId || (isRemote ? '' : process.env.ANTIGRAVITY_CONVERSATION_ID || '')
  ).trim();
  const convId = rawConvId && !/[\\/]|\.\./.test(rawConvId) ? rawConvId : '';
  const force = data?.force === '1' || data?.force === true;
  if (!isTestRuntime()) {
    if (!isRemote && !lsRuntimeEndpoint.baseUrl) {
      await ensureLsEndpointDiscovered({ force: false });
    }
  }
  const rawScope = String(data?.scope || '').trim();
  const scope =
    rawScope === 'consumption' ||
    rawScope === 'consumption-presets' ||
    rawScope === 'conversation'
      ? rawScope
      : '';
  const filterOpts = {
    range: data?.range || 'all',
    startMs: sanitizePositiveFiniteMs(data?.startMs),
    endMs: sanitizePositiveFiniteMs(data?.endMs),
    ...(scope ? { scope } : {}),
    endpoint: epCtx.endpoint,
  };
  let payload;
  trackEndpointRequestStart(epCtx.endpoint);
  try {
    payload = await buildTelemetryPayload(convId, force, filterOpts);
  } finally {
    trackEndpointRequestEnd(epCtx.endpoint);
  }
  const isScopedConsumptionPayload =
    payload?.scope === 'consumption' || payload?.scope === 'consumption-presets';
  const responsePayload =
    !isScopedConsumptionPayload && data?.stepDetails === 'display'
      ? projectDisplayTelemetry(payload, data.stepRevision)
      : payload;
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(responsePayload),
  };
}

export async function executeSessionHealthAction(data, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const isRemote = epCtx.isRemote;
  const rawConvId = String(
    data?.conversationId || (isRemote ? '' : process.env.ANTIGRAVITY_CONVERSATION_ID || '')
  ).trim();
  const convId = rawConvId && !/[\\/]|\.\./.test(rawConvId) ? rawConvId : '';
  const force = data?.force === '1' || data?.force === true;
  if (!isTestRuntime() && !isRemote && !lsRuntimeEndpoint.baseUrl) {
    await ensureLsEndpointDiscovered({ force: false });
  }
  let payload;
  trackEndpointRequestStart(epCtx.endpoint);
  try {
    payload = await buildTelemetryPayload(convId, force, {
      range: 'today',
      endpoint: epCtx.endpoint,
    });
  } finally {
    trackEndpointRequestEnd(epCtx.endpoint);
  }

  const active = payload?.activeConversation || {};
  const subagentCount = Number(active.subagentCount || 0);
  const hasSubs = subagentCount > 0;
  const ctxSource = (hasSubs ? active.aggregated?.context : null) || active.context || {};
  const totalTokens = Number(ctxSource.totalTokens || 0);
  const limitTokens = Number(ctxSource.compactionLimitTokens || ctxSource.limitTokens || 0);
  const usedPct =
    ctxSource.usedPct != null && Number.isFinite(Number(ctxSource.usedPct))
      ? +Number(ctxSource.usedPct).toFixed(1)
      : limitTokens > 0 && totalTokens > 0
        ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1))
        : 0;

  const fallbackEmptyHealth = () => {
    const { stepDiagnosticsByIndex: _ignored, ...empty } = analyzeSessionHealth([]);
    return empty;
  };
  const mainSessionHealth = active.sessionHealth || fallbackEmptyHealth();
  const sessionHealth = hasSubs
    ? active.aggregated?.sessionHealth || mainSessionHealth
    : mainSessionHealth;

  const responsePayload = {
    generatedAtMs: Date.now(),
    conversation: {
      cascadeId: String(active.cascadeId || ''),
      title: String(active.title || ''),
      status: String(active.status || 'IDLE'),
      isRunning: Boolean(active.isRunning),
      stepCount: Number(active.stepCount || 0),
      totalStepsAllAgents: Number(active.totalStepsAllAgents ?? active.stepCount ?? 0),
      subagentCount,
      activeModelShort: String(active.activeModelShort || ''),
      activeModelLabel: String(active.activeModelLabel || ''),
    },
    context: {
      totalTokens,
      limitTokens,
      usedPct,
      latestCacheHitPct:
        (hasSubs ? active.aggregated?.latestCacheHitPct : null) ??
        active.latestCacheHitPct ??
        null,
      sessionCacheHitPct:
        (hasSubs ? active.aggregated?.sessionCacheHitPct : null) ??
        active.sessionCacheHitPct ??
        null,
    },
    sessionHealth,
    ...(hasSubs ? { mainSessionHealth } : {}),
  };

  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(responsePayload),
  };
}

export function executeSettingsAction(data) {
  const current = loadSettings();
  const payload = isPlainObject(data) ? stripEndpointField(data) : {};
  const updated = mergeSettingsPatch(current, payload);
  if (!saveJson(SETTINGS_FILE, updated)) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to persist settings' }),
    };
  }
  const affectsBackendTelemetry =
    updated.weeklyLimitMode !== current.weeklyLimitMode ||
    updated.weeklyTokenBudget !== current.weeklyTokenBudget ||
    updated.weeklyCostBudget !== current.weeklyCostBudget;
  inFlightRequests.clear();
  if (affectsBackendTelemetry) {
    clearTelemetryBuilderMemo();
  }
  if ((updated.enableCliStatusLine !== false) !== (current.enableCliStatusLine !== false)) {
    ensureCliStatusLineConfigured({ enabled: updated.enableCliStatusLine !== false });
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    updated,
    body: JSON.stringify(updated),
  };
}

export function executeResetSettingsAction() {
  const current = loadSettings();
  const updated = createDefaultSettingsObject();
  if (!saveJson(SETTINGS_FILE, updated)) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to reset settings' }),
    };
  }
  inFlightRequests.clear();
  clearTelemetryBuilderMemo();
  if ((updated.enableCliStatusLine !== false) !== (current.enableCliStatusLine !== false)) {
    ensureCliStatusLineConfigured({ enabled: updated.enableCliStatusLine !== false });
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    updated,
    body: JSON.stringify(updated),
  };
}

export function executeRebuildCacheAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const ok = epCtx.isRemote
    ? clearRemoteEndpointCaches(epCtx.id)
    : clearRuntimeCaches();
  if (!ok) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to clear trajectory cache' }),
    };
  }
  const cachePrefix = `${epCtx.id}::`;
  for (const key of Array.from(displayStepsCache.keys())) {
    if (key.startsWith(cachePrefix)) {
      displayStepsCache.delete(key);
    }
  }
  clearScannerRuntimeMemos(epCtx.isRemote ? epCtx.id : null);
  clearTelemetryBuilderMemo(epCtx.id);
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: true, endpointId: epCtx.id, clearedAt: Date.now() }),
  };
}

const BRIDGE_ROUTE_LOOKUP = new Map(
  BRIDGE_API_ROUTE_DEFS.map((r) => [`${r.method}:${r.path}`, r.action])
);

export async function dispatchBridgeApiRequest(pathname, method, data, opts = undefined) {
  const action = BRIDGE_ROUTE_LOOKUP.get(`${String(method || '').toUpperCase()}:${pathname}`);
  switch (action) {
    case 'telemetry':
      return executeTelemetryAction(data, opts);
    case 'session_health':
      return executeSessionHealthAction(data, opts);
    case 'settings':
      return executeSettingsAction(data);
    case 'settings_reset':
      return executeResetSettingsAction();
    case 'cache_rebuild':
      return executeRebuildCacheAction(data, opts);
    default:
      return {
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not found' }),
      };
  }
}
