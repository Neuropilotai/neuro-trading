'use strict';

/**
 * Strategy validation framework (anti-bias + ranking) from paper_trades.jsonl.
 *
 * Goal:
 * - Reject statistically weak / suspicious strategies.
 * - Score robust candidates with transparent reasons.
 *
 * This module is read-only: it computes from JSONL content and returns a report payload.
 */

const { parsePaperTradesJsonlContent } = require('./parsePaperTradesJsonl');
const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');

const STRATEGY_VALIDATION_SCHEMA_VERSION = '1.5.0';
const VALIDATION_TARGET = Object.freeze({
  requiredValidatedStrategies: 1,
  source: 'computeStrategyValidationFramework',
  isExplicit: true,
});

const DEFAULT_MODE_RULES = Object.freeze({
  research: Object.freeze({
    minTrades: 40,
    minTradesHard: 15,
    suspiciousHighWinRatePct: 90,
    suspiciousHighWinRateTradesMax: 50,
    maxBarsShareWarn: 0.6,
    minProfitFactor: 1.0,
    minExpectancy: -0.05,
    multiMarketRequiredForPromotion: false,
  }),
  promotion: Object.freeze({
    minTrades: 100,
    minTradesHard: 30,
    suspiciousHighWinRatePct: 90,
    suspiciousHighWinRateTradesMax: 50,
    maxBarsShareWarn: 0.5,
    minProfitFactor: 1.1,
    minExpectancy: 0,
    multiMarketRequiredForPromotion: true,
  }),
});

const NON_PRODUCTION_NAME_POLICY = Object.freeze({
  hardExcludePrefixRegexes: Object.freeze([
    /^example_/i,
    /^demo_/i,
    /^test_/i,
  ]),
  hardExcludeSuffixRegexes: Object.freeze([
    /_smoke$/i,
    /_fixture$/i,
    /_sandbox$/i,
  ]),
  hardExcludeWholeWordTokens: Object.freeze([
    'fixture',
    'sandbox',
    'dummy',
    'mock',
  ]),
  warnOnlyWholeWordTokens: Object.freeze([
    'dev',
    'qa',
    'sample',
    'smoke',
    'playground',
  ]),
});

