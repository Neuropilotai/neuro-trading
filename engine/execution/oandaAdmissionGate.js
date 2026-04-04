'use strict';

/**
 * Minimal OANDA V2 admission gate (fail-closed).
 * Live: ENABLE_LIVE_TRADING=1 already enforced upstream in resolveOandaExecutionMode;
 * here: strategy promotable OR explicit env allow-list.
 */

const { envTruthy } = require('./resolveExecutionMode');
const { isStrategyPromotable } = require('./oandaPromotableLookup');

function parseAllowList(env) {
  const raw = env.NEUROPILOT_OANDA_LIVE_ALLOW_STRATEGY_IDS || env.NEUROPILOT_OANDA_LIVE_OVERRIDE_STRATEGY_IDS;
  if (!raw || !String(raw).trim()) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * @param {object} params
 * @param {'disabled'|'paper'|'live'} params.executionMode
 * @param {object} params.orderIntent - symbol, action, stopLoss, price, quantity, setupId/strategyId
 * @param {boolean} [params.signalValid]
 * @param {object} [params.env]
 * @param {object} [params.opts] - { dataRoot } for promotable lookup
 */
function evaluateOandaAdmissionGate(params = {}) {
  const env = params.env || process.env;
  const mode = params.executionMode || 'paper';
  const oi = params.orderIntent || {};
  const strategyId =
    oi.setupId != null ? String(oi.setupId).trim() : oi.strategyId != null ? String(oi.strategyId).trim() : '';
  const symbol = oi.symbol != null ? String(oi.symbol).trim() : '';
  const action = String(oi.action || '').toUpperCase();

  const violations = [];

  if (!strategyId) violations.push('missing_strategyId');
  if (!symbol) violations.push('missing_symbol');
  if (!['BUY', 'SELL', 'CLOSE'].includes(action)) violations.push('invalid_direction');

  if (params.signalValid === false) violations.push('signal_invalid');

  if (violations.length > 0) {
    return { allowed: false, violations, strategyId, symbol, mode };
  }

  if (mode === 'disabled' || mode === 'blocked') {
    return {
      allowed: false,
      violations: [mode === 'blocked' ? 'execution_blocked_opt_in' : 'execution_disabled'],
      strategyId,
      symbol,
      mode,
    };
  }

  if (mode === 'paper') {
    return { allowed: true, violations: [], strategyId, symbol, mode };
  }

  // mode === 'live'
  if (String(env.ENABLE_LIVE_TRADING || '').trim() !== '1') {
    return { allowed: false, violations: ['ENABLE_LIVE_TRADING_not_1'], strategyId, symbol, mode };
  }

  const allowSet = parseAllowList(env);
  const explicitAllow = allowSet.has(strategyId);
  const promotable = isStrategyPromotable(strategyId, { dataRoot: params.opts && params.opts.dataRoot });
  const forceNonPromotable = envTruthy(env.NEUROPILOT_OANDA_LIVE_ALLOW_NON_PROMOTABLE);

  if (explicitAllow || promotable || forceNonPromotable) {
    const reasons = [];
    if (explicitAllow) reasons.push('explicit_allow_list');
    if (promotable) reasons.push('promotable_snapshot');
    if (forceNonPromotable) reasons.push('NEUROPILOT_OANDA_LIVE_ALLOW_NON_PROMOTABLE');
    return { allowed: true, violations: [], strategyId, symbol, mode, reasons };
  }

  return {
    allowed: false,
    violations: ['strategy_not_promotable_and_not_explicitly_allowed'],
    strategyId,
    symbol,
    mode,
  };
}

module.exports = {
  evaluateOandaAdmissionGate,
};
