'use strict';

/**
 * Simple regime candidate from price vs EMAs
 *
 * Heuristic (no ML): trend up = price > ema20 > ema50; trend down = price < ema20 < ema50;
 * range = mixed or emas flat. Used as a candidate for strategy selection.
 *
 * @param {number} price - Current close
 * @param {number} ema20 - EMA(20) value
 * @param {number} ema50 - EMA(50) value
 * @param {number} [ema20Slope] - Optional; if provided, "strong" trend when slope same sign as trend
 * @returns {'trend_up'|'trend_down'|'range'}
 */
function regimeCandidate(price, ema20, ema50, ema20Slope = 0) {
  if (ema20 == null || ema50 == null) return 'range';
  if (price > ema20 && ema20 > ema50) return 'trend_up';
  if (price < ema20 && ema20 < ema50) return 'trend_down';
  return 'range';
}

/**
 * Map to short label for output (e.g. "trend" for trend_up/trend_down).
 */
function regimeCandidateLabel(price, ema20, ema50) {
  const r = regimeCandidate(price, ema20, ema50);
  if (r === 'trend_up') return 'trend';
  if (r === 'trend_down') return 'trend';
  return 'range';
}

module.exports = { regimeCandidate, regimeCandidateLabel };
