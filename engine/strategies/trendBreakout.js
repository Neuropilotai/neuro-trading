'use strict';

/**
 * NeuroPilot Quant Engine v1 — Trend / Breakout Strategy
 *
 * Use when regime is TREND_UP, TREND_DOWN, or BREAKOUT. Trades in direction of trend
 * or inferred breakout direction. Confidence increases when price is aligned with
 * EMAs and VWAP, and when volume spike or range expansion is present.
 *
 * Pure function: evaluate(features, regime) -> decision.
 */

const REGIMES = require('../regime/regimeEngine').REGIMES;

const STRATEGY_NAME = 'trend_breakout';

/** Regimes for which this strategy is applicable. */
const APPLICABLE_REGIMES = Object.freeze([
  REGIMES.TREND_UP,
  REGIMES.TREND_DOWN,
  REGIMES.BREAKOUT,
]);

/**
 * Default thresholds (override via options in evaluate).
 */
const DEFAULT_OPTIONS = Object.freeze({
  // Max |price - ema20| / atr to consider "aligned" (smaller = stricter)
  alignmentAtrTolerance: 1.0,
  // Max |vwapDistance| / atr to consider price aligned with VWAP
  vwapAlignmentAtrTolerance: 0.75,
  // Minimum regime confidence to consider strategy valid
  minRegimeConfidence: 0.3,
  // Boost to confidence when volumeSpike or rangeState === 'expansion'
  volumeExpansionBoost: 0.1,
});

/**
 * Infer direction for BREAKOUT: long if price above EMAs/VWAP bias, short otherwise.
 * Uses price vs ema20, ema50, and vwapDistance (positive = above VWAP).
 */
function inferBreakoutDirection(features) {
  const { price, ema20, ema50, vwapDistance } = features;
  let longScore = 0;
  let shortScore = 0;
  if (price != null && ema20 != null && price > ema20) longScore += 1;
  else if (price != null && ema20 != null) shortScore += 1;
  if (price != null && ema50 != null && price > ema50) longScore += 1;
  else if (price != null && ema50 != null) shortScore += 1;
  if (vwapDistance != null && vwapDistance > 0) longScore += 1;
  else if (vwapDistance != null) shortScore += 1;
  return longScore >= shortScore ? 'long' : 'short';
}

/**
 * Direction for trend regimes: long for TREND_UP, short for TREND_DOWN.
 */
function directionForTrend(regimeName) {
  if (regimeName === REGIMES.TREND_UP) return 'long';
  if (regimeName === REGIMES.TREND_DOWN) return 'short';
  return null;
}

/**
 * Score alignment: price vs EMA20 and VWAP (0..1). Uses ATR-normalized distance.
 */
function alignmentScore(features, opts) {
  const { price, ema20, vwapDistance, atr } = features;
  if (atr == null || atr <= 0) return 0.5;
  let score = 1;
  if (price != null && ema20 != null) {
    const distEma = Math.abs(price - ema20) / atr;
    score *= Math.max(0, 1 - distEma / opts.alignmentAtrTolerance);
  }
  if (vwapDistance != null) {
    const distVwap = Math.abs(vwapDistance) / atr;
    score *= Math.max(0, 1 - distVwap / opts.vwapAlignmentAtrTolerance);
  }
  return Math.min(1, score);
}

/**
 * Build human-readable reason string for the decision.
 */
function buildReason(regimeName, direction, features, alignment, hasVolumeBoost) {
  const parts = [];
  parts.push(regimeName);
  if (features.ema20Slope != null && features.ema20Slope > 0) parts.push('positive EMA slope');
  if (features.ema20Slope != null && features.ema20Slope < 0) parts.push('negative EMA slope');
  if (features.vwapDistance != null) {
    if (features.vwapDistance > 0) parts.push('price above VWAP');
    else parts.push('price below VWAP');
  }
  if (alignment >= 0.6) parts.push('price aligned with EMA and VWAP');
  if (hasVolumeBoost) parts.push('volume spike or expansion');
  return parts.length ? parts.join(', ') : regimeName;
}

/**
 * Evaluate trend/breakout strategy. Pure function.
 *
 * @param {object} features - Feature object from Feature Engine
 * @param {object} regime - { regime: string, confidence: number }
 * @param {object} [options] - Override default thresholds
 * @returns {{ strategy: string, direction: string|null, confidence: number, reason: string, valid: boolean }}
 */
function evaluate(features, regime, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const regimeName = regime && regime.regime;
  const regimeConfidence = regime && typeof regime.confidence === 'number' ? regime.confidence : 0;

  const invalidDecision = {
    strategy: STRATEGY_NAME,
    direction: null,
    confidence: 0,
    reason: 'Trend/breakout not applicable or regime confidence too low',
    valid: false,
  };

  if (!regimeName || !APPLICABLE_REGIMES.includes(regimeName)) {
    return invalidDecision;
  }
  if (regimeConfidence < opts.minRegimeConfidence) {
    return invalidDecision;
  }

  let direction = directionForTrend(regimeName);
  if (regimeName === REGIMES.BREAKOUT) {
    direction = inferBreakoutDirection(features);
  }

  const alignment = alignmentScore(features, opts);
  const hasVolumeBoost = features.volumeSpike === true || features.rangeState === 'expansion';
  let confidence = regimeConfidence * 0.6 + alignment * 0.4;
  if (hasVolumeBoost) confidence = Math.min(1, confidence + opts.volumeExpansionBoost);
  confidence = Math.max(0, Math.min(1, confidence));

  const reason = buildReason(regimeName, direction, features, alignment, hasVolumeBoost);

  return {
    strategy: STRATEGY_NAME,
    direction,
    confidence,
    reason,
    valid: true,
  };
}

module.exports = {
  name: STRATEGY_NAME,
  applicableRegimes: APPLICABLE_REGIMES,
  evaluate,
  DEFAULT_OPTIONS,
};
