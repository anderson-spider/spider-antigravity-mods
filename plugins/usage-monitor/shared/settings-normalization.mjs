/**
 * @fileoverview Shared preference enum constants, defaults, and stateless pure
 * normalization functions used across backend, UI, and CLI.
 */

export const SUPPORTED_LANGUAGES = Object.freeze(['auto', 'en-US', 'pt-BR']);

export const THEME_ACCENT_KEYS = Object.freeze([
  'host',
  'blue',
  'emerald',
  'amber',
  'violet',
  'cyan',
  'rose',
]);

export const FONT_SCALE_KEYS = Object.freeze(['sm', 'md', 'lg', 'xl']);

export const TOPBAR_SLOT_KEYS = Object.freeze([
  'context',
  'tps',
  'ttft',
  'avg_tps',
  'cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'quota_auto',
  'gemini_5h',
  'gemini_weekly',
  'claude_5h',
  'claude_weekly',
]);

export const DEFAULT_TOPBAR_SLOTS = Object.freeze(['tps', 'ttft', 'context']);
export const MIN_TOPBAR_SLOTS = 1;
export const MAX_TOPBAR_SLOTS = 5;

export const CURRENT_SETTINGS_SCHEMA_VERSION = 2;

export const OVERVIEW_MODULE_KEYS = Object.freeze([
  'metrics',
  'session_health',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_OVERVIEW_MODULES = Object.freeze([
  'metrics',
  'session_health',
  'context',
  'quotas',
  'live_tasks',
]);

export const OVERVIEW_METRIC_KEYS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'context_usage',
  'quota_tightest',
]);

export const DEFAULT_OVERVIEW_METRICS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
]);

export const STEP_TABLE_COLUMN_KEYS = Object.freeze([
  'step',
  'time',
  'model',
  'tps',
  'ttft',
  'duration',
  'tokens_combo',
  'tokens_io_cache',
  'tokens_custom',
  'input_tokens',
  'cache_tokens',
  'output_tokens',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TABLE_COLUMNS = Object.freeze([
  'step',
  'model',
  'tps',
  'ttft',
  'tokens_combo',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TOKEN_COMBO_FORMAT = 'context:in:cache';

export const STEP_TOKEN_SEGMENT_ALIASES = Object.freeze({
  context: 'context',
  ctx: 'context',
  contexto: 'context',
  in: 'in',
  new: 'in',
  input: 'in',
  entrada: 'in',
  out: 'out',
  output: 'out',
  saida: 'out',
  'saída': 'out',
  cache: 'cache',
  cached: 'cache',
  cache_read: 'cache',
  cacheread: 'cache',
  think: 'think',
  thinking: 'think',
  pensamento: 'think',
  reply: 'reply',
  body: 'reply',
  resp: 'reply',
  response: 'reply',
  text: 'reply',
  resposta: 'reply',
  total: 'total',
  all: 'total',
  sum: 'total',
});

/**
 * Normalizes the UI language setting (`'auto'`, `'en-US'`, or `'pt-BR'`).
 *
 * @param {unknown} lang
 * @returns {'auto'|'en-US'|'pt-BR'}
 */
export function normalizeLanguageSetting(lang) {
  const raw = String(lang ?? '').trim();
  if (!raw) return 'auto';
  const lower = raw.toLowerCase();
  if (lower === 'auto' || lower === 'system') return 'auto';
  if (lower === 'en' || lower === 'en-us' || lower.startsWith('en-')) return 'en-US';
  if (lower === 'pt' || lower === 'pt-br' || lower.startsWith('pt-')) return 'pt-BR';
  return 'auto';
}

/**
 * Normalizes the theme accent preset key (defaults to `'host'`).
 *
 * @param {unknown} accent
 * @returns {'host'|'blue'|'emerald'|'amber'|'violet'|'cyan'|'rose'}
 */
export function normalizeThemeAccent(accent) {
  const clean = String(accent ?? '').trim().toLowerCase();
  return THEME_ACCENT_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'host';
}

/**
 * Normalizes the UI font scale key (defaults to `'md'`).
 *
 * @param {unknown} scale
 * @returns {'sm'|'md'|'lg'|'xl'}
 */
export function normalizeFontScale(scale) {
  const clean = String(scale ?? '').trim().toLowerCase();
  return FONT_SCALE_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'md';
}

/**
 * Normalizes the model identifier display mode (`'short'` | `'upstream_compact'` | `'upstream'`),
 * preserving compatibility with legacy `showUpstreamModel`.
 *
 * @param {unknown} mode
 * @param {unknown} [legacyShowUpstream]
 * @returns {'short'|'upstream_compact'|'upstream'}
 */
export function normalizeModelDisplayMode(mode, legacyShowUpstream) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'upstream' || m === 'raw' || m === 'full') return 'upstream';
  if (m === 'upstream_compact' || m === 'compact_upstream' || m === 'trimmed') {
    return 'upstream_compact';
  }
  if (m === 'short') return 'short';
  if (legacyShowUpstream === true) return 'upstream';
  return 'short';
}

/**
 * Normalizes the Orchestrator model ID display mode (`'compact'` vs `'full'`).
 *
 * @param {unknown} mode
 * @returns {'compact'|'full'}
 */
export function normalizeOrchestratorIdMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

/**
 * Parses a custom step token combo format expression (1-4 unique segments).
 *
 * @param {unknown} raw
 * @returns {Array<'context'|'in'|'out'|'cache'|'think'|'reply'|'total'>}
 */
export function parseStepTokenComboSegments(raw) {
  const str = String(raw ?? '').trim();
  const out = [];
  const seen = new Set();
  if (str) {
    for (const part of str.split(/[:/,|]+/)) {
      const key = part.trim().toLowerCase();
      if (!key) continue;
      const mapped = Object.prototype.hasOwnProperty.call(STEP_TOKEN_SEGMENT_ALIASES, key)
        ? STEP_TOKEN_SEGMENT_ALIASES[key]
        : null;
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(/** @type {any} */ (mapped));
      if (out.length >= 4) break;
    }
  }
  return out.length > 0 ? out : ['context', 'in', 'cache'];
}

/**
 * Normalizes a custom step token combo format string (e.g. `'context:new:cache'` -> `'context:in:cache'`).
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeStepTokenComboFormat(raw) {
  return parseStepTokenComboSegments(raw).join(':');
}

/**
 * Normalizes the weekly quota limit mode (`'official'` | `'custom_tokens'` | `'custom_cost'`).
 *
 * @param {unknown} mode
 * @returns {'official'|'custom_tokens'|'custom_cost'}
 */
export function normalizeWeeklyLimitMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'custom_tokens' || m === 'tokens') return 'custom_tokens';
  if (m === 'custom_cost' || m === 'cost') return 'custom_cost';
  return 'official';
}

