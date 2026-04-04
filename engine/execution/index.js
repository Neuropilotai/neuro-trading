'use strict';

/**
 * NeuroPilot Quant Engine v1 — Execution / Trade Decision (public API)
 *
 * Transforms strategy decision into trade decision (shouldTrade, entry/stop/target models, risk-reward).
 *
 * Usage:
 *   const { compute } = require('./engine/features');
 *   const { classify } = require('./engine/regime');
 *   const { select } = require('./engine/strategies');
 *   const { decide } = require('./engine/execution');
 *   const features = compute(ohlcvCandles);
 *   const regime = classify(features);
 *   const strategyDecision = select(features, regime);
 *   const tradeDecision = decide(features, regime, strategyDecision);
 *   // e.g. { shouldTrade: true, strategy: 'trend_breakout', direction: 'long', ... }
 */
const tradeDecisionEngine = require('./tradeDecisionEngine');

module.exports = {
  decide: tradeDecisionEngine.decide,
  NO_TRADE_DECISION: tradeDecisionEngine.NO_TRADE_DECISION,
  DEFAULT_OPTIONS: tradeDecisionEngine.DEFAULT_OPTIONS,
  STRATEGY_EXECUTION_DEFAULTS: tradeDecisionEngine.STRATEGY_EXECUTION_DEFAULTS,
  getExecutionParams: tradeDecisionEngine.getExecutionParams,
};
