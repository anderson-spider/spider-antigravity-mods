import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendHarness } from './backend-harness.mjs';
import {
  MEASUREMENT_VERSION,
  extractModelSteps,
} from '../backend/trajectory-metrics.mjs';
import {
  analyzeSessionHealth,
  mergeAgentSessionHealths,
  stripStepDiagnostics,
} from '../backend/session-health.mjs';
import { readLocalSqliteTrajectory } from '../backend/cli-sqlite-reader.mjs';
import { getNodeSqliteDatabaseSync } from '../backend/sqlite-client.mjs';
import {
  CURRENT_SETTINGS_SCHEMA_VERSION,
  DEFAULT_OVERVIEW_MODULES,
  mergeSettingsPatch,
  normalizeFullSettings,
} from '../shared/settings-normalization.mjs';
import {
  applyCliStatusLineToSettingsObject,
  formatCliStatusLineCapsule,
  isManagedCliStatusLineCommand,
} from '../cli/statusline-config.mjs';

function makeStep(overrides = {}) {
  return {
    stepIndex: 0,
    isCompactionStep: false,
    modelKey: 'MODEL_PLACEHOLDER_M37',
    responseModel: 'gemini-4-carbon-high',
    createdAtMs: Date.parse('2026-11-20T10:00:00Z'),
    inputTokens: 2000,
    cacheReadTokens: 18000,
    outputTokens: 400,
    totalDurationSec: 4,
    hasToolCalls: true,
    toolCallCount: 2,
    hasBlockingTool: false,
    hasPlanModeSwitch: false,
    hadSystemMessageBetween: false,
    toolStageSec: 2,
    isTurnStart: false,
    turnHasMedia: false,
    ...overrides,
  };
}

test('extractModelSteps keeps MEASUREMENT_VERSION=4 and extracts toolCallCount, blocking, plan-mode latch, system-msg flag, and toolStageSec', () => {
  assert.equal(MEASUREMENT_VERSION, 4);

  const rawSteps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      userInput: { userResponse: 'Plan and implement feature' },
      metadata: { createdAt: '2026-11-20T10:00:00Z' },
    },
    // Step 1: calls enter_plan_mode (arms plan-mode latch for NEXT step, not itself!)
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        toolCalls: [{ id: 'tc-1', name: 'default_api:enter_plan_mode' }],
      },
      metadata: {
        createdAt: '2026-11-20T10:00:01Z',
        finishedGeneratingAt: '2026-11-20T10:00:04Z',
        sourceTrajectoryStepInfo: { stepIndex: 1 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '20000', outputTokens: '200' },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_TOOL',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-20T10:00:04Z', completedAt: '2026-11-20T10:00:06Z' },
    },
    // Step 2: receives hasPlanModeSwitch=true from step 1's enter_plan_mode, calls 2 non-blocking tools
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        toolCalls: [
          { id: 'tc-2', name: 'read_file' },
          { id: 'tc-3', name: 'grep_search' },
        ],
      },
      metadata: {
        createdAt: '2026-11-20T10:00:07Z',
        finishedGeneratingAt: '2026-11-20T10:00:10Z',
        sourceTrajectoryStepInfo: { stepIndex: 3 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '22000', outputTokens: '300' },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_TOOL',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-20T10:00:10Z', completedAt: '2026-11-20T10:00:14Z' },
    },
    // Step 3: latch cleared, calls blocking tool ask_question (toolStageSec must be null)
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        toolCalls: [{ id: 'tc-4', name: 'default_api:ask_question' }],
      },
      metadata: {
        createdAt: '2026-11-20T10:00:15Z',
        finishedGeneratingAt: '2026-11-20T10:00:18Z',
        sourceTrajectoryStepInfo: { stepIndex: 5 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '5000', cacheReadTokens: '20000', outputTokens: '150' },
      },
    },
    // SYSTEM_MESSAGE with plan mode notice leading into step 4
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      systemMessage: { message: 'Plan mode is off: proceeding to execution' },
      metadata: { createdAt: '2026-11-20T10:00:25Z' },
    },
    // Step 4: hasPlanModeSwitch=true + hadSystemMessageBetween=true; no tool calls
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: 'Executing now' },
      metadata: {
        createdAt: '2026-11-20T10:00:26Z',
        finishedGeneratingAt: '2026-11-20T10:00:30Z',
        sourceTrajectoryStepInfo: { stepIndex: 7 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '25000', outputTokens: '400' },
      },
    },
    // Step 5: latch must NOT leak from step 4
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: 'Done' },
      metadata: {
        createdAt: '2026-11-20T10:00:31Z',
        finishedGeneratingAt: '2026-11-20T10:00:34Z',
        sourceTrajectoryStepInfo: { stepIndex: 8 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '1000', cacheReadTokens: '25000', outputTokens: '200' },
      },
    },
  ];

  const steps = extractModelSteps(rawSteps, []);
  assert.equal(steps.length, 5);

  assert.equal(steps[0].toolCallCount, 1);
  assert.equal(steps[0].hasBlockingTool, false);
  assert.equal(steps[0].hasPlanModeSwitch, false);
  assert.equal(steps[0].hadSystemMessageBetween, false);
  assert.equal(steps[0].toolStageSec, 3); // 10:00:04 -> 10:00:07 (next model step)

  assert.equal(steps[1].toolCallCount, 2);
  assert.equal(steps[1].hasBlockingTool, false);
  assert.equal(steps[1].hasPlanModeSwitch, true);
  assert.equal(steps[1].toolStageSec, 5); // 10:00:10 -> 10:00:15

  assert.equal(steps[2].toolCallCount, 1);
  assert.equal(steps[2].hasBlockingTool, true);
  assert.equal(steps[2].hasPlanModeSwitch, false);
  assert.equal(steps[2].toolStageSec, null);

  assert.equal(steps[3].toolCallCount, 0);
  assert.equal(steps[3].hasPlanModeSwitch, true);
  assert.equal(steps[3].hadSystemMessageBetween, true);
  assert.equal(steps[3].toolStageSec, null);

  assert.equal(steps[4].hasPlanModeSwitch, false);
  assert.equal(steps[4].hadSystemMessageBetween, false);
});

