'use strict';

/**
 * Phase B — realized PnL for a UTC calendar day from ledger fills only.
 * Includes fills where matchedLocalExecution === true OR signalExecutionKey is present.
 * Does not use unrealized PnL or non-correlated fills.
 */

/**
 * @param {object} fill
 * @returns {boolean}
 */
function includeCorrelatedFill(fill) {
  if (!fill || fill.type !== 'ORDER_FILL') return false;
  if (fill.matchedLocalExecution === true) return true;
  const sk = fill.signalExecutionKey != null ? String(fill.signalExecutionKey).trim() : '';
  return Boolean(sk);
}

function utcDayBoundsMs(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  const end = start + 86400000;
  return {
    start,
    end,
    periodStartUtc: new Date(start).toISOString(),
    periodEndUtc: new Date(end).toISOString(),
  };
}

/**
 * @param {object} state — must have fillsLedger (enriched with matchedLocalExecution)
 * @param {number} [nowMs]
 * @returns {object} pnlPeriod block for execution_state.json
 */
function computePnlPeriodUtcDay(state, nowMs = Date.now()) {
  const { start, end, periodStartUtc, periodEndUtc } = utcDayBoundsMs(nowMs);
  let realizedPnl = 0;
  let realizedFeesPeriod = 0;
  let fillsCount = 0;
  let matchedFillsCount = 0;

  for (const f of state.fillsLedger || []) {
    if (!includeCorrelatedFill(f)) continue;
    const t = f.time ? Date.parse(f.time) : NaN;
    if (!Number.isFinite(t) || t < start || t >= end) continue;
    fillsCount += 1;
    if (f.matchedLocalExecution === true) matchedFillsCount += 1;
    realizedPnl += Number.isFinite(Number(f.pl)) ? Number(f.pl) : 0;
    realizedFeesPeriod += Number.isFinite(Number(f.financing)) ? Number(f.financing) : 0;
  }

  if (fillsCount === 0) {
    return {
      window: 'utc_day',
      periodStartUtc,
      periodEndUtc,
      realizedPnl: null,
      realizedFeesPeriod: null,
      fillsCount: 0,
      matchedFillsCount: 0,
      source: 'none',
      computedAt: new Date(nowMs).toISOString(),
    };
  }

  return {
    window: 'utc_day',
    periodStartUtc,
    periodEndUtc,
    realizedPnl,
    realizedFeesPeriod,
    fillsCount,
    matchedFillsCount,
    source: 'correlated_fills',
    computedAt: new Date(nowMs).toISOString(),
  };
}

module.exports = {
  computePnlPeriodUtcDay,
  includeCorrelatedFill,
  utcDayBoundsMs,
};
