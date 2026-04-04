'use strict';

/**
 * NeuroPilot Quant Engine v1 — Breakout Strength Filter
 *
 * Optional filter for trend_breakout: only allow breakouts when the breakout candle
 * shows strong momentum. Reduces immediate false breakouts (e.g. bars=1 losses).
 * Pure function; no side effects.
 *
 * Criteria (pipeline: body >= 60% + close in extreme):
 *   - body = abs(close - open), range = high - low, bodyPercent = body / range → bodyPercent >= 0.6
 *   - Long: closeStrength = (close - low) / range >= closeStrengthMin (default 0.7) → close near high
 *   - Short: closeStrength = (high - close) / range >= closeStrengthMin (default 0.7) → close near low
 *   - Optional: requireRangeExpansion (current bar range > previous bar range).
 */

const TREND_BREAKOUT_STRATEGY = 'trend_breakout';

/**
 * Default options for the filter.
 */
const DEFAULT_OPTIONS = Object.freeze({
  /** Minimum body/range ratio (0..1). Default 0.6 = body must be at least 60% of range. */
  minBodyRatio: 0.6,
  /** Close in extreme: long (close-low)/range >= this, short (high-close)/range >= this. Default 0.7 = close near high/low. */
  closeStrengthMin: 0.7,
  /** Close must be in this fraction of range from the extreme (long: top 20% = 0.2). Used only if closeStrengthMin not set. */
  closeInExtremePercent: 0.2,
  /** When true, require current bar range > previous bar range (range expansion). */
  requireRangeExpansion: false,
});

/**
 * Evaluate whether the breakout candle at the given index has strong momentum.
 * Only applicable to trend_breakout; call when strategy is trend_breakout and direction is known.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {number} index - Bar index of the breakout candle (signal bar)
 * @param {string} direction - 'long' | 'short'
 * @param {object} [options] - { minBodyRatio, closeStrengthMin, closeInExtremePercent, requireRangeExpansion }
 * @returns {{ passed: boolean, reason: string }}
 */
function evaluate(candles, index, direction, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const minBodyRatio = typeof opts.minBodyRatio === 'number' && opts.minBodyRatio >= 0 && opts.minBodyRatio <= 1
    ? opts.minBodyRatio
    : DEFAULT_OPTIONS.minBodyRatio;
  const closeStrengthMin = typeof opts.closeStrengthMin === 'number' && opts.closeStrengthMin >= 0 && opts.closeStrengthMin <= 1
    ? opts.closeStrengthMin
    : DEFAULT_OPTIONS.closeStrengthMin;

  if (!Array.isArray(candles) || index < 0 || index >= candles.length) {
    return { passed: false, reason: 'Missing candle or invalid index' };
  }

  const bar = candles[index];
  const open = bar && typeof bar.open === 'number' ? bar.open : null;
  const high = bar && typeof bar.high === 'number' ? bar.high : null;
  const low = bar && typeof bar.low === 'number' ? bar.low : null;
  const close = bar && typeof bar.close === 'number' ? bar.close : null;

  if (open == null || high == null || low == null || close == null) {
    return { passed: false, reason: 'Bar missing OHLC' };
  }

  const range = high - low;
  if (range <= 0) {
    return { passed: false, reason: 'Zero or negative range' };
  }

  const body = Math.abs(close - open);
  const bodyRatio = body / range;
  if (bodyRatio < minBodyRatio) {
    return { passed: false, reason: `Body ratio ${(bodyRatio * 100).toFixed(1)}% < ${(minBodyRatio * 100).toFixed(0)}%` };
  }

  // Close in extreme: long (close-low)/range >= closeStrengthMin, short (high-close)/range >= closeStrengthMin
  const isLong = direction === 'long';
  if (isLong) {
    const closeStrength = (close - low) / range;
    if (closeStrength < closeStrengthMin) {
      return { passed: false, reason: `Long: closeStrength ${(closeStrength * 100).toFixed(1)}% < ${(closeStrengthMin * 100).toFixed(0)}%` };
    }
  } else {
    const closeStrength = (high - close) / range;
    if (closeStrength < closeStrengthMin) {
      return { passed: false, reason: `Short: closeStrength ${(closeStrength * 100).toFixed(1)}% < ${(closeStrengthMin * 100).toFixed(0)}%` };
    }
  }

  if (opts.requireRangeExpansion && index > 0) {
    const prev = candles[index - 1];
    const prevRange = prev && typeof prev.high === 'number' && typeof prev.low === 'number'
      ? prev.high - prev.low
      : 0;
    if (range <= prevRange) {
      return { passed: false, reason: 'Range expansion required but current range <= previous' };
    }
  }

  return { passed: true, reason: 'Breakout strength passed' };
}

module.exports = {
  evaluate,
  DEFAULT_OPTIONS,
  TREND_BREAKOUT_STRATEGY,
};