test('analyzeSessionHealth classifies all 9 CacheMissReason categories, sustained collapse, timing, gaps > 60s, and hygiene', () => {
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  const steps = [
    // Step 0: baseline 20k prompt, media turn
    makeStep({ stepIndex: 0, createdAtMs: t0, inputTokens: 20000, cacheReadTokens: 0, isTurnStart: true, turnHasMedia: true, toolCallCount: 1 }),
    // Step 1: plan_mode_switch miss (streak 1)
    makeStep({ stepIndex: 1, createdAtMs: t0 + 10_000, inputTokens: 20000, cacheReadTokens: 2000, hasPlanModeSwitch: true, toolCallCount: 1 }),
    // Step 2: model_switch miss (streak 2)
    makeStep({ stepIndex: 2, createdAtMs: t0 + 20_000, modelKey: 'MODEL_PLACEHOLDER_M42', responseModel: 'gemini-3.8-flash', inputTokens: 20000, cacheReadTokens: 2000, toolCallCount: 1 }),
    // Step 3: 0-token error step latches prevHadError without breaking prevPromptTok
    makeStep({ stepIndex: 3, createdAtMs: t0 + 25_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, anomaly: { primaryKind: 'rate_limit', severity: 'warn', count: 1 } }),
    // Step 4: error_retry miss (streak 3 -> sustained collapse!)
    makeStep({ stepIndex: 4, createdAtMs: t0 + 35_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 20000, cacheReadTokens: 2000, toolCallCount: 1 }),
    // Step 5: active_slow_gap (>=60s after non-blocking tool call, not turn start) (streak 4)
    makeStep({ stepIndex: 5, createdAtMs: t0 + 115_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 20000, cacheReadTokens: 2000, hasBlockingTool: true, toolCallCount: 1 }),
    // Step 6: idle_or_wait_gap (>=60s after blocking tool) (streak 5)
    makeStep({ stepIndex: 6, createdAtMs: t0 + 200_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 20000, cacheReadTokens: 2000, hasToolCalls: false, toolCallCount: 0 }),
    // Step 7: async_wakeup_fast (!prevHadCalls && hadSystemMessageBetween, <60s) (streak 6)
    makeStep({ stepIndex: 7, createdAtMs: t0 + 215_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 20000, cacheReadTokens: 2000, hadSystemMessageBetween: true, toolCallCount: 1 }),
    // Step 8: prefix_or_replica_miss (streak 7)
    makeStep({ stepIndex: 8, createdAtMs: t0 + 225_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 20000, cacheReadTokens: 2000, toolCallCount: 1 }),
    // Step 9: context_dilution (prev=22k, cur=60k, cache=18k -> hitRate=30% < 50%, retained=18k/22k=81.8% >= 75%) -> flushes streak of 7!
    makeStep({ stepIndex: 9, createdAtMs: t0 + 235_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 42000, cacheReadTokens: 18000, toolCallCount: 1 }),
    // Step 10: high context + active media (>= 180k) with good cache hit
    makeStep({ stepIndex: 10, createdAtMs: t0 + 245_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 20000, cacheReadTokens: 170000, toolCallCount: 3 }),
    // Step 11: explicit compaction resets prevPromptTok & hasActiveMedia
    makeStep({ stepIndex: 11, createdAtMs: t0 + 260_000, modelKey: 'MODEL_PLACEHOLDER_M42', isCompactionStep: true, inputTokens: 5000, cacheReadTokens: 170000, outputTokens: 1000 }),
    // Step 12: post-compaction step (must NOT be double-counted as compaction or multimodal high-ctx!)
    makeStep({ stepIndex: 12, createdAtMs: t0 + 275_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 35000, cacheReadTokens: 0, toolCallCount: 2 }),
    // Step 13: implicit compaction drop (< 0.78 * 35k = 27.3k)
    makeStep({ stepIndex: 13, createdAtMs: t0 + 285_000, modelKey: 'MODEL_PLACEHOLDER_M42', inputTokens: 15000, cacheReadTokens: 0, toolCallCount: 2 }),
  ];

  const health = analyzeSessionHealth(steps);
  assert.equal(health.status, 'degraded');
  assert.equal(health.evaluatedSteps, 12); // excludes 0-token step 3 and compaction step 11

  const attr = health.cacheMissAttribution;
  assert.equal(attr.planModeSwitch, 1);
  assert.equal(attr.modelSwitch, 1);
  assert.equal(attr.errorRetry, 1);
  assert.equal(attr.activeSlowGap, 1);
  assert.equal(attr.idleOrWaitGap, 1);
  assert.equal(attr.asyncWakeupFast, 1);
  assert.equal(attr.prefixOrReplicaMiss, 1);
  assert.equal(attr.total, 7);
  assert.equal(attr.contextDilutionTurns, 1);
  assert.equal(attr.compactionResets, 2); // explicit step 11 + implicit step 13
  assert.deepEqual(attr.sustainedCollapse, {
    runs: 1,
    turns: 7,
    maxStreak: 7,
    activeStreak: 0,
  });

  // Verify stepDiagnosticsByIndex
  assert.equal(health.stepDiagnosticsByIndex[1].cacheMissReason, 'plan_mode_switch');
  assert.equal(health.stepDiagnosticsByIndex[2].cacheMissReason, 'model_switch');
  assert.equal(health.stepDiagnosticsByIndex[4].cacheMissReason, 'error_retry');
  assert.equal(health.stepDiagnosticsByIndex[5].cacheMissReason, 'active_slow_gap');
  assert.equal(health.stepDiagnosticsByIndex[5].isOver60sGap, true);
  assert.equal(health.stepDiagnosticsByIndex[6].cacheMissReason, 'idle_or_wait_gap');
  assert.equal(health.stepDiagnosticsByIndex[6].isOver60sGap, false);
  assert.equal(health.stepDiagnosticsByIndex[7].cacheMissReason, 'async_wakeup_fast');
  assert.equal(health.stepDiagnosticsByIndex[8].cacheMissReason, 'prefix_or_replica_miss');
  assert.equal(health.stepDiagnosticsByIndex[9].cacheMissReason, 'context_dilution');
  assert.equal(health.stepDiagnosticsByIndex[11].cacheMissReason, 'compaction');
  assert.equal(health.stepDiagnosticsByIndex[12].cacheMissReason, null);
  assert.equal(health.stepDiagnosticsByIndex[13].cacheMissReason, 'compaction');

  // Verify hygiene
  assert.equal(health.hygiene.mediaTurns, 1);
  assert.equal(health.hygiene.over150kTurns, 1);
  assert.equal(health.hygiene.multimodalHighCtxTurns, 1);
  assert.equal(health.hygiene.multimodalOver180kTurns, 1);
  assert.equal(health.hygiene.hasToolBatchTelemetry, true);
  assert.equal(health.timing.hasToolTimingTelemetry, true);
  assert.equal(health.timing.gapsOver60s, 1);
  assert.ok(health.timing.effectiveTps > 0);
  assert.ok(health.findings.length > 0 && health.findings.length <= 5);
  assert.equal(health.findings[0].severity, 'degraded');
});

