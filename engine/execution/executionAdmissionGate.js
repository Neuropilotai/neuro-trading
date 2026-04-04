'use strict';

/**
 * Policy gate before pre-trade risk and broker I/O.
 * Does not replace champion allowlist / riskCheck in server.js — composes with pipeline V1.
 */

const { resolveExecutionMode, envTruthy } = require('./resolveExecutionMode');

function brokerType(env = process.env) {
  const e = env || process.env;
  return String(e.BROKER || 'paper').toLowerCase();
}

function oandaCredentialsPresent(env = process.env) {
  const e = env || process.env;
  const k = e.OANDA_API_KEY || e.NEUROPILOT_OANDA_API_KEY;
  const a = e.OANDA_ACCOUNT_ID || e.NEUROPILOT_OANDA_ACCOUNT_ID;
  return Boolean(k && String(k).trim() && a && String(a).trim());
}

function alpacaCredentialsPresent(env = process.env) {
  const e = env || process.env;
  const k = e.ALPACA_API_KEY_ID || e.ALPACA_API_KEY;
  const s = e.ALPACA_API_SECRET_KEY || e.ALPACA_SECRET_KEY;
  return Boolean(k && String(k).trim() && s && String(s).trim());
}

function ibkrConfigured(env = process.env) {
  const e = env || process.env;
  return String(e.BROKER || '').toLowerCase() === 'ibkr';
}

/**
 * @param {object} opts
 * @param {object} opts.orderIntent
 * @param {() => any} opts.getBrokerAdapter
 * @param {boolean} [opts.signalValid] - caller asserts webhook validation already passed
 * @param {string} [opts.timeframe]
 * @param {object} [opts.env]
 */
async function evaluateExecutionAdmissionGate(opts = {}) {
  const env = opts.env || process.env;
  const orderIntent = opts.orderIntent || {};
  const symbol = orderIntent.symbol != null ? String(orderIntent.symbol) : '';
  const strategyId =
    orderIntent.setupId != null
      ? String(orderIntent.setupId)
      : orderIntent.strategyId != null
        ? String(orderIntent.strategyId)
        : '';
  const tradingMode = String(env.TRADING_MODE || 'paper').toLowerCase();
  const modeRes = resolveExecutionMode(env);
  const brk = brokerType(env);

  const reasons = [];
  const policyChecks = {
    executionModeResolved: modeRes.mode,
    liveArmed: modeRes.liveArmed,
    requestedTradingMode: tradingMode,
    /** @deprecated use requestedTradingMode — kept for backward compatibility */
    tradingMode,
    broker: brk,
    championGateAssumedDone: true,
  };

  if (modeRes.mode === 'disabled') {
    reasons.push('execution_disabled');
    return {
      allowed: false,
      mode: 'blocked',
      reasons,
      strategyId,
      symbol,
      broker: brk,
      policyChecks,
    };
  }

  if (opts.signalValid === false) {
    reasons.push('signal_invalid');
    return {
      allowed: false,
      mode: 'blocked',
      reasons,
      strategyId,
      symbol,
      broker: brk,
      policyChecks,
    };
  }

  if (!symbol) {
    reasons.push('missing_symbol');
    return {
      allowed: false,
      mode: 'blocked',
      reasons,
      strategyId,
      symbol,
      broker: brk,
      policyChecks,
    };
  }

  // Live broker path: strict arm checks
  if (tradingMode === 'live') {
    if (brk === 'paper') {
      reasons.push('live_trading_requires_non_paper_BROKER');
      return {
        allowed: false,
        mode: 'blocked',
        reasons,
        strategyId,
        symbol,
        broker: brk,
        policyChecks,
      };
    }
    if (modeRes.mode !== 'live' || !modeRes.liveArmed) {
      reasons.push('live_trading_not_fully_armed');
      return {
        allowed: false,
        mode: 'blocked',
        reasons: reasons.concat(modeRes.reasons || []),
        strategyId,
        symbol,
        broker: brk,
        policyChecks,
      };
    }
    if (!envTruthy(env.TRADING_ENABLED)) {
      reasons.push('TRADING_ENABLED_not_truthy_for_live');
      return {
        allowed: false,
        mode: 'blocked',
        reasons,
        strategyId,
        symbol,
        broker: brk,
        policyChecks,
      };
    }
    if (brk === 'oanda' && !oandaCredentialsPresent(env)) {
      reasons.push('oanda_credentials_missing');
      return {
        allowed: false,
        mode: 'blocked',
        reasons,
        strategyId,
        symbol,
        broker: brk,
        policyChecks,
      };
    }
    if (brk === 'alpaca' && !alpacaCredentialsPresent(env)) {
      reasons.push('alpaca_credentials_missing');
      return {
        allowed: false,
        mode: 'blocked',
        reasons,
        strategyId,
        symbol,
        broker: brk,
        policyChecks,
      };
    }
    if (brk === 'ibkr' && !ibkrConfigured(env)) {
      reasons.push('ibkr_broker_not_selected');
      return {
        allowed: false,
        mode: 'blocked',
        reasons,
        strategyId,
        symbol,
        broker: brk,
        policyChecks,
      };
    }

    let brokerHealthOk = false;
    try {
      const getAdapter = opts.getBrokerAdapter;
      if (typeof getAdapter === 'function') {
        const adapter = getAdapter();
        const h = await Promise.resolve(adapter.healthCheck && adapter.healthCheck());
        brokerHealthOk = !!(h && (h.connected === true || h.ok === true || h.status === 'ok'));
        policyChecks.brokerHealth = {
          connected: h && h.connected,
          broker: h && h.broker,
          degraded: h && h.degraded,
        };
      } else {
        reasons.push('no_broker_getter');
      }
    } catch (e) {
      policyChecks.brokerHealthError = e && e.message ? String(e.message).slice(0, 200) : 'error';
      reasons.push('broker_health_check_failed');
    }

    if (!brokerHealthOk) {
      if (!reasons.includes('broker_health_check_failed')) {
        reasons.push('broker_health_not_ok');
      }
      return {
        allowed: false,
        mode: 'blocked',
        reasons,
        strategyId,
        symbol,
        broker: brk,
        policyChecks,
      };
    }
  }

  const effectiveExecutionMode = tradingMode === 'live' ? 'live' : 'paper';
  policyChecks.effectiveExecutionMode = effectiveExecutionMode;
  policyChecks.tradingModeDryRun = tradingMode === 'dry_run';
  return {
    allowed: true,
    mode: effectiveExecutionMode,
    reasons: ['admission_ok'],
    strategyId,
    symbol,
    broker: brk,
    policyChecks,
  };
}

module.exports = {
  evaluateExecutionAdmissionGate,
  brokerType,
  oandaCredentialsPresent,
  alpacaCredentialsPresent,
};