/**
 * Normalizes CLI status bar capsule slots (1-5 unique entries, default 3).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeTopbarCapsuleSlots(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_TOPBAR_SLOTS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_TOPBAR_SLOTS) break;
  }
  if (out.length < MIN_TOPBAR_SLOTS) {
    return ['context'];
  }
  return out;
}

/**
 * Normalizes Live Overview top metric matrix slots (1-4 entries, default 4).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewMetrics(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_METRICS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const rawVal = String(item ?? '').trim();
    const val = rawVal === 'cost' ? 'step_cost' : rawVal;
    if (!OVERVIEW_METRIC_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : ['tps'];
}

/**
 * Normalizes Live Overview module order (1..OVERVIEW_MODULE_KEYS.length).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out.length > 0 ? out : ['metrics'];
}

/**
 * Normalizes Step Records table columns and order (2-14 columns, default 7).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeStepTableColumns(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_STEP_TABLE_COLUMNS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!STEP_TABLE_COLUMN_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= STEP_TABLE_COLUMN_KEYS.length) break;
  }
  if (out.length < 2) {
    for (const fallbackCol of ['step', 'model', 'tps']) {
      if (!seen.has(fallbackCol)) {
        seen.add(fallbackCol);
        out.push(fallbackCol);
      }
      if (out.length >= 2) break;
    }
  }
  return out;
}

/**
 * Normalizes the Modern UI toggle (defaults to `true`).
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeModernUi(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

/**
 * Normalizes legacy `experimentalModernUi` boolean (defaults to `false`).
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeExperimentalModernUi(val) {
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'on';
  }
  return Boolean(val);
}

function isSettingsPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function sanitizePositiveSettingNumber(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export const DEFAULT_SETTINGS_SCHEMA = Object.freeze({
  settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
  language: 'auto',
  themeAccent: 'host',
  fontScale: 'md',
  modernUi: true,
  experimentalModernUi: true,
  weeklyTokenBudget: 150000000,
  weeklyCostBudget: 100,
  weeklyLimitMode: 'official',
  modelDisplayMode: 'short',
  showUpstreamModel: false,
  orchestratorIdMode: 'compact',
  enableCliStatusLine: true,
  showTopbarMultiSession: true,
  topbarCapsuleSlots: DEFAULT_TOPBAR_SLOTS,
  overviewModules: DEFAULT_OVERVIEW_MODULES,
  overviewMetrics: DEFAULT_OVERVIEW_METRICS,
  showQuotaPace: true,
  showStepTurnRail: false,
  showStepAgentBadge: true,
  showStepSpeedColor: false,
  stepTokenComboFormat: DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  stepTableColumns: DEFAULT_STEP_TABLE_COLUMNS,
});

/**
 * Returns a fresh deep-copied default settings object.
 */
export function createDefaultSettingsObject() {
  return {
    ...DEFAULT_SETTINGS_SCHEMA,
    topbarCapsuleSlots: [...DEFAULT_TOPBAR_SLOTS],
    overviewModules: [...DEFAULT_OVERVIEW_MODULES],
    overviewMetrics: [...DEFAULT_OVERVIEW_METRICS],
    stepTableColumns: [...DEFAULT_STEP_TABLE_COLUMNS],
  };
}