test('analyzeSessionHealth handles empty sessions and degrades gracefully for legacy v4 cached steps', () => {
  const empty = analyzeSessionHealth([]);
  assert.equal(empty.status, 'healthy');
  assert.equal(empty.evaluatedSteps, 0);
  assert.equal(empty.cacheHitPct, 0);
  assert.equal(empty.timing.effectiveTps, null);
  assert.equal(empty.hygiene.singleToolTurnPct, null);
  assert.equal(empty.hygiene.avgToolsPerToolTurn, null);
  assert.deepEqual(empty.findings, []);

  // Legacy v4 steps missing toolCallCount, hasBlockingTool, hasPlanModeSwitch, hadSystemMessageBetween, toolStageSec
  const t0 = Date.parse('2026-11-20T12:00:00Z');
  const legacySteps = [
    {
      stepIndex: 0,
      isCompactionStep: false,
      modelKey: 'MODEL_PLACEHOLDER_M37',
      createdAtMs: t0,
      inputTokens: 20000,
      cacheReadTokens: 0,
      outputTokens: 500,
      totalDurationSec: 5,
      hasToolCalls: true,
      isTurnStart: true,
    },
    {
      stepIndex: 1,
      isCompactionStep: false,
      modelKey: 'MODEL_PLACEHOLDER_M37',
      createdAtMs: t0 + 10_000,
      inputTokens: 2000,
      cacheReadTokens: 18000,
      outputTokens: 500,
      totalDurationSec: 5,
      hasToolCalls: true,
      isTurnStart: false,
    },
  ];
  const h = analyzeSessionHealth(legacySteps);
  assert.equal(h.status, 'healthy');
  assert.equal(h.timing.hasToolTimingTelemetry, false);
  assert.equal(h.hygiene.hasToolBatchTelemetry, false);
  assert.equal(h.timing.llmTimeSec, 10);
  assert.equal(h.timing.toolExecTimeSec, 0);
  assert.equal(h.timing.effectiveTps, 100);
});

