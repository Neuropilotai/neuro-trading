'use strict';

/**
 * NeuroPilot Quant Engine v1 — Signal Journal
 *
 * Converts a pipeline signal into a flattened journal record for research, analytics,
 * and future learning. Pure function: no side effects, no database writes.
 *
 * Inputs:
 *   - signal: full signal object from signalPipeline.run() (features, regime, strategyDecision, tradeDecision, sizingDecision, reason)
 *   - symbol: instrument identifier (e.g. "XAUUSD")
 *   - timeframe: bar granularity (e.g. "2m", "1h")
 *   - timestamp: Date, ISO string, or ms; used for record and for ID generation
 *
 * Output:
 *   - Flattened record: id, timestamp (ISO), symbol, timeframe, shouldTrade, valid, regime, regimeConfidence, strategy, direction, strategyConfidence, tradeConfidence, riskPercent, riskAmount, stopDistance, positionSize, reason
 *   - No-trade signals: strategy/direction/sizing fields null where not applicable; reason preserved.
 */

const PREFIX = 'sig_';

/**
 * Normalize timestamp to ISO string. Accepts Date, number (ms), or ISO string.
 */
function toISOTimestamp(ts) {
  if (ts == null) return new Date().toISOString();
  if (typeof ts === 'string') return new Date(ts).toISOString();
  if (typeof ts === 'number') return new Date(ts).toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return new Date(ts).toISOString();
}

/**
 * Generate a deterministic journal record ID from timestamp, symbol, and timeframe.
 * Format: sig_YYYYMMDD_HHMMSS_SYMBOL_TIMEFRAME (symbol and timeframe sanitized for ID safety).
 */
function generateId(timestampISO, symbol, timeframe) {
  const d = new Date(timestampISO);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  const safeSymbol = (symbol || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '');
  const safeTf = (timeframe || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
  return `${PREFIX}${Y}${M}${D}_${h}${m}${s}_${safeSymbol}_${safeTf}`;
}

/**
 * Round number to fixed decimals for consistent journal storage; null preserved.
 */
function roundNullable(value, decimals = 2) {
  if (value == null || typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Flatten pipeline signal into a single journal record. Pure function.
 *
 * @param {object} signal - Output of signalPipeline.run(): { features, regime, strategyDecision, tradeDecision, sizingDecision, shouldTrade, valid, reason }
 * @param {string} symbol - Instrument symbol (e.g. "XAUUSD")
 * @param {string} timeframe - Bar timeframe (e.g. "2m")
 * @param {Date|string|number} [timestamp] - Signal time; default now
 * @returns {object} Journal record (see module doc)
 */
function toRecord(signal, symbol, timeframe, timestamp) {
  const tsISO = toISOTimestamp(timestamp);
  const id = generateId(tsISO, symbol, timeframe);

  if (!signal || typeof signal !== 'object') {
    return {
      id,
      timestamp: tsISO,
      symbol: symbol || null,
      timeframe: timeframe || null,
      shouldTrade: false,
      valid: false,
      regime: null,
      regimeConfidence: null,
      strategy: null,
      direction: null,
      strategyConfidence: null,
      tradeConfidence: null,
      riskPercent: null,
      riskAmount: null,
      stopDistance: null,
      positionSize: null,
      reason: 'Missing or invalid signal',
    };
  }

  const regimeObj = signal.regime;
  const strategyDec = signal.strategyDecision;
  const tradeDec = signal.tradeDecision;
  const sizingDec = signal.sizingDecision;

  const shouldTrade = Boolean(signal.shouldTrade);
  const valid = Boolean(signal.valid);
  const regime = regimeObj && typeof regimeObj.regime === 'string' ? regimeObj.regime : null;
  const regimeConfidence = roundNullable(regimeObj && typeof regimeObj.confidence === 'number' ? regimeObj.confidence : null);
  const strategy = tradeDec && typeof tradeDec.strategy === 'string' ? tradeDec.strategy : (strategyDec && strategyDec.strategy) || null;
  const direction = tradeDec && (tradeDec.direction === 'long' || tradeDec.direction === 'short') ? tradeDec.direction : (strategyDec && strategyDec.direction) || null;
  const strategyConfidence = roundNullable(strategyDec && typeof strategyDec.confidence === 'number' ? strategyDec.confidence : null);
  const tradeConfidence = roundNullable(tradeDec && typeof tradeDec.confidence === 'number' ? tradeDec.confidence : null);

  const riskPercent = sizingDec && sizingDec.valid ? roundNullable(sizingDec.riskPercent) : null;
  const riskAmount = sizingDec && sizingDec.valid ? roundNullable(sizingDec.riskAmount) : null;
  const stopDistance = sizingDec && sizingDec.valid ? roundNullable(sizingDec.stopDistance) : null;
  const positionSize = sizingDec && sizingDec.valid ? roundNullable(sizingDec.positionSize) : null;

  const reason = typeof signal.reason === 'string' ? signal.reason : 'No reason';

  return {
    id,
    timestamp: tsISO,
    symbol: symbol || null,
    timeframe: timeframe || null,
    shouldTrade,
    valid,
    regime,
    regimeConfidence,
    strategy,
    direction,
    strategyConfidence,
    tradeConfidence,
    riskPercent,
    riskAmount,
    stopDistance,
    positionSize,
    reason,
  };
}

module.exports = {
  toRecord,
  generateId,
  toISOTimestamp,
  PREFIX,
};
