/**
 * @fileoverview 后端全局路径常量、默认配置、JSON 持久化工具与运行时共享状态容器。
 *
 * 负责统一管理：
 * 1. 插件根目录 (`PLUGIN_ROOT`)、面板目录 (`HERE`) 与持久化数据目录 (`DATA_DIR`) 的路径解析；
 * 2. Language Server RPC 连接参数 (`LS_ADDR` / `LS_BASE_URL` / `CSRF_TOKEN`) 与 GitHub 云端价格表地址；
 * 3. 安全的 JSON 读写封装 (`loadJson` / `saveJson`) 与用户设置合并 (`loadSettings`)；
 * 4. 跨子系统共享的内存态缓存容器（采用对象属性就地更新设计，兼容 ES Module 与 VM 沙箱）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFullSettings } from '../shared/settings-normalization.mjs';
import { isTestRuntime } from './runtime-env.mjs';
import { writeTrajectoryCacheFile } from './trajectory-cache-file.mjs';
import {
  createQuotaCache,
  createTrajectoryCacheStore,
  resetQuotaCache,
} from './trajectory-store.mjs';

/**
 * 自适应解析 `sidecars/panel` 目录路径：
 * - 在真实 Node ESM 运行时中，本文件位于 `sidecars/panel/backend/config.mjs`，向上取一级即为 `sidecars/panel`；
 * - 在 `backend-harness.mjs` 单元测试沙箱中，`fileURLToPath` 返回 `.../sidecars/panel/main.mjs`，当前目录即为 `sidecars/panel`。
 */
const rawModuleDir = dirname(fileURLToPath(import.meta.url));
export const HERE = /[\\/]backend$/i.test(rawModuleDir) ? dirname(rawModuleDir) : rawModuleDir;
export const PLUGIN_ROOT = dirname(dirname(HERE));
export const PLUGIN_MANIFEST_FILE = join(PLUGIN_ROOT, 'plugin.json');
export const LOCAL_CATALOG_FILE = join(PLUGIN_ROOT, 'pricing-catalog.json');

function resolveGeminiBaseDir() {
  const envGemini = String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  return envGemini || join(homedir(), '.gemini');
}

function dedupeDirCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const clean = String(item || '').trim();
    if (!clean) continue;
    const key = process.platform === 'win32' ? clean.toLowerCase() : clean;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function resolveProductDataRoots() {
  const geminiBase = resolveGeminiBaseDir();
  const explicitAppDir = String(
    process.env.USAGE_MONITOR_APP_DATA_DIR || process.env.ANTIGRAVITY_APP_DATA_DIR || ''
  ).trim();
  const customRoot = explicitAppDir
    ? /[\\/]|^[a-zA-Z]:/.test(explicitAppDir)
      ? explicitAppDir
      : join(geminiBase, explicitAppDir)
    : '';
  return dedupeDirCandidates([
    customRoot,
    join(geminiBase, 'antigravity'),
    join(geminiBase, 'antigravity-cli'),
    join(geminiBase, 'antigravity-ide'),
    join(geminiBase, 'antigravity-idea'),
  ]);
}

/**
 * 插件持久化数据目录（默认由 Antigravity 宿主注入 `~/.gemini/antigravity/sidecar_data/usage-monitor/panel/data`）。
 * 兼容桌面端、Antigravity IDE 与无头 `agy` CLI（`~/.gemini/antigravity-cli`）：
 * 优先使用已存在的持久化目录，纯 CLI 服务器自动落入 `~/.gemini/antigravity-cli/sidecar_data/usage-monitor/panel/data`，
 * 避免落入插件源码目录而在自更新时丢失缓存与设置。
 */