test('mergeAgentSessionHealths sums totals, takes max streaks, and excludes side questions in telemetry-builder + /api/session-health', async () => {
  const t0 = Date.parse('2026-11-20T14:00:00Z');
  const a1 = analyzeSessionHealth([
    makeStep({ stepIndex: 0, createdAtMs: t0, inputTokens: 20000, cacheReadTokens: 0, outputTokens: 200, totalDurationSec: 2, toolStageSec: 2 }),
    makeStep({ stepIndex: 1, createdAtMs: t0 + 6000, inputTokens: 2000, cacheReadTokens: 18000, outputTokens: 200, totalDurationSec: 2, toolStageSec: 2 }),
  ]);
  const a2 = analyzeSessionHealth([
    makeStep({ stepIndex: 0, createdAtMs: t0, inputTokens: 20000, cacheReadTokens: 0, outputTokens: 400, totalDurationSec: 4, toolStageSec: 4 }),
    makeStep({ stepIndex: 1, createdAtMs: t0 + 10000, inputTokens: 20000, cacheReadTokens: 1000, outputTokens: 400, totalDurationSec: 4, toolStageSec: 0 }),
    makeStep({ stepIndex: 2, createdAtMs: t0 + 16000, inputTokens: 20000, cacheReadTokens: 1000, outputTokens: 400, totalDurationSec: 4, toolStageSec: 0 }),
    makeStep({ stepIndex: 3, createdAtMs: t0 + 22000, inputTokens: 20000, cacheReadTokens: 1000, outputTokens: 400, totalDurationSec: 4, toolStageSec: 0 }),
  ]);
  const merged = mergeAgentSessionHealths([a1, a2]);
  assert.equal(merged.evaluatedSteps, 6);
  assert.equal(merged.status, 'degraded');
  assert.equal(merged.cacheMissAttribution.sustainedCollapse.activeStreak, 3);
  assert.equal(merged.cacheMissAttribution.sustainedCollapse.maxStreak, 3);
  assert.equal(merged.timing.totalOutputTokens, 2000);
  assert.equal(merged.stepDiagnosticsByIndex, undefined);

  // Full backend harness integration: /api/session-health + display projection + side-question exclusion
  const mainCid = '11111111-2222-4333-8444-555555555555';
  const subCid = '22222222-2222-4333-8444-555555555555';
  const h = backendHarness({
    summaries: {
      [mainCid]: { summary: 'Health Integration', stepCount: 3, lastModifiedTime: '2026-11-20T14:01:00Z', status: 'IDLE' },
      [subCid]: { summary: 'Sub Worker', stepCount: 2, lastModifiedTime: '2026-11-20T14:00:50Z', status: 'IDLE' },
    },
    trajectories: {
      [mainCid]: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_USER_INPUT',
              userInput: { userResponse: 'Run health test' },
              metadata: { createdAt: '2026-11-20T14:00:00Z' },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: {
                toolCalls: [{ id: 't1', name: 'invoke_subagent' }],
              },
              metadata: {
                createdAt: '2026-11-20T14:00:01Z',
                finishedGeneratingAt: '2026-11-20T14:00:04Z',
                modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '20000', outputTokens: '300' },
              },
            },
            {
              type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
              invokeSubagent: { conversationId: subCid, subagentSpec: { name: 'helper' } },
              metadata: { createdAt: '2026-11-20T14:00:05Z', completedAt: '2026-11-20T14:00:10Z' },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { response: 'All done' },
              metadata: {
                createdAt: '2026-11-20T14:00:11Z',
                finishedGeneratingAt: '2026-11-20T14:00:14Z',
                modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '1000', cacheReadTokens: '20000', outputTokens: '200' },
              },
            },
          ],
        },
      },
      [subCid]: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { response: 'Sub done' },
              metadata: {
                createdAt: '2026-11-20T14:00:06Z',
                finishedGeneratingAt: '2026-11-20T14:00:09Z',
                modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '15000', outputTokens: '150' },
              },
            },
          ],
        },
      },
    },
  });

  // Verify display projection preserves cacheMissReason, gapSec, isOver60sGap, toolCallCount
  const dispRes = await h.dispatchBridgeApiRequest('/api/telemetry', 'GET', {
    conversationId: mainCid,
    stepDetails: 'display',
  });
  assert.equal(dispRes.status, 200);
  const dispBody = JSON.parse(dispRes.body);
  assert.equal(dispBody.activeConversation.sessionHealth.stepDiagnosticsByIndex, undefined);
  assert.equal(dispBody.activeConversation.aggregated.sessionHealth.evaluatedSteps, 3);
  const projectedStep = dispBody.activeConversation.recentSteps[0];
  assert.ok('cacheMissReason' in projectedStep);
  assert.ok('gapSec' in projectedStep);
  assert.ok('isOver60sGap' in projectedStep);
  assert.ok('toolCallCount' in projectedStep);

  // Verify /api/session-health compact contract
  const healthRes = await h.dispatchBridgeApiRequest('/api/session-health', 'GET', {
    conversationId: mainCid,
  });
  assert.equal(healthRes.status, 200);
  const healthBody = JSON.parse(healthRes.body);
  assert.ok(healthBody.generatedAtMs > 0);
  assert.equal(healthBody.conversation.cascadeId, mainCid);
  assert.equal(healthBody.conversation.subagentCount, 1);
  assert.equal(healthBody.sessionHealth.evaluatedSteps, 3);
  assert.equal(healthBody.mainSessionHealth.evaluatedSteps, 2);
  assert.equal(
    healthBody.context.sessionCacheHitPct,
    dispBody.activeConversation.aggregated.sessionCacheHitPct
  );
  assert.ok(Buffer.byteLength(healthRes.body, 'utf8') < 64 * 1024);

  // Regression: stripStepDiagnostics preserves exact token-weighted cacheHitPct in mergeAgentSessionHealths
  const strippedHeavy = stripStepDiagnostics(
    analyzeSessionHealth([
      makeStep({ stepIndex: 0, createdAtMs: t0, inputTokens: 0, cacheReadTokens: 100_000, outputTokens: 100 }),
    ])
  );
  const strippedLight = stripStepDiagnostics(
    analyzeSessionHealth([
      makeStep({ stepIndex: 0, createdAtMs: t0, inputTokens: 20_000, cacheReadTokens: 0, outputTokens: 100 }),
    ])
  );
  assert.equal(strippedHeavy.stepDiagnosticsByIndex, undefined);
  const weightedMerged = mergeAgentSessionHealths([strippedHeavy, strippedLight]);
  // Exact token-weighted: 100k / 120k = 83.3% (NOT unweighted 50.0%)
  assert.equal(weightedMerged.cacheHitPct, 83.3);

  // Regression: speedReason === 'error' / 'interrupted' without step.anomaly attributes error_retry
  const speedReasonErrHealth = analyzeSessionHealth([
    makeStep({ stepIndex: 0, createdAtMs: t0, inputTokens: 20_000, cacheReadTokens: 0 }),
    makeStep({ stepIndex: 1, createdAtMs: t0 + 5_000, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, speedReason: 'error' }),
    makeStep({ stepIndex: 2, createdAtMs: t0 + 10_000, inputTokens: 20_000, cacheReadTokens: 1000 }),
    makeStep({ stepIndex: 3, createdAtMs: t0 + 15_000, inputTokens: 20_000, cacheReadTokens: 1000, speedReason: 'interrupted' }),
  ]);
  assert.equal(speedReasonErrHealth.cacheMissAttribution.errorRetry, 2);
  assert.equal(speedReasonErrHealth.stepDiagnosticsByIndex[2].cacheMissReason, 'error_retry');
  assert.equal(speedReasonErrHealth.stepDiagnosticsByIndex[3].cacheMissReason, 'error_retry');
});

