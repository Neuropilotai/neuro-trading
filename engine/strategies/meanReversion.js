'use strict';

/**
 * NeuroPilot Quant Engine v1 — Mean Reversion Strategy
 *
 * Use when regime is RANGE. Fades extremes: long when price is below VWAP,
 * short when price is above VWAP. Assumes price will revert toward VWAP.
 *
 * Pure function: evaluate(features, regime) -> decision.
 */

const REGIMES = require('../regime/regimeEngine').REGIMES;

const STRATEGY_NAME = 'mean_reversion';

/** Regimes for which this strategy is applicable. */
const APPLICABLE_REGIMES = Object.freeze([REGIMES.RANGE]);

/**
 * Default thresholds (override via options in evaluate).
 */
const DEFAULT_OPTIONS = Object.freeze({
  // Min |vwapDistance|/ATR to consider price "stretched" (avoid trading at VWAP)
  minStretchAtr: 0.25,
  // Max |vwapDistance|/ATR beyond which we cap confidence (avoid overstretch noise)
  maxStretchAtr: 2.0,
  // Minimum regime confidence to consider strategy valid
  minRegimeConfidence: 0.3,
  // Penalty if trend alignment is strong (ema20Slope * atr) — avoid mean reversion in disguised trend
  maxEmaSlopeAtr: 0.3,
});

/**
 * Check that trend is not too strong (avoid mean reversion in trending market).
 */
function isTrendWeak(features, opts) {
  const { ema20Slope, atr } = features;
  if (ema20Slope == null || atr == null || atr <= 0) return true;
  const slopeAtr = Math.abs(ema20Slope) / atr;
  return slopeAtr <= opts.maxEmaSlopeAtr;
}

/**
 * Stretch score: how far price is from VWAP in ATR units (0..1 scale for confidence).
 */
function stretchScore(features, opts) {
  const { vwapDistance, atr } = features;
  if (vwapDistance == null || atr == null || atr <= 0) return 0;
  const stretchAtr = Math.abs(vwapDistance) / atr;
  if (stretchAtr < opts.minStretchAtr) return 0;
  return Math.min(1, (stretchAtr - opts.minStretchAtr) / (opts.maxStretchAtr - opts.minStretchAtr));
}

/**
 * Build human-readable reason string.
 */
function buildReason(direction, features) {
  const parts = ['RANGE'];
  if (features.vwapDistance != null) {
    if (features.vwapDistance < 0) parts.push('price below VWAP');
    else parts.push('price above VWAP');
  }
  parts.push('no strong trend');
  return parts.join(', ');
}

/**
 * Evaluate mean reversion strategy. Pure function.
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
    reason: 'Mean reversion not applicable or conditions not met',
    valid: false,
  };

  if (!regimeName || !APPLICABLE_REGIMES.includes(regimeName)) {
    return invalidDecision;
  }
  if (regimeConfidence < opts.minRegimeConfidence) {
    return invalidDecision;
  }
  if (!isTrendWeak(features, opts)) {
    return invalidDecision;
  }

  const { vwapDistance } = features;
  let direction = null;
  if (vwapDistance != null) {
    direction = vwapDistance < 0 ? 'long' : 'short';
  }
  if (direction == null) {
    return invalidDecision;
  }

  const stretch = stretchScore(features, opts);
  const confidence = Math.max(0, Math.min(1, regimeConfidence * 0.5 + stretch * 0.5));
  const reason = buildReason(direction, features);

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