function resolveDefaultDataDir() {
  const explicitDataDir = String(process.env.USAGE_MONITOR_DATA_DIR || '').trim();
  if (explicitDataDir) {
    return explicitDataDir;
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  if (isTestRuntime()) {
    return join(HERE, '.data');
  }
  const geminiBase = resolveGeminiBaseDir();
  const antigravityRoot = join(geminiBase, 'antigravity');
  const cliRoot = join(geminiBase, 'antigravity-cli');
  const panelDataDir = join(antigravityRoot, 'sidecar_data', 'usage-monitor', 'panel', 'data');
  const legacyDataDir = join(antigravityRoot, 'sidecar_data', 'usage-monitor', 'data');
  const cliPanelDataDir = join(cliRoot, 'sidecar_data', 'usage-monitor', 'panel', 'data');
  if (existsSync(panelDataDir)) return panelDataDir;
  if (existsSync(legacyDataDir)) return legacyDataDir;
  if (existsSync(cliPanelDataDir)) return cliPanelDataDir;
  if (existsSync(antigravityRoot)) return panelDataDir;
  if (
    process.env.USAGE_MONITOR_PLUGIN_DATA &&
    !process.env.USAGE_MONITOR_PLUGIN_DATA.includes('${')
  ) {
    return process.env.USAGE_MONITOR_PLUGIN_DATA;
  }
  if (existsSync(cliRoot)) return cliPanelDataDir;
  return join(HERE, '.data');
}

export const DATA_DIR = resolveDefaultDataDir();
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
export const CACHE_FILE = join(DATA_DIR, 'trajectory_usage_cache.json');
export const CLI_STATUS_SNAPSHOT_FILE = join(DATA_DIR, 'cli-status-snapshot.json');

/**
 * 本地对话记录目录、脑图日志目录、守护发现目录与跨端深层统计缓存路径候选列表（联合覆盖 Desktop / CLI / IDE）。
 */
export const PRODUCT_DATA_ROOTS = resolveProductDataRoots();
export const CONVERSATION_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'conversations'));
export const BRAIN_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'brain'));
export const ANNOTATION_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'annotations'));
export const DAEMON_DIRS = dedupeDirCandidates([
  join(resolveGeminiBaseDir(), 'antigravity-cli', 'daemon'),
  ...PRODUCT_DATA_ROOTS.map((root) => join(root, 'daemon')),
]);
export const CONVERSATIONS_DIR = CONVERSATION_DIRS[0];
export const BRAIN_DIR = BRAIN_DIRS[0];
export const DEEP_STATS_CACHE_CANDIDATES = dedupeDirCandidates([
  join(resolveGeminiBaseDir(), 'antigravity-ide', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity-cli', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity-idea', 'brain', '.deep_stats_cache.json'),
  ...BRAIN_DIRS.map((dir) => join(dir, '.deep_stats_cache.json')),
]);

/**
 * Antigravity 本地 Language Server Connect RPC 端点与鉴权 Token（支持环境变量静态注入与进程/守护文件动态发现）。
 */
const rawLsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
const LS_PROTOCOL = /^https:\/\//i.test(rawLsAddr) ? 'https' : 'http';
export const LS_ADDR = rawLsAddr.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
export const LS_BASE_URL = LS_ADDR ? `${LS_PROTOCOL}://${LS_ADDR}` : '';
export const CSRF_TOKEN =
  process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN;

export const lsRuntimeEndpoint = {
  addr: LS_ADDR,
  baseUrl: LS_BASE_URL,
  csrfToken: CSRF_TOKEN || '',
  isDynamic: false,
};

/**
 * 动态更新运行时 Language Server / Hub RPC 连接端点与 CSRF 令牌。
 *
 * @param {string} nextAddr
 * @param {string} nextCsrfToken
 * @param {{ isDynamic?: boolean }} [opts]
 */
export function setLsRuntimeEndpoint(nextAddr, nextCsrfToken, { isDynamic = true } = {}) {
  const raw = String(nextAddr || '').trim();
  const proto = /^https:\/\//i.test(raw) ? 'https' : 'http';
  const cleanAddr = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  lsRuntimeEndpoint.addr = cleanAddr;
  lsRuntimeEndpoint.baseUrl = cleanAddr ? `${proto}://${cleanAddr}` : '';
  lsRuntimeEndpoint.csrfToken = String(nextCsrfToken || '').trim();
  lsRuntimeEndpoint.isDynamic = Boolean(cleanAddr && isDynamic);
}

/** 历史轨迹缓存 Schema 版本号，升级时触发旧缓存字段迁移校验。 */
export const CACHE_SCHEMA_VERSION = 'v10-model-identity';

/**
 * 判断输入值是否为非数组普通对象（Plain Object）。
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 安全读取并解析本地 JSON 文件；文件不存在或解析失败时返回 `fallback`。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {*} fallback 失败时的回退值
 * @returns {*}
 */
export function loadJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 将数据序列化为格式化 JSON 并写入 `DATA_DIR` 下的指定文件。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {*} data 待写入的数据对象
 * @returns {boolean} 是否写入成功
 */
