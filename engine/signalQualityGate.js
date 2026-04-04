'use strict';

/**
 * NeuroPilot Quant Engine v1 — Signal Quality Gate
 *
 * Applies additional quality filters to an adaptive signal before it is considered tradable.
 * Pure function; no side effects, no database writes.
 *
 * Inputs:
 *   - adaptiveSignal: object from adaptivePipeline.run()
 *   - context: optional { symbol, nowMs, recentSignals: [{ symbol, timeMs|time|timestamp }, ...] }
 *   - options: optional threshold overrides
 *
 * Output:
 *   - { shouldPass: boolean, qualityAction: "pass"|"block", reason: string }
 */

const DEFAULT_OPTIONS = Object.freeze({
  /** Stricter minimum confidence than adaptive policy defaults. */
  minFinalConfidence: 0.55,
  /** Minimum regime confidence required. */
  minRegimeConfidence: 0.4,
  /** Minimum strategy/trade confidence required. */
  minStrategyConfidence: 0.5,
  /** Minimum stop distance relative to price: stopDistance / price >= minStopDistancePct. */
  minStopDistancePct: 0.0005,
  /** Maximum stop distance relative to price: stopDistance / price <= maxStopDistancePct. */
  maxStopDistancePct: 0.03,
  /** Cooldown window for same-symbol signals. */
  cooldownMs: 5 * 60 * 1000,
});

function pass(reason = 'Signal passed quality gate') {
  return { shouldPass: true, qualityAction: 'pass', reason };
}

function block(reason) {
  return { shouldPass: false, qualityAction: 'block', reason: reason || 'Signal blocked by quality gate' };
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getStrategyConfidence(signal) {
  const tradeConf = safeNumber(signal && signal.tradeDecision && signal.tradeDecision.confidence);
  if (tradeConf != null) return tradeConf;
  const strategyConf = safeNumber(signal && signal.strategyDecision && signal.strategyDecision.confidence);
  if (strategyConf != null) return strategyConf;
  return 0;
}

function getRegimeConfidence(signal) {
  const regimeConf = safeNumber(signal && signal.regime && signal.regime.confidence);
  return regimeConf != null ? regimeConf : 0;
}

function getFinalConfidence(signal) {
  const finalConf = safeNumber(signal && signal.finalConfidence);
  if (finalConf != null) return finalConf;
  return getStrategyConfidence(signal);
}

function getPrice(signal) {
  const featurePrice = safeNumber(signal && signal.features && signal.features.price);
  if (featurePrice != null && featurePrice > 0) return featurePrice;
  const tradePrice = safeNumber(signal && signal.tradeDecision && signal.tradeDecision.entryPrice);
  if (tradePrice != null && tradePrice > 0) return tradePrice;
  return null;
}

function getStopDistance(signal) {
  const sizingStop = safeNumber(signal && signal.sizingDecision && signal.sizingDecision.stopDistance);
  if (sizingStop != null && sizingStop > 0) return sizingStop;
  return null;
}

function getSignalSymbol(signal, context) {
  const fromContext = context && typeof context.symbol === 'string' ? context.symbol : null;
  if (fromContext) return fromContext;
  const fromSignal = signal && typeof signal.symbol === 'string' ? signal.symbol : null;
  return fromSignal;
}

function getTimeMs(value) {
  const t = safeNumber(value);
  if (t == null || t <= 0) return null;
  // Normalize seconds timestamps to ms.
  return t < 1e12 ? t * 1000 : t;
}

function getCurrentTimeMs(signal, context) {
  const fromContext = getTimeMs(context && context.nowMs);
  if (fromContext != null) return fromContext;
  const fromFeatures = getTimeMs(signal && signal.features && signal.features.time);
  if (fromFeatures != null) return fromFeatures;
  const fromSignal = getTimeMs(signal && (signal.timeMs ?? signal.timestamp ?? signal.time));
  return fromSignal;
}

function getRecentSignalTimeMs(recentSignal) {
  return getTimeMs(recentSignal && (recentSignal.timeMs ?? recentSignal.timestamp ?? recentSignal.time));
}

/**
 * Decide if cooldown should block this signal.
 *
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function evaluateCooldown(signal, context, opts) {
  const recentSignals = context && Array.isArray(context.recentSignals) ? context.recentSignals : [];
  if (recentSignals.length === 0 || opts.cooldownMs <= 0) {
    return { blocked: false, reason: null };
  }

  const symbol = getSignalSymbol(signal, context);
  const nowMs = getCurrentTimeMs(signal, context);
  if (!symbol || nowMs == null) {
    // Cooldown can only be evaluated when symbol and timestamp are provided.
    return { blocked: false, reason: null };
  }

  for (const prior of recentSignals) {
    if (!prior || String(prior.symbol || '') !== String(symbol)) continue;
    const priorMs = getRecentSignalTimeMs(prior);
    if (priorMs == null) continue;
    const delta = nowMs - priorMs;
    if (delta >= 0 && delta < opts.cooldownMs) {
      return {
        blocked: true,
        reason: `Recent signal for ${symbol} within cooldown window (${Math.round(delta)}ms < ${opts.cooldownMs}ms)`,
      };
    }
  }
  return { blocked: false, reason: null };
}

/**
 * Run quality gate rules in deterministic order. Pure function.
 *
 * @param {object} adaptiveSignal - Adaptive signal from adaptivePipeline
 * @param {object} [context] - Optional runtime context (symbol, nowMs, recentSignals)
 * @param {object} [options] - Override thresholds/cooldown
 * @returns {{ shouldPass: boolean, qualityAction: "pass"|"block", reason: string }}
 */
function evaluate(adaptiveSignal, context = {}, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const signal = adaptiveSignal || {};

  if (!signal || signal.valid !== true || signal.shouldTrade !== true) {
    return block('Adaptive signal is not tradable');
  }

  const finalConfidence = getFinalConfidence(signal);
  if (finalConfidence < opts.minFinalConfidence) {
    return block(`Final confidence ${finalConfidence.toFixed(2)} below minimum ${opts.minFinalConfidence}`);
  }

  const regimeConfidence = getRegimeConfidence(signal);
  if (regimeConfidence < opts.minRegimeConfidence) {
    return block(`Regime confidence ${regimeConfidence.toFixed(2)} below minimum ${opts.minRegimeConfidence}`);
  }

  const strategyConfidence = getStrategyConfidence(signal);
  if (strategyConfidence < opts.minStrategyConfidence) {
    return block(`Strategy confidence ${strategyConfidence.toFixed(2)} below minimum ${opts.minStrategyConfidence}`);
  }

  const price = getPrice(signal);
  const stopDistance = getStopDistance(signal);
  if (price == null || stopDistance == null) {
    return block('Missing price or stopDistance for stop-distance quality check');
  }
  const stopDistancePct = stopDistance / price;
  if (stopDistancePct < opts.minStopDistancePct) {
    return block(`Stop distance ratio ${stopDistancePct.toFixed(6)} below minimum ${opts.minStopDistancePct}`);
  }
  if (stopDistancePct > opts.maxStopDistancePct) {
    return block(`Stop distance ratio ${stopDistancePct.toFixed(6)} above maximum ${opts.maxStopDistancePct}`);
  }

  const cooldown = evaluateCooldown(signal, context || {}, opts);
  if (cooldown.blocked) {
    return block(cooldown.reason);
  }

  return pass('Signal passed all quality checks');
}

module.exports = {
  evaluate,
  DEFAULT_OPTIONS,
  evaluateCooldown,
  getFinalConfidence,
  getRegimeConfidence,
  getStrategyConfidence,
  getPrice,
  getStopDistance,
};
