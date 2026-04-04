'use strict';

/**
 * NeuroPilot Quant Engine v1 — Trade Decision Engine
 *
 * Transforms a strategy decision into a trade decision: whether to trade, entry/stop/target
 * models, and risk-reward. Pure function: same inputs => same output.
 *
 * Inputs:
 *   - features: object from Feature Engine (used for optional reason enrichment)
 *   - regime: { regime: string, confidence: number } from Regime Engine
 *   - strategyDecision: { strategy, direction, confidence, reason, valid } from Strategy Engine
 *
 * Output:
 *   - Trade decision: { shouldTrade, strategy, direction, confidence, entryType, stopModel, targetModel, riskReward, valid, reason }
 *   - If no valid trade: shouldTrade false, strategy/direction null, confidence 0, valid false.
 */

/** Canonical "no trade" decision. */
const NO_TRADE_DECISION = Object.freeze({
  shouldTrade: false,
  strategy: null,
  direction: null,
  confidence: 0,
  entryType: null,
  stopModel: null,
  targetModel: null,
  riskReward: null,
  valid: false,
  reason: 'No valid trade decision',
});

/**
 * Per-strategy execution defaults: entry type, stop model, target model, risk-reward.
 * Extend this map when adding new strategies.
 */
const STRATEGY_EXECUTION_DEFAULTS = Object.freeze({
  trend_breakout: Object.freeze({
    entryType: 'market',
    stopModel: 'atr',
    targetModel: 'rr_multiple',
    riskReward: 2.0,
  }),
  mean_reversion: Object.freeze({
    entryType: 'market',
    stopModel: 'atr',
    targetModel: 'vwap_revert',
    riskReward: 1.5,
  }),
});

/**
 * Default thresholds. All are configurable via options.
 */
const DEFAULT_OPTIONS = Object.freeze({
  /** Minimum combined confidence to allow a trade (e.g. regime + strategy blend). */
  minConfidence: 0.4,
  /** Minimum regime confidence (from regime object). */
  minRegimeConfidence: 0.3,
  /** Minimum strategy decision confidence. */
  minStrategyConfidence: 0.35,
});

/**
 * Build reason string for valid trade (strategy reason + optional regime context).
 */
function buildTradeReason(strategyDecision, regime) {
  const base = strategyDecision.reason || '';
  if (!regime || !regime.regime) return base;
  return `${base} in ${regime.regime} regime`;
}

/**
 * Resolve execution params (entryType, stopModel, targetModel, riskReward) for a strategy.
 * Unknown strategies get market/atr/rr_multiple/1.5 as fallback.
 */
function getExecutionParams(strategyName) {
  const params = STRATEGY_EXECUTION_DEFAULTS[strategyName];
  if (params) return { ...params };
  return {
    entryType: 'market',
    stopModel: 'atr',
    targetModel: 'rr_multiple',
    riskReward: 1.5,
  };
}

/**
 * Decide whether to trade and with which execution parameters.
 * Pure function: no side effects; same (features, regime, strategyDecision, options) => same result.
 *
 * @param {object} features - Feature object from Feature Engine (used for reason; can be empty)
 * @param {object} regime - { regime: string, confidence: number } from Regime Engine
 * @param {object} strategyDecision - { strategy, direction, confidence, reason, valid } from Strategy Engine
 * @param {object} [options] - Override minConfidence, minRegimeConfidence, minStrategyConfidence
 * @returns {object} Trade decision object (see module doc)
 */
function decide(features, regime, strategyDecision, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!strategyDecision || strategyDecision.valid !== true) {
    return { ...NO_TRADE_DECISION };
  }

  const regimeConfidence = regime && typeof regime.confidence === 'number' ? regime.confidence : 0;
  const strategyConfidence = typeof strategyDecision.confidence === 'number' ? strategyDecision.confidence : 0;

  if (regimeConfidence < opts.minRegimeConfidence) {
    return {
      ...NO_TRADE_DECISION,
      reason: `Regime confidence ${regimeConfidence.toFixed(2)} below minRegimeConfidence (${opts.minRegimeConfidence})`,
    };
  }
  if (strategyConfidence < opts.minStrategyConfidence) {
    return {
      ...NO_TRADE_DECISION,
      reason: `Strategy confidence ${strategyConfidence.toFixed(2)} below minStrategyConfidence (${opts.minStrategyConfidence})`,
    };
  }

  const confidence = strategyConfidence;
  if (confidence < opts.minConfidence) {
    return {
      ...NO_TRADE_DECISION,
      reason: `Confidence ${confidence.toFixed(2)} below minConfidence (${opts.minConfidence})`,
    };
  }

  const strategyName = strategyDecision.strategy;
  const execution = getExecutionParams(strategyName);
  const reason = buildTradeReason(strategyDecision, regime);

  return {
    shouldTrade: true,
    strategy: strategyName,
    direction: strategyDecision.direction,
    confidence,
    entryType: execution.entryType,
    stopModel: execution.stopModel,
    targetModel: execution.targetModel,
    riskReward: execution.riskReward,
    valid: true,
    reason,
  };
}

module.exports = {
  decide,
  NO_TRADE_DECISION,
  DEFAULT_OPTIONS,
  STRATEGY_EXECUTION_DEFAULTS,
  getExecutionParams,
};
