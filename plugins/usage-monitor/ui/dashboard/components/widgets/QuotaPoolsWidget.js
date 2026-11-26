/**
 * @fileoverview Standalone decoupled Quota Pools Widget (`QuotaPoolsWidget.js`).
 * Renders dynamic multi-pool quota bars (Gemini, Argon/Carbon, Claude & GPT)
 * and weekly summary footer for `LiveOverviewView` and settings structure previews.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { formatCountdown, formatTokens, formatUsd } from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';

export const QUOTA_WINDOW_5H_MS = 5 * 60 * 60 * 1000;
export const QUOTA_WINDOW_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

const PACE_STYLE_MAP = Object.freeze({
  high: { toneClass: 'pace-high', labelKey: 'quota.paceAhead' },
  ahead: { toneClass: 'pace-ahead', labelKey: 'quota.paceAhead' },
  under: { toneClass: 'pace-under', labelKey: 'quota.paceUnder' },
  on_pace: { toneClass: 'pace-on-pace', labelKey: 'quota.paceOnTrack' },
});

/**
 * Computes expected cycle usage based on elapsed time in the quota window
 * and compares actual consumption against a steady burn rate.
 *
 * @param {{
 *   usedPct: number | string | null | undefined,
 *   resetTime: string | number | null | undefined,
 *   windowMs: number,
 *   nowMs?: number
 * }} params
 * @returns {{
 *   expectedPct: number,
 *   usedPct: number,
 *   deltaPct: number,
 *   paceRatio: number | null,
 *   status: 'under' | 'on_pace' | 'ahead' | 'high'
 * } | null}
 */
export function computeQuotaPace({ usedPct, resetTime, windowMs, nowMs = Date.now() }) {
  if (usedPct == null || usedPct === '') return null;
  const parsedUsed = Number(usedPct);
  if (!Number.isFinite(parsedUsed)) return null;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  const resetMs =
    typeof resetTime === 'number' ? resetTime : Date.parse(String(resetTime || '').trim());
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  const rawRemMs = resetMs - nowMs;
  if (rawRemMs > windowMs * 1.05) return null;

  const remMs = Math.min(windowMs, Math.max(0, rawRemMs));
  const elapsedMs = windowMs - remMs;
  const expectedPct = Math.min(100, Math.max(0, (elapsedMs / windowMs) * 100));
  const used = Math.min(100, Math.max(0, parsedUsed));
  const deltaPct = used - expectedPct;
  const paceRatio = expectedPct >= 2 ? used / expectedPct : null;
  const status =
    deltaPct > 15 ? 'high' : deltaPct > 5 ? 'ahead' : deltaPct < -5 ? 'under' : 'on_pace';

  return { expectedPct, usedPct: used, deltaPct, paceRatio, status };
}

/**
 * Formats localized pill text, tooltip, and tone class for a quota pace measurement.
 *
 * @param {ReturnType<typeof computeQuotaPace>} pace
 */
export function formatQuotaPaceSummary(pace) {
  if (!pace) return null;
  const cfg = PACE_STYLE_MAP[pace.status] || PACE_STYLE_MAP.on_pace;
  const exp = Math.round(pace.expectedPct);
  const absDelta = Math.round(Math.abs(pace.deltaPct));
  const expPrecision = pace.expectedPct.toFixed(1);
  const usedPrecision = pace.usedPct.toFixed(1);
  const signedDelta = `${pace.deltaPct >= 0 ? '+' : '-'}${Math.abs(pace.deltaPct).toFixed(1)}`;
  const text = t(cfg.labelKey, { delta: absDelta, exp });
  const tooltip =
    pace.paceRatio != null
      ? t('quota.paceTooltip', {
          exp: expPrecision,
          used: usedPrecision,
          signedDelta,
          ratio: pace.paceRatio.toFixed(2),
        })
      : t('quota.paceTooltipNoRatio', {
          exp: expPrecision,
          used: usedPrecision,
          signedDelta,
        });
  return {
    text,
    tooltip,
    toneClass: cfg.toneClass,
  };
}

function isCustomLocalWeekly(weekly) {
  if (!weekly || typeof weekly !== 'object') return false;
  if (typeof weekly.isCustomLocal === 'boolean') return weekly.isCustomLocal;
  return weekly.isOfficial === false && (weekly.usedPct != null || weekly.remainingPct != null);
}

