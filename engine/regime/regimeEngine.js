'use strict';

/**
 * NeuroPilot Quant Engine v1 — Regime Engine
 *
 * Pure function: classifies market regime from a feature object (output of the Feature Engine).
 * Returns a single regime label and a confidence score in [0, 1].
 *
 * Regimes:
 *   TREND_UP       — price > ema20, ema20 > ema50, ema20Slope > 0
 *   TREND_DOWN     — price < ema20, ema20 < ema50, ema20Slope < 0
 *   RANGE          — ema20 close to ema50, price near VWAP, low volatility
 *   BREAKOUT       — rangeState === 'expansion' && volumeSpike === true
 *   HIGH_VOLATILITY — ATR% above threshold (or volatility === 'high')
 *
 * Input: feature object from engine/features (price, ema20, ema50, ema20Slope, atr, vwapDistance, volumeSpike, rangeState, volatility).
 * Output: { regime: string, confidence: number }
 */

/** Regime labels (single source of truth for downstream strategies). */
const REGIMES = Object.freeze({
  TREND_UP: 'TREND_UP',
  TREND_DOWN: 'TREND_DOWN',
  RANGE: 'RANGE',
  BREAKOUT: 'BREAKOUT',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
});

/**
 * Default thresholds for regime classification.
 * All numeric thresholds are tuning parameters; override via options.
 */
const DEFAULT_OPTIONS = Object.freeze({
  // RANGE: "ema20 close to ema50" — max allowed |ema20 - ema50| as fraction of ema50 (e.g. 0.005 = 0.5%)
  rangeEmaProximityPct: 0.005,
  // RANGE: "price near VWAP" — max |vwapDistance| in ATR units (e.g. 0.5 = half an ATR)
  rangeVwapDistanceAtrMax: 0.5,
  // HIGH_VOLATILITY: ATR% above this value => high volatility regime (e.g. 0.02 = 2%)
  highVolatilityAtrPctMin: 0.02,
  // Minimum score to assign a regime; below this we return RANGE with low confidence
  minConfidenceToAssign: 0.2,
  // Priority order when multiple regimes score: first wins (e.g. BREAKOUT over TREND)
  priorityOrder: [
    REGIMES.BREAKOUT,
    REGIMES.HIGH_VOLATILITY,
    REGIMES.TREND_UP,
    REGIMES.TREND_DOWN,
    REGIMES.RANGE,
  ],
});

/**
 * Score TREND_UP: 0..1 from strength of (price > ema20, ema20 > ema50, ema20Slope > 0).
 * Uses relative distances (in ATR units) so confidence reflects strength, not just binary.
 */
function scoreTrendUp(features, opts) {
  const { price, ema20, ema50, ema20Slope, atr } = features;
  if (price == null || ema20 == null || ema50 == null || ema20Slope == null || atr == null || atr <= 0) {
    return 0;
  }
  const aboveEma20 = (price - ema20) / atr;
  const ema20Above50 = (ema20 - ema50) / atr;
  const slopePositive = ema20Slope > 0 ? Math.min(1, ema20Slope / atr) : 0;
  if (aboveEma20 <= 0 || ema20Above50 <= 0) return 0;
  const c1 = Math.min(1, aboveEma20);
  const c2 = Math.min(1, ema20Above50);
  const c3 = Math.min(1, slopePositive + 0.5);
  return (c1 + c2 + c3) / 3;
}

/**
 * Score TREND_DOWN: 0..1 from strength of (price < ema20, ema20 < ema50, ema20Slope < 0).
 */
function scoreTrendDown(features, opts) {
  const { price, ema20, ema50, ema20Slope, atr } = features;
  if (price == null || ema20 == null || ema50 == null || ema20Slope == null || atr == null || atr <= 0) {
    return 0;
  }
  const belowEma20 = (ema20 - price) / atr;
  const ema20Below50 = (ema50 - ema20) / atr;
  const slopeNegative = ema20Slope < 0 ? Math.min(1, -ema20Slope / atr) : 0;
  if (belowEma20 <= 0 || ema20Below50 <= 0) return 0;
  const c1 = Math.min(1, belowEma20);
  const c2 = Math.min(1, ema20Below50);
  const c3 = Math.min(1, slopeNegative + 0.5);
  return (c1 + c2 + c3) / 3;
}

