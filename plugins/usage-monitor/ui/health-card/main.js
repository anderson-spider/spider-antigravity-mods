/**
 * @fileoverview Inline Chat Health Card MCP App (`ui/health-card/main.js`).
 *
 * Uses `@modelcontextprotocol/ext-apps` (`App`, `applyDocumentTheme`,
 * `applyHostStyleVariables`, `applyHostFonts`).
 * - Registers `ontoolinput`, `ontoolresult`, `onhostcontextchanged` BEFORE `app.connect()`.
 * - Renders immediately from `ontoolresult` (`result.structuredContent`).
 * - Supports bilingual `en-US` / `pt-BR` driven by `ctx.locale`.
 * - Exposes Refresh (`usage_monitor_api` GET `/api/session-health`) and, ONLY when
 *   `app.getHostCapabilities()?.updateModelContext` is truthy, "Attach diagnosis to context"
 *   calling `app.updateModelContext(...)` (never `sendMessage`).
 */

import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const APP_VERSION = '2.0.0';

const COPY = Object.freeze({
  'en-US': {
    title: 'Session Health',
    loading: 'Loading session health diagnostics…',
    empty: 'No session health data available yet.',
    errorPrefix: 'Unable to load session health: ',
    statusHealthy: 'Healthy',
    statusWarn: 'Attention',
    statusDegraded: 'Degraded',
    kpiCacheHit: 'Cache Hit',
    kpiEffTps: 'Effective TPS',
    kpiContext: 'Context',
    kpiSteps: 'Steps',
    subSteps: '{count} steps',
    subSubs: '{count} sub',
    missBreakdown: 'Prompt Cache Attribution',
    missesOf: '{misses}/{eligible} misses',
    noMisses: 'No cache misses',
    activeTime: 'Active Time (LLM vs. Tools)',
    llmPart: 'LLM {pct}% ({sec})',
    toolsPart: 'Tools {pct}% ({sec})',
    toolsLegacy: 'Tool timing N/A (legacy cache)',
    gapsOver60: '{count} gaps >60s ({pct}%)',
    gapsZero: '0 gaps >60s',
    hygiene: 'Context Hygiene',
    hygieneOver150k: '>150k ctx: {count} ({pct}%)',
    hygieneMedia150k: 'Media ≥150k: {count}',
    hygieneMedia180k: 'Media ≥180k: {count}',
    hygieneBatching: '1-tool turns: {pct}% ({avg} avg)',
    hygieneClean: 'Clean context & batching',
    collapseActive: 'Active cache collapse: {active} consecutive misses (max {max}×)',
    collapseHistorical: 'Sustained cache collapse: {runs} run(s), {turns} turns (max {max}×)',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    attach: 'Attach diagnosis to context',
    attached: 'Diagnosis attached to next message context.',
    attachFailed: 'Could not attach diagnosis to context.',
    reasons: {
      plan_mode_switch: 'Plan mode switch',
      model_switch: 'Model switch',
      error_retry: 'Error / retry',
      idle_or_wait_gap: 'Idle / wait gap',
      active_slow_gap: 'Slow active gap',
      async_wakeup_fast: 'Async wakeup',
      prefix_or_replica_miss: 'Prefix / replica miss',
      context_dilution: 'Context dilution',
      compaction: 'Compaction reset',
    },
    findings: {
      sustained_cache_collapse:
        'Sustained cache collapse: {runs} run(s), {turns} turns (max {maxStreak}×, active {activeStreak}×)',
      high_cache_miss_rate:
        'High cache miss rate: {missPct}% ({misses}/{eligible}), top cause: {topReason}',
      active_slow_gaps:
        'Frequent active gaps >60s: {gapsOver60s}/{activeGapsTotal} ({over60sGapPct}%)',
      multimodal_high_context:
        'Multimodal media in high context: {turns150k} turns ≥150k ({turns180k} ≥180k)',
      high_context_pressure:
        'High context pressure: {over150kTurns}/{evaluatedSteps} steps ≥150k ({over150kRatioPct}%)',
      low_tool_batching:
        'Low tool batching: {singleToolTurnPct}% single-tool turns ({singleToolTurns}/{toolTurns}, avg {avgToolsPerToolTurn})',
      tool_time_dominant:
        'Tool execution dominates active time: {toolSharePct}% ({toolExecTimeSec}s / {activeTimeSec}s)',
    },
  },
  'pt-BR': {
    title: 'Saúde da sessão',
    loading: 'Carregando diagnóstico de saúde da sessão…',
    empty: 'Nenhum dado de saúde da sessão disponível ainda.',
    errorPrefix: 'Falha ao carregar saúde da sessão: ',
    statusHealthy: 'Saudável',
    statusWarn: 'Atenção',
    statusDegraded: 'Degradada',
    kpiCacheHit: 'Acerto de cache',
    kpiEffTps: 'TPS efetivo',
    kpiContext: 'Contexto',
    kpiSteps: 'Etapas',
    subSteps: '{count} etapas',
    subSubs: '{count} sub',
    missBreakdown: 'Atribuição de perdas de cache',
    missesOf: '{misses}/{eligible} perdas',
    noMisses: 'Sem perdas de cache',
    activeTime: 'Tempo ativo (LLM vs. Ferramentas)',
    llmPart: 'LLM {pct}% ({sec})',
    toolsPart: 'Ferramentas {pct}% ({sec})',
    toolsLegacy: 'Tempo de ferramentas N/D (cache legado)',
    gapsOver60: '{count} pausas >60s ({pct}%)',
    gapsZero: '0 pausas >60s',
    hygiene: 'Higiene de contexto',
    hygieneOver150k: 'Ctx >150k: {count} ({pct}%)',
    hygieneMedia150k: 'Mídia ≥150k: {count}',
    hygieneMedia180k: 'Mídia ≥180k: {count}',
    hygieneBatching: 'Turnos 1-tool: {pct}% (méd {avg})',
    hygieneClean: 'Contexto e agrupamento saudáveis',
    collapseActive: 'Colapso de cache ativo: {active} perdas seguidas (máx {max}×)',
    collapseHistorical: 'Colapso contínuo de cache: {runs} ocorrência(s), {turns} turnos (máx {max}×)',
    refresh: 'Atualizar',
    refreshing: 'Atualizando…',
    attach: 'Anexar diagnóstico ao contexto',
    attached: 'Diagnóstico anexado ao contexto da próxima mensagem.',
    attachFailed: 'Não foi possível anexar o diagnóstico.',
    reasons: {
      plan_mode_switch: 'Troca de modo de plano',
      model_switch: 'Troca de modelo',
      error_retry: 'Erro / retry',
      idle_or_wait_gap: 'Pausa ociosa / espera',
      active_slow_gap: 'Intervalo ativo lento',
      async_wakeup_fast: 'Despertar assíncrono',
      prefix_or_replica_miss: 'Prefixo / réplica',
      context_dilution: 'Diluição de contexto',
      compaction: 'Compactação',
    },
    findings: {
      sustained_cache_collapse:
        'Colapso contínuo de cache: {runs} ocorrência(s), {turns} turnos (máx {maxStreak}×, ativo {activeStreak}×)',
      high_cache_miss_rate:
        'Alta taxa de perda de cache: {missPct}% ({misses}/{eligible}), causa principal: {topReason}',
      active_slow_gaps:
        'Pausas ativas >60s frequentes: {gapsOver60s}/{activeGapsTotal} ({over60sGapPct}%)',
      multimodal_high_context:
        'Mídia em contexto alto: {turns150k} turnos ≥150k ({turns180k} ≥180k)',
      high_context_pressure:
        'Alta pressão de contexto: {over150kTurns}/{evaluatedSteps} etapas ≥150k ({over150kRatioPct}%)',
      low_tool_batching:
        'Baixo agrupamento de tools: {singleToolTurnPct}% turnos com 1 tool ({singleToolTurns}/{toolTurns}, méd {avgToolsPerToolTurn})',
      tool_time_dominant:
        'Execução de ferramentas domina o tempo ativo: {toolSharePct}% ({toolExecTimeSec}s / {activeTimeSec}s)',
    },
  },
});