/**
 * 归一化动态配额池列表；在官方配额尚未返回时回退预占 Gemini 与 Claude & GPT 两个标准池槽位。
 *
 * @param {object|null|undefined} quotas
 * @param {number} minuteTick
 * @param {{ isPending?: boolean, showQuotaPace?: boolean }} [options]
 * @returns {Array<object>}
 */
export function buildQuotaPoolItems(
  quotas,
  minuteTick = 0,
  { isPending = false, showQuotaPace = true } = {}
) {
  const safeQuotas = quotas || {};
  const activePool = safeQuotas.activePool || {};
  const rawPools =
    Array.isArray(safeQuotas.pools) && safeQuotas.pools.length > 0
      ? safeQuotas.pools
      : [
          { poolKey: 'Gemini', poolLabel: 'Gemini', family: 'Gemini' },
          { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', family: 'Claude & GPT' },
        ];
  const weekly = safeQuotas.weekly || {};
  const poolItems = rawPools.map((p) => {
    const key = p.poolKey || p.family || p.poolLabel || 'Other';
    const poolLabel = p.poolLabel || p.family || key;
    const isActivePool =
      Boolean(activePool.family) &&
      (activePool.poolKey === key ||
        activePool.family === p.family ||
        (key === 'Claude & GPT' && ['Claude', 'GPT'].includes(activePool.family)));
    return {
      key,
      poolLabel,
      poolData: p,
      fallbackWeekly: weekly,
      isActivePool,
      minuteTick,
      isPending,
      showQuotaPace: showQuotaPace !== false,
    };
  });
  if (
    isCustomLocalWeekly(weekly) &&
    poolItems.length > 0 &&
    !poolItems.some((item) => item.isActivePool)
  ) {
    poolItems[0].isActivePool = true;
  }
  return poolItems;
}

/**
 * 创建单个配额池的 DOM 行结构，内含 5h 限额与每周限额两个可独立显隐的子窗口进度条。
 */
export function createPoolQuotaRow() {
  const title5h = h('span', { className: 'quota-win-title', text: '5h' });
  const usage5h = h('span', { className: 'quota-win-usage', hidden: true, text: '' });
  const left5h = h('span', { className: 'quota-win-left' }, [title5h, usage5h]);
  const pacePill5h = h('span', { className: 'quota-pace-pill text-mono', hidden: true, text: '' });
  const meta5h = h('span', { className: 'panel-meta quota-win-meta text-mono', text: '--' });
  const metaGroup5h = h('span', { className: 'quota-win-meta-group' }, [pacePill5h, meta5h]);
  const fill5h = h('div', { className: 'progress-fill' });
  const paceMarker5h = h('span', {
    className: 'progress-pace-marker',
    hidden: true,
    'aria-hidden': 'true',
  });
  const track5h = h('div', { className: 'progress-track quota-progress-track' }, [
    fill5h,
    paceMarker5h,
  ]);
  const row5h = h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
    h('div', { className: 'panel-header quota-win-head' }, [left5h, metaGroup5h]),
    track5h,
  ]);

  const titleWk = h('span', { className: 'quota-win-title', text: t('quota.weeklyShort') });
  const usageWk = h('span', { className: 'quota-win-usage', hidden: true, text: '' });
  const leftWk = h('span', { className: 'quota-win-left' }, [titleWk, usageWk]);
  const pacePillWk = h('span', { className: 'quota-pace-pill text-mono', hidden: true, text: '' });
  const metaWk = h('span', { className: 'panel-meta quota-win-meta text-mono', text: '--' });
  const metaGroupWk = h('span', { className: 'quota-win-meta-group' }, [pacePillWk, metaWk]);
  const fillWk = h('div', { className: 'progress-fill' });
  const paceMarkerWk = h('span', {
    className: 'progress-pace-marker',
    hidden: true,
    'aria-hidden': 'true',
  });
  const trackWk = h('div', { className: 'progress-track quota-progress-track' }, [
    fillWk,
    paceMarkerWk,
  ]);
  const rowWk = h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
    h('div', { className: 'panel-header quota-win-head' }, [leftWk, metaGroupWk]),
    trackWk,
  ]);

  const el = h('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }, [
    row5h,
    rowWk,
  ]);

  return {
    el,
    refs: {
      row5h,
      left5h,
      title5h,
      usage5h,
      pacePill5h,
      meta5h,
      track5h,
      paceMarker5h,
      fill5h,
      rowWk,
      leftWk,
      titleWk,
      usageWk,
      pacePillWk,
      metaWk,
      trackWk,
      paceMarkerWk,
      fillWk,
    },
  };
}