/**
 * Score RANGE: ema20 close to ema50, price near VWAP, low volatility.
 * Each condition contributes to a 0..1 score; combined as average.
 */
function scoreRange(features, opts) {
  const { price, ema20, ema50, vwapDistance, atr, volatility } = features;
  const ema50Safe = ema50 != null && Math.abs(ema50) > 1e-9 ? ema50 : 1;
  const atrSafe = atr != null && atr > 0 ? atr : 1;

  let emaProximity = 0;
  if (ema20 != null && ema50 != null) {
    const diffPct = Math.abs(ema20 - ema50) / ema50Safe;
    emaProximity = diffPct <= opts.rangeEmaProximityPct ? 1 : Math.max(0, 1 - diffPct / (opts.rangeEmaProximityPct * 2));
  }

  let vwapNear = 0;
  if (vwapDistance != null) {
    const distAtr = Math.abs(vwapDistance) / atrSafe;
    vwapNear = distAtr <= opts.rangeVwapDistanceAtrMax ? 1 : Math.max(0, 1 - (distAtr - opts.rangeVwapDistanceAtrMax));
  }

  const lowVol = volatility === 'low' ? 1 : (volatility === 'medium' ? 0.5 : 0);

  return (emaProximity + vwapNear + lowVol) / 3;
}

/**
 * Score BREAKOUT: rangeState === 'expansion' && volumeSpike === true.
 * Binary satisfaction with optional strength from rangeState ratio if we had it.
 */
function scoreBreakout(features, opts) {
  const { rangeState, volumeSpike } = features;
  if (rangeState === 'expansion' && volumeSpike === true) return 1;
  if (rangeState === 'expansion' || volumeSpike === true) return 0.5;
  return 0;
}

/**
 * Score HIGH_VOLATILITY: ATR% above threshold, or volatility === 'high'.
 */
function scoreHighVolatility(features, opts) {
  const { atr, price, volatility } = features;
  if (volatility === 'high') return 1;
  if (atr != null && price != null && price > 0) {
    const atrPct = atr / price;
    if (atrPct >= opts.highVolatilityAtrPctMin) {
      return Math.min(1, atrPct / (opts.highVolatilityAtrPctMin * 1.5));
    }
  }
  if (volatility === 'medium') return 0.3;
  return 0;
}

/** All scorers: regime -> scoring function. */
const SCORERS = Object.freeze({
  [REGIMES.TREND_UP]: scoreTrendUp,
  [REGIMES.TREND_DOWN]: scoreTrendDown,
  [REGIMES.RANGE]: scoreRange,
  [REGIMES.BREAKOUT]: scoreBreakout,
  [REGIMES.HIGH_VOLATILITY]: scoreHighVolatility,
});

/**
 * Classify market regime from a feature object.
 * Pure function: no side effects; same features + options => same result.
 *
 * @param {object} features - Feature object from the Feature Engine (price, ema20, ema50, ema20Slope, atr, vwap, vwapDistance, volumeSpike, rangeState, volatility, regimeCandidate)
 * @param {object} [options] - Override default thresholds (rangeEmaProximityPct, rangeVwapDistanceAtrMax, highVolatilityAtrPctMin, minConfidenceToAssign, priorityOrder)
 * @returns {{ regime: string, confidence: number }} - Single regime label and confidence in [0, 1]
 */
function classify(features, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const order = opts.priorityOrder || DEFAULT_OPTIONS.priorityOrder;

  let bestRegime = REGIMES.RANGE;
  let bestScore = 0;

  for (const regime of order) {
    const fn = SCORERS[regime];
    if (!fn) continue;
    const score = fn(features, opts);
    if (score > bestScore) {
      bestScore = score;
      bestRegime = regime;
    }
  }

  const confidence = bestScore < opts.minConfidenceToAssign && bestRegime !== REGIMES.RANGE
    ? bestScore
    : bestRegime === REGIMES.RANGE && bestScore < opts.minConfidenceToAssign
      ? Math.max(bestScore, 0.3)
      : bestScore;

  return {
    regime: bestRegime,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

module.exports = {
  classify,
  REGIMES,
  DEFAULT_OPTIONS,
  SCORERS,
};
