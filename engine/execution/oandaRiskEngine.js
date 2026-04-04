'use strict';

/**
 * OANDA V2 pre-send risk (simple, strict). FAIL = no broker call.
 */

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function loadLimits(env = process.env) {
  return {
    maxRiskPct: num(env.NEUROPILOT_OANDA_MAX_RISK_PCT, 1),
    maxOpenPerStrategy: Math.max(1, Math.floor(num(env.NEUROPILOT_OANDA_MAX_OPEN_PER_STRATEGY, 3))),
    maxOpenGlobal: Math.max(1, Math.floor(num(env.NEUROPILOT_OANDA_MAX_OPEN_GLOBAL, 10))),
    maxTradesPerDay: Math.max(1, Math.floor(num(env.NEUROPILOT_OANDA_MAX_TRADES_DAY, 20))),
    dailyLossCapPct: num(env.NEUROPILOT_OANDA_DAILY_LOSS_CAP_PCT, 3),
    minStopDistPct: num(env.NEUROPILOT_OANDA_MIN_STOP_PCT, 0.05),
  };
}

/**
 * @param {object} orderIntent
 * @param {object} context
 * @param {number} context.equity
 * @param {number} [context.openCountGlobal]
 * @param {number} [context.openCountForStrategy]
 * @param {number} [context.tradesToday]
 * @param {number} [context.dailyRealizedPnl]
 * @param {object} [env]
 */
function evaluateOandaRisk(orderIntent, context = {}, env = process.env) {
  const limits = loadLimits(env);
  const violations = [];

  const price = num(orderIntent.price, NaN);
  const qtyIn = num(orderIntent.quantity, NaN);
  const stop = orderIntent.stopLoss != null ? num(orderIntent.stopLoss, NaN) : NaN;
  const action = String(orderIntent.action || '').toUpperCase();
  const equity = num(context.equity, NaN);

  if (action === 'CLOSE') {
    return {
      accepted: true,
      qty: qtyIn,
      riskAmount: null,
      violations: [],
      checks: { close: true },
    };
  }

  if (!Number.isFinite(equity) || equity <= 0) {
    violations.push('invalid_equity');
    return { accepted: false, qty: null, riskAmount: null, violations, checks: {} };
  }

  if (!Number.isFinite(price) || price <= 0) violations.push('invalid_price');
  if (!Number.isFinite(qtyIn) || qtyIn === 0) violations.push('invalid_quantity');
  if (!Number.isFinite(stop)) violations.push('missing_stop');

  if (violations.length) {
    return { accepted: false, qty: null, riskAmount: null, violations, checks: {} };
  }

  const stopDist = Math.abs(price - stop);
  const stopPct = (stopDist / price) * 100;
  if (stopPct < limits.minStopDistPct) {
    violations.push(`stop_too_tight:${stopPct.toFixed(4)}pct_lt_${limits.minStopDistPct}`);
  }

  const riskPerUnit = stopDist;
  const riskAmount = Math.abs(qtyIn) * riskPerUnit;
  const riskPct = (riskAmount / equity) * 100;
  if (riskPct > limits.maxRiskPct) {
    violations.push(`risk_pct_exceeded:${riskPct.toFixed(3)}_gt_${limits.maxRiskPct}`);
  }

  const og = Math.floor(num(context.openCountGlobal, 0));
  if (og >= limits.maxOpenGlobal) {
    violations.push(`max_open_global:${og}>=${limits.maxOpenGlobal}`);
  }

  const os = Math.floor(num(context.openCountForStrategy, 0));
  if (os >= limits.maxOpenPerStrategy) {
    violations.push(`max_open_strategy:${os}>=${limits.maxOpenPerStrategy}`);
  }

  const td = Math.floor(num(context.tradesToday, 0));
  if (td >= limits.maxTradesPerDay) {
    violations.push(`max_trades_day:${td}>=${limits.maxTradesPerDay}`);
  }

  const pnl = num(context.dailyRealizedPnl, 0);
  if (pnl < 0) {
    const lossPct = (Math.abs(pnl) / equity) * 100;
    if (lossPct >= limits.dailyLossCapPct) {
      violations.push(`daily_loss_cap:${lossPct.toFixed(3)}>=${limits.dailyLossCapPct}`);
    }
  }

  if (violations.length) {
    return { accepted: false, qty: null, riskAmount: null, violations, checks: { stopPct, riskPct } };
  }

  return {
    accepted: true,
    qty: qtyIn,
    riskAmount,
    violations: [],
    checks: { stopPct, riskPct, notional: Math.abs(qtyIn * price) },
  };
}

module.exports = {
  evaluateOandaRisk,
  loadLimits,
};
