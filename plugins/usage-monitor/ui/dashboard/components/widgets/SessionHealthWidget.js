/**
 * @fileoverview Standalone Session Health diagnostics widget (`SessionHealthWidget.js`).
 * Renders prompt cache miss attribution, sustained cache collapse alerts, LLM vs. tool
 * active time split, effective TPS, >60s active gaps, context hygiene badges, and
 * prioritized diagnostic findings. Responsive across narrow `aux_pane` (~340px) and
 * wide `global` surfaces.
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
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { resolveScopedConversation } from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

const REASON_BREAKDOWN_DEFS = Object.freeze([
  { field: 'planModeSwitch', key: 'plan_mode_switch', tone: 'warn' },
  { field: 'modelSwitch', key: 'model_switch', tone: 'warn' },
  { field: 'errorRetry', key: 'error_retry', tone: 'danger' },
  { field: 'idleOrWaitGap', key: 'idle_or_wait_gap', tone: 'warn' },
  { field: 'activeSlowGap', key: 'active_slow_gap', tone: 'danger' },
  { field: 'asyncWakeupFast', key: 'async_wakeup_fast', tone: 'info' },
  { field: 'prefixOrReplicaMiss', key: 'prefix_or_replica_miss', tone: 'danger' },
  { field: 'compactionResets', key: 'compaction', tone: 'info' },
  { field: 'contextDilutionTurns', key: 'context_dilution', tone: 'warn' },
]);

function formatDurationShort(sec) {
  const num = Number(sec);
  if (!Number.isFinite(num) || num <= 0) return '0s';
  if (num < 60) return `${num < 10 ? num.toFixed(1) : Math.round(num)}s`;
  const mins = Math.floor(num / 60);
  const remSec = Math.round(num % 60);
  if (mins < 60) return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
}

export function formatFindingText(finding) {
  if (!finding || !finding.code) return '';
  const rawParams = finding.params && typeof finding.params === 'object' ? finding.params : {};
  const vars = { ...rawParams };
  if (typeof vars.topReason === 'string' && vars.topReason) {
    vars.topReason = t(`health.reason.${vars.topReason}`);
  }
  return t(`health.finding.${finding.code}`, vars);
}

function resolveHealthToneClass(status) {
  if (status === 'degraded') return 'is-degraded';
  if (status === 'warn') return 'is-warn';
  return 'is-healthy';
}

export const SessionHealthWidget = defineComponent({
  name: 'SessionHealthWidget',
  setup({ props }) {
    const getCtxAgentId =
      typeof props.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;

    const titleTextEl = h('span', { text: t('module.session_health') });
    const statusPillEl = h('span', {
      className: 'health-status-pill is-healthy',
      text: t('health.status.healthy'),
    });
    const metaSummaryEl = h('span', {
      className: 'health-meta-summary text-mono',
      text: '',
      hidden: true,
    });

    const emptyEl = h('div', {
      className: 'health-empty',
      text: t('health.empty'),
    });

    // Sustained cache collapse banner
    const collapseTextEl = h('span', { className: 'health-collapse-text' });
    const collapseBannerEl = h(
      'div',
      { className: 'health-collapse-banner', hidden: true, role: 'status' },
      [createSvgIcon('warning', { size: 12 }), collapseTextEl]
    );

    // Prompt Cache Attribution section
    const cacheTitleEl = h('span', { className: 'health-section-label', text: t('health.cacheHit') });
    const cacheHitValueEl = h('strong', { className: 'health-cache-pct text-mono', text: '0%' });
    const cacheMissMetaEl = h('span', { className: 'health-section-meta text-mono', text: '' });
    const reasonChipsEl = h('div', { className: 'health-reason-chips' });
    const cacheSectionEl = h('div', { className: 'health-section health-cache-section' }, [
      h('div', { className: 'health-section-head' }, [
        h('span', { className: 'health-section-left' }, [cacheTitleEl, cacheHitValueEl]),
        cacheMissMetaEl,
      ]),
      reasonChipsEl,
    ]);

    // Active Time (LLM vs Tools) + Effective TPS + Gaps >60s section
    const activeTimeLabelEl = h('span', {
      className: 'health-section-label',
      text: t('health.activeTimeTitle'),
    });
    const activeTimeTotalEl = h('strong', { className: 'health-active-total text-mono', text: '0s' });
    const effectiveTpsEl = h('span', {
      className: 'health-metric-chip text-mono',
      hidden: true,
    });
    const gapsBadgeEl = h('span', {
      className: 'health-gap-badge text-mono',
      hidden: true,
    });
    const llmSegEl = h('div', { className: 'health-time-seg is-llm' });
    const toolsSegEl = h('div', { className: 'health-time-seg is-tools' });
    const timeTrackEl = h('div', { className: 'progress-track health-time-track' }, [
      llmSegEl,
      toolsSegEl,
    ]);
    const llmLegendEl = h('span', { className: 'health-time-legend-item is-llm text-mono' });
    const toolsLegendEl = h('span', { className: 'health-time-legend-item is-tools text-mono' });
    const timingSectionEl = h('div', { className: 'health-section health-timing-section' }, [
      h('div', { className: 'health-section-head health-timing-head' }, [
        h('span', { className: 'health-section-left' }, [activeTimeLabelEl, activeTimeTotalEl]),
        h('span', { className: 'health-timing-badges' }, [effectiveTpsEl, gapsBadgeEl]),
      ]),
      timeTrackEl,
      h('div', { className: 'health-time-legend' }, [llmLegendEl, toolsLegendEl]),
    ]);

    // Context Hygiene badges row
    const hygieneLabelEl = h('span', {
      className: 'health-section-label',
      text: t('health.hygieneTitle'),
    });
    const hygieneChipsEl = h('div', { className: 'health-hygiene-chips' });
    const hygieneSectionEl = h('div', { className: 'health-section health-hygiene-section' }, [
      hygieneLabelEl,
      hygieneChipsEl,
    ]);

    // Diagnostic Findings list
    const findingsListEl = h('div', { className: 'health-findings-list', hidden: true });

    const bodyEl = h('div', { className: 'health-body', hidden: true }, [
      collapseBannerEl,
      cacheSectionEl,
      timingSectionEl,
      hygieneSectionEl,
      findingsListEl,
    ]);

    const panelEl = h('section', { className: 'panel health-panel' }, [
      h('div', { className: 'panel-header health-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('shield', { size: 13 }),
          titleTextEl,
        ]),
        h('span', { className: 'panel-meta health-header-meta' }, [metaSummaryEl, statusPillEl]),
      ]),
      emptyEl,
      bodyEl,
    ]);

    function resolveHealth(data) {
      if (!data || typeof data !== 'object') return null;
      const { scopedConv, aggregated, mainAgent } = resolveScopedConversation(
        data,
        'all',
        getCtxAgentId()
      );
      return (
        scopedConv?.sessionHealth ||
        aggregated?.sessionHealth ||
        mainAgent?.sessionHealth ||
        data.activeConversation?.sessionHealth ||
        null
      );
    }

    function update({ data } = {}) {
      const locale = getEffectiveLocale();
      patchText(titleTextEl, t('module.session_health'));
      patchText(cacheTitleEl, t('health.cacheHit'));
      patchText(activeTimeLabelEl, t('health.activeTimeTitle'));
      patchText(hygieneLabelEl, t('health.hygieneTitle'));
      patchText(emptyEl, t('health.empty'));

      const health = resolveHealth(data);
      const evaluatedSteps = Number(health?.evaluatedSteps || 0);

      if (!health || evaluatedSteps <= 0) {
        patchAttr(emptyEl, 'hidden', false);
        patchAttr(bodyEl, 'hidden', true);
        patchAttr(metaSummaryEl, 'hidden', true);
        patchAttr(statusPillEl, 'class', 'health-status-pill is-healthy');
        patchText(statusPillEl, t('health.status.healthy'));
        return;
      }

      patchAttr(emptyEl, 'hidden', true);
      patchAttr(bodyEl, 'hidden', false);

      // 1. Header status pill & summary meta
      const status =
        health.status === 'degraded' || health.status === 'warn' ? health.status : 'healthy';
      patchAttr(statusPillEl, 'class', `health-status-pill ${resolveHealthToneClass(status)}`);
      patchText(statusPillEl, t(`health.status.${status}`));

      const cacheHitPct = Number.isFinite(Number(health.cacheHitPct))
        ? Number(health.cacheHitPct)
        : 0;
      patchAttr(metaSummaryEl, 'hidden', false);
      patchText(metaSummaryEl, t('health.evaluatedSteps', { count: evaluatedSteps }));

      // 2. Sustained cache collapse banner
      const attr = health.cacheMissAttribution || {};
      const collapse = attr.sustainedCollapse || {};
      const activeStreak = Number(collapse.activeStreak || 0);
      const collapseRuns = Number(collapse.runs || 0);
      const collapseTurns = Number(collapse.turns || 0);
      const maxStreak = Number(collapse.maxStreak || 0);
      const showCollapse = activeStreak >= 3 || collapseRuns >= 1;
      patchAttr(collapseBannerEl, 'hidden', !showCollapse);
      if (showCollapse) {
        patchClasses(collapseBannerEl, { 'is-active-streak': activeStreak >= 3 });
        patchText(
          collapseTextEl,
          activeStreak >= 3
            ? t('health.collapseActive', { active: activeStreak, max: maxStreak })
            : t('health.collapseHistorical', {
                runs: collapseRuns,
                turns: collapseTurns,
                max: maxStreak,
              })
        );
      }

      // 3. Prompt Cache Miss Attribution
      const cacheTone =
        cacheHitPct >= 80
          ? 'tone-good'
          : cacheHitPct >= 50
            ? 'tone-warn'
            : 'tone-danger';
      patchAttr(cacheHitValueEl, 'class', `health-cache-pct text-mono ${cacheTone}`);
      patchText(cacheHitValueEl, `${cacheHitPct.toFixed(1)}%`);

      const totalMisses = Number(attr.total || 0);
      const eligibleTrans = Number(attr.eligibleTransitions || 0);
      if (totalMisses > 0) {
        patchText(
          cacheMissMetaEl,
          eligibleTrans > 0
            ? t('health.cacheMissesOf', { misses: totalMisses, eligible: eligibleTrans })
            : t('health.cacheMisses', { count: totalMisses })
        );
      } else {
        patchText(cacheMissMetaEl, t('health.noMisses'));
      }

      const reasonItems = [];
      for (const def of REASON_BREAKDOWN_DEFS) {
        const count = Number(attr[def.field] || 0);
        if (count > 0) {
          reasonItems.push({
            key: def.key,
            count,
            tone: def.tone,
            shortLabel: t(`health.reasonShort.${def.key}`),
            fullLabel: t(`health.reason.${def.key}`),
          });
        }
      }
      patchAttr(reasonChipsEl, 'hidden', reasonItems.length === 0);
      patchKeyedList(reasonChipsEl, reasonItems, {
        keyFn: (it) => it.key,
        sigFn: (it) => `${locale}:${it.key}:${it.count}:${it.tone}`,
        createRow: () => {
          const labelSpan = h('span', { className: 'health-chip-label' });
          const countSpan = h('strong', { className: 'health-chip-count text-mono' });
          const chip = h('span', { className: 'health-reason-chip' }, [labelSpan, countSpan]);
          return { el: chip, refs: { chip, labelSpan, countSpan } };
        },
        updateRow: (refs, it) => {
          patchAttr(refs.chip, 'class', `health-reason-chip is-${it.tone}`);
          patchAttr(refs.chip, 'title', `${it.fullLabel}: ${it.count}`);
          patchText(refs.labelSpan, it.shortLabel);
          patchText(refs.countSpan, `×${it.count}`);
        },
      });

      // 4. LLM vs Tools Active Time + Effective TPS + Gaps >60s
      const timing = health.timing || {};
      const llmSec = Number(timing.llmTimeSec || 0);
      const toolSec = Number(timing.toolExecTimeSec || 0);
      const activeSec = Number(timing.activeTimeSec || 0);
      const llmPct = Number.isFinite(Number(timing.llmSharePct)) ? Number(timing.llmSharePct) : 0;
      const toolPct = Number.isFinite(Number(timing.toolSharePct))
        ? Number(timing.toolSharePct)
        : 0;
      patchText(activeTimeTotalEl, formatDurationShort(activeSec));

      const hasEffTps =
        timing.effectiveTps != null &&
        Number.isFinite(Number(timing.effectiveTps)) &&
        Number(timing.effectiveTps) > 0;
      patchAttr(effectiveTpsEl, 'hidden', !hasEffTps);
      if (hasEffTps) {
        patchText(effectiveTpsEl, t('health.effectiveTps', { tps: Number(timing.effectiveTps).toFixed(1) }));
        patchAttr(effectiveTpsEl, 'title', t('health.effectiveTpsTitle'));
      }

      const activeGapsTotal = Number(timing.activeGapsTotal || 0);
      const gapsOver60s = Number(timing.gapsOver60s || 0);
      const over60sGapPct = Number(timing.over60sGapPct || 0);
      patchAttr(gapsBadgeEl, 'hidden', activeGapsTotal <= 0 && gapsOver60s <= 0);
      if (activeGapsTotal > 0 || gapsOver60s > 0) {
        const gapTone =
          activeGapsTotal >= 4 && over60sGapPct >= 25
            ? 'is-danger'
            : gapsOver60s >= 2 || (activeGapsTotal >= 4 && over60sGapPct >= 10)
              ? 'is-warn'
              : gapsOver60s > 0
                ? 'is-warn'
                : 'is-muted';
        patchAttr(gapsBadgeEl, 'class', `health-gap-badge text-mono ${gapTone}`);
        patchText(
          gapsBadgeEl,
          gapsOver60s > 0
            ? t('health.gapsBadge', { count: gapsOver60s, pct: Math.round(over60sGapPct) })
            : t('health.gapsZero')
        );
        patchAttr(
          gapsBadgeEl,
          'title',
          t('health.gapsTitle', { over: gapsOver60s, total: activeGapsTotal })
        );
      }

      patchStyleVar(llmSegEl, '--seg-w', `${activeSec > 0 ? Math.max(0, Math.min(100, llmPct)) : 0}%`);
      patchStyleVar(
        toolsSegEl,
        '--seg-w',
        `${activeSec > 0 ? Math.max(0, Math.min(100, toolPct)) : 0}%`
      );
      patchText(
        llmLegendEl,
        t('health.llmLabel', { pct: Math.round(llmPct), sec: formatDurationShort(llmSec) })
      );
      patchText(
        toolsLegendEl,
        timing.hasToolTimingTelemetry === false
          ? t('health.toolsLegacyHint')
          : t('health.toolsLabel', { pct: Math.round(toolPct), sec: formatDurationShort(toolSec) })
      );

      // 5. Context Hygiene Badges
      const hygiene = health.hygiene || {};
      const hygieneItems = [];
      const over150kTurns = Number(hygiene.over150kTurns || 0);
      const over150kRatioPct = Number(hygiene.over150kRatioPct || 0);
      if (over150kTurns > 0) {
        hygieneItems.push({
          key: 'over150k',
          tone: evaluatedSteps >= 5 && over150kRatioPct >= 50 ? 'warn' : 'info',
          text: t('health.hygieneOver150k', {
            count: over150kTurns,
            pct: Math.round(over150kRatioPct),
          }),
        });
      }
      const media150k = Number(hygiene.multimodalHighCtxTurns || 0);
      const media180k = Number(hygiene.multimodalOver180kTurns || 0);
      if (media180k > 0) {
        hygieneItems.push({
          key: 'media180k',
          tone: media180k >= 3 ? 'danger' : 'warn',
          text: t('health.hygieneMediaOver180k', { count: media180k }),
        });
      } else if (media150k > 0) {
        hygieneItems.push({
          key: 'media150k',
          tone: 'warn',
          text: t('health.hygieneMediaHighCtx', { count: media150k }),
        });
      }
      const toolTurns = Number(hygiene.toolTurns || 0);
      const singlePct = hygiene.singleToolTurnPct;
      const avgTools = hygiene.avgToolsPerToolTurn;
      if (
        hygiene.hasToolBatchTelemetry !== false &&
        toolTurns > 0 &&
        singlePct != null &&
        Number.isFinite(Number(singlePct))
      ) {
        hygieneItems.push({
          key: 'batching',
          tone: toolTurns >= 6 && Number(singlePct) >= 75 ? 'warn' : 'muted',
          text: t('health.hygieneBatching', {
            pct: Math.round(Number(singlePct)),
            avg: avgTools != null && Number.isFinite(Number(avgTools)) ? Number(avgTools).toFixed(1) : '1.0',
          }),
        });
      }
      if (hygieneItems.length === 0) {
        hygieneItems.push({
          key: 'clean',
          tone: 'good',
          text: t('health.hygieneClean'),
        });
      }

      patchKeyedList(hygieneChipsEl, hygieneItems, {
        keyFn: (it) => it.key,
        sigFn: (it) => `${locale}:${it.key}:${it.tone}:${it.text}`,
        createRow: () => {
          const badge = h('span', { className: 'health-hygiene-badge' });
          return { el: badge, refs: { badge } };
        },
        updateRow: (refs, it) => {
          patchAttr(refs.badge, 'class', `health-hygiene-badge is-${it.tone}`);
          patchText(refs.badge, it.text);
        },
      });

      // 6. Findings List
      const findings = Array.isArray(health.findings) ? health.findings.slice(0, 5) : [];
      patchAttr(findingsListEl, 'hidden', findings.length === 0);
      patchKeyedList(findingsListEl, findings, {
        keyFn: (f) => `${f.code}:${f.severity}`,
        sigFn: (f) => `${locale}:${f.code}:${f.severity}:${formatFindingText(f)}`,
        createRow: () => {
          const dotEl = h('span', { className: 'health-finding-dot', 'aria-hidden': 'true' });
          const textEl = h('span', { className: 'health-finding-text' });
          const row = h('div', { className: 'health-finding-item' }, [dotEl, textEl]);
          return { el: row, refs: { row, textEl } };
        },
        updateRow: (refs, f) => {
          const sev =
            f.severity === 'degraded' ? 'degraded' : f.severity === 'warn' ? 'warn' : 'info';
          patchAttr(refs.row, 'class', `health-finding-item is-${sev}`);
          patchText(refs.textEl, formatFindingText(f));
        },
      });
    }

    return {
      el: panelEl,
      refs: {
        update,
        statusPillEl,
        collapseBannerEl,
        reasonChipsEl,
        hygieneChipsEl,
        findingsListEl,
      },
    };
  },
});