function toMs(ts) {
  if (ts == null || ts === '') return 0;
  const ms = new Date(String(ts)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(n, p = 4) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

function pct(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return round((part / total) * 100, 2);
}

function aggregateStrategyMetrics(strategyId, trades) {
  const ordered = [...trades].sort((a, b) => toMs(a.exitTs || a.ts) - toMs(b.exitTs || b.ts));
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let grossWin = 0;
  let grossLossAbs = 0;
  let totalPnl = 0;
  let maxEquity = 0;
  let maxDrawdown = 0;
  const reasonCounts = {};
  const symbols = new Set();

  for (const t of ordered) {
    const pnl = num(t.pnl);
    totalPnl += pnl;
    if (pnl > 0) {
      wins += 1;
      grossWin += pnl;
    } else if (pnl < 0) {
      losses += 1;
      grossLossAbs += Math.abs(pnl);
    } else {
      flat += 1;
    }

    const reason = t.reason != null && String(t.reason).trim() !== '' ? String(t.reason).trim() : 'unknown';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;

    const symbol = t.symbol != null && String(t.symbol).trim() !== '' ? String(t.symbol).trim().toUpperCase() : null;
    if (symbol) symbols.add(symbol);

    if (totalPnl > maxEquity) maxEquity = totalPnl;
    const dd = maxEquity - totalPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const n = ordered.length;
  const expectancy = n > 0 ? totalPnl / n : 0;
  const avgWin = wins > 0 ? grossWin / wins : 0;
  const avgLossAbs = losses > 0 ? grossLossAbs / losses : 0;
  const profitFactor = grossLossAbs > 0 ? grossWin / grossLossAbs : grossWin > 0 ? Infinity : 0;
  const winRate = pct(wins, n);
  const maxBarsCount = num(reasonCounts.max_bars) + num(reasonCounts.max_bars_intrabar_priority);
  const maxBarsShare = n > 0 ? maxBarsCount / n : 0;

  return {
    strategyId,
    trades: n,
    wins,
    losses,
    flat,
    winRate,
    totalPnl: round(totalPnl, 8),
    expectancy: round(expectancy, 8),
    avgWin: round(avgWin, 8),
    avgLossAbs: round(avgLossAbs, 8),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 4) : null,
    maxDrawdown: round(maxDrawdown, 8),
    byReason: reasonCounts,
    maxBarsShare: round(maxBarsShare, 4),
    symbolCount: symbols.size,
    symbols: Array.from(symbols).sort(),
  };
}

function splitNameTokens(strategyId) {
  return String(strategyId || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function nonProductionNameSignals(strategyId) {
  const id = String(strategyId || '').trim();
  if (!id) {
    return {
      matched: false,
      hardMatched: false,
      warnMatched: false,
      hardTokensMatched: [],
      warnTokensMatched: [],
      allTokensMatched: [],
    };
  }

  const tokens = splitNameTokens(id);
  const hardTokensMatched = [];
  const warnTokensMatched = [];

  for (const re of NON_PRODUCTION_NAME_POLICY.hardExcludePrefixRegexes) {
    if (re.test(id)) hardTokensMatched.push(`prefix:${re.source}`);
  }
  for (const re of NON_PRODUCTION_NAME_POLICY.hardExcludeSuffixRegexes) {
    if (re.test(id)) hardTokensMatched.push(`suffix:${re.source}`);
  }
  for (const t of NON_PRODUCTION_NAME_POLICY.hardExcludeWholeWordTokens) {
    if (tokens.includes(t)) hardTokensMatched.push(`token:${t}`);
  }
  for (const t of NON_PRODUCTION_NAME_POLICY.warnOnlyWholeWordTokens) {
    if (tokens.includes(t)) warnTokensMatched.push(`token:${t}`);
  }

  const allTokensMatched = Array.from(new Set([...hardTokensMatched, ...warnTokensMatched]));
  return {
    matched: allTokensMatched.length > 0,
    hardMatched: hardTokensMatched.length > 0,
    warnMatched: warnTokensMatched.length > 0,
    hardTokensMatched,
    warnTokensMatched,
    allTokensMatched,
  };
}

function evaluateFlags(m, rules, modeName) {
  const hardFails = [];
  const warns = [];
  const nameSignals = nonProductionNameSignals(m.strategyId);

  if (nameSignals.hardMatched) {
    hardFails.push('non_production_example_strategy');
  } else if (nameSignals.warnMatched) {
    warns.push('non_production_name_warning');
  }
  if (m.trades < rules.minTradesHard) hardFails.push('too_few_trades_hard');
  if (m.expectancy < rules.minExpectancy) hardFails.push('negative_expectancy');
  if (
    m.profitFactor != null &&
    Number.isFinite(m.profitFactor) &&
    m.profitFactor < rules.minProfitFactor
  ) {
    if (modeName === 'promotion' || m.trades >= rules.minTrades) hardFails.push('low_profit_factor');
    else warns.push('low_profit_factor_small_sample');
  }

  if ((m.winRate || 0) >= rules.suspiciousHighWinRatePct && m.trades < rules.suspiciousHighWinRateTradesMax) {
    warns.push('suspicious_high_win_rate_small_sample');
  }
  if (m.trades < rules.minTrades) warns.push('insufficient_sample_for_promotion');
  if (m.maxBarsShare > rules.maxBarsShareWarn) warns.push('max_bars_exit_share_high');
  if (m.symbolCount <= 1) warns.push('single_market_only');
  if (rules.multiMarketRequiredForPromotion && m.symbolCount <= 1) hardFails.push('single_market_required');

  return { hardFails, warns, nameSignals };
}

/**
 * Strict positive expectancy: linear `expectancy * 10` crushed micro-PnL paper edges (~0.006 → ~0.06 pts).
 * Replaced with bounded log1p scaling (local to strict scoreBreakdown only; learning uses its own constants).
 */
const STRICT_EXPECTANCY_LOG_SCALE = 1500;
const STRICT_EXPECTANCY_LOG_MULT = 5;
const STRICT_EXPECTANCY_CAP = 20;

/**
 * Observable decomposition of scoreStrategy (pre-trend). Same arithmetic as score final before trend adj.
 * penalties = points subtracted for max_bars share + suspicious win rate only (non-negative).
 */
function computeScoreStrategyBreakdown(m, flags, rules) {
  const base = 50;
  let expectancyPts = 0;
  if (m.expectancy > 0) {
    expectancyPts = Math.min(
      STRICT_EXPECTANCY_CAP,
      Math.log1p(m.expectancy * STRICT_EXPECTANCY_LOG_SCALE) * STRICT_EXPECTANCY_LOG_MULT
    );
  } else {
    expectancyPts = -25;
  }

  let profitFactorPts = 0;
  if (m.profitFactor != null && Number.isFinite(m.profitFactor)) {
    if (m.profitFactor >= 1) {
      profitFactorPts = Math.min(20, (m.profitFactor - 1) * 20);
    } else {
      profitFactorPts = -20;
    }
  }

  let samplePts = 0;
  if (m.trades >= rules.minTrades) samplePts = 12;
  else if (m.trades >= rules.minTradesHard) samplePts = 3;
  else samplePts = -20;

  const maxBarsPenaltyPts = m.maxBarsShare > rules.maxBarsShareWarn ? 8 : 0;
  const suspiciousWinratePenaltyPts = flags.warns.includes('suspicious_high_win_rate_small_sample')
    ? 10
    : 0;
  const penalties = maxBarsPenaltyPts + suspiciousWinratePenaltyPts;

  const rawSum =
    base + expectancyPts + profitFactorPts + samplePts - maxBarsPenaltyPts - suspiciousWinratePenaltyPts;
  const roundedPreClamp = Math.round(rawSum);
  const scoreBaseClamped = Math.max(0, Math.min(100, roundedPreClamp));

  return {
    base,
    expectancyPts: round(expectancyPts, 4),
    profitFactorPts: round(profitFactorPts, 4),
    samplePts,
    penalties,
    maxBarsPenaltyPts,
    suspiciousWinratePenaltyPts,
    rawSum: round(rawSum, 4),
    roundedPreClamp,
    scoreBaseClamped,
  };
}

function scoreStrategy(m, flags, rules) {
  const scoreBreakdown = computeScoreStrategyBreakdown(m, flags, rules);
  const reasons = [];

  if (m.expectancy > 0) reasons.push('+expectancy');
  else reasons.push('-expectancy');

  if (m.profitFactor != null && Number.isFinite(m.profitFactor)) {
    if (m.profitFactor >= 1) reasons.push('+profit_factor');
    else reasons.push('-profit_factor');
  }

  if (m.trades >= rules.minTrades) reasons.push('+sample_size');
  else if (m.trades >= rules.minTradesHard) reasons.push('+sample_size_partial');
  else reasons.push('-sample_size_hard');

  if (m.maxBarsShare > rules.maxBarsShareWarn) reasons.push('-max_bars_share');
  if (flags.warns.includes('suspicious_high_win_rate_small_sample')) reasons.push('-suspicious_winrate');

  return { score: scoreBreakdown.scoreBaseClamped, reasons, scoreBreakdown };
}

function validationTier(score, hardFails, modeName) {
  if (hardFails.length > 0) return 'reject';
  if (modeName === 'research') {
    if (score >= 72) return 'watchlist';
    if (score >= 58) return 'needs_more_data';
    return 'reject';
  }
  if (score >= 80) return 'promote_candidate';
  if (score >= 65) return 'watchlist';
  return 'reject';
}

/** Parallel paper-oriented score: not used for tiers, promotableCount, or gates. */
const LEARNING_SCORE_BASE = 40;
const LEARNING_EXPECTANCY_LOG_SCALE = 1500;
const LEARNING_EXPECTANCY_LOG_MULT = 5;
const LEARNING_EXPECTANCY_CAP = 25;
const LEARNING_PF_MULT = 12;
const LEARNING_PF_CAP = 20;
const LEARNING_SAMPLE_LOG_MULT = 2.8;
const LEARNING_SAMPLE_CAP = 14;
const LEARNING_STABILITY_MAX = 10;
const LEARNING_DD_PNL_RATIO_MULT = 5;

/**
 * Informative only; does not gate promotion.
 */
function inferLearningTier(learningScore) {
  const s = Number(learningScore);
  if (!Number.isFinite(s)) return 'unknown';
  if (s >= 78) return 'strong_potential';
  if (s >= 62) return 'moderate_potential';
  return 'weak_potential';
}

/**
 * @param {object} m - aggregateStrategyMetrics row
 * @param {{ warns: string[] }} flags
 * @param {object} rules - mode rules (maxBarsShareWarn)
 */
function computeLearningScoreBreakdown(m, flags, rules) {
  const trades = Math.max(0, num(m.trades));
  const e = num(m.expectancy);

  let expectancyPts = 0;
  if (!Number.isFinite(e)) {
    expectancyPts = 0;
  } else if (e <= 0) {
    expectancyPts = -Math.min(25, Math.log1p(Math.abs(e) * 2000) * 6);
  } else {
    const rawExp = Math.min(
      LEARNING_EXPECTANCY_CAP,
      Math.log1p(e * LEARNING_EXPECTANCY_LOG_SCALE) * LEARNING_EXPECTANCY_LOG_MULT
    );
    const sampleScaleExp = trades >= 100 ? 1 : trades / 100;
    expectancyPts = rawExp * sampleScaleExp;
  }
  expectancyPts = round(expectancyPts, 4);

  let profitFactorPts = 0;
  const pf = m.profitFactor;
  if (pf != null && Number.isFinite(Number(pf))) {
    const pfN = Number(pf);
    const sampleScalePf = trades >= 50 ? 1 : trades / 50;
    if (pfN < 1) {
      profitFactorPts = round(-15 * sampleScalePf, 4);
    } else {
      profitFactorPts = round(
        Math.min(LEARNING_PF_CAP, (pfN - 1) * LEARNING_PF_MULT) * sampleScalePf,
        4
      );
    }
  }

  const samplePts = round(Math.min(LEARNING_SAMPLE_CAP, Math.log1p(trades) * LEARNING_SAMPLE_LOG_MULT), 4);

  let stabilityPts = LEARNING_STABILITY_MAX;
  const dd = num(m.maxDrawdown);
  const pnlAbs = Math.abs(num(m.totalPnl));
  if (Number.isFinite(dd) && dd > 0 && Number.isFinite(pnlAbs)) {
    const ratio = dd / Math.max(pnlAbs, 1e-9);
    const pen = Math.min(LEARNING_STABILITY_MAX, ratio * LEARNING_DD_PNL_RATIO_MULT);
    stabilityPts = Math.max(0, LEARNING_STABILITY_MAX - pen);
  }
  stabilityPts = round(stabilityPts, 4);

  const maxBarsPenaltyPts = m.maxBarsShare > rules.maxBarsShareWarn ? 8 : 0;
  const suspiciousWinratePenaltyPts = flags.warns.includes('suspicious_high_win_rate_small_sample')
    ? 10
    : 0;
  const penalties = maxBarsPenaltyPts + suspiciousWinratePenaltyPts;

  const rawSum =
    LEARNING_SCORE_BASE +
    expectancyPts +
    profitFactorPts +
    samplePts +
    stabilityPts -
    penalties;
  const roundedPreClamp = Math.round(rawSum);
  const finalScore = Math.max(0, Math.min(100, roundedPreClamp));

  return {
    base: LEARNING_SCORE_BASE,
    expectancyPts,
    profitFactorPts,
    samplePts,
    stabilityPts,
    penalties,
    maxBarsPenaltyPts,
    suspiciousWinratePenaltyPts,
    rawSum: round(rawSum, 4),
    roundedPreClamp,
    finalScore,
  };
}

function isTrendApplyEnabled() {
  const v = String(process.env.TREND_MEMORY_APPLY || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * P7 safe apply (score-only): derive a global trend direction/confidence from run_trend_memory.
 * No veto, no hard fail, no exclusion. This is ranking guidance only.
 */
function getTrendMemoryApplyContext() {
  const defaults = {
    enabled: false,
    minSampleForTrendApply: Number(process.env.TREND_MEMORY_MIN_SAMPLE_FOR_APPLY || 30),
    minTrendConfidenceForApply: Number(process.env.TREND_MEMORY_MIN_CONFIDENCE_FOR_APPLY || 0.6),
    maxTrendPenaltyPts: Number(process.env.TREND_MEMORY_MAX_PENALTY_PTS || 6),
    maxTrendBonusPts: Number(process.env.TREND_MEMORY_MAX_BONUS_PTS || 3),
    minTrendPenaltyPts: Number(process.env.TREND_MEMORY_MIN_PENALTY_PTS || 3),
    minTrendBonusPts: Number(process.env.TREND_MEMORY_MIN_BONUS_PTS || 1),
    trendDirection: 'flat',
    trendConfidence: 0,
    reason: 'expected_by_config_fallback_under_trend_apply_disabled',
    sourcePath: null,
  };
  const enabled = isTrendApplyEnabled();
  defaults.enabled = enabled;
  if (!enabled) return defaults;

  const discoveryDir = dataRoot.getPath('discovery');
  const p = path.join(discoveryDir, 'run_trend_memory.json');
  const tm = readJsonSafe(p);
  if (!tm || typeof tm !== 'object') {
    return {
      ...defaults,
      enabled: true,
      reason: 'trend_apply_enabled_but_run_trend_memory_missing',
      sourcePath: p,
    };
  }
  const s = tm.signals && typeof tm.signals === 'object' ? tm.signals : {};
  const blocked = clamp(Number(s.blockedRate || 0), 0, 1);
  const degraded = clamp(Number(s.degradedRate || 0), 0, 1);
  const fallback = clamp(Number(s.fallbackRate || 0), 0, 1);
  const invalid = clamp(Number(s.avgInvalidRatio || 0), 0, 1);
  // Bounded risk proxy [0,1], tuned conservative for V1 safe-apply.
  const riskScore = clamp(
    blocked * 0.45 + degraded * 0.25 + fallback * 0.15 + invalid * 0.15,
    0,
    1
  );
  let trendDirection = 'flat';
  let trendConfidence = 0;
  if (riskScore >= 0.6) {
    trendDirection = 'down';
    trendConfidence = riskScore;
  } else if (riskScore <= 0.25) {
    trendDirection = 'up';
    trendConfidence = 1 - riskScore;
  } else {
    trendDirection = 'flat';
    trendConfidence = Math.abs(riskScore - 0.5) * 2;
  }
  return {
    ...defaults,
    enabled: true,
    trendDirection,
    trendConfidence: round(trendConfidence, 4),
    reason: 'trend_apply_context_ready',
    sourcePath: p,
    riskScore: round(riskScore, 4),
    trendMemoryGeneratedAt: tm.generatedAt || null,
    trendMemoryVersion: tm.trendMemoryVersion || null,
  };
}

function computeTrendAdjustmentPoints(context, trades) {
  if (!context || !context.enabled) {
    return {
      applied: false,
      points: 0,
      reason: 'expected_by_config_fallback_under_trend_apply_disabled',
      direction: context?.trendDirection || 'flat',
      confidence: context?.trendConfidence || 0,
      cappedBy: 0,
    };
  }
  if ((Number(trades) || 0) < context.minSampleForTrendApply) {
    return {
      applied: false,
      points: 0,
      reason: 'trend_apply_skipped_low_sample',
      direction: context.trendDirection,
      confidence: context.trendConfidence,
      cappedBy: 0,
    };
  }
  if ((Number(context.trendConfidence) || 0) < context.minTrendConfidenceForApply) {
    return {
      applied: false,
      points: 0,
      reason: 'trend_apply_skipped_low_confidence',
      direction: context.trendDirection,
      confidence: context.trendConfidence,
      cappedBy: 0,
    };
  }
  if (context.trendDirection !== 'down' && context.trendDirection !== 'up') {
    return {
      applied: false,
      points: 0,
      reason: 'trend_apply_skipped_flat_trend',
      direction: context.trendDirection,
      confidence: context.trendConfidence,
      cappedBy: 0,
    };
  }

  const conf = clamp(Number(context.trendConfidence), context.minTrendConfidenceForApply, 1);
  const confNorm = (conf - context.minTrendConfidenceForApply) / Math.max(1e-6, 1 - context.minTrendConfidenceForApply);
  if (context.trendDirection === 'down') {
    const basePenalty =
      context.minTrendPenaltyPts +
      (context.maxTrendPenaltyPts - context.minTrendPenaltyPts) * confNorm;
    const pts = -Math.round(clamp(basePenalty, 0, context.maxTrendPenaltyPts));
    return {
      applied: true,
      points: pts,
      reason: 'trend_apply_soft_penalty',
      direction: 'down',
      confidence: round(conf, 4),
      cappedBy: context.maxTrendPenaltyPts,
    };
  }

  const baseBonus =
    context.minTrendBonusPts +
    (context.maxTrendBonusPts - context.minTrendBonusPts) * confNorm;
  const pts = Math.round(clamp(baseBonus, 0, context.maxTrendBonusPts));
  return {
    applied: true,
    points: pts,
    reason: 'trend_apply_soft_bonus',
    direction: 'up',
    confidence: round(conf, 4),
    cappedBy: context.maxTrendBonusPts,
  };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function buildReadiness(metrics, flags, promotionRules, promotionTier) {
  const tradesTarget = Math.max(1, Number(promotionRules.minTrades) || 100);
  const marketsTarget = (promotionRules.multiMarketRequiredForPromotion ? 2 : 1);
  const tradesProgress = clamp01((Number(metrics.trades) || 0) / tradesTarget);
  const marketsProgress = clamp01((Number(metrics.symbolCount) || 0) / marketsTarget);

  let qualityChecksPassed = 0;
  const qualityChecksTotal = 3;
  if (Number(metrics.expectancy) >= Number(promotionRules.minExpectancy || 0)) qualityChecksPassed += 1;
  if (
    metrics.profitFactor != null &&
    Number.isFinite(Number(metrics.profitFactor)) &&
    Number(metrics.profitFactor) >= Number(promotionRules.minProfitFactor || 1)
  ) {
    qualityChecksPassed += 1;
  }
  if (!flags.warns.includes('suspicious_high_win_rate_small_sample')) qualityChecksPassed += 1;
  const qualityProgress = clamp01(qualityChecksPassed / qualityChecksTotal);

  const noHardFailProgress = flags.hardFails.length === 0 ? 1 : 0;

  const readinessRaw = (
    tradesProgress * 40 +
    marketsProgress * 20 +
    qualityProgress * 20 +
    noHardFailProgress * 20
  );
  const readinessPct = Math.round(Math.max(0, Math.min(100, readinessRaw)));

  const tradesToPromotionTarget = Math.max(0, tradesTarget - (Number(metrics.trades) || 0));
  const marketsToPromotionTarget = Math.max(0, marketsTarget - (Number(metrics.symbolCount) || 0));

  const blockingReasons = Array.from(new Set([
    ...flags.hardFails,
    ...(flags.warns.includes('insufficient_sample_for_promotion') ? ['insufficient_sample_for_promotion'] : []),
    ...(flags.warns.includes('single_market_only') ? ['single_market_only'] : []),
  ]));

  let nextMilestone = 'ready_for_promotion_review';
  if (blockingReasons.includes('non_production_example_strategy')) {
    nextMilestone = 'rename_or_remove_non_production_strategy';
  } else if (tradesToPromotionTarget > 0) {
    nextMilestone = `need_${tradesToPromotionTarget}_more_trades`;
  } else if (marketsToPromotionTarget > 0) {
    nextMilestone = `need_${marketsToPromotionTarget}_more_markets`;
  } else if (promotionTier !== 'promote_candidate') {
    nextMilestone = 'improve_quality_metrics';
  }

  return {
    readinessPct,
    readinessBreakdown: {
      tradesProgress: round(tradesProgress * 100, 2),
      marketCoverageProgress: round(marketsProgress * 100, 2),
      qualityChecksProgress: round(qualityProgress * 100, 2),
      noHardFailProgress: round(noHardFailProgress * 100, 2),
    },
    blockingReasons,
    nextMilestone,
    tradesToPromotionTarget,
    marketsToPromotionTarget,
  };
}

function computeBlockingSummary(promotionRows) {
  const out = {
    insufficient_sample_for_promotion: 0,
    single_market_only: 0,
    low_profit_factor: 0,
    negative_expectancy: 0,
    non_production_name_hard_exclude: 0,
    suspicious_high_win_rate_small_sample: 0,
  };
  for (const r of promotionRows || []) {
    const blockers = Array.isArray(r.blockingReasons) ? r.blockingReasons : [];
    if (blockers.includes('insufficient_sample_for_promotion') || blockers.includes('too_few_trades_hard')) {
      out.insufficient_sample_for_promotion += 1;
    }
    if (blockers.includes('single_market_only') || blockers.includes('single_market_required')) {
      out.single_market_only += 1;
    }
    if (blockers.includes('low_profit_factor')) out.low_profit_factor += 1;
    if (blockers.includes('negative_expectancy')) out.negative_expectancy += 1;
    if (
      blockers.includes('non_production_name_hard_exclude') ||
      blockers.includes('non_production_example_strategy')
    ) {
      out.non_production_name_hard_exclude += 1;
    }
    if (blockers.includes('suspicious_high_win_rate_small_sample')) {
      out.suspicious_high_win_rate_small_sample += 1;
    }
  }
  return out;
}

/**
 * Read-only explainer for ops phase gate when summary.promotableCount === 0.
 * Does not change scoring tiers — surfaces why strict promote_candidate is empty.
 */
function buildStrictPaperGateExplainer(promotionSummary, promotionRows) {
  const promotableCount = Number(promotionSummary && promotionSummary.promotableCount);
  if (Number.isFinite(promotableCount) && promotableCount > 0) {
    return {
      status: 'satisfied',
      promotableCount,
      detail: null,
    };
  }
  const rows = Array.isArray(promotionRows) ? promotionRows : [];
  if (rows.length === 0) {
    return {
      status: 'no_strategy_buckets',
      promotableCount: 0,
      promoteCandidateMinScore: 80,
      detail:
        'no strategy rows after aggregating paper_trades.jsonl (empty or unparsable trades)',
    };
  }
  const best = rows[0];
  const sid = String(best.strategyId || 'unknown');
  const sc = Number(best.score);
  const tier = String(best.tier || 'unknown');
  const fails = Array.isArray(best.hardFails) ? best.hardFails : [];
  const scoreHint = Number.isFinite(sc) ? sc : 0;
  let detail;
  if (fails.length > 0) {
    detail = `top ${sid} promotion score=${scoreHint} tier=${tier}; hardFails=${fails.join(', ')}`;
  } else if (tier !== 'promote_candidate') {
    detail = `top ${sid} promotion score=${scoreHint} tier=${tier} (promote_candidate requires score>=80 and zero hard fails)`;
  } else {
    detail = `top ${sid} tier=${tier} excluded from promotableCount (check excludedFromRanking)`;
  }
  return {
    status: 'blocked',
    promotableCount: 0,
    promoteCandidateMinScore: 80,
    bestPromotionStrategyId: sid,
    bestPromotionScore: Number.isFinite(sc) ? scoreHint : null,
    bestPromotionTier: tier,
    primaryHardFails: fails,
    nextMilestone: best.nextMilestone != null ? String(best.nextMilestone) : null,
    detail,
  };
}

function buildValidationFunnel(validationPayload) {
  const promoRows = validationPayload?.modes?.promotion?.rows || [];
  const researchRows = validationPayload?.modes?.research?.rows || [];
  const byIdResearch = new Map(researchRows.map((r) => [String(r.strategyId), r]));
  const rows = promoRows.map((p) => {
    const r = byIdResearch.get(String(p.strategyId));
    return { promotionTier: p.tier, researchTier: r?.tier };
  });
  return {
    detected: rows.length,
    researchActive: rows.filter((x) => x.researchTier && x.researchTier !== 'reject').length,
    watchlist: rows.filter((x) => x.researchTier === 'watchlist' || x.promotionTier === 'watchlist').length,
    needsMoreData: rows.filter((x) => x.researchTier === 'needs_more_data').length,
    promotionCandidate: rows.filter((x) => x.promotionTier === 'promote_candidate').length,
    excluded: promoRows.filter((x) => x.excludedFromRanking).length,
    rejected: rows.filter((x) => x.promotionTier === 'reject').length,
  };
}

function summarizeRows(rows) {
  const promotable = rows.filter((r) => r.promotable && !r.excludedFromRanking);
  const watchlist = rows.filter((r) => r.tier === 'watchlist' && !r.excludedFromRanking);
  const rejected = rows.filter((r) => r.tier === 'reject');
  const needsMoreData = rows.filter((r) => r.tier === 'needs_more_data');

  return {
    summary: {
      strategiesTotal: rows.length,
      promotableCount: promotable.length,
      watchlistCount: watchlist.length,
      needsMoreDataCount: needsMoreData.length,
      rejectedCount: rejected.length,
    },
    topPromotable: promotable.slice(0, 10).map((r) => ({
      strategyId: r.strategyId,
      score: r.score,
      trades: r.trades,
      expectancy: r.expectancy,
      profitFactor: r.profitFactor,
      winRate: r.winRate,
    })),
    topWatchlist: watchlist.slice(0, 10).map((r) => ({
      strategyId: r.strategyId,
      score: r.score,
      trades: r.trades,
      expectancy: r.expectancy,
      profitFactor: r.profitFactor,
      winRate: r.winRate,
      warnings: r.warnings,
    })),
  };
}

function runMode(baseMetricsRows, rules, modeName) {
  const trendApplyContext = getTrendMemoryApplyContext();
  const rows = baseMetricsRows.map((metrics) => {
    const flags = evaluateFlags(metrics, rules, modeName);
    const { score, reasons, scoreBreakdown: breakdownBase } = scoreStrategy(metrics, flags, rules);
    const trendAdj = computeTrendAdjustmentPoints(trendApplyContext, metrics.trades);
    const scoreAdjusted = Math.max(0, Math.min(100, Number(score || 0) + Number(trendAdj.points || 0)));
    const scoreDrivers = [...reasons];
    if (trendAdj.applied && trendAdj.points !== 0) {
      scoreDrivers.push(
        trendAdj.points > 0
          ? `+trend_memory_${trendAdj.points}`
          : `trend_memory_${trendAdj.points}`
      );
    }
    const tier = validationTier(scoreAdjusted, flags.hardFails, modeName);
    const excludedReasons = [];
    if (flags.hardFails.includes('non_production_example_strategy')) {
      excludedReasons.push('non_production_name_hard_exclude');
    }
    if (flags.warns.includes('suspicious_high_win_rate_small_sample')) {
      excludedReasons.push('suspicious_high_win_rate_small_sample');
    }
    const excludedFromRanking = excludedReasons.length > 0;
    const scoreBreakdown = {
      ...breakdownBase,
      trendAdjustmentPts: Number(trendAdj.points || 0),
      scoreAfterTrend: scoreAdjusted,
    };
    const learningScoreBreakdown = computeLearningScoreBreakdown(metrics, flags, rules);
    const learningScore = learningScoreBreakdown.finalScore;
    const learningTier = inferLearningTier(learningScore);
    const row = {
      ...metrics,
      score: scoreAdjusted,
      scoreBase: score,
      scoreBreakdown,
      learningScore,
      learningScoreBreakdown,
      learningTier,
      tier,
      mode: modeName,
      scoreDrivers,
      hardFails: flags.hardFails,
      warnings: flags.warns,
      promotable: tier === 'promote_candidate',
      excludedFromRanking,
      excludedReasons,
      nonProductionNameMatch: !!flags.nameSignals.matched,
      nonProductionNameTokensMatched: flags.nameSignals.allTokensMatched,
      trendAdjustmentApplied: !!trendAdj.applied,
      trendDirection: trendAdj.direction || trendApplyContext.trendDirection || 'flat',
      trendConfidence: trendAdj.confidence != null ? trendAdj.confidence : trendApplyContext.trendConfidence,
      trendPenaltyPts: trendAdj.points < 0 ? Math.abs(trendAdj.points) : 0,
      trendBonusPts: trendAdj.points > 0 ? trendAdj.points : 0,
      trendAdjustmentPts: trendAdj.points || 0,
      trendApplyReason: trendAdj.reason || trendApplyContext.reason,
    };
    if (modeName === 'promotion') {
      Object.assign(row, buildReadiness(metrics, flags, rules, tier));
    }
    return row;
  });

  rows.sort((a, b) => {
    const sd = (b.score || 0) - (a.score || 0);
    if (sd !== 0) return sd;
    const td = (b.trades || 0) - (a.trades || 0);
    if (td !== 0) return td;
    return String(a.strategyId).localeCompare(String(b.strategyId));
  });

  return { rows, ...summarizeRows(rows) };
}

function buildTransitionView(researchRows, promotionRows) {
  const byId = new Map();
  for (const r of researchRows || []) {
    byId.set(String(r.strategyId), {
      strategyId: String(r.strategyId),
      researchTier: r.tier,
      researchScore: r.score,
      excludedFromRanking: !!r.excludedFromRanking,
      excludedReasons: Array.isArray(r.excludedReasons) ? r.excludedReasons : [],
      nonProductionNameMatch: !!r.nonProductionNameMatch,
      nonProductionNameTokensMatched: Array.isArray(r.nonProductionNameTokensMatched)
        ? r.nonProductionNameTokensMatched
        : [],
    });
  }
  for (const p of promotionRows || []) {
    const key = String(p.strategyId);
    const cur = byId.get(key) || { strategyId: key };
    cur.promotionTier = p.tier;
    cur.promotionScore = p.score;
    cur.trades = p.trades;
    cur.expectancy = p.expectancy;
    cur.profitFactor = p.profitFactor;
    cur.winRate = p.winRate;
    cur.excludedFromRanking = !!p.excludedFromRanking || !!cur.excludedFromRanking;
    if (Array.isArray(p.excludedReasons)) {
      cur.excludedReasons = Array.from(new Set([...(cur.excludedReasons || []), ...p.excludedReasons]));
    }
    cur.nonProductionNameMatch = !!p.nonProductionNameMatch || !!cur.nonProductionNameMatch;
    if (Array.isArray(p.nonProductionNameTokensMatched)) {
      cur.nonProductionNameTokensMatched = Array.from(
        new Set([...(cur.nonProductionNameTokensMatched || []), ...p.nonProductionNameTokensMatched])
      );
    }
    byId.set(key, cur);
  }

  const all = Array.from(byId.values()).map((r) => {
    let transitionTag = 'unchanged';
    if (r.excludedFromRanking && (r.excludedReasons || []).includes('non_production_name_hard_exclude')) {
      transitionTag = 'example_or_demo_strategy';
    } else if (r.researchTier === 'watchlist' && r.promotionTier === 'reject') {
      transitionTag = 'research_watchlist_promotion_reject';
    } else if (r.researchTier === 'needs_more_data' && r.promotionTier === 'reject') {
      transitionTag = 'needs_more_data_promotion_reject';
    } else if (r.researchTier === 'watchlist' && r.promotionTier === 'watchlist') {
      transitionTag = 'watchlist_both_modes';
    } else if (r.promotionTier === 'promote_candidate') {
      transitionTag = 'promotion_candidate';
    }
    return { ...r, transitionTag };
  });

  const priority = {
    research_watchlist_promotion_reject: 0,
    needs_more_data_promotion_reject: 1,
    watchlist_both_modes: 2,
    promotion_candidate: 3,
    unchanged: 4,
  };

  all.sort((a, b) => {
    const pa = priority[a.transitionTag] ?? 99;
    const pb = priority[b.transitionTag] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.researchScore || 0) - (a.researchScore || 0);
  });

  const researchOnlyCandidates = all.filter((r) => r.transitionTag === 'research_watchlist_promotion_reject');
  return {
    rows: all,
    summary: {
      total: all.length,
      researchOnlyCandidates: researchOnlyCandidates.length,
    },
    researchOnlyCandidates: researchOnlyCandidates.slice(0, 10),
  };
}

/**
 * @param {string} jsonlContent
 * @param {object} [rulesOverrides]
 */
function computeStrategyValidationFromContent(jsonlContent, rulesOverrides = {}) {
  const overrideRoot = rulesOverrides || {};
  const researchRules = {
    ...DEFAULT_MODE_RULES.research,
    ...((overrideRoot.research && typeof overrideRoot.research === 'object') ? overrideRoot.research : {}),
  };
  const promotionRules = {
    ...DEFAULT_MODE_RULES.promotion,
    ...((overrideRoot.promotion && typeof overrideRoot.promotion === 'object') ? overrideRoot.promotion : {}),
  };

  // Backward compatibility: flat overrides apply to promotion mode.
  for (const [k, v] of Object.entries(overrideRoot)) {
    if (k === 'research' || k === 'promotion') continue;
    promotionRules[k] = v;
  }

  const { trades, parseErrors, lineCount } = parsePaperTradesJsonlContent(jsonlContent == null ? '' : String(jsonlContent));

  const byStrategyMap = new Map();
  for (const t of trades) {
    const id = t.strategyId != null && String(t.strategyId).trim() !== '' ? String(t.strategyId).trim() : 'unknown';
    if (!byStrategyMap.has(id)) byStrategyMap.set(id, []);
    byStrategyMap.get(id).push(t);
  }

  const baseMetricsRows = [];
  for (const [strategyId, list] of byStrategyMap.entries()) {
    baseMetricsRows.push(aggregateStrategyMetrics(strategyId, list));
  }

  const research = runMode(baseMetricsRows, researchRules, 'research');
  const promotion = runMode(baseMetricsRows, promotionRules, 'promotion');
  const transitionView = buildTransitionView(research.rows, promotion.rows);
  const blockingSummary = computeBlockingSummary(promotion.rows);

  const payload = {
    strategyValidationSchemaVersion: STRATEGY_VALIDATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: 'governance/paper_trades.jsonl',
    lineCount,
    parseErrors,
    validTradeCount: trades.length,
    defaultMode: 'promotion',
    rulesByMode: {
      research: researchRules,
      promotion: promotionRules,
    },
    // Backward-compatible root fields map to strict promotion gate.
    rules: promotionRules,
    summary: promotion.summary,
    topPromotable: promotion.topPromotable,
    topWatchlist: promotion.topWatchlist,
    rows: promotion.rows,
    modes: {
      research,
      promotion,
    },
    transition: transitionView,
    transitionCandidates: transitionView.researchOnlyCandidates,
    whatBlocksPromotion: blockingSummary,
    trendMemoryApply: getTrendMemoryApplyContext(),
    validationTarget: { ...VALIDATION_TARGET },
  };
  payload.validationFunnel = buildValidationFunnel(payload);
  payload.strictPaperGateExplainer = buildStrictPaperGateExplainer(promotion.summary, promotion.rows);
  return payload;
}

function computeStrategyValidationFromFile(filePath, fs = require('fs'), rulesOverrides = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return computeStrategyValidationFromContent('', rulesOverrides);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return computeStrategyValidationFromContent(content, rulesOverrides);
}

module.exports = {
  computeStrategyValidationFromContent,
  computeStrategyValidationFromFile,
  STRATEGY_VALIDATION_SCHEMA_VERSION,
  DEFAULT_MODE_RULES,
  NON_PRODUCTION_NAME_POLICY,
  nonProductionNameSignals,
  buildStrictPaperGateExplainer,
  computeScoreStrategyBreakdown,
  scoreStrategy,
  computeLearningScoreBreakdown,
  inferLearningTier,
};

