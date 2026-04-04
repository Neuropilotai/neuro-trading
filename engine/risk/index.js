'use strict';

/**
 * NeuroPilot Quant Engine v1 — Risk Sizing (public API)
 *
 * Converts a valid trade decision into a position sizing decision: risk amount,
 * stop distance, and position size.
 *
 * Usage:
 *   const { decide } = require('./engine/execution');
 *   const { size } = require('./engine/risk');
 *   const tradeDecision = decide(features, regime, strategyDecision);
 *   const sizingDecision = size(features, regime, strategyDecision, tradeDecision, account);
 *   // e.g. { shouldSize: true, riskAmount: 5, stopDistance: 4.5, positionSize: 1.11, ... }
 */
const riskSizingEngine = require('./riskSizingEngine');

module.exports = {
  size: riskSizingEngine.size,
  NO_SIZE_DECISION: riskSizingEngine.NO_SIZE_DECISION,
  DEFAULT_OPTIONS: riskSizingEngine.DEFAULT_OPTIONS,
  getStopDistance: riskSizingEngine.getStopDistance,
  validateAccountAndLimits: riskSizingEngine.validateAccountAndLimits,
  computeSizing: riskSizingEngine.computeSizing,
};