/**
 * 格式化可用额度面板底部的汇总行文案（官方配额模式下展示各池周期合计，自定义预算模式下展示自然周累计）。
 */
export function formatQuotaSummaryFooter(quotas, account) {
  const weekly = quotas?.weekly || {};
  const isCustomLocal = isCustomLocalWeekly(weekly);
  const tokStr = formatTokens(weekly.tokens || 0);
  const costStr = formatUsd(weekly.costUsd || 0);
  const leftText = isCustomLocal
    ? t('quota.footTokensCustom', { tok: tokStr, cost: costStr })
    : t('quota.footTokensCycle', { tok: tokStr, cost: costStr });
  const rightText =
    Number(account?.aiCredits) > 0
      ? t('quota.footCredits', { credits: account.aiCredits })
      : isCustomLocal
        ? t('quota.footCallsCustom', { calls: weekly.calls || 0 })
        : t('quota.footCallsCycle', { calls: weekly.calls || 0 });
  const tooltip = isCustomLocal ? t('quota.footTipCustom') : t('quota.footTipCycle');
  return { leftText, rightText, tooltip };
}

function applyQuotaPace(pace, { showPace, trackEl, markerEl, pillEl }) {
  const summary = showPace && pace ? formatQuotaPaceSummary(pace) : null;
  if (summary) {
    markerEl.hidden = false;
    patchStyleVar(markerEl, '--pace-pos', `${pace.expectedPct.toFixed(1)}%`);
    patchClasses(trackEl, { 'has-pace-marker': true });
    patchAttr(trackEl, 'title', summary.tooltip);
    pillEl.hidden = false;
    patchText(pillEl, summary.text);
    patchAttr(pillEl, 'title', summary.tooltip);
    patchClasses(pillEl, {
      'pace-high': summary.toneClass === 'pace-high',
      'pace-ahead': summary.toneClass === 'pace-ahead',
      'pace-under': summary.toneClass === 'pace-under',
      'pace-on-pace': summary.toneClass === 'pace-on-pace',
    });
    return;
  }
  markerEl.hidden = true;
  patchClasses(trackEl, { 'has-pace-marker': false });
  patchAttr(trackEl, 'title', null);
  pillEl.hidden = true;
  patchText(pillEl, '');
  patchAttr(pillEl, 'title', null);
  patchClasses(pillEl, {
    'pace-high': false,
    'pace-ahead': false,
    'pace-under': false,
    'pace-on-pace': false,
  });
}

/**
 * 同步单个配额池行的 5h 与每周窗口状态。
 */
