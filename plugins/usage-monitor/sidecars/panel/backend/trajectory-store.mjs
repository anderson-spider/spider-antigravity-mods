/**
 * @fileoverview Deep trajectory cache store and quota summary cache primitives shared by local and remote endpoints.
 */

import { inferCompactionStepModels, normalizeCachedStep } from '../trajectory-metrics.mjs';

export const CACHE_RUNNING_SAVE_INTERVAL_MS = 30_000;

const activeTrajectoryStores = new Set();

function isStorePlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Create a fresh quota summary cache record. */
export function createQuotaCache() {
  return {
    ts: 0,
    lastAttemptTs: 0,
    accountName: '',
    accountGeneration: 0,
    data: null,
    error: null,
  };
}

/** Reset a quota summary cache record in place and bump `accountGeneration`. */
export function resetQuotaCache(cache) {
  if (!cache || typeof cache !== 'object') return;
  cache.ts = 0;
  cache.lastAttemptTs = 0;
  cache.accountName = '';
  cache.accountGeneration += 1;
  cache.data = null;
  cache.error = null;
}

function hydrateTrajectoryCacheObject(rawLoaded) {
  const cacheObj = Object.create(null);
  let migrated =
    rawLoaded !== null && rawLoaded !== undefined && !isStorePlainObject(rawLoaded);
  if (isStorePlainObject(rawLoaded)) {
    for (const [id, entry] of Object.entries(rawLoaded)) {
      if (!id || !isStorePlainObject(entry)) {
        migrated = true;
        continue;
      }
      const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
      if (!Array.isArray(entry.steps)) migrated = true;
      const objectSteps = rawSteps.filter((s) => isStorePlainObject(s));
      if (objectSteps.length !== rawSteps.length) migrated = true;
      const normalizedSteps = objectSteps.map((s) => {
        const norm = normalizeCachedStep(s);
        if (norm !== s) migrated = true;
        return norm;
      });
      const finalSteps = inferCompactionStepModels(normalizedSteps);
      for (let i = 0; i < finalSteps.length; i++) {
        if (finalSteps[i] !== normalizedSteps[i]) {
          migrated = true;
          break;
        }
      }
      cacheObj[id] = { ...entry, steps: finalSteps };
    }
  }
  return { cacheObj, migrated };
}

/**
 * Create a self-contained trajectory cache store with hydration, 30s throttled persistence,
 * synchronous flush on idle/exit, and atomic clear.
 */
export function createTrajectoryCacheStore({
  filePath = '',
  loadJson,
  saveJson,
  shouldSaveSync = () => false,
}) {
  const loaded = filePath ? loadJson(filePath, {}) : {};
  const { cacheObj, migrated } = hydrateTrajectoryCacheObject(loaded);
  const state = {
    needsSave: Boolean(filePath && migrated),
    lastSavedAtMs: 0,
    flushTimer: null,
  };

  function cancelFlushTimer() {
    if (state.flushTimer) {
      try {
        clearTimeout(state.flushTimer);
      } catch {
        // ignore timer clear errors in sandboxed runtimes
      }
      state.flushTimer = null;
    }
  }

  function flushTrajectoryCacheNow() {
    cancelFlushTimer();
    if (!filePath) {
      state.needsSave = false;
      return true;
    }
    const ok = Boolean(saveJson(filePath, cacheObj));
    state.needsSave = !ok;
    if (ok) {
      state.lastSavedAtMs = Date.now();
    }
    return ok;
  }

  function persistTrajectoryCacheIfNeeded({
    hasRunningSessions = false,
    allowThrottleInTest = false,
  } = {}) {
    if (!filePath) {
      state.needsSave = false;
      return;
    }
    if (shouldSaveSync({ allowThrottleInTest }) || typeof setTimeout !== 'function') {
      flushTrajectoryCacheNow();
      return;
    }
    const nowMs = Date.now();
    const elapsedMs = nowMs - (state.lastSavedAtMs || 0);
    if (
      !hasRunningSessions ||
      state.lastSavedAtMs === 0 ||
      elapsedMs >= CACHE_RUNNING_SAVE_INTERVAL_MS
    ) {
      flushTrajectoryCacheNow();
      return;
    }
    state.needsSave = true;
    if (!state.flushTimer) {
      const delayMs = Math.max(100, CACHE_RUNNING_SAVE_INTERVAL_MS - elapsedMs);
      const timer = setTimeout(() => {
        state.flushTimer = null;
        if (state.needsSave) {
          flushTrajectoryCacheNow();
        }
      }, delayMs);
      timer?.unref?.();
      state.flushTimer = timer;
    }
  }

  function clearCache() {
    if (filePath && !saveJson(filePath, {})) return false;
    cancelFlushTimer();
    for (const key of Object.keys(cacheObj)) {
      delete cacheObj[key];
    }
    state.needsSave = false;
    state.lastSavedAtMs = 0;
    return true;
  }

  const store = {
    cacheFilePath: filePath,
    cacheState: state,
    cancelFlushTimer,
    getCachedTrajectory: (cascadeId) => cacheObj[cascadeId],
    listCachedTrajectoryEntries: () => Object.entries(cacheObj),
    setCachedTrajectory: (cascadeId, entry) => {
      cacheObj[cascadeId] = entry;
    },
    removeCachedTrajectory: (cascadeId) => {
      delete cacheObj[cascadeId];
    },
    hasPendingTrajectoryCacheSave: () => state.needsSave,
    persistTrajectoryCacheIfNeeded,
    flushTrajectoryCacheNow,
    clearCache,
    dispose: () => {
      cancelFlushTimer();
      activeTrajectoryStores.delete(store);
    },
  };

  activeTrajectoryStores.add(store);
  return store;
}

if (typeof process !== 'undefined' && typeof process?.once === 'function') {
  process.once('exit', () => {
    for (const store of activeTrajectoryStores) {
      if (store.hasPendingTrajectoryCacheSave()) {
        store.flushTrajectoryCacheNow();
      }
      store.cancelFlushTimer();
    }
  });
}
