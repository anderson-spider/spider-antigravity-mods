/**
 * @fileoverview Pure offline Session Health diagnostics engine.
 *
 * Computes Prompt Cache Miss Attribution, sustained cache collapse detection,
 * active time decomposition (LLM vs. tools + Effective TPS), inter-step gaps > 60s,
 * context hygiene (150k+ pressure, multimodal high-context turns, tool batching),
 * and structured findings ready for UI rendering and plain-text summaries.
 *
 * Cache-miss attribution and active-time heuristics adapted from INK-Q/agy-fast
 * (`src/benchmark-core.ts`, MIT License, Copyright (c) 2026 agy-fast contributors).
 */

const MIN_CACHE_EVAL_PROMPT_TOKENS = 10_000;
const IMPLICIT_COMPACTION_MIN_PREV_TOKENS = 30_000;
const IMPLICIT_COMPACTION_DROP_RATIO = 0.78;
const CACHE_MISS_HIT_RATE_THRESHOLD = 0.5;
const CACHE_MISS_RETAINED_RATIO_THRESHOLD = 0.75;
const HIGH_CONTEXT_THRESHOLD = 150_000;
const CRITICAL_MULTIMODAL_CONTEXT_THRESHOLD = 180_000;
const MAX_STEP_STAGE_SEC = 600;
const MAX_ACTIVE_GAP_SEC = 3600;
const SLOW_GAP_THRESHOLD_SEC = 60;

const MISS_REASON_PRIORITY = Object.freeze([
  ['plan_mode_switch', 'planModeSwitch'],
  ['model_switch', 'modelSwitch'],
  ['error_retry', 'errorRetry'],
  ['active_slow_gap', 'activeSlowGap'],
  ['idle_or_wait_gap', 'idleOrWaitGap'],
  ['async_wakeup_fast', 'asyncWakeupFast'],
  ['prefix_or_replica_miss', 'prefixOrReplicaMiss'],
]);

const SEVERITY_ORDER = Object.freeze({
  degraded: 0,
  warn: 1,
  info: 2,
});

const rawHealthTotals = new WeakMap();

function round1(val) {
  return Number.isFinite(val) ? +val.toFixed(1) : 0;
}

function resolveComparableModelKey(step) {
  const key = String(step?.modelKey || '').trim();
  if (key && key !== 'unknown') return key;
  const resp = String(step?.responseModel || '').trim();
  return resp || '';
}

function pickTopMissReason(attr) {
  let topReason = 'prefix_or_replica_miss';
  let bestCount = 0;
  for (const [reasonKey, fieldName] of MISS_REASON_PRIORITY) {
    const count = Number(attr[fieldName] || 0);
    if (count > bestCount) {
      bestCount = count;
      topReason = reasonKey;
    }
  }
  return topReason;
}