const REASON_DEFS = Object.freeze([
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

export function resolveCardLocale(rawLocale) {
  const clean = String(rawLocale || '').trim().toLowerCase();
  if (clean.startsWith('pt')) return 'pt-BR';
  if (clean) return 'en-US';
  try {
    if (typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('pt')) {
      return 'pt-BR';
    }
  } catch {
    // ignore
  }
  return 'en-US';
}

function interpolate(template, vars) {
  if (!vars || typeof template !== 'string') return String(template || '');
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}

function fmtTokens(n) {
  const val = Number(n || 0);
  if (!Number.isFinite(val) || val <= 0) return '0';
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(Math.round(val));
}

function fmtDuration(sec) {
  const n = Number(sec || 0);
  if (!Number.isFinite(n) || n <= 0) return '0s';
  if (n < 60) return `${n < 10 ? n.toFixed(1) : Math.round(n)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function formatFindingForLocale(finding, locale = 'en-US') {
  const dict = COPY[locale] || COPY['en-US'];
  const tpl = dict.findings?.[finding?.code];
  if (!tpl) return String(finding?.code || '');
  const vars = { ...(finding?.params || {}) };
  if (typeof vars.topReason === 'string' && dict.reasons?.[vars.topReason]) {
    vars.topReason = dict.reasons[vars.topReason];
  }
  return interpolate(tpl, vars);
}

export function formatHealthContextAttachment(payload, locale = 'en-US') {
  const dict = COPY[locale] || COPY['en-US'];
  const conv = payload?.conversation || {};
  const ctx = payload?.context || {};
  const health = payload?.sessionHealth || {};
  const attr = health.cacheMissAttribution || {};
  const timing = health.timing || {};
  const hygiene = health.hygiene || {};
  const status = String(health.status || 'healthy').toUpperCase();
  const title = conv.title || conv.cascadeId || 'current session';
  const model = conv.activeModelShort || conv.activeModelLabel || 'unknown';
  const lines = [
    `[Usage Monitor Session Health] Status: ${status} | Session: ${title} | Model: ${model} | Steps: ${Number(health.evaluatedSteps || conv.stepCount || 0)}`,
  ];

  const reasons = REASON_DEFS.filter((d) => Number(attr[d.field] || 0) > 0)
    .map((d) => `${d.key}=${attr[d.field]}`)
    .join(', ');
  const collapse = attr.sustainedCollapse || {};
  const collapsePart =
    Number(collapse.activeStreak || 0) >= 3
      ? ` | Active collapse streak: ${collapse.activeStreak}x (max ${collapse.maxStreak}x)`
      : Number(collapse.runs || 0) >= 1
        ? ` | Collapse runs: ${collapse.runs} (${collapse.turns} turns, max ${collapse.maxStreak}x)`
        : '';
  lines.push(
    `Prompt Cache: ${Number(health.cacheHitPct || 0).toFixed(1)}% hit | Misses: ${Number(attr.total || 0)}/${Number(attr.eligibleTransitions || 0)}${reasons ? ` (${reasons})` : ''}${collapsePart}`
  );
  lines.push(
    `Active Time: ${fmtDuration(timing.activeTimeSec)} (LLM ${Number(timing.llmSharePct || 0).toFixed(0)}% / Tools ${Number(timing.toolSharePct || 0).toFixed(0)}%) | Effective TPS: ${timing.effectiveTps != null ? `${Number(timing.effectiveTps).toFixed(1)} tok/s` : 'N/A'} | Active Gaps >60s: ${Number(timing.gapsOver60s || 0)}/${Number(timing.activeGapsTotal || 0)} (${Number(timing.over60sGapPct || 0).toFixed(1)}%)`
  );
  lines.push(
    `Context: ${fmtTokens(ctx.totalTokens)}/${fmtTokens(ctx.limitTokens)} (${Number(ctx.usedPct || 0).toFixed(1)}%) | >150k turns: ${Number(hygiene.over150kTurns || 0)} | Media >=150k: ${Number(hygiene.multimodalHighCtxTurns || 0)} (>=180k: ${Number(hygiene.multimodalOver180kTurns || 0)}) | 1-tool turns: ${hygiene.singleToolTurnPct != null ? `${Number(hygiene.singleToolTurnPct).toFixed(1)}%` : 'N/A'}`
  );
  const findings = Array.isArray(health.findings) ? health.findings : [];
  if (findings.length > 0) {
    lines.push(
      `Findings: ${findings.map((f) => formatFindingForLocale(f, locale)).join('; ')}`
    );
  }
  return lines.join('\n');
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'onClick') node.addEventListener('click', v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child !== undefined && child !== null && child !== false) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
}

function mountHealthCard() {
  const rootEl = document.getElementById('health-card-root');
  if (!rootEl) return;

  let currentLocale = resolveCardLocale('');
  let currentPayload = null;
  let currentConversationId = '';
  let loading = true;
  let refreshing = false;
  let errorMsg = '';
  let feedbackMsg = '';
  let canUpdateContext = false;

  const app = new App({ name: 'Usage Monitor Health Card', version: APP_VERSION }, {});

  function applyHostContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    if (ctx.theme) {
      applyDocumentTheme(ctx.theme);
      document.documentElement.setAttribute('data-theme', ctx.theme);
      document.documentElement.style.colorScheme = ctx.theme;
    }
    if (ctx.styles?.variables) {
      applyHostStyleVariables(ctx.styles.variables);
    }
    if (ctx.styles?.css?.fonts && typeof applyHostFonts === 'function') {
      applyHostFonts(ctx.styles.css.fonts);
    }
    if (ctx.locale) {
      const nextLocale = resolveCardLocale(ctx.locale);
      if (nextLocale !== currentLocale) {
        currentLocale = nextLocale;
        render();
      }
    }
  }

  async function handleRefresh() {
    if (refreshing) return;
    refreshing = true;
    errorMsg = '';
    feedbackMsg = '';
    render();
    try {
      const res = await app.callServerTool({
        name: 'usage_monitor_api',
        arguments: {
          path: '/api/session-health',
          method: 'GET',
          ...(currentConversationId ? { query: { conversationId: currentConversationId } } : {}),
        },
      });
      const structured = res?.structuredContent;
      if (structured && structured.ok && structured.data && typeof structured.data === 'object') {
        currentPayload = structured.data;
        if (currentPayload.conversation?.cascadeId) {
          currentConversationId = String(currentPayload.conversation.cascadeId);
        }
      } else if (structured?.data?.error) {
        errorMsg = String(structured.data.error);
      } else if (res?.isError) {
        errorMsg = 'Request failed';
      }
    } catch (err) {
      errorMsg = err?.message || String(err);
    } finally {
      loading = false;
      refreshing = false;
      render();
    }
  }

  async function handleAttachContext() {
    if (!canUpdateContext || !currentPayload) return;
    const dict = COPY[currentLocale] || COPY['en-US'];
    try {
      const text = formatHealthContextAttachment(currentPayload, currentLocale);
      await app.updateModelContext({
        content: [{ type: 'text', text }],
      });
      feedbackMsg = dict.attached;
    } catch {
      feedbackMsg = dict.attachFailed;
    }
    render();
  }

  function render() {
    const dict = COPY[currentLocale] || COPY['en-US'];
    rootEl.textContent = '';

    if (loading && !currentPayload) {
      rootEl.appendChild(el('div', { className: 'hc-empty', text: dict.loading }));
      return;
    }

    if (errorMsg && !currentPayload) {
      rootEl.appendChild(el('div', { className: 'hc-empty', text: `${dict.errorPrefix}${errorMsg}` }));
      return;
    }

    const payload = currentPayload;
    const health = payload?.sessionHealth;
    if (!payload || !health) {
      rootEl.appendChild(el('div', { className: 'hc-empty', text: dict.empty }));
      return;
    }

    const conv = payload.conversation || {};
    const ctx = payload.context || {};
    const attr = health.cacheMissAttribution || {};
    const collapse = attr.sustainedCollapse || {};
    const timing = health.timing || {};
    const hygiene = health.hygiene || {};
    const status =
      health.status === 'degraded' || health.status === 'warn' ? health.status : 'healthy';
    const statusLabel =
      status === 'degraded'
        ? dict.statusDegraded
        : status === 'warn'
          ? dict.statusWarn
          : dict.statusHealthy;

    const sessionMetaParts = [];
    if (conv.title) sessionMetaParts.push(conv.title);
    if (conv.activeModelShort || conv.activeModelLabel) {
      sessionMetaParts.push(conv.activeModelShort || conv.activeModelLabel);
    }
    if (Number(conv.subagentCount || 0) > 0) {
      sessionMetaParts.push(interpolate(dict.subSubs, { count: conv.subagentCount }));
    }

    // Header
    rootEl.appendChild(
      el('div', { className: 'hc-header' }, [
        el('div', { className: 'hc-title-wrap' }, [
          el('div', { className: 'hc-title-row' }, [
            el('span', { className: 'hc-title', text: dict.title }),
          ]),
          sessionMetaParts.length > 0
            ? el('div', {
                className: 'hc-session-meta',
                text: sessionMetaParts.join(' · '),
                title: sessionMetaParts.join(' · '),
              })
            : null,
        ]),
        el('span', { className: `hc-status-pill is-${status}`, text: statusLabel }),
      ])
    );

    // Sustained Collapse Banner
    const activeStreak = Number(collapse.activeStreak || 0);
    const collapseRuns = Number(collapse.runs || 0);
    if (activeStreak >= 3 || collapseRuns >= 1) {
      const bannerText =
        activeStreak >= 3
          ? interpolate(dict.collapseActive, {
              active: activeStreak,
              max: Number(collapse.maxStreak || activeStreak),
            })
          : interpolate(dict.collapseHistorical, {
              runs: collapseRuns,
              turns: Number(collapse.turns || 0),
              max: Number(collapse.maxStreak || 0),
            });
      rootEl.appendChild(el('div', { className: 'hc-banner', text: bannerText }));
    }

    // KPI Row
    const cachePct = Number(health.cacheHitPct || 0);
    const cacheTone = cachePct >= 80 ? 'is-good' : cachePct >= 50 ? 'is-warn' : 'is-danger';
    const usedPct = Number(ctx.usedPct || 0);
    const ctxTone = usedPct >= 88 ? 'is-danger' : usedPct >= 70 ? 'is-warn' : '';
    const effTps =
      timing.effectiveTps != null && Number.isFinite(Number(timing.effectiveTps))
        ? `${Number(timing.effectiveTps).toFixed(1)} t/s`
        : '—';

    rootEl.appendChild(
      el('div', { className: 'hc-kpi-grid' }, [
        el('div', { className: 'hc-kpi' }, [
          el('span', { className: 'hc-kpi-label', text: dict.kpiCacheHit }),
          el('span', { className: `hc-kpi-val ${cacheTone}`, text: `${cachePct.toFixed(1)}%` }),
          el('span', {
            className: 'hc-kpi-sub',
            text:
              Number(attr.total || 0) > 0
                ? interpolate(dict.missesOf, {
                    misses: Number(attr.total || 0),
                    eligible: Number(attr.eligibleTransitions || 0),
                  })
                : dict.noMisses,
          }),
        ]),
        el('div', { className: 'hc-kpi' }, [
          el('span', { className: 'hc-kpi-label', text: dict.kpiEffTps }),
          el('span', { className: 'hc-kpi-val', text: effTps }),
          el('span', {
            className: 'hc-kpi-sub',
            text: fmtDuration(timing.activeTimeSec),
          }),
        ]),
        el('div', { className: 'hc-kpi' }, [
          el('span', { className: 'hc-kpi-label', text: dict.kpiContext }),
          el('span', {
            className: `hc-kpi-val${ctxTone ? ` ${ctxTone}` : ''}`,
            text: `${usedPct.toFixed(1)}%`,
          }),
          el('span', {
            className: 'hc-kpi-sub',
            text: `${fmtTokens(ctx.totalTokens)} / ${fmtTokens(ctx.limitTokens)}`,
          }),
        ]),
        el('div', { className: 'hc-kpi' }, [
          el('span', { className: 'hc-kpi-label', text: dict.kpiSteps }),
          el('span', {
            className: 'hc-kpi-val',
            text: String(Number(health.evaluatedSteps || conv.stepCount || 0)),
          }),
          el('span', {
            className: 'hc-kpi-sub',
            text:
              Number(timing.gapsOver60s || 0) > 0
                ? interpolate(dict.gapsOver60, {
                    count: Number(timing.gapsOver60s || 0),
                    pct: Math.round(Number(timing.over60sGapPct || 0)),
                  })
                : dict.gapsZero,
          }),
        ]),
      ])
    );

    // Cache Miss Attribution Chips
    const activeReasons = REASON_DEFS.filter((d) => Number(attr[d.field] || 0) > 0);
    if (activeReasons.length > 0) {
      rootEl.appendChild(
        el('div', { className: 'hc-section' }, [
          el('div', { className: 'hc-section-head' }, [
            el('span', { className: 'hc-section-label', text: dict.missBreakdown }),
            el('span', {
              className: 'hc-section-meta',
              text: interpolate(dict.missesOf, {
                misses: Number(attr.total || 0),
                eligible: Number(attr.eligibleTransitions || 0),
              }),
            }),
          ]),
          el(
            'div',
            { className: 'hc-chips' },
            activeReasons.map((def) =>
              el('span', { className: `hc-chip is-${def.tone}` }, [
                document.createTextNode(`${dict.reasons[def.key] || def.key} `),
                el('strong', { text: `×${attr[def.field]}` }),
              ])
            )
          ),
        ])
      );
    }

    // Active Time Bar (LLM vs Tools)
    const llmPct = Math.max(0, Math.min(100, Number(timing.llmSharePct || 0)));
    const toolPct = Math.max(0, Math.min(100, Number(timing.toolSharePct || 0)));
    const llmBar = el('div', { className: 'hc-bar-seg is-llm' });
    const toolBar = el('div', { className: 'hc-bar-seg is-tools' });
    llmBar.style.width = `${Number(timing.activeTimeSec || 0) > 0 ? llmPct : 0}%`;
    toolBar.style.width = `${Number(timing.activeTimeSec || 0) > 0 ? toolPct : 0}%`;

    rootEl.appendChild(
      el('div', { className: 'hc-section' }, [
        el('div', { className: 'hc-section-head' }, [
          el('span', { className: 'hc-section-label', text: dict.activeTime }),
          el('span', { className: 'hc-section-meta', text: fmtDuration(timing.activeTimeSec) }),
        ]),
        el('div', { className: 'hc-bar-track' }, [llmBar, toolBar]),
        el('div', { className: 'hc-bar-legend' }, [
          el('span', { className: 'hc-legend-item' }, [
            el('span', { className: 'hc-legend-dot is-llm' }),
            document.createTextNode(
              interpolate(dict.llmPart, {
                pct: Math.round(llmPct),
                sec: fmtDuration(timing.llmTimeSec),
              })
            ),
          ]),
          el('span', { className: 'hc-legend-item' }, [
            el('span', { className: 'hc-legend-dot is-tools' }),
            document.createTextNode(
              timing.hasToolTimingTelemetry === false
                ? dict.toolsLegacy
                : interpolate(dict.toolsPart, {
                    pct: Math.round(toolPct),
                    sec: fmtDuration(timing.toolExecTimeSec),
                  })
            ),
          ]),
        ]),
      ])
    );

    // Context Hygiene
    const hygieneChips = [];
    if (Number(hygiene.over150kTurns || 0) > 0) {
      hygieneChips.push(
        el('span', {
          className: `hc-chip ${Number(hygiene.over150kRatioPct || 0) >= 50 ? 'is-warn' : 'is-info'}`,
          text: interpolate(dict.hygieneOver150k, {
            count: Number(hygiene.over150kTurns || 0),
            pct: Math.round(Number(hygiene.over150kRatioPct || 0)),
          }),
        })
      );
    }
    if (Number(hygiene.multimodalOver180kTurns || 0) > 0) {
      hygieneChips.push(
        el('span', {
          className: `hc-chip ${Number(hygiene.multimodalOver180kTurns || 0) >= 3 ? 'is-danger' : 'is-warn'}`,
          text: interpolate(dict.hygieneMedia180k, {
            count: Number(hygiene.multimodalOver180kTurns || 0),
          }),
        })
      );
    } else if (Number(hygiene.multimodalHighCtxTurns || 0) > 0) {
      hygieneChips.push(
        el('span', {
          className: 'hc-chip is-warn',
          text: interpolate(dict.hygieneMedia150k, {
            count: Number(hygiene.multimodalHighCtxTurns || 0),
          }),
        })
      );
    }
    if (
      hygiene.hasToolBatchTelemetry !== false &&
      Number(hygiene.toolTurns || 0) > 0 &&
      hygiene.singleToolTurnPct != null
    ) {
      const warnBatch = Number(hygiene.toolTurns || 0) >= 6 && Number(hygiene.singleToolTurnPct) >= 75;
      hygieneChips.push(
        el('span', {
          className: `hc-chip${warnBatch ? ' is-warn' : ''}`,
          text: interpolate(dict.hygieneBatching, {
            pct: Math.round(Number(hygiene.singleToolTurnPct)),
            avg:
              hygiene.avgToolsPerToolTurn != null
                ? Number(hygiene.avgToolsPerToolTurn).toFixed(1)
                : '1.0',
          }),
        })
      );
    }
    if (hygieneChips.length === 0) {
      hygieneChips.push(el('span', { className: 'hc-chip is-good', text: dict.hygieneClean }));
    }
    rootEl.appendChild(
      el('div', { className: 'hc-section' }, [
        el('span', { className: 'hc-section-label', text: dict.hygiene }),
        el('div', { className: 'hc-chips' }, hygieneChips),
      ])
    );

    // Findings
    const findings = Array.isArray(health.findings) ? health.findings.slice(0, 5) : [];
    if (findings.length > 0) {
      rootEl.appendChild(
        el(
          'div',
          { className: 'hc-findings' },
          findings.map((f) => {
            const sev =
              f.severity === 'degraded' ? 'degraded' : f.severity === 'warn' ? 'warn' : 'info';
            return el('div', { className: `hc-finding is-${sev}` }, [
              el('span', { className: 'hc-finding-dot', 'aria-hidden': 'true' }),
              el('span', { text: formatFindingForLocale(f, currentLocale) }),
            ]);
          })
        )
      );
    }

    // Action Bar
    const actionButtons = [
      el('button', {
        type: 'button',
        className: 'hc-btn',
        disabled: refreshing,
        text: refreshing ? dict.refreshing : dict.refresh,
        onClick: () => {
          void handleRefresh();
        },
      }),
    ];
    if (canUpdateContext) {
      actionButtons.push(
        el('button', {
          type: 'button',
          className: 'hc-btn is-primary',
          text: dict.attach,
          onClick: () => {
            void handleAttachContext();
          },
        })
      );
    }

    rootEl.appendChild(
      el('div', { className: 'hc-actions' }, [
        el('div', { className: 'hc-btn-group' }, actionButtons),
        feedbackMsg
          ? el('span', { className: 'hc-feedback', text: feedbackMsg })
          : errorMsg
            ? el('span', { className: 'hc-feedback', text: errorMsg })
            : null,
      ])
    );
  }

  // Register lifecycle handlers BEFORE connect() so initial notifications are never missed.
  app.ontoolinput = ({ arguments: args } = {}) => {
    if (args && typeof args.conversationId === 'string' && args.conversationId.trim()) {
      currentConversationId = args.conversationId.trim();
    }
    if (!currentPayload) {
      loading = true;
      render();
    }
  };

  app.ontoolresult = (result) => {
    loading = false;
    errorMsg = '';
    if (result?.isError) {
      const errText = Array.isArray(result.content)
        ? result.content
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join(' ')
        : 'Failed to load session health';
      errorMsg = errText;
    } else if (result?.structuredContent && typeof result.structuredContent === 'object') {
      currentPayload = result.structuredContent;
      if (currentPayload.conversation?.cascadeId) {
        currentConversationId = String(currentPayload.conversation.cascadeId);
      }
    }
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    applyHostContext(ctx);
  };

  render();

  void app
    .connect()
    .then(() => {
      applyHostContext(app.getHostContext());
      canUpdateContext = Boolean(app.getHostCapabilities()?.updateModelContext);
      render();
    })
    .catch((err) => {
      loading = false;
      errorMsg = err?.message || 'Failed to connect to host';
      render();
    });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', mountHealthCard);
  } else {
    mountHealthCard();
  }
}