export function syncPoolQuotaRow(refs, item, idx, rowEl) {
  const { poolData, poolLabel, fallbackWeekly, isActivePool, isPending, showQuotaPace } = item;
  const showPace = showQuotaPace !== false;
  patchAttr(
    rowEl,
    'style',
    idx === 0
      ? 'display: flex; flex-direction: column; gap: 8px;'
      : 'display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-hairline);'
  );

  const has5h = poolData?.usedPct != null && poolData?.remainingPct != null;
  const used5hVal = has5h ? Number(poolData.usedPct) : 0;
  const rem5hVal = has5h ? Number(poolData.remainingPct) : 0;

  const useCustomWeekly = Boolean(isActivePool && isCustomLocalWeekly(fallbackWeekly));
  const wkUsedRaw = useCustomWeekly
    ? fallbackWeekly?.usedPct
    : poolData?.weeklyUsedPct ?? (isActivePool ? fallbackWeekly?.usedPct : null);
  const wkRemRaw = useCustomWeekly
    ? fallbackWeekly?.remainingPct
    : poolData?.weeklyRemainingPct ?? (isActivePool ? fallbackWeekly?.remainingPct : null);
  const wkResetRaw = useCustomWeekly
    ? fallbackWeekly?.resetTime || poolData?.weeklyResetTime
    : poolData?.weeklyResetTime || (isActivePool ? fallbackWeekly?.resetTime : null);
  const hasWk = wkUsedRaw != null && wkRemRaw != null;
  const usedWkVal = hasWk ? Number(wkUsedRaw) : 0;
  const remWkVal = hasWk ? Number(wkRemRaw) : 0;

  const hide5h = !has5h && hasWk;
  const hideWk = !hasWk && has5h;
  refs.row5h.hidden = hide5h;
  refs.row5h.style.display = hide5h ? 'none' : 'flex';
  refs.rowWk.hidden = hideWk;
  refs.rowWk.style.display = hideWk ? 'none' : 'flex';

  const fallbackMetaText = isPending ? t('quota.loading') : t('quota.failed');

  patchText(refs.title5h, `5h (${poolLabel})`);
  const c5h = poolData?.cycle5h;
  if (!isPending && has5h && c5h && (c5h.tokens != null || c5h.costUsd != null)) {
    const tok5h = formatTokens(c5h.tokens || 0);
    const cost5h = formatUsd(c5h.costUsd || 0);
    const calls5h = Number(c5h.calls || 0);
    refs.usage5h.hidden = false;
    patchText(refs.usage5h, `· ${tok5h} (${cost5h})`);
    patchAttr(
      refs.left5h,
      'title',
      t('quota.cycle5hTitle', {
        pool: poolLabel,
        tok: tok5h,
        cost: cost5h,
        calls: calls5h,
      })
    );
  } else {
    refs.usage5h.hidden = true;
    patchText(refs.usage5h, '');
    patchAttr(refs.left5h, 'title', null);
  }
  patchText(
    refs.meta5h,
    has5h
      ? t('quota.usedAndLeft', {
          reset: formatCountdown(poolData.resetTime),
          used: used5hVal.toFixed(1),
          rem: rem5hVal.toFixed(1),
        })
      : fallbackMetaText
  );
  patchStyleVar(refs.fill5h, '--fill-w', `${Math.min(100, used5hVal)}%`);
  patchClasses(refs.fill5h, {
    'tone-warn': used5hVal >= 70 && used5hVal < 85,
    'tone-danger': used5hVal >= 85,
  });
  const pace5h =
    has5h && !isPending
      ? computeQuotaPace({
          usedPct: used5hVal,
          resetTime: poolData.resetTime,
          windowMs: QUOTA_WINDOW_5H_MS,
        })
      : null;
  applyQuotaPace(pace5h, {
    showPace,
    trackEl: refs.track5h,
    markerEl: refs.paceMarker5h,
    pillEl: refs.pacePill5h,
  });

  const customTitle = useCustomWeekly
    ? t('quota.weeklyCustomLocal')
    : t('quota.weeklyPool', { pool: poolLabel });
  patchText(refs.titleWk, customTitle);
  const cWk = useCustomWeekly
    ? fallbackWeekly
    : poolData?.cycleWeekly || (isActivePool ? fallbackWeekly : null);
  if (!isPending && hasWk && cWk && (cWk.tokens != null || cWk.costUsd != null)) {
    const tokWk = formatTokens(cWk.tokens || 0);
    const costWk = formatUsd(cWk.costUsd || 0);
    const callsWk = Number(cWk.calls || 0);
    refs.usageWk.hidden = false;
    patchText(refs.usageWk, `· ${tokWk} (${costWk})`);
    patchAttr(
      refs.leftWk,
      'title',
      useCustomWeekly
        ? t('quota.cycleWkCustomTitle', { tok: tokWk, cost: costWk, calls: callsWk })
        : t('quota.cycleWkPoolTitle', {
            pool: poolLabel,
            tok: tokWk,
            cost: costWk,
            calls: callsWk,
          })
    );
  } else {
    refs.usageWk.hidden = true;
    patchText(refs.usageWk, '');
    patchAttr(refs.leftWk, 'title', null);
  }
  patchText(
    refs.metaWk,
    hasWk
      ? t('quota.usedAndLeft', {
          reset: formatCountdown(wkResetRaw),
          used: usedWkVal.toFixed(1),
          rem: remWkVal.toFixed(1),
        })
      : fallbackMetaText
  );
  patchStyleVar(refs.fillWk, '--fill-w', `${Math.min(100, usedWkVal)}%`);
  patchClasses(refs.fillWk, {
    'tone-warn': usedWkVal >= 70 && usedWkVal < 85,
    'tone-danger': usedWkVal >= 85,
  });
  const paceWk =
    hasWk && !isPending
      ? computeQuotaPace({
          usedPct: usedWkVal,
          resetTime: wkResetRaw,
          windowMs: QUOTA_WINDOW_WEEKLY_MS,
        })
      : null;
  applyQuotaPace(paceWk, {
    showPace,
    trackEl: refs.trackWk,
    markerEl: refs.paceMarkerWk,
    pillEl: refs.pacePillWk,
  });
}