function finalizeHealthSummary(acc, stepDiagnosticsByIndex) {
  const evaluatedSteps = acc.evaluatedSteps;
  const cacheHitPct =
    acc.largePromptSum > 0
      ? round1((acc.largeCacheSum / acc.largePromptSum) * 100)
      : acc.allPromptSum > 0
        ? round1((acc.allCacheSum / acc.allPromptSum) * 100)
        : 0;

  const missTotal =
    acc.planModeSwitch +
    acc.modelSwitch +
    acc.errorRetry +
    acc.idleOrWaitGap +
    acc.activeSlowGap +
    acc.asyncWakeupFast +
    acc.prefixOrReplicaMiss;

  const cacheMissAttribution = {
    total: missTotal,
    eligibleTransitions: acc.eligibleTransitions,
    planModeSwitch: acc.planModeSwitch,
    modelSwitch: acc.modelSwitch,
    errorRetry: acc.errorRetry,
    idleOrWaitGap: acc.idleOrWaitGap,
    activeSlowGap: acc.activeSlowGap,
    asyncWakeupFast: acc.asyncWakeupFast,
    prefixOrReplicaMiss: acc.prefixOrReplicaMiss,
    compactionResets: acc.compactionResets,
    contextDilutionTurns: acc.contextDilutionTurns,
    sustainedCollapse: {
      runs: acc.collapseRuns,
      turns: acc.collapseTurns,
      maxStreak: acc.maxStreak,
      activeStreak: acc.activeStreak,
    },
  };

  const llmTimeSec = round1(acc.rawLlmTimeSec);
  const toolExecTimeSec = round1(acc.rawToolExecTimeSec);
  const rawActiveTimeSec = acc.rawLlmTimeSec + acc.rawToolExecTimeSec;
  const activeTimeSec = round1(rawActiveTimeSec);
  const llmSharePct =
    rawActiveTimeSec > 0 ? round1((acc.rawLlmTimeSec / rawActiveTimeSec) * 100) : 0;
  const toolSharePct = rawActiveTimeSec > 0 ? +(100 - llmSharePct).toFixed(1) : 0;
  const effectiveTps =
    rawActiveTimeSec > 0 ? round1(acc.totalOutputTokens / rawActiveTimeSec) : null;
  const over60sGapPct =
    acc.activeGapsTotal > 0 ? round1((acc.gapsOver60s / acc.activeGapsTotal) * 100) : 0;

  const timing = {
    llmTimeSec,
    toolExecTimeSec,
    activeTimeSec,
    llmSharePct,
    toolSharePct,
    totalOutputTokens: acc.totalOutputTokens,
    effectiveTps,
    activeGapsTotal: acc.activeGapsTotal,
    gapsOver60s: acc.gapsOver60s,
    over60sGapPct,
    hasToolTimingTelemetry: acc.hasToolTimingTelemetry,
  };

  const over150kRatioPct =
    evaluatedSteps > 0 ? round1((acc.over150kTurns / evaluatedSteps) * 100) : 0;
  const singleToolTurnPct =
    acc.toolTurns > 0 ? round1((acc.singleToolTurns / acc.toolTurns) * 100) : null;
  const avgToolsPerToolTurn =
    acc.toolTurns > 0 ? round1(acc.totalToolCalls / acc.toolTurns) : null;

  const hygiene = {
    over150kTurns: acc.over150kTurns,
    over150kRatioPct,
    mediaTurns: acc.mediaTurns,
    multimodalHighCtxTurns: acc.multimodalHighCtxTurns,
    multimodalOver180kTurns: acc.multimodalOver180kTurns,
    toolTurns: acc.toolTurns,
    totalToolCalls: acc.totalToolCalls,
    singleToolTurns: acc.singleToolTurns,
    singleToolTurnPct,
    avgToolsPerToolTurn,
    hasToolBatchTelemetry: acc.hasToolBatchTelemetry,
  };

  const missRatio =
    acc.eligibleTransitions > 0 ? missTotal / acc.eligibleTransitions : 0;
  const missPct = round1(missRatio * 100);

  const isDegraded =
    acc.collapseRuns >= 1 ||
    acc.activeStreak >= 3 ||
    (acc.eligibleTransitions >= 4 && missRatio >= 0.4) ||
    (acc.activeGapsTotal >= 4 && over60sGapPct >= 25) ||
    acc.multimodalOver180kTurns >= 3;

  const isWarn =
    !isDegraded &&
    (acc.maxStreak === 2 ||
      acc.activeSlowGap >= 1 ||
      acc.prefixOrReplicaMiss >= 2 ||
      (acc.eligibleTransitions >= 3 && missRatio >= 0.2) ||
      acc.gapsOver60s >= 2 ||
      (acc.activeGapsTotal >= 4 && over60sGapPct >= 10) ||
      acc.multimodalHighCtxTurns >= 1 ||
      (evaluatedSteps >= 5 && over150kRatioPct >= 50) ||
      (acc.toolTurns >= 6 && singleToolTurnPct !== null && singleToolTurnPct >= 75));

  const status = isDegraded ? 'degraded' : isWarn ? 'warn' : 'healthy';

  const findings = [];

  if (acc.collapseRuns >= 1 || acc.activeStreak >= 3) {
    findings.push({
      code: 'sustained_cache_collapse',
      severity: 'degraded',
      params: {
        runs: acc.collapseRuns,
        turns: acc.collapseTurns,
        maxStreak: acc.maxStreak,
        activeStreak: acc.activeStreak,
      },
    });
  }

  if (acc.eligibleTransitions >= 4 && missRatio >= 0.4) {
    findings.push({
      code: 'high_cache_miss_rate',
      severity: 'degraded',
      params: {
        misses: missTotal,
        eligible: acc.eligibleTransitions,
        missPct,
        topReason: pickTopMissReason(cacheMissAttribution),
      },
    });
  } else if (acc.eligibleTransitions >= 3 && missRatio >= 0.2) {
    findings.push({
      code: 'high_cache_miss_rate',
      severity: 'warn',
      params: {
        misses: missTotal,
        eligible: acc.eligibleTransitions,
        missPct,
        topReason: pickTopMissReason(cacheMissAttribution),
      },
    });
  }

  if (acc.activeGapsTotal >= 4 && over60sGapPct >= 25) {
    findings.push({
      code: 'active_slow_gaps',
      severity: 'degraded',
      params: {
        gapsOver60s: acc.gapsOver60s,
        activeGapsTotal: acc.activeGapsTotal,
        over60sGapPct,
      },
    });
  } else if (acc.gapsOver60s >= 2 || (acc.activeGapsTotal >= 4 && over60sGapPct >= 10)) {
    findings.push({
      code: 'active_slow_gaps',
      severity: 'warn',
      params: {
        gapsOver60s: acc.gapsOver60s,
        activeGapsTotal: acc.activeGapsTotal,
        over60sGapPct,
      },
    });
  }

  if (acc.multimodalOver180kTurns >= 3) {
    findings.push({
      code: 'multimodal_high_context',
      severity: 'degraded',
      params: {
        turns150k: acc.multimodalHighCtxTurns,
        turns180k: acc.multimodalOver180kTurns,
        mediaTurns: acc.mediaTurns,
      },
    });
  } else if (acc.multimodalHighCtxTurns >= 1) {
    findings.push({
      code: 'multimodal_high_context',
      severity: 'warn',
      params: {
        turns150k: acc.multimodalHighCtxTurns,
        turns180k: acc.multimodalOver180kTurns,
        mediaTurns: acc.mediaTurns,
      },
    });
  }

  if (evaluatedSteps >= 5 && over150kRatioPct >= 50) {
    findings.push({
      code: 'high_context_pressure',
      severity: 'warn',
      params: {
        over150kTurns: acc.over150kTurns,
        evaluatedSteps,
        over150kRatioPct,
      },
    });
  }

  if (acc.toolTurns >= 6 && singleToolTurnPct !== null && singleToolTurnPct >= 75) {
    findings.push({
      code: 'low_tool_batching',
      severity: 'warn',
      params: {
        singleToolTurns: acc.singleToolTurns,
        toolTurns: acc.toolTurns,
        singleToolTurnPct,
        avgToolsPerToolTurn: avgToolsPerToolTurn ?? 0,
      },
    });
  }

  if (activeTimeSec >= 30 && toolSharePct >= 60) {
    findings.push({
      code: 'tool_time_dominant',
      severity: 'info',
      params: {
        toolSharePct,
        toolExecTimeSec,
        activeTimeSec,
      },
    });
  }

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  const summary = {
    status,
    evaluatedSteps,
    cacheHitPct,
    cacheMissAttribution,
    timing,
    hygiene,
    findings: findings.slice(0, 5),
    ...(stepDiagnosticsByIndex !== undefined ? { stepDiagnosticsByIndex } : {}),
  };

  rawHealthTotals.set(summary, {
    largePromptSum: acc.largePromptSum,
    largeCacheSum: acc.largeCacheSum,
    allPromptSum: acc.allPromptSum,
    allCacheSum: acc.allCacheSum,
    rawLlmTimeSec: acc.rawLlmTimeSec,
    rawToolExecTimeSec: acc.rawToolExecTimeSec,
  });

  return summary;
}