export function saveJson(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (filePath === CACHE_FILE) {
      writeTrajectoryCacheFile(filePath, data);
    } else {
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }
    return true;
  } catch (err) {
    console.error(`Failed writing ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * 读取用户设置并通过统一 Schema 归一化合并默认值，自动迁移旧版字段。
 */
export function loadSettings() {
  return normalizeFullSettings(loadJson(SETTINGS_FILE, {}));
}

/**
 * 将浮点指标保留 1 位小数；非有限数值返回 `null`。
 *
 * @param {number} value
 * @returns {number|null}
 */
export function roundMetric(value) {
  return Number.isFinite(value) ? +value.toFixed(1) : null;
}

/**
 * 计算前端产物与后端源码文件的最大修改时间戳，用于插件热更新后触发客户端重载。
 *
 * @returns {string}
 */
export function computeRuntimeCodeVersion() {
  let maxMtime = 0;
  const candidates = [
    join(HERE, 'app.js'),
    join(HERE, 'styles.css'),
    join(HERE, 'main.mjs'),
    join(HERE, 'standalone.mjs'),
    join(HERE, 'cli-statusline.mjs'),
    join(HERE, 'trajectory-metrics.mjs'),
    LOCAL_CATALOG_FILE,
  ];
  for (const subDir of ['shared', 'backend']) {
    const absDir = join(HERE, subDir);
    try {
      if (existsSync(absDir)) {
        for (const name of readdirSync(absDir)) {
          if (name.endsWith('.mjs') || name.endsWith('.js')) {
            candidates.push(join(absDir, name));
          }
        }
      }
    } catch {
      // 忽略目录列举异常
    }
  }
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const mtime = Math.floor(statSync(file).mtimeMs || 0);
        if (mtime > maxMtime) maxMtime = mtime;
      }
    } catch {
      // 忽略单文件 stat 异常
    }
  }
  return String(maxMtime || Date.now());
}

// ---------------------------------------------------------------------------
// 跨模块共享运行时状态容器（启动时自动完成历史轨迹缓存迁移与损坏结构防御）
// ---------------------------------------------------------------------------

export const localTrajectoryStore = createTrajectoryCacheStore({
  filePath: CACHE_FILE,
  loadJson,
  saveJson,
  shouldSaveSync: ({ allowThrottleInTest }) => isTestRuntime() && !allowThrottleInTest,
});

export const {
  getCachedTrajectory,
  listCachedTrajectoryEntries,
  setCachedTrajectory,
  removeCachedTrajectory,
  hasPendingTrajectoryCacheSave,
  persistTrajectoryCacheIfNeeded,
  flushTrajectoryCacheNow,
} = localTrajectoryStore;

export const externalDeepStatsMemo = {
  sig: '',
  convos: new Map(),
};

export const localSummaryMemo = {
  sig: '',
  byId: new Map(),
  available: false,
  summariesObj: {},
  sideQuestionParents: {},
  byRootsKey: new Map(),
};

/** 并发请求去重表（防止同一参数并发重复拉取）。 */
export const inFlightRequests = new Map();

/** 官方配额摘要 10 秒短期缓存与失败退避冷却记录。 */
export const quotaSummaryCache = createQuotaCache();

/** 离线价格与版本目录状态。 */
export const cloudSyncState = {
  catalogVersion: 'builtin',
  updatedAt: null,
  source: 'builtin', // 'builtin' | 'local'
  latestPluginVersion: null,
};

/**
 * 清空内存态轨迹缓存、外部深层统计 Memo 与配额摘要短期缓存，并将磁盘缓存重置为空对象。
 * 空缓存落盘成功后再清理内存，写入失败时可继续使用内存数据并重试。
 *
 * @returns {boolean} 是否成功写回空白缓存文件
 */
export function clearRuntimeCaches() {
  if (!localTrajectoryStore.clearCache()) return false;
  externalDeepStatsMemo.sig = '';
  externalDeepStatsMemo.convos.clear();
  localSummaryMemo.sig = '';
  localSummaryMemo.byId.clear();
  localSummaryMemo.available = false;
  localSummaryMemo.summariesObj = {};
  localSummaryMemo.sideQuestionParents = {};
  localSummaryMemo.byRootsKey.clear();
  resetQuotaCache(quotaSummaryCache);
  return true;
}