export function quotaPoolRowSig(item, idx) {
  const c5h = item.poolData?.cycle5h;
  const cWk = item.poolData?.cycleWeekly;
  const fw = item.fallbackWeekly;
  return `${getEffectiveLocale()}:${idx}:${item.poolLabel}:${item.isActivePool}:${Boolean(item.isPending)}:${item.showQuotaPace !== false}:${item.minuteTick}:${item.poolData?.usedPct}:${item.poolData?.remainingPct}:${item.poolData?.resetTime}:${item.poolData?.weeklyUsedPct}:${item.poolData?.weeklyRemainingPct}:${item.poolData?.weeklyResetTime}:${c5h?.tokens}:${c5h?.costUsd}:${c5h?.calls}:${cWk?.tokens}:${cWk?.costUsd}:${cWk?.calls}:${fw?.isOfficial}:${fw?.isCustomLocal}:${fw?.usedPct}:${fw?.remainingPct}:${fw?.resetTime}:${fw?.title}:${fw?.tokens}:${fw?.costUsd}:${fw?.calls}`;
}

export const QuotaPoolsWidget = defineComponent({
  name: 'QuotaPoolsWidget',
  setup({ props }) {
    const compactHover = Boolean(props.compactHover);
    const titleTextEl = h('span', { text: t('module.quotas') });
    const tierBadge = h('span', { className: 'panel-meta', text: 'Google AI · Pro' });
    const poolsListEl = h(
      'div',
      compactHover
        ? { className: 'wm-hover-quota-pools' }
        : { style: 'display: flex; flex-direction: column; gap: 0;' }
    );

    if (compactHover) {
      patchKeyedList(poolsListEl, buildQuotaPoolItems(null, 0, { isPending: true }), {
        keyFn: (item) => item.key,
        sigFn: quotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncPoolQuotaRow,
      });
    }

    const initFoot = formatQuotaSummaryFooter(null, null);
    const wkFootLeft = h('span', { className: 'text-muted', text: initFoot.leftText });
    const wkFootRight = h('span', {
      className: 'text-muted',
      text: compactHover ? initFoot.rightText : '',
    });

    const quotaPanel = h('section', { className: 'panel quota-pools-panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          titleTextEl,
        ]),
        tierBadge,
      ]),
      poolsListEl,
      h(
        'div',
        compactHover
          ? { className: 'panel-header wm-hover-quota-foot' }
          : { className: 'panel-header', style: 'font-size: var(--fs-md); padding-top: 2px;' },
        [wkFootLeft, wkFootRight]
      ),
    ]);

    function update({ data, minuteTick } = {}) {
      patchText(titleTextEl, t('module.quotas'));
      if (!data) {
        if (compactHover) {
          patchKeyedList(poolsListEl, buildQuotaPoolItems(null, 0, { isPending: true }), {
            keyFn: (item) => item.key,
            sigFn: quotaPoolRowSig,
            createRow: createPoolQuotaRow,
            updateRow: syncPoolQuotaRow,
          });
          const pendingFoot = formatQuotaSummaryFooter(null, null);
          patchText(wkFootLeft, pendingFoot.leftText);
          patchText(wkFootRight, pendingFoot.rightText);
        }
        return;
      }

      const quotas = data.quotas || {};
      const showQuotaPace = data.settings?.showQuotaPace !== false;
      const effTick = Number.isFinite(minuteTick) ? minuteTick : Math.floor(Date.now() / 30000);
      patchText(
        tierBadge,
        `${data.account?.tierName || 'Google AI'} · ${data.account?.planName || 'Pro'}`
      );
      patchKeyedList(poolsListEl, buildQuotaPoolItems(quotas, effTick, { showQuotaPace }), {
        keyFn: (item) => item.key,
        sigFn: quotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncPoolQuotaRow,
      });

      const footSummary = formatQuotaSummaryFooter(quotas, data.account);
      patchText(wkFootLeft, footSummary.leftText);
      patchText(wkFootRight, footSummary.rightText);
      patchAttr(wkFootLeft, 'title', footSummary.tooltip);
      patchAttr(wkFootRight, 'title', footSummary.tooltip);
    }

    return {
      el: quotaPanel,
      refs: { update, poolsListEl },
    };
  },
});
