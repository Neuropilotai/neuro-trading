'use strict';

/**
 * NeuroPilot Quant Engine v1 — Policy-Aware Pipeline Runner
 *
 * Combines the signal pipeline with the adaptive selector so the final output is one
 * adaptive, policy-aware signal object. Pure function: no side effects, no DB writes.
 *
 * Pipeline:
 *   1. Run signalPipeline(candles, account, options.pipeline, index)
 *   2. Run adaptiveSelector(signal, ranking, options.adaptive)
 *   3. Merge into one object; override shouldTrade/valid when policy blocks
 *
 * Inputs:
 *   - candles: OHLCV array (oldest first)
 *   - account: { equity, dailyPnL, openPositions }
 *   - ranking: from strategyRanking.rank(analysis)
 *   - options: optional { pipeline: {}, adaptive: {} }
 *   - index: optional bar index (default: last bar)
 *
 * Output:
 *   - { shouldTrade, valid, features, regime, strategyDecision, tradeDecision, sizingDecision, policyDecision, finalConfidence, finalDecision, reason }
 */

const signalPipeline = require('./signalPipeline');
const adaptiveSelector = require('./adaptiveSelector');

/**
 * Build final reason string: combine signal and policy when allowed; use policy reason when blocked.
 */
function buildFinalReason(signal, policyDecision, finalDecision) {
  if (finalDecision === 'block') {
    return policyDecision && policyDecision.reason ? policyDecision.reason : 'Signal blocked by policy';
  }
  const signalReason = signal.reason || '';
  const policyReason = policyDecision && policyDecision.reason ? policyDecision.reason : '';
  if (policyReason && (policyDecision.policyAction === 'favor' || policyDecision.policyAction === 'allow')) {
    return signalReason ? `${signalReason}, ${policyReason}` : policyReason;
  }
  return signalReason || policyReason || 'Valid signal';
}

/**
 * Run the policy-aware pipeline: signal pipeline + adaptive selector, return one merged result. Pure function.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {object} account - Account state for risk sizing
 * @param {object} ranking - Strategy ranking from strategyRanking.rank()
 * @param {object} [options] - { pipeline: signalPipeline options, adaptive: adaptiveSelector options }
 * @param {number} [index] - Bar index for features (default: candles.length - 1)
 * @returns {object} Adaptive signal: all pipeline fields + policyDecision, finalConfidence, finalDecision, reason
 */
function run(candles, account, ranking, options = {}, index = candles.length - 1) {
  const opts = options || {};
  const pipelineOptions = opts.pipeline != null ? opts.pipeline : {};
  const adaptiveOptions = opts.adaptive != null ? opts.adaptive : {};

  // 1. Run signal pipeline
  const signal = signalPipeline.run(candles, account, pipelineOptions, index);

  // 2. Run adaptive selector (accepts invalid signal; returns shouldAllow false)
  const policyDecision = adaptiveSelector.select(signal, ranking, adaptiveOptions);

  // 3. Determine final decision and overrides
  let finalDecision = policyDecision.policyAction;
  if (!signal.valid) {
    finalDecision = 'block';
  } else if (!policyDecision.shouldAllow) {
    finalDecision = 'block';
  }

  const policyBlocked = finalDecision === 'block' && signal.valid === true && !policyDecision.shouldAllow;
  const invalidSignal = !signal.valid;

  const shouldTrade = invalidSignal || policyBlocked ? false : signal.shouldTrade;
  const valid = invalidSignal || policyBlocked ? false : signal.valid;
  const finalConfidence = policyDecision.adjustedConfidence != null ? policyDecision.adjustedConfidence : (signal.tradeDecision && signal.tradeDecision.confidence) || 0;
  const reason = buildFinalReason(signal, policyDecision, finalDecision);

  return {
    shouldTrade,
    valid,
    features: signal.features,
    regime: signal.regime,
    strategyDecision: signal.strategyDecision,
    tradeDecision: signal.tradeDecision,
    sizingDecision: signal.sizingDecision,
    policyDecision: {
      shouldAllow: policyDecision.shouldAllow,
      adjustedConfidence: policyDecision.adjustedConfidence,
      selectedStrategy: policyDecision.selectedStrategy,
      policyAction: policyDecision.policyAction,
      reason: policyDecision.reason,
    },
    finalConfidence,
    finalDecision,
    reason,
  };
}

module.exports = {
  run,
  buildFinalReason,
};
