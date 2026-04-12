'use strict';

/**
 * Transparent macro/news/calendar scoring on top of phase-1 universe scores.
 * No execution; all components inspectable.
 */

const macroCalendarProvider = require('./macroCalendarProvider');
const newsSignalProvider = require('./newsSignalProvider');

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function parseBool(v, defaultValue = false) {
  if (v === undefined || v === null || v === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

/**
 * Per-symbol macro theme sensitivity [0,1] by theme key.
 */
function getSymbolMacroSensitivityMap() {
  return Object.freeze({
    XAUUSD: { usd: 0.9, inflation: 0.9, rates: 0.8, riskOff: 0.8, centralBank: 0.6, growth: 0.4 },
    EURUSD: { usd: 0.95, rates: 0.75, inflation: 0.6, growth: 0.5, centralBank: 0.7 },
    USDJPY: { usd: 0.9, rates: 0.85, riskOff: 0.7, centralBank: 0.8, inflation: 0.5 },
    BTCUSD: { usd: 0.5, riskOn: 0.9, liquidity: 0.8, sentiment: 0.9, inflation: 0.3 },
    NAS100USD: { rates: 0.9, riskOn: 0.85, growth: 0.75, tech: 0.8, inflation: 0.45 },
    SPX500USD: { rates: 0.75, riskOn: 0.75, growth: 0.75, broadRisk: 0.8, inflation: 0.5 },
    ETHUSD: { usd: 0.45, riskOn: 0.85, liquidity: 0.75, sentiment: 0.85 },
    GBPUSD: { usd: 0.85, rates: 0.7, inflation: 0.55, centralBank: 0.65 },
  });
}

function getMacroScoringConfig(overrides = {}) {
  const e = process.env;
  const maxBoost = parseFloat(e.DYNAMIC_UNIVERSE_MACRO_MAX_BOOST || '0.25');
  return {
    macroEnabled: parseBool(e.DYNAMIC_UNIVERSE_MACRO_ENABLED, false),
    newsEnabled: parseBool(e.DYNAMIC_UNIVERSE_NEWS_ENABLED, false),
    calendarEnabled: parseBool(e.DYNAMIC_UNIVERSE_CALENDAR_ENABLED, false),
    maxMacroBoost: Number.isFinite(maxBoost) && maxBoost > 0 ? Math.min(0.5, maxBoost) : 0.25,
    staleNewsPenalty: 0.03,
    missingSensitivityPenalty: 0.02,
    ...overrides,
  };
}

const CATEGORY_TO_THEMES = {
  inflation: ['inflation', 'usd'],
  rates: ['rates', 'usd'],
  labor: ['growth', 'usd'],
  growth: ['growth', 'usd'],
  central_bank: ['centralBank', 'rates', 'usd'],
  unknown: ['usd'],
};

function importanceWeight(imp) {
  const i = String(imp || 'medium').toLowerCase();
  if (i === 'high') return 1;
  if (i === 'low') return 0.35;
  return 0.65;
}

function calendarBoostForSymbol(symbol, events, sensitivityMap) {
  const sens = sensitivityMap[symbol] || {};
  let boost = 0;
  const reasons = [];

  for (const ev of events || []) {
    const w = importanceWeight(ev.importance);
    const cat = String(ev.category || 'unknown').toLowerCase().replace(/\s/g, '_');
    const themes = CATEGORY_TO_THEMES[cat] || CATEGORY_TO_THEMES.unknown;
    let local = 0;
    for (const th of themes) {
      const s = sens[th];
      if (s != null && Number.isFinite(s)) {
        local += s * 0.06 * w;
      }
    }
    if (String(ev.currency || '').toUpperCase() === 'USD' && ev.importance === 'high') {
      const usd = sens.usd != null ? sens.usd : 0;
      local += usd * 0.08 * w;
      if (local > 0) reasons.push('calendar_high_impact_usd');
    }
    if (local > 0) {
      reasons.push(`calendar_event:${ev.id || ev.title}`);
    }
    boost += local;
  }

  return { boost: Math.min(boost, 0.15), reasons: [...new Set(reasons)] };
}

function newsBoostForSymbol(symbol, signals, sensitivityMap, symbolMetadata) {
  const sens = sensitivityMap[symbol] || {};
  let boost = 0;
  const reasons = [];

  for (const sig of signals || []) {
    const mapped = newsSignalProvider.mapNewsSignalToSymbols(sig, symbolMetadata);
    if (!mapped.includes(symbol)) continue;

    const impW = importanceWeight(sig.importance);
    const conf = Number(sig.confidence) || 0.5;
    const base = 0.04 * impW * conf;

    let local = base;
    for (const cat of sig.categories || []) {
      const c = String(cat).toLowerCase();
      if (c.includes('usd') || c === 'macro') local += (sens.usd || 0.3) * 0.03;
      if (c.includes('inflation')) local += (sens.inflation || 0.3) * 0.04;
      if (c.includes('crypto')) local += symbol === 'BTCUSD' ? 0.06 : 0;
    }
    if (local > 0) {
      reasons.push(`news_signal:${sig.id}`);
      if (sig.sentimentBias && sig.sentimentBias !== 'neutral') {
        reasons.push(`news_sentiment_${sig.sentimentBias}`);
      }
    }
    boost += local;
  }

  return { boost: Math.min(boost, 0.12), reasons: [...new Set(reasons)] };
}

function macroSensitivityBoost(symbol, regimeBias, sensitivityMap) {
  const sens = sensitivityMap[symbol];
  if (!sens) return { boost: 0, reasons: [] };
  const map = {
    usd_event_risk: ['usd', 'rates'],
    crypto_pulse: ['riskOn', 'sentiment', 'liquidity'],
    risk_on_equities: ['riskOn', 'growth', 'tech'],
    neutral: [],
  };
  const keys = map[regimeBias] || map.neutral;
  if (!keys.length) return { boost: 0, reasons: [] };
  let b = 0;
  for (const k of keys) {
    if (sens[k] != null) b += sens[k] * 0.02;
  }
  const reasons =
    b > 0 ? [`macro_regime_${regimeBias}`] : [];
  return { boost: Math.min(b, 0.08), reasons };
}

function inferRegimeBias(calendarResult, newsResult) {
  const evs = (calendarResult && calendarResult.events) || [];
  const highUsd = evs.some(
    (e) => String(e.currency).toUpperCase() === 'USD' && e.importance === 'high'
  );
  if (highUsd) return 'usd_event_risk';

  const sigs = (newsResult && newsResult.signals) || [];
  if (sigs.some((s) => (s.categories || []).some((c) => String(c).toLowerCase().includes('crypto')))) {
    return 'crypto_pulse';
  }
  if (sigs.some((s) => (s.impactedAssets || []).some((a) => /NAS100|SPX500/.test(a)))) {
    return 'risk_on_equities';
  }
  return 'neutral';
}

function aggregateConfidence(calendarResult, newsResult, cfg) {
  let n = 0;
  let sum = 0;
  if (cfg.calendarEnabled && calendarResult && calendarResult.ok) {
    const c = (calendarResult.events || []).length > 0 ? 0.75 : 0.35;
    sum += c;
    n++;
  }
  if (cfg.newsEnabled && newsResult && newsResult.ok) {
    const avgConf =
      (newsResult.signals || []).reduce((a, s) => a + (Number(s.confidence) || 0.5), 0) /
      Math.max(1, (newsResult.signals || []).length);
    sum += avgConf;
    n++;
  }
  if (n === 0) return 0.4;
  return round4(clamp01(sum / n));
}

/**
 * @param {object} baseRow - phase-1 row: { symbol, totalScore, components, reasons, eligible, decision, assetClass }
 * @param {object} context - { calendarResult, newsResult, regimeBias, sensitivityMap, symbolMetadata, config }
 */
function scoreSymbolWithMacroContext(baseRow, context) {
  const symbol = String(baseRow.symbol || '').toUpperCase();
  const sensitivityMap = context.sensitivityMap || getSymbolMacroSensitivityMap();
  const cfg = context.config || getMacroScoringConfig();

  const baseUniverseScore = round4(clamp01(Number(baseRow.totalScore) || 0));

  if (!baseRow.eligible || baseRow.decision === 'suspended') {
    return {
      symbol,
      score: baseUniverseScore,
      decision: baseRow.decision,
      reasons: [...(baseRow.reasons || [])],
      components: {
        baseUniverseScore,
        newsBoost: 0,
        calendarBoost: 0,
        macroSensitivityBoost: 0,
        uncertaintyPenalty: 0,
        phase1Components: baseRow.components || {},
      },
    };
  }

  const cal = cfg.calendarEnabled
    ? calendarBoostForSymbol(symbol, (context.calendarResult || {}).events, sensitivityMap)
    : { boost: 0, reasons: [] };
  const news = cfg.newsEnabled
    ? newsBoostForSymbol(
        symbol,
        (context.newsResult || {}).signals,
        sensitivityMap,
        context.symbolMetadata || {}
      )
    : { boost: 0, reasons: [] };
  const macroSens = cfg.macroEnabled
    ? macroSensitivityBoost(symbol, context.regimeBias || 'neutral', sensitivityMap)
    : { boost: 0, reasons: [] };

  let uncertaintyPenalty = 0;
  if (!sensitivityMap[symbol]) uncertaintyPenalty += cfg.missingSensitivityPenalty;

  const macroSum = cal.boost + news.boost + macroSens.boost;
  const cappedMacro = Math.min(macroSum, cfg.maxMacroBoost);
  const finalScore = round4(
    clamp01(baseUniverseScore + cappedMacro - uncertaintyPenalty)
  );

  const reasons = [
    ...(baseRow.reasons || []),
    ...cal.reasons,
    ...news.reasons,
    ...macroSens.reasons,
  ];
  if (uncertaintyPenalty > 0) reasons.push('macro_uncertainty_penalty');

  return {
    symbol,
    score: finalScore,
    decision: 'candidate',
    reasons: [...new Set(reasons)].slice(0, 24),
    components: {
      baseUniverseScore,
      newsBoost: round4(news.boost),
      calendarBoost: round4(cal.boost),
      macroSensitivityBoost: round4(macroSens.boost),
      uncertaintyPenalty: round4(uncertaintyPenalty),
      phase1Components: baseRow.components || {},
    },
  };
}

/**
 * @param {object[]} baseUniverseRows - scored rows from phase 1 (before slotting)
 * @param {object} context - optional pre-fetched calendar/news; if omitted, providers are called
 */
function buildMacroAdjustedUniverseScores(baseUniverseRows, context = {}) {
  const cfg = { ...getMacroScoringConfig(), ...(context.config || {}) };
  const sensitivityMap = getSymbolMacroSensitivityMap();

  let calendarResult = context.calendarResult;
  let newsResult = context.newsResult;
  const providerWarnings = [...(context.providerWarnings || [])];

  if (cfg.calendarEnabled && !calendarResult) {
    try {
      calendarResult = macroCalendarProvider.getUpcomingMacroEvents({ now: context.now });
      providerWarnings.push(...(calendarResult.warnings || []));
    } catch (e) {
      providerWarnings.push(`calendar_exception:${e && e.message}`);
      calendarResult = { ok: false, events: [], warnings: [] };
    }
  }

  if (cfg.newsEnabled && !newsResult) {
    try {
      newsResult = newsSignalProvider.getLatestNewsSignals({ now: context.now });
      providerWarnings.push(...(newsResult.warnings || []));
    } catch (e) {
      providerWarnings.push(`news_exception:${e && e.message}`);
      newsResult = { ok: false, signals: [], warnings: [] };
    }
  }

  const regimeBias = context.regimeBias || inferRegimeBias(calendarResult || {}, newsResult || {});

  const scoreContext = {
    calendarResult: calendarResult || { events: [] },
    newsResult: newsResult || { signals: [] },
    regimeBias,
    sensitivityMap,
    symbolMetadata: context.symbolMetadata || {},
    config: cfg,
  };

  const adjusted = (baseUniverseRows || []).map((row) =>
    scoreSymbolWithMacroContext(row, scoreContext)
  );

  const confidence = aggregateConfidence(calendarResult || {}, newsResult || {}, cfg);

  return {
    adjustedRows: adjusted,
    macroContext: {
      enabled: cfg.macroEnabled,
      newsEnabled: cfg.newsEnabled,
      calendarEnabled: cfg.calendarEnabled,
      regimeBias,
      confidence,
    },
    providerStatus: {
      calendar: calendarResult
        ? { ok: calendarResult.ok !== false, source: calendarResult.source, eventCount: (calendarResult.events || []).length }
        : { ok: false, source: 'skipped', eventCount: 0 },
      news: newsResult
        ? { ok: newsResult.ok !== false, source: newsResult.source, signalCount: (newsResult.signals || []).length }
        : { ok: false, source: 'skipped', signalCount: 0 },
    },
    providerWarnings,
    calendarEventsUsed: (calendarResult && calendarResult.events) || [],
    newsSignalsUsed: (newsResult && newsResult.signals) || [],
  };
}

module.exports = {
  getMacroScoringConfig,
  getSymbolMacroSensitivityMap,
  scoreSymbolWithMacroContext,
  buildMacroAdjustedUniverseScores,
  inferRegimeBias,
};
