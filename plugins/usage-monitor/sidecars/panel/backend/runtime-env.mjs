/**
 * @fileoverview Explicit runtime mode seam (`test` vs `production`).
 * Centralizes test-mode detection so no other backend module hardcodes `'test.invalid'`.
 */

function detectInitialTestMode() {
  const mode = String(process?.env?.USAGE_MONITOR_RUNTIME_MODE || '').trim().toLowerCase();
  if (mode === 'test') return true;
  if (mode === 'production') return false;
  return String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid';
}

export const runtimeEnv = {
  isTestMode: detectInitialTestMode(),
};

export function isTestRuntime() {
  return Boolean(runtimeEnv.isTestMode);
}

export function configureRuntimeEnv(overrides = {}) {
  if (typeof overrides.isTestMode === 'boolean') {
    runtimeEnv.isTestMode = overrides.isTestMode;
  }
}
