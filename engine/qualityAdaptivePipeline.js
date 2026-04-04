'use strict';

/**
 * NeuroPilot Quant Engine v1 — Quality-Aware Adaptive Pipeline
 *
 * Runs adaptivePipeline, then signalQualityGate, and returns one merged
 * quality-aware adaptive signal object. Pure function; no side effects.
 */

const adaptivePipeline = require('./adaptivePipeline');
const signalQualityGate = require('./signalQualityGate');

/**
 * Build final reason string based on adaptive validity and quality outcome.
 *
 * @param {object} adaptiveSignal - Output from adaptivePipeline.run()
 * @param {object} qualityDecision - Output from signalQualityGate.evaluate()
 * @returns {string}
 */
function buildFinalReason(adaptiveSignal, qualityDecision) {
  if (!adaptiveSignal || adaptiveSignal.valid !== true) {
    return (adaptiveSignal && adaptiveSignal.reason) || 'Adaptive signal invalid before quality gate';
  }
  if (!qualityDecision || qualityDecision.shouldPass !== true) {
    return (qualityDecision && qualityDecision.reason) || 'Adaptive signal blocked by quality gate';
  }
  return 'Adaptive signal passed quality gate';
}

/**
 * Run quality-aware adaptive pipeline: adaptivePipeline -> signalQualityGate.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {object} account - Account state for risk sizing
 * @param {object} ranking - Strategy ranking from strategyRanking.rank()
 * @param {object} [context] - Optional quality context (symbol, nowMs, recentSignals)
 * @param {object} [options] - { adaptivePipeline?: object, qualityGate?: object }
 * @param {number} [index] - Bar index for features (default: last bar)
 * @returns {object} Quality-aware adaptive signal (adaptive signal + qualityDecision + finalDecision/reason overrides)
 */
function run(candles, account, ranking, context = {}, options = {}, index = candles.length - 1) {
  const opts = options && typeof options === 'object' ? options : {};
  const adaptiveOptions = opts.adaptivePipeline && typeof opts.adaptivePipeline === 'object'
    ? opts.adaptivePipeline
    : {};
  const qualityOptions = opts.qualityGate && typeof opts.qualityGate === 'object'
    ? opts.qualityGate
    : {};

  // 1) Adaptive stage
  const adaptiveSignal = adaptivePipeline.run(candles, account, ranking, adaptiveOptions, index);

  // 2) Quality stage
  const qualityDecision = signalQualityGate.evaluate(adaptiveSignal, context, qualityOptions);

  // 3) Final quality-aware decision
  const adaptiveInvalid = adaptiveSignal.valid !== true;
  const qualityBlocked = qualityDecision.shouldPass !== true;
  const blocked = adaptiveInvalid || qualityBlocked;

  const finalDecision = blocked ? 'block' : qualityDecision.qualityAction;
  const shouldTrade = blocked ? false : adaptiveSignal.shouldTrade;
  const valid = blocked ? false : adaptiveSignal.valid;
  const reason = buildFinalReason(adaptiveSignal, qualityDecision);

  return {
    shouldTrade,
    valid,
    features: adaptiveSignal.features,
    regime: adaptiveSignal.regime,
    strategyDecision: adaptiveSignal.strategyDecision,
    tradeDecision: adaptiveSignal.tradeDecision,
    sizingDecision: adaptiveSignal.sizingDecision,
    policyDecision: adaptiveSignal.policyDecision,
    qualityDecision: {
      shouldPass: qualityDecision.shouldPass,
      qualityAction: qualityDecision.qualityAction,
      reason: qualityDecision.reason,
    },
    finalConfidence: adaptiveSignal.finalConfidence,
    finalDecision,
    reason,
  };
}

module.exports = {
  run,
  buildFinalReason,
};
