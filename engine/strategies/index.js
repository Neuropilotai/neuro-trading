'use strict';

/**
 * NeuroPilot Quant Engine v1 — Strategy Engine (public API)
 *
 * Usage:
 *   const { compute } = require('./engine/features');
 *   const { classify } = require('./engine/regime');
 *   const { select } = require('./engine/strategies');
 *   const features = compute(ohlcvCandles);
 *   const regime = classify(features);
 *   const decision = select(features, regime);
 *   // e.g. { strategy: 'trend_breakout', direction: 'long', confidence: 0.74, reason: '...', valid: true }
 */
const strategyEngine = require('./strategyEngine');
const trendBreakout = require('./trendBreakout');
const meanReversion = require('./meanReversion');

module.exports = {
  select: strategyEngine.select,
  NO_STRATEGY_DECISION: strategyEngine.NO_STRATEGY_DECISION,
  REGIME_TO_STRATEGY: strategyEngine.REGIME_TO_STRATEGY,
  STRATEGIES: strategyEngine.STRATEGIES,
  trendBreakout,
  meanReversion,
};