test('settingsSchemaVersion v1->v2 one-time migration inserts session_health once and respects v2 user removal', () => {
  assert.equal(CURRENT_SETTINGS_SCHEMA_VERSION, 2);
  assert.deepEqual([...DEFAULT_OVERVIEW_MODULES], [
    'metrics',
    'session_health',
    'context',
    'quotas',
    'live_tasks',
  ]);

  // Legacy v1 settings (no settingsSchemaVersion) with metrics present -> inserted right after metrics
  const migratedAfterMetrics = normalizeFullSettings({
    overviewModules: ['metrics', 'context', 'quotas', 'live_tasks'],
  });
  assert.equal(migratedAfterMetrics.settingsSchemaVersion, 2);
  assert.deepEqual(migratedAfterMetrics.overviewModules, [
    'metrics',
    'session_health',
    'context',
    'quotas',
    'live_tasks',
  ]);

  // Legacy v1 settings without metrics -> inserted at index 0
  const migratedNoMetrics = normalizeFullSettings({
    overviewModules: ['context', 'quotas'],
  });
  assert.deepEqual(migratedNoMetrics.overviewModules, ['session_health', 'context', 'quotas']);

  // User in v2 explicitly removes session_health -> stays removed across patch and reload
  const removedInV2 = mergeSettingsPatch(migratedAfterMetrics, {
    overviewModules: ['metrics', 'context', 'quotas'],
  });
  assert.equal(removedInV2.settingsSchemaVersion, 2);
  assert.deepEqual(removedInV2.overviewModules, ['metrics', 'context', 'quotas']);
  const reloadedV2 = normalizeFullSettings(removedInV2);
  assert.deepEqual(reloadedV2.overviewModules, ['metrics', 'context', 'quotas']);
});