/**
 * Analyzes chronological model steps of a single agent trajectory and produces
 * Session Health metrics, findings, and per-step cache/gap diagnostics.
 *
 * @param {Array<object>} steps
 */
export function analyzeSessionHealth(steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const stepDiagnosticsByIndex = {};

  let evaluatedSteps = 0;
  let largePromptSum = 0;
  let largeCacheSum = 0;
  let allPromptSum = 0;
  let allCacheSum = 0;

  let eligibleTransitions = 0;
  let planModeSwitch = 0;
  let modelSwitch = 0;
  let errorRetry = 0;
  let idleOrWaitGap = 0;
  let activeSlowGap = 0;
  let asyncWakeupFast = 0;
  let prefixOrReplicaMiss = 0;
  let compactionResets = 0;
  let contextDilutionTurns = 0;

  let currentStreak = 0;
  let maxStreak = 0;
  let collapseRuns = 0;
  let collapseTurns = 0;

  let rawLlmTimeSec = 0;
  let rawToolExecTimeSec = 0;
  let totalOutputTokens = 0;
  let activeGapsTotal = 0;
  let gapsOver60s = 0;

  let over150kTurns = 0;
  let mediaTurns = 0;
  let multimodalHighCtxTurns = 0;
  let multimodalOver180kTurns = 0;
  let toolTurns = 0;
  let totalToolCalls = 0;
  let singleToolTurns = 0;

  let seenNumericToolCount = false;
  let seenLegacyToolCallsWithoutCount = false;
  let seenNumericToolStage = false;
  let seenToolStepWithoutStage = false;

  let prevPromptTok = null;
  let prevModel = '';
  let prevEndMs = 0;
  let prevHadCalls = false;
  let prevHadBlockingTool = false;
  let prevHadError = false;
  let hasActiveMedia = false;

  const flushStreak = () => {
    if (currentStreak >= 3) {
      collapseRuns += 1;
      collapseTurns += currentStreak;
    }
    currentStreak = 0;
  };

  for (const step of list) {
    if (!step || typeof step !== 'object') continue;

    const inTok = Math.max(0, Number(step.inputTokens || 0));
    const cacheTok = Math.max(0, Number(step.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(step.outputTokens || 0));
    const promptTok = inTok + cacheTok;

    const createdAtMs = Number(step.createdAtMs || 0);
    const totalDurSec = Number(step.totalDurationSec);
    const hasValidDur = Number.isFinite(totalDurSec) && totalDurSec > 0 && totalDurSec <= MAX_STEP_STAGE_SEC;
    const stepEndMs =
      createdAtMs > 0
        ? hasValidDur
          ? createdAtMs + totalDurSec * 1000
          : createdAtMs
        : 0;

    let gapSec = null;
    if (prevEndMs > 0 && createdAtMs > 0) {
      const rawGap = (createdAtMs - prevEndMs) / 1000;
      if (rawGap >= 0) {
        gapSec = +rawGap.toFixed(1);
      }
    }

    const stepHasNonCanceledError = Boolean(
      (step.anomaly && step.anomaly.primaryKind !== 'canceled') ||
        step.speedReason === 'error' ||
        step.speedReason === 'interrupted'
    );

    if (step.isCompactionStep) {
      compactionResets += 1;
      flushStreak();
      prevPromptTok = null;
      hasActiveMedia = false;
      prevHadCalls = false;
      prevHadBlockingTool = false;
      prevHadError = false;
      if (stepEndMs > 0) prevEndMs = stepEndMs;
      if (step.stepIndex !== undefined && step.stepIndex !== null) {
        stepDiagnosticsByIndex[step.stepIndex] = {
          cacheMissReason: 'compaction',
          gapSec,
          isOver60sGap: false,
        };
      }
      continue;
    }

    if (promptTok <= 0) {
      if (stepHasNonCanceledError) {
        prevHadError = true;
      }
      if (stepEndMs > 0) prevEndMs = stepEndMs;
      if (step.stepIndex !== undefined && step.stepIndex !== null) {
        stepDiagnosticsByIndex[step.stepIndex] = {
          cacheMissReason: null,
          gapSec,
          isOver60sGap: false,
        };
      }
      continue;
    }

    evaluatedSteps += 1;
    allPromptSum += promptTok;
    allCacheSum += cacheTok;
    if (promptTok >= MIN_CACHE_EVAL_PROMPT_TOKENS) {
      largePromptSum += promptTok;
      largeCacheSum += cacheTok;
    }

    if (hasValidDur) {
      rawLlmTimeSec += totalDurSec;
    }
    totalOutputTokens += outTok;

    const hasNumericToolCount =
      typeof step.toolCallCount === 'number' && Number.isFinite(step.toolCallCount);
    const stepHadCalls = hasNumericToolCount
      ? step.toolCallCount > 0
      : Boolean(step.hasToolCalls);
    const stepHasBlocking = Boolean(step.hasBlockingTool);

    if (hasNumericToolCount) {
      seenNumericToolCount = true;
      if (step.toolCallCount > 0) {
        toolTurns += 1;
        totalToolCalls += step.toolCallCount;
        if (step.toolCallCount === 1) {
          singleToolTurns += 1;
        }
      }
    } else if (step.hasToolCalls) {
      seenLegacyToolCallsWithoutCount = true;
    }

    const hasNumericToolStage =
      typeof step.toolStageSec === 'number' && Number.isFinite(step.toolStageSec);
    if (hasNumericToolStage) {
      seenNumericToolStage = true;
      if (!stepHasBlocking && step.toolStageSec > 0 && step.toolStageSec <= MAX_STEP_STAGE_SEC) {
        rawToolExecTimeSec += step.toolStageSec;
      }
    } else if (stepHadCalls && !stepHasBlocking && step.toolStageSec === undefined) {
      seenToolStepWithoutStage = true;
    }

    if (step.isTurnStart && step.turnHasMedia) {
      mediaTurns += 1;
      hasActiveMedia = true;
    }

    let cacheMissReason = null;
    const curModel = resolveComparableModelKey(step);

    if (
      prevPromptTok !== null &&
      prevPromptTok >= IMPLICIT_COMPACTION_MIN_PREV_TOKENS &&
      promptTok < prevPromptTok * IMPLICIT_COMPACTION_DROP_RATIO
    ) {
      compactionResets += 1;
      cacheMissReason = 'compaction';
      flushStreak();
      hasActiveMedia = Boolean(step.isTurnStart && step.turnHasMedia);
    } else if (
      prevPromptTok !== null &&
      prevPromptTok >= MIN_CACHE_EVAL_PROMPT_TOKENS &&
      promptTok >= MIN_CACHE_EVAL_PROMPT_TOKENS
    ) {
      eligibleTransitions += 1;
      const hitRate = cacheTok / promptTok;
      const retainedRatio = cacheTok / prevPromptTok;

      if (
        hitRate < CACHE_MISS_HIT_RATE_THRESHOLD &&
        retainedRatio < CACHE_MISS_RETAINED_RATIO_THRESHOLD
      ) {
        if (step.hasPlanModeSwitch) {
          cacheMissReason = 'plan_mode_switch';
          planModeSwitch += 1;
        } else if (prevModel && curModel && prevModel !== curModel) {
          cacheMissReason = 'model_switch';
          modelSwitch += 1;
        } else if (prevHadError || stepHasNonCanceledError) {
          cacheMissReason = 'error_retry';
          errorRetry += 1;
        } else if (gapSec !== null && gapSec >= SLOW_GAP_THRESHOLD_SEC) {
          if (step.isTurnStart || !prevHadCalls || prevHadBlockingTool) {
            cacheMissReason = 'idle_or_wait_gap';
            idleOrWaitGap += 1;
          } else {
            cacheMissReason = 'active_slow_gap';
            activeSlowGap += 1;
          }
        } else if (!prevHadCalls && (step.hadSystemMessageBetween || step.isTurnStart)) {
          cacheMissReason = 'async_wakeup_fast';
          asyncWakeupFast += 1;
        } else {
          cacheMissReason = 'prefix_or_replica_miss';
          prefixOrReplicaMiss += 1;
        }
        currentStreak += 1;
        if (currentStreak > maxStreak) {
          maxStreak = currentStreak;
        }
      } else if (
        hitRate < CACHE_MISS_HIT_RATE_THRESHOLD &&
        retainedRatio >= CACHE_MISS_RETAINED_RATIO_THRESHOLD
      ) {
        flushStreak();
        contextDilutionTurns += 1;
        cacheMissReason = 'context_dilution';
      } else {
        flushStreak();
      }
    }

    if (promptTok >= HIGH_CONTEXT_THRESHOLD) {
      over150kTurns += 1;
      if (hasActiveMedia) {
        multimodalHighCtxTurns += 1;
        if (promptTok >= CRITICAL_MULTIMODAL_CONTEXT_THRESHOLD) {
          multimodalOver180kTurns += 1;
        }
      }
    }

    let isOver60sGap = false;
    const isActiveGap =
      !step.isTurnStart &&
      !prevHadBlockingTool &&
      !(!prevHadCalls && Boolean(step.hadSystemMessageBetween));
    if (
      prevEndMs > 0 &&
      isActiveGap &&
      gapSec !== null &&
      gapSec >= 0 &&
      gapSec <= MAX_ACTIVE_GAP_SEC
    ) {
      activeGapsTotal += 1;
      if (gapSec > SLOW_GAP_THRESHOLD_SEC) {
        gapsOver60s += 1;
        isOver60sGap = true;
      }
    }

    if (step.stepIndex !== undefined && step.stepIndex !== null) {
      stepDiagnosticsByIndex[step.stepIndex] = {
        cacheMissReason,
        gapSec,
        isOver60sGap,
      };
    }

    prevPromptTok = promptTok;
    if (curModel) prevModel = curModel;
    if (stepEndMs > 0) prevEndMs = stepEndMs;
    prevHadCalls = stepHadCalls;
    prevHadBlockingTool = stepHasBlocking;
    prevHadError = stepHasNonCanceledError;
  }

  const activeStreak = currentStreak;
  flushStreak();

  return finalizeHealthSummary(
    {
      evaluatedSteps,
      largePromptSum,
      largeCacheSum,
      allPromptSum,
      allCacheSum,
      eligibleTransitions,
      planModeSwitch,
      modelSwitch,
      errorRetry,
      idleOrWaitGap,
      activeSlowGap,
      asyncWakeupFast,
      prefixOrReplicaMiss,
      compactionResets,
      contextDilutionTurns,
      collapseRuns,
      collapseTurns,
      maxStreak,
      activeStreak,
      rawLlmTimeSec,
      rawToolExecTimeSec,
      totalOutputTokens,
      activeGapsTotal,
      gapsOver60s,
      over150kTurns,
      mediaTurns,
      multimodalHighCtxTurns,
      multimodalOver180kTurns,
      toolTurns,
      totalToolCalls,
      singleToolTurns,
      hasToolTimingTelemetry: !(seenToolStepWithoutStage && !seenNumericToolStage),
      hasToolBatchTelemetry: !(seenLegacyToolCallsWithoutCount && !seenNumericToolCount),
    },
    stepDiagnosticsByIndex
  );
}

/**
 * Returns a copy of a Session Health summary without `stepDiagnosticsByIndex`,
 * preserving exact internal token/time totals for downstream `mergeAgentSessionHealths()`.
 *
 * @param {object | null | undefined} health
 */
export function stripStepDiagnostics(health) {
  if (!health || typeof health !== 'object') return health;
  const { stepDiagnosticsByIndex: _ignored, ...stripped } = health;
  const raw = rawHealthTotals.get(health);
  if (raw) {
    rawHealthTotals.set(stripped, raw);
  }
  return stripped;
}

/**
 * Merges per-agent Session Health summaries (mainline + subagents/swarm workers,
 * never running sequential transition logic across interleaved multi-agent steps).
 *
 * @param {Array<object>} healthSummaries
 */
export function mergeAgentSessionHealths(healthSummaries = []) {
  const valid = (Array.isArray(healthSummaries) ? healthSummaries : []).filter(
    (item) => item && typeof item === 'object'
  );
  if (valid.length === 0) {
    const { stepDiagnosticsByIndex: _ignored, ...empty } = analyzeSessionHealth([]);
    return empty;
  }

  const acc = {
    evaluatedSteps: 0,
    largePromptSum: 0,
    largeCacheSum: 0,
    allPromptSum: 0,
    allCacheSum: 0,
    eligibleTransitions: 0,
    planModeSwitch: 0,
    modelSwitch: 0,
    errorRetry: 0,
    idleOrWaitGap: 0,
    activeSlowGap: 0,
    asyncWakeupFast: 0,
    prefixOrReplicaMiss: 0,
    compactionResets: 0,
    contextDilutionTurns: 0,
    collapseRuns: 0,
    collapseTurns: 0,
    maxStreak: 0,
    activeStreak: 0,
    rawLlmTimeSec: 0,
    rawToolExecTimeSec: 0,
    totalOutputTokens: 0,
    activeGapsTotal: 0,
    gapsOver60s: 0,
    over150kTurns: 0,
    mediaTurns: 0,
    multimodalHighCtxTurns: 0,
    multimodalOver180kTurns: 0,
    toolTurns: 0,
    totalToolCalls: 0,
    singleToolTurns: 0,
    hasToolTimingTelemetry: true,
    hasToolBatchTelemetry: true,
  };

  for (const h of valid) {
    const stepsCount = Math.max(0, Number(h.evaluatedSteps || 0));
    acc.evaluatedSteps += stepsCount;

    const raw = rawHealthTotals.get(h);
    if (raw) {
      acc.largePromptSum += raw.largePromptSum;
      acc.largeCacheSum += raw.largeCacheSum;
      acc.allPromptSum += raw.allPromptSum;
      acc.allCacheSum += raw.allCacheSum;
      acc.rawLlmTimeSec += raw.rawLlmTimeSec;
      acc.rawToolExecTimeSec += raw.rawToolExecTimeSec;
    } else {
      if (stepsCount > 0) {
        const hitPct = Math.max(0, Math.min(100, Number(h.cacheHitPct || 0)));
        acc.allPromptSum += stepsCount * 100;
        acc.allCacheSum += stepsCount * hitPct;
      }
      acc.rawLlmTimeSec += Math.max(0, Number(h.timing?.llmTimeSec || 0));
      acc.rawToolExecTimeSec += Math.max(0, Number(h.timing?.toolExecTimeSec || 0));
    }

    const attr = h.cacheMissAttribution || {};
    acc.eligibleTransitions += Math.max(0, Number(attr.eligibleTransitions || 0));
    acc.planModeSwitch += Math.max(0, Number(attr.planModeSwitch || 0));
    acc.modelSwitch += Math.max(0, Number(attr.modelSwitch || 0));
    acc.errorRetry += Math.max(0, Number(attr.errorRetry || 0));
    acc.idleOrWaitGap += Math.max(0, Number(attr.idleOrWaitGap || 0));
    acc.activeSlowGap += Math.max(0, Number(attr.activeSlowGap || 0));
    acc.asyncWakeupFast += Math.max(0, Number(attr.asyncWakeupFast || 0));
    acc.prefixOrReplicaMiss += Math.max(0, Number(attr.prefixOrReplicaMiss || 0));
    acc.compactionResets += Math.max(0, Number(attr.compactionResets || 0));
    acc.contextDilutionTurns += Math.max(0, Number(attr.contextDilutionTurns || 0));

    const collapse = attr.sustainedCollapse || {};
    acc.collapseRuns += Math.max(0, Number(collapse.runs || 0));
    acc.collapseTurns += Math.max(0, Number(collapse.turns || 0));
    acc.maxStreak = Math.max(acc.maxStreak, Math.max(0, Number(collapse.maxStreak || 0)));
    acc.activeStreak = Math.max(
      acc.activeStreak,
      Math.max(0, Number(collapse.activeStreak || 0))
    );

    const timing = h.timing || {};
    acc.totalOutputTokens += Math.max(0, Number(timing.totalOutputTokens || 0));
    acc.activeGapsTotal += Math.max(0, Number(timing.activeGapsTotal || 0));
    acc.gapsOver60s += Math.max(0, Number(timing.gapsOver60s || 0));
    if (timing.hasToolTimingTelemetry === false) {
      acc.hasToolTimingTelemetry = false;
    }

    const hyg = h.hygiene || {};
    acc.over150kTurns += Math.max(0, Number(hyg.over150kTurns || 0));
    acc.mediaTurns += Math.max(0, Number(hyg.mediaTurns || 0));
    acc.multimodalHighCtxTurns += Math.max(0, Number(hyg.multimodalHighCtxTurns || 0));
    acc.multimodalOver180kTurns += Math.max(0, Number(hyg.multimodalOver180kTurns || 0));
    acc.toolTurns += Math.max(0, Number(hyg.toolTurns || 0));
    acc.totalToolCalls += Math.max(0, Number(hyg.totalToolCalls || 0));
    acc.singleToolTurns += Math.max(0, Number(hyg.singleToolTurns || 0));
    if (hyg.hasToolBatchTelemetry === false) {
      acc.hasToolBatchTelemetry = false;
    }
  }

  return finalizeHealthSummary(acc, undefined);
}
