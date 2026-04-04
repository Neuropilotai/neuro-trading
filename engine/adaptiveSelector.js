'use strict';

/**
 * NeuroPilot Quant Engine v1 — Adaptive Selector / Policy Layer
 *
 * Uses strategy ranking and regime ranking to influence whether a signal should be
 * allowed, boosted, penalized, or blocked. Pure function: no side effects, no DB writes.
 *
 * Inputs:
 *   - signal: from signalPipeline.run() (valid, regime, strategyDecision, tradeDecision, reason)
 *   - ranking: from strategyRanking.rank() (topStrategies, topRegimes, recommendations)
 *
 * Output:
 *   - { shouldAllow, adjustedConfidence, selectedStrategy, policyAction, reason }
 */

/**
 * Default policy parameters. All overridable via options.
 */
const DEFAULT_OPTIONS = Object.freeze({
  /** Confidence added when signal strategy is top-ranked. */
  boostAmount: 0.05,
  /** Confidence added when signal regime is top-ranked (stackable with strategy boost). */
  regimeBoostAmount: 0.05,
  /** Confidence subtracted when strategy appears in "Reduce ... until more data". */
  penaltyAmount: 0.1,
  /** Minimum adjusted confidence to allow the signal; below this → shouldAllow false. */
  minConfidenceThreshold: 0.35,
});

/**
 * Extract policy-relevant flags from signal and ranking.
 *
 * @param {object} signal - Pipeline signal (regime, strategyDecision, tradeDecision)
 * @param {object} ranking - Strategy ranking (topStrategies, topRegimes, recommendations)
 * @returns {{ isTopStrategy: boolean, isTopRegime: boolean, isReduceRecommendation: boolean, strategy: string|null, regime: string|null }}
 */
function extractPolicyFlags(signal, ranking) {
  const strategy = (signal && signal.tradeDecision && signal.tradeDecision.strategy) ||
    (signal && signal.strategyDecision && signal.strategyDecision.strategy) || null;
  const regime = (signal && signal.regime && signal.regime.regime) ? signal.regime.regime : null;

  const topStrategy = ranking && Array.isArray(ranking.topStrategies) && ranking.topStrategies[0];
  const topRegime = ranking && Array.isArray(ranking.topRegimes) && ranking.topRegimes[0];

  const isTopStrategy = Boolean(
    strategy && topStrategy && (topStrategy.strategy || topStrategy.key) === strategy
  );
  const isTopRegime = Boolean(
    regime && topRegime && (topRegime.regime || topRegime.key) === regime
  );

  const reducePrefix = 'Reduce ';
  const recommendations = ranking && Array.isArray(ranking.recommendations) ? ranking.recommendations : [];
  const isReduceRecommendation = Boolean(
    strategy && recommendations.some(
      (r) => typeof r === 'string' && r.startsWith(reducePrefix) && r.includes(strategy)
    )
  );

  return {
    isTopStrategy,
    isTopRegime,
    isReduceRecommendation,
    strategy,
    regime,
  };
}

/**
 * Apply a boost to confidence (cap at 1).
 *
 * @param {number} confidence - Current confidence in [0, 1]
 * @param {number} amount - Positive amount to add
 * @returns {number} Math.min(1, confidence + amount)
 */
function applyBoost(confidence, amount) {
  const c = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  const a = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : 0;
  return Math.min(1, Math.max(0, c + a));
}

/**
 * Apply a penalty to confidence (floor at 0).
 *
 * @param {number} confidence - Current confidence in [0, 1]
 * @param {number} amount - Positive amount to subtract
 * @returns {number} Math.max(0, confidence - amount)
 */
function applyPenalty(confidence, amount) {
  const c = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  const a = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : 0;
  return Math.max(0, Math.min(1, c - a));
}

/**
 * Decide if the signal should be blocked based on adjusted confidence vs threshold.
 *
 * @param {number} adjustedConfidence - Confidence after boosts/penalties
 * @param {number} minThreshold - Minimum allowed confidence
 * @returns {boolean} true if adjustedConfidence < minThreshold
 */