test('CLI statusLine renders cache collapse alert ONLY at activeStreak >= 3 and migrates legacy sidecars/panel/cli-statusline.mjs', () => {
  const barNoAlert = formatCliStatusLineCapsule(
    { hasTelemetry: true, tps: 50, ttft: 1.2, usedPct: 30, cacheCollapseStreak: 2 },
    { slots: ['tps', 'ttft', 'context'], color: false }
  );
  assert.equal(barNoAlert.includes('cache ×'), false);

  const barAlert = formatCliStatusLineCapsule(
    { hasTelemetry: true, tps: 50, ttft: 1.2, usedPct: 30, cacheCollapseStreak: 4 },
    { slots: ['tps', 'ttft', 'context'], color: false }
  );
  assert.match(barAlert, /⚠ cache ×4/);

  const legacyCmd = 'node "/Users/dev/.gemini/config/plugins/usage-monitor/sidecars/panel/cli-statusline.mjs"';
  const newCmd = 'node "/Users/dev/.gemini/config/plugins/usage-monitor/cli/statusline.mjs"';
  assert.equal(isManagedCliStatusLineCommand(legacyCmd), true);
  assert.equal(isManagedCliStatusLineCommand(newCmd), true);
  assert.equal(isManagedCliStatusLineCommand('node "/opt/custom/statusline.mjs"'), false);

  const migrated = applyCliStatusLineToSettingsObject(
    { statusLine: { type: 'command', command: legacyCmd, enabled: true, padding: 0, stack_with_default: false } },
    { enabled: true, command: newCmd }
  );
  assert.equal(migrated.changed, true);
  assert.equal(migrated.object.statusLine.command, newCmd);
});

