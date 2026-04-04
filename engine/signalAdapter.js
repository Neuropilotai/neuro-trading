'use strict';

/**
 * NeuroPilot Quant Engine v1 — Signal Adapter / Execution Bridge
 *
 * Converts a final adaptive signal into a normalized execution payload compatible
 * with the neuropilot_trading_v2 paper-trading / webhook pipeline. Pure function;
 * no HTTP or broker calls.
 *
 * Inputs:
 *   - adaptiveSignal: from adaptivePipeline.run() or adaptive backtest record context
 *   - symbol: instrument identifier (e.g. "XAUUSD")
 *   - options: optional { mode: "paper"|"live", source: string }
 *
 * Output:
 *   - Normalized payload object, or invalid payload { valid: false } when signal should not trade.
 */

/** Default mode and source for execution payload. */
const DEFAULT_OPTIONS = Object.freeze({
  mode: 'paper',
  source: 'neuropilot_quant_v1',
});

/**
 * Map direction to execution action.
 * @param {string} direction - "long" | "short"
 * @returns {string|null} "BUY" | "SELL" | null
 */
function directionToAction(direction) {
  if (direction === 'long') return 'BUY';
  if (direction === 'short') return 'SELL';
  return null;
}

/**
 * Convert an adaptive signal to a normalized execution payload. Pure function.
 *
 * @param {object} adaptiveSignal - Adaptive pipeline output (valid, shouldTrade, features, regime, tradeDecision, sizingDecision, finalConfidence)
 * @param {string} symbol - Instrument symbol
 * @param {object} [options] - { mode, source }
 * @returns {object} Payload with valid: true and execution fields, or valid: false and null-like fields
 */
function toPayload(adaptiveSignal, symbol, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const invalidPayload = {
    valid: false,
    symbol: symbol || null,
    action: null,
    price: null,
    quantity: null,
    strategy: null,
    confidence: null,
    regime: null,
    riskAmount: null,
    stopDistance: null,
    riskReward: null,
    mode: opts.mode,
    source: opts.source,
  };

  if (!adaptiveSignal || typeof adaptiveSignal !== 'object') {
    return invalidPayload;
  }
  if (adaptiveSignal.valid !== true || adaptiveSignal.shouldTrade !== true) {
    return invalidPayload;
  }

  const direction = adaptiveSignal.tradeDecision && adaptiveSignal.tradeDecision.direction;
  const action = directionToAction(direction);
  if (!action) {
    return invalidPayload;
  }

  const features = adaptiveSignal.features || {};
  const tradeDecision = adaptiveSignal.tradeDecision || {};
  const sizingDecision = adaptiveSignal.sizingDecision || {};
  const regimeObj = adaptiveSignal.regime;

  const price = typeof features.price === 'number' && Number.isFinite(features.price) ? features.price : null;
  const quantity = typeof sizingDecision.positionSize === 'number' && Number.isFinite(sizingDecision.positionSize) ? sizingDecision.positionSize : null;
  const confidence = typeof adaptiveSignal.finalConfidence === 'number' && Number.isFinite(adaptiveSignal.finalConfidence) ? adaptiveSignal.finalConfidence : (tradeDecision.confidence ?? null);
  const regime = regimeObj && typeof regimeObj.regime === 'string' ? regimeObj.regime : null;
  const strategy = typeof tradeDecision.strategy === 'string' ? tradeDecision.strategy : null;
  const riskAmount = typeof sizingDecision.riskAmount === 'number' && Number.isFinite(sizingDecision.riskAmount) ? sizingDecision.riskAmount : null;
  const stopDistance = typeof sizingDecision.stopDistance === 'number' && Number.isFinite(sizingDecision.stopDistance) ? sizingDecision.stopDistance : null;
  const riskReward = typeof tradeDecision.riskReward === 'number' && Number.isFinite(tradeDecision.riskReward) ? tradeDecision.riskReward : null;

  return {
    valid: true,
    symbol: symbol || null,
    action,
    price,
    quantity,
    strategy,
    confidence,
    regime,
    riskAmount,
    stopDistance,
    riskReward,
    mode: opts.mode,
    source: opts.source,
  };
}

/**
 * Return null when signal is invalid or shouldTrade is false; otherwise return payload.
 * Convenience for pipelines that prefer null over invalid payload object.
 *
 * @param {object} adaptiveSignal
 * @param {string} symbol
 * @param {object} [options]
 * @returns {object|null} Payload or null
 */
function toPayloadOrNull(adaptiveSignal, symbol, options = {}) {
  const payload = toPayload(adaptiveSignal, symbol, options);
  return payload.valid === true ? payload : null;
}

module.exports = {
  toPayload,
  toPayloadOrNull,
  directionToAction,
  DEFAULT_OPTIONS,
};