function shouldBlockSignal(adjustedConfidence, minThreshold) {
  const conf = typeof adjustedConfidence === 'number' && Number.isFinite(adjustedConfidence) ? adjustedConfidence : 0;
  const thresh = typeof minThreshold === 'number' && Number.isFinite(minThreshold) ? minThreshold : 0;
  return conf < thresh;
}

/**
 * Build policy action label and reason string from flags and final allow/block.
 */
function buildPolicyReason(flags, adjustedConfidence, blocked, opts) {
  const parts = [];
  if (flags.isTopStrategy) parts.push(`${flags.strategy} is top-ranked`);
  if (flags.isTopRegime) parts.push(`${flags.regime} is dominant`);
  if (flags.isReduceRecommendation) parts.push(`${flags.strategy} in reduce-until-more-data`);
  if (blocked) {
    return {
      policyAction: 'block',
      reason: `Adjusted confidence ${adjustedConfidence.toFixed(2)} below threshold ${opts.minConfidenceThreshold}`,
    };
  }
  if (flags.isTopStrategy && flags.isTopRegime) {
    return { policyAction: 'favor', reason: `${flags.strategy} is top-ranked and ${flags.regime} is dominant` };
  }
  if (flags.isTopStrategy) {
    return { policyAction: 'favor', reason: `${flags.strategy} is top-ranked strategy` };
  }
  if (flags.isTopRegime) {
    return { policyAction: 'favor', reason: `${flags.regime} is dominant regime` };
  }
  if (flags.isReduceRecommendation) {
    return { policyAction: 'penalize', reason: `${flags.strategy} flagged to reduce until more data` };
  }
  return { policyAction: 'allow', reason: 'Signal allowed; no ranking override' };
}

/**
 * Run adaptive policy: allow/boost/penalize/block based on signal and ranking. Pure function.
 *
 * @param {object} signal - Pipeline signal object
 * @param {object} ranking - Strategy ranking object
 * @param {object} [options] - Override boostAmount, regimeBoostAmount, penaltyAmount, minConfidenceThreshold
 * @returns {object} { shouldAllow, adjustedConfidence, selectedStrategy, policyAction, reason }
 */
function select(signal, ranking, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const reject = (reason, policyAction = 'block') => ({
    shouldAllow: false,
    adjustedConfidence: 0,
    selectedStrategy: null,
    policyAction,
    reason,
  });

  if (!signal || signal.valid !== true) {
    return reject('Invalid signal', 'block');
  }

  const baseConfidence = typeof signal.tradeDecision?.confidence === 'number' && Number.isFinite(signal.tradeDecision.confidence)
    ? signal.tradeDecision.confidence
    : (typeof signal.strategyDecision?.confidence === 'number' && Number.isFinite(signal.strategyDecision.confidence)
      ? signal.strategyDecision.confidence
      : 0);

  const flags = extractPolicyFlags(signal, ranking || {});

  let adjusted = baseConfidence;
  if (flags.isTopStrategy) adjusted = applyBoost(adjusted, opts.boostAmount);
  if (flags.isTopRegime) adjusted = applyBoost(adjusted, opts.regimeBoostAmount);
  if (flags.isReduceRecommendation) adjusted = applyPenalty(adjusted, opts.penaltyAmount);

  adjusted = Math.round(adjusted * 100) / 100;
  const blocked = shouldBlockSignal(adjusted, opts.minConfidenceThreshold);

  const { policyAction, reason } = buildPolicyReason(flags, adjusted, blocked, opts);

  return {
    shouldAllow: !blocked,
    adjustedConfidence: adjusted,
    selectedStrategy: flags.strategy,
    policyAction,
    reason,
  };
}

module.exports = {
  select,
  applyBoost,
  applyPenalty,
  extractPolicyFlags,
  shouldBlockSignal,
  buildPolicyReason,
  DEFAULT_OPTIONS,
};
