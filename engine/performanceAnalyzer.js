'use strict';

/**
 * NeuroPilot Quant Engine v1 — Performance Analyzer
 *
 * Analyzes backtest journal records and produces summary statistics for quant research.
 * Pure function: no side effects, no database writes.
 *
 * Input: records (array of journal records from backtestRunner / signalJournal)
 * Output: { totals, ratios, byRegime, byStrategy, byDirection, noTradeReasons, topRegime, topStrategy }
 */

/**
 * Count records by a given field. Null/undefined values are keyed as "null".
 * Safe for empty or non-array input.
 *
 * @param {Array<object>} records - Journal records
 * @param {string} field - Field name (e.g. "regime", "strategy", "direction")
 * @returns {object} Map of field value -> count
 */
function countByField(records, field) {
  if (!Array.isArray(records) || typeof field !== 'string') return {};
  const out = {};
  for (const r of records) {
    const val = r[field];
    const key = val != null ? String(val) : 'null';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Count no-trade reasons: for records where shouldTrade is false, group by reason string.
 *
 * @param {Array<object>} records - Journal records (with reason, shouldTrade)
 * @returns {object} Map of reason -> count
 */
function countNoTradeReasons(records) {
  if (!Array.isArray(records)) return {};
  const out = {};
  for (const r of records) {
    if (r.shouldTrade === true) continue;
    const key = typeof r.reason === 'string' ? r.reason : 'No reason';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Calculate ratios from totals. Safe division: returns 0 when totalRecords is 0.
 *
 * @param {object} totals - { totalRecords, validSignals, tradeableSignals }
 * @returns {object} { validRate, tradeableRate } in [0, 1]
 */
function calculateRatios(totals) {
  if (!totals || typeof totals.totalRecords !== 'number') {
    return { validRate: 0, tradeableRate: 0 };
  }
  const n = totals.totalRecords;
  const validRate = n > 0 && typeof totals.validSignals === 'number'
    ? Math.min(1, Math.max(0, totals.validSignals / n))
    : 0;
  const tradeableRate = n > 0 && typeof totals.tradeableSignals === 'number'
    ? Math.min(1, Math.max(0, totals.tradeableSignals / n))
    : 0;
  return { validRate, tradeableRate };
}

/**
 * Pick the key with the highest count. Returns null if object is empty or all counts zero.
 *
 * @param {object} countObj - Map of key -> count (numbers)
 * @returns {string|null} Key with max count, or null
 */
function pickTopKey(countObj) {
  if (!countObj || typeof countObj !== 'object') return null;
  let topKey = null;
  let topCount = -1;
  for (const [key, count] of Object.entries(countObj)) {
    const n = Number(count);
    if (Number.isFinite(n) && n > topCount) {
      topCount = n;
      topKey = key;
    }
  }
  return topKey;
}

/**
 * Analyze journal records and return full performance summary. Safe for empty input.
 *
 * @param {Array<object>} records - Journal records from backtestRunner
 * @returns {object} { totals, ratios, byRegime, byStrategy, byDirection, noTradeReasons, topRegime, topStrategy }
 */
function analyze(records) {
  const list = Array.isArray(records) ? records : [];
  const totalRecords = list.length;
  const validSignals = list.filter((r) => r.valid === true).length;
  const tradeableSignals = list.filter((r) => r.shouldTrade === true).length;
  const noTradeSignals = totalRecords - tradeableSignals;

  const totals = {
    totalRecords,
    validSignals,
    tradeableSignals,
    noTradeSignals,
  };

  const ratios = calculateRatios(totals);

  const byRegime = countByField(list, 'regime');
  const byStrategy = countByField(list, 'strategy');
  const byDirection = countByField(list, 'direction');
  const noTradeReasons = countNoTradeReasons(list);

  const topRegime = pickTopKey(byRegime);
  const topStrategy = pickTopKey(byStrategy);

  return {
    totals,
    ratios,
    byRegime,
    byStrategy,
    byDirection,
    noTradeReasons,
    topRegime: topRegime === 'null' ? null : topRegime,
    topStrategy: topStrategy === 'null' ? null : topStrategy,
  };
}

module.exports = {
  analyze,
  countByField,
  countNoTradeReasons,
  calculateRatios,
  pickTopKey,
};
