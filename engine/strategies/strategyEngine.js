'use strict';

/**
 * NeuroPilot Quant Engine v1 — Strategy Engine
 *
 * Selects a single execution strategy based on market regime and features.
 * Pure function: select(features, regime) -> decision.
 *
 * Input:
 *   - features: object from Feature Engine (price, ema20, ema50, atr, vwapDistance, etc.)
 *   - regime: { regime: string, confidence: number } from Regime Engine
 *
 * Output:
 *   - { strategy: string|null, direction: 'long'|'short'|null, confidence: number, reason: string, valid: boolean }
 *   - If no strategy is valid: strategy and direction are null, valid is false.
 */

const REGIMES = require('../regime/regimeEngine').REGIMES;
const trendBreakout = require('./trendBreakout');
const meanReversion = require('./meanReversion');

/** Canonical "no strategy" decision. */
const NO_STRATEGY_DECISION = Object.freeze({
  strategy: null,
  direction: null,
  confidence: 0,
  reason: 'No valid strategy for current regime',
  valid: false,
});

/**
 * Registry: regime name -> strategy module (first applicable strategy per regime).
 * Order determines which strategy is used when a regime maps to multiple strategies.
 */
const REGIME_TO_STRATEGY = Object.freeze({
  [REGIMES.TREND_UP]: trendBreakout,
  [REGIMES.TREND_DOWN]: trendBreakout,
  [REGIMES.BREAKOUT]: trendBreakout,
  [REGIMES.RANGE]: meanReversion,
  [REGIMES.HIGH_VOLATILITY]: null, // No dedicated strategy; returns NO_STRATEGY_DECISION
});

/** All registered strategies (for extension: add to this array and to REGIME_TO_STRATEGY). */
const STRATEGIES = Object.freeze([trendBreakout, meanReversion]);

/**
 * Select one strategy for the given regime and compute its decision.
 * Pure function: same inputs => same output.
 *
 * @param {object} features - Feature object from Feature Engine
 * @param {object} regime - { regime: string, confidence: number } from Regime Engine
 * @param {object} [options] - Passed through to strategy evaluate(); keys per strategy (e.g. trendBreakout, meanReversion)
 * @returns {{ strategy: string|null, direction: string|null, confidence: number, reason: string, valid: boolean }}
 */
function select(features, regime, options = {}) {
  const regimeName = regime && regime.regime;
  if (!regimeName) {
    return { ...NO_STRATEGY_DECISION };
  }

  const strategyModule = REGIME_TO_STRATEGY[regimeName];
  if (!strategyModule) {
    return { ...NO_STRATEGY_DECISION };
  }

  const strategyOptions = options[strategyModule.name] || {};
  const decision = strategyModule.evaluate(features, regime, strategyOptions);

  if (!decision.valid) {
    return { ...NO_STRATEGY_DECISION };
  }

  return {
    strategy: decision.strategy,
    direction: decision.direction,
    confidence: decision.confidence,
    reason: decision.reason,
    valid: true,
  };
}

module.exports = {
  select,
  NO_STRATEGY_DECISION,
  REGIME_TO_STRATEGY,
  STRATEGIES,
};