/**
 * Normalizes a persisted settings object or merged patch into the canonical schema.
 * Legacy sidecar/overlay/CDP/standalone keys are silently ignored.
 *
 * @param {unknown} rawInput
 */
export function normalizeFullSettings(rawInput) {
  const safeRaw = isSettingsPlainObject(rawInput) ? rawInput : {};
  const rawVersion = Number(safeRaw.settingsSchemaVersion || 0);
  const modelDisplayMode = normalizeModelDisplayMode(
    safeRaw.modelDisplayMode,
    safeRaw.showUpstreamModel
  );
  const modernUi =
    safeRaw.modernUi !== undefined ? normalizeModernUi(safeRaw.modernUi) : true;
  let overviewModules = normalizeOverviewModules(safeRaw.overviewModules);
  if (
    rawVersion < CURRENT_SETTINGS_SCHEMA_VERSION &&
    Array.isArray(safeRaw.overviewModules) &&
    !overviewModules.includes('session_health')
  ) {
    const nextModules = [...overviewModules];
    const metricsIdx = nextModules.indexOf('metrics');
    nextModules.splice(metricsIdx >= 0 ? metricsIdx + 1 : 0, 0, 'session_health');
    overviewModules = nextModules;
  }
  return {
    settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    language: normalizeLanguageSetting(safeRaw.language),
    themeAccent: normalizeThemeAccent(safeRaw.themeAccent),
    fontScale: normalizeFontScale(safeRaw.fontScale),
    modernUi,
    experimentalModernUi: modernUi,
    weeklyTokenBudget: sanitizePositiveSettingNumber(
      safeRaw.weeklyTokenBudget ?? safeRaw.weeklyTokenLimit,
      DEFAULT_SETTINGS_SCHEMA.weeklyTokenBudget
    ),
    weeklyCostBudget: sanitizePositiveSettingNumber(
      safeRaw.weeklyCostBudget,
      DEFAULT_SETTINGS_SCHEMA.weeklyCostBudget
    ),
    weeklyLimitMode: normalizeWeeklyLimitMode(safeRaw.weeklyLimitMode),
    modelDisplayMode,
    showUpstreamModel: modelDisplayMode !== 'short',
    orchestratorIdMode: normalizeOrchestratorIdMode(safeRaw.orchestratorIdMode),
    enableCliStatusLine: safeRaw.enableCliStatusLine !== false,
    showTopbarMultiSession: safeRaw.showTopbarMultiSession !== false,
    topbarCapsuleSlots: normalizeTopbarCapsuleSlots(safeRaw.topbarCapsuleSlots),
    overviewModules,
    overviewMetrics: normalizeOverviewMetrics(safeRaw.overviewMetrics),
    showQuotaPace: safeRaw.showQuotaPace !== false,
    showStepTurnRail: safeRaw.showStepTurnRail === true,
    showStepAgentBadge: safeRaw.showStepAgentBadge !== false,
    showStepSpeedColor: safeRaw.showStepSpeedColor === true,
    stepTokenComboFormat: normalizeStepTokenComboFormat(safeRaw.stepTokenComboFormat),
    stepTableColumns: normalizeStepTableColumns(safeRaw.stepTableColumns),
  };
}

/**
 * Merges a partial settings patch into `current` and returns the normalized full settings object.
 */
export function mergeSettingsPatch(current, patch) {
  const safeCurrent = isSettingsPlainObject(current) ? current : {};
  const payload = isSettingsPlainObject(patch) ? patch : {};
  const nextModelDisplayMode =
    payload.modelDisplayMode !== undefined
      ? normalizeModelDisplayMode(payload.modelDisplayMode)
      : typeof payload.showUpstreamModel === 'boolean'
        ? payload.showUpstreamModel
          ? 'upstream'
          : 'short'
        : normalizeModelDisplayMode(safeCurrent.modelDisplayMode, safeCurrent.showUpstreamModel);
  const nextModernUi =
    payload.modernUi !== undefined
      ? normalizeModernUi(payload.modernUi)
      : payload.experimentalModernUi !== undefined
        ? normalizeModernUi(payload.experimentalModernUi)
        : normalizeModernUi(safeCurrent.modernUi);
  return normalizeFullSettings({
    ...safeCurrent,
    ...payload,
    settingsSchemaVersion: CURRENT_SETTINGS_SCHEMA_VERSION,
    modernUi: nextModernUi,
    weeklyTokenBudget: sanitizePositiveSettingNumber(
      payload.weeklyTokenBudget ?? payload.weeklyTokenLimit,
      safeCurrent.weeklyTokenBudget
    ),
    weeklyCostBudget: sanitizePositiveSettingNumber(
      payload.weeklyCostBudget,
      safeCurrent.weeklyCostBudget
    ),
    modelDisplayMode: nextModelDisplayMode,
  });
}
