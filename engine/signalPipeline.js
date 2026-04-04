'use strict';

/**
 * NeuroPilot Quant Engine v1 — Signal Pipeline Runner
 *
 * Single orchestrator that runs the full decision pipeline: features → regime →
 * strategy → trade decision → risk sizing. Pure function: same (candles, account, options)
 * => same output. No side effects; all stage outputs are preserved in the result.
 *
 * Inputs:
 *   - candles: OHLCV array (oldest first) for Feature Engine
 *   - account: { equity, dailyPnL, openPositions } for Risk Sizing Engine
 *   - options: optional per-module overrides { features, regime, strategies, execution, risk }
 *
 * Output:
 *   - { shouldTrade, valid, features, regime, strategyDecision, tradeDecision, sizingDecision, reason }
 *   - shouldTrade/valid true only when trade and sizing both valid; reason explains outcome.
 */

const features = require('./features');
const regime = require('./regime');
const strategies = require('./strategies');
const execution = require('./execution');
const risk = require('./risk');

/**
 * Build final reason string. Valid: describe strategy + direction + risk-sized.
 * Invalid: use the first failing stage's reason (trade or sizing).
 */
function buildReason(tradeDecision, sizingDecision) {
  if (tradeDecision.valid && tradeDecision.shouldTrade && sizingDecision.valid && sizingDecision.shouldSize) {
    const strategy = tradeDecision.strategy || 'trade';
    const direction = tradeDecision.direction || '';
    return `Valid ${strategy.replace(/_/g, ' ')} ${direction} with risk-sized position`;
  }
  if (!tradeDecision.valid || !tradeDecision.shouldTrade) {
    return tradeDecision.reason || 'No valid trade decision';
  }
  return sizingDecision.reason || 'No valid sizing decision';
}

/**
 * Run the full signal pipeline. Pure orchestration; no side effects.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first) for feature computation
 * @param {object} account - { equity: number, dailyPnL: number, openPositions: number }
 * @param {object} [options] - Per-module options: { features, regime, strategies, execution, risk }
 * @param {number} [index] - Bar index for features (default: last bar, candles.length - 1)
 * @returns {object} Full signal: { shouldTrade, valid, features, regime, strategyDecision, tradeDecision, sizingDecision, reason }
 */
function run(candles, account, options = {}, index = candles.length - 1) {
  const opts = options || {};
  const featuresOpts = opts.features != null ? opts.features : {};
  const regimeOpts = opts.regime != null ? opts.regime : {};
  const strategiesOpts = opts.strategies != null ? opts.strategies : {};
  const executionOpts = opts.execution != null ? opts.execution : {};
  const riskOpts = opts.risk != null ? opts.risk : {};

  // 1. Compute features (always run; needed for downstream and for output)
  const featureObject = features.compute(candles, index, featuresOpts);

  // 2. Classify regime
  const regimeObject = regime.classify(featureObject, regimeOpts);

  // 3. Select strategy
  const strategyDecision = strategies.select(featureObject, regimeObject, strategiesOpts);

  // 4. Build trade decision
  const tradeDecision = execution.decide(featureObject, regimeObject, strategyDecision, executionOpts);

  // 5. Size risk (always run so sizingDecision is always present; may be invalid)
  const sizingDecision = risk.size(
    featureObject,
    regimeObject,
    strategyDecision,
    tradeDecision,
    account,
    riskOpts
  );

  // 6. Final validity and reason
  const shouldTrade = tradeDecision.valid === true && tradeDecision.shouldTrade === true &&
    sizingDecision.valid === true && sizingDecision.shouldSize === true;
  const valid = shouldTrade;
  const reason = buildReason(tradeDecision, sizingDecision);

  return {
    shouldTrade,
    valid,
    features: featureObject,
    regime: regimeObject,
    strategyDecision,
    tradeDecision,
    sizingDecision,
    reason,
  };
}

module.exports = {
  run,
  buildReason,
};
