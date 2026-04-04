'use strict';

/**
 * NeuroPilot Quant Engine v1 — Breakout Entry Confirmation Filter
 *
 * Optional filter to reduce immediate false breakouts for trend_breakout strategy.
 * Pure function; no side effects.
 *
 * v1 options:
 *   - requireOneBarConfirmation: only allow trend_breakout when the previous bar
 *     was already in a trend/breakout regime (TREND_UP, TREND_DOWN, BREAKOUT).
 *     Entry is then on the bar after the breakout bar, not on the breakout bar itself.
 */

const features = require('./features');
const regime = require('./regime');

const TREND_BREAKOUT_STRATEGY = 'trend_breakout';

/** Regimes that count as "trend/breakout" for one-bar confirmation. */
const TREND_BREAKOUT_REGIMES = Object.freeze([
  regime.REGIMES.TREND_UP,
  regime.REGIMES.TREND_DOWN,
  regime.REGIMES.BREAKOUT,
]);

/**
 * Default options for the filter.
 */
const DEFAULT_OPTIONS = Object.freeze({
  /** When true, trend_breakout signals are only allowed if previous bar was in a trend/breakout regime. */
  requireOneBarConfirmation: false,
  /** Minimum bars required before we have a valid "previous" bar (must be >= 1). */
  minBars: 51,
});

/**
 * Evaluate whether a trend_breakout signal passes the confirmation filter.
 * Non–trend_breakout strategies are not filtered (return confirmed: true when not applicable).
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {number} index - Current bar index (signal was generated at this bar)
 * @param {string} strategyName - Strategy name from the signal (e.g. 'trend_breakout')
 * @param {object} [options] - { requireOneBarConfirmation, minBars, features?: object, regime?: object } (features/regime opts for prev bar computation)
 * @returns {{ confirmed: boolean, reason: string }}
 */
function evaluate(candles, index, strategyName, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const minBars = typeof opts.minBars === 'number' && opts.minBars >= 0 ? opts.minBars : DEFAULT_OPTIONS.minBars;

  if (strategyName !== TREND_BREAKOUT_STRATEGY) {
    return { confirmed: true, reason: 'Filter only applies to trend_breakout' };
  }

  if (!opts.requireOneBarConfirmation) {
    return { confirmed: true, reason: 'One-bar confirmation disabled' };
  }

  const prevIndex = index - 1;
  if (prevIndex < 0 || prevIndex < minBars) {
    return { confirmed: false, reason: 'No previous bar for confirmation' };
  }

  if (!Array.isArray(candles) || prevIndex >= candles.length) {
    return { confirmed: false, reason: 'Missing candle data for previous bar' };
  }

  const featuresOpts = opts.features && typeof opts.features === 'object' ? opts.features : {};
  const regimeOpts = opts.regime && typeof opts.regime === 'object' ? opts.regime : {};
  const prevFeatures = features.compute(candles, prevIndex, featuresOpts);
  const prevRegimeResult = regime.classify(prevFeatures, regimeOpts);
  const prevRegime = prevRegimeResult && prevRegimeResult.regime ? prevRegimeResult.regime : null;

  if (!prevRegime || !TREND_BREAKOUT_REGIMES.includes(prevRegime)) {
    return { confirmed: false, reason: `Previous bar regime ${prevRegime || 'null'} not trend/breakout` };
  }

  return { confirmed: true, reason: `Previous bar confirmed ${prevRegime}` };
}

module.exports = {
  evaluate,
  DEFAULT_OPTIONS,
  TREND_BREAKOUT_STRATEGY,
  TREND_BREAKOUT_REGIMES,
};