test('cli-sqlite-reader decodes step_type=101 SYSTEM_MESSAGE plan-mode notices on root trajectories', (t) => {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) {
    t.skip('node:sqlite is unavailable in this Node runtime');
    return;
  }

  const encodeVarint = (val) => {
    let v = BigInt(val);
    const out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return Buffer.from(out);
  };
  const encodeFieldBytes = (fieldNo, buf) =>
    Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(buf.length), buf]);

  const tempDir = mkdtempSync(join(tmpdir(), 'um-sqlite-sysmsg-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = join(tempDir, 'root-conv.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)').run('root-conv', 'root-conv', 0, 1);

  // SYSTEM_MESSAGE protobuf: field 114 -> SystemMessage { field 1: message }
  const sysMsgInner = encodeFieldBytes(1, Buffer.from('Plan mode is on: read-only mode', 'utf8'));
  const sysPayload = encodeFieldBytes(114, sysMsgInner);
  // Minimal metadata with createdAt (field 1: Timestamp { field 1: seconds })
  const tsBuf = Buffer.concat([encodeVarint((1 << 3) | 0), encodeVarint(1763632800)]);
  const metaBuf = encodeFieldBytes(1, tsBuf);

  db.prepare('INSERT INTO steps VALUES (0, 101, 2, ?, ?)').run(metaBuf, sysPayload);
  db.close();

  const traj = readLocalSqliteTrajectory(dbPath, { cascadeId: 'root-conv', isRunning: false });
  assert.ok(traj);
  assert.equal(traj.steps.length, 1);
  assert.equal(traj.steps[0].type, 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE');
  assert.match(traj.steps[0].systemMessage?.message || traj.steps[0].content || '', /Plan mode is on:/);
});
