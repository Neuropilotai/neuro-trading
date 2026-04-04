'use strict';

/**
 * OANDA-only execution pipeline V2 (minimal, auditable, fail-closed).
 *
 * Steps:
 * 1. execution mode (resolveOandaExecutionMode)
 * 2. admission gate (oandaAdmissionGate)
 * 3. risk (oandaRiskEngine)
 * 4. OANDA health (live/paper-to-broker paths only when sending to OANDA)
 * 5. placeOrder — only when mode=live and prior steps OK
 * 6. journal every exit
 */

const path = require('path');
const { resolveOandaExecutionMode } = require('./resolveOandaExecutionMode');
const { evaluateOandaAdmissionGate } = require('./oandaAdmissionGate');
const { evaluateOandaRisk } = require('./oandaRiskEngine');
const { appendOandaV2Intent } = require('./oandaExecutionJournal');

function strategyIdFromIntent(oi) {
  if (!oi || typeof oi !== 'object') return '';
  if (oi.setupId != null) return String(oi.setupId).trim();
  if (oi.strategyId != null) return String(oi.strategyId).trim();
  return '';
}

function buildRiskContext(orderIntent, options, env) {
  if (options.riskContext && typeof options.riskContext === 'object') {
    return options.riskContext;
  }
  const equity = Number(options.accountBalance);
  const base = {
    equity: Number.isFinite(equity) ? equity : parseFloat(env.ACCOUNT_BALANCE || '100000'),
    openCountGlobal: 0,
    openCountForStrategy: 0,
    tradesToday: 0,
    dailyRealizedPnl: 0,
  };
  try {
    const riskEngine = require(path.join(__dirname, '..', '..', 'backend', 'services', 'riskEngine'));
    const stats = riskEngine.getStats();
    base.openCountGlobal = stats?.dailyStats?.openPositions ?? 0;
    base.tradesToday = stats?.dailyStats?.tradeCount ?? 0;
    base.dailyRealizedPnl = stats?.dailyStats?.totalPnL ?? 0;
  } catch (_) {
    /* optional */
  }
  return base;
}

function baseResult(partial) {
  return {
    accepted: partial.accepted,
    mode: partial.mode,
    stage: partial.stage,
    reason: partial.reason != null ? partial.reason : null,
    order: partial.order != null ? partial.order : null,
    risk: partial.risk != null ? partial.risk : null,
    broker: partial.broker != null ? partial.broker : null,
  };
}

/**
 * @param {object} orderIntent
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {object} [options.journalOpts] - { dataRoot }
 * @param {boolean} [options.signalValid]
 * @param {number} [options.accountBalance]
 * @param {object} [options.riskContext]
 * @param {() => object} [options.createOandaAdapter] - returns mock adapter with connect/healthCheck/placeOrder
 */
async function runOandaExecutionPipeline(orderIntent, options = {}) {
  const env = options.env || process.env;
  const journalOpts = options.journalOpts || {};
  const ts = new Date().toISOString();
  const sid = strategyIdFromIntent(orderIntent);
  const sym = orderIntent && orderIntent.symbol != null ? String(orderIntent.symbol) : '';

  const modeRes = resolveOandaExecutionMode(env);
  const mode = modeRes.mode;

  const log = (decision, reason, riskSnap, brokerSnap) => {
    appendOandaV2Intent(
      {
        ts,
        mode,
        strategyId: sid,
        symbol: sym,
        decision,
        reason,
        risk: riskSnap,
        broker: brokerSnap,
      },
      journalOpts
    );
  };

  if (mode === 'disabled' || mode === 'blocked') {
    const r = baseResult({
      accepted: false,
      mode,
      stage: 'mode',
      reason: modeRes.reasons.join(';'),
      order: null,
      risk: null,
      broker: null,
    });
    log('rejected', r.reason, null, null);
    return r;
  }

  const admission = evaluateOandaAdmissionGate({
    executionMode: mode,
    orderIntent,
    signalValid: options.signalValid !== false,
    env,
    opts: { dataRoot: journalOpts.dataRoot },
  });

  if (!admission.allowed) {
    const reason = admission.violations.join(';');
    const r = baseResult({
      accepted: false,
      mode,
      stage: 'admission',
      reason,
      order: null,
      risk: null,
      broker: null,
    });
    log('rejected', reason, null, null);
    return r;
  }

  const riskCtx = buildRiskContext(orderIntent, options, env);
  const risk = evaluateOandaRisk(orderIntent, riskCtx, env);

  if (!risk.accepted) {
    const reason = risk.violations.join(';');
    const r = baseResult({
      accepted: false,
      mode,
      stage: 'risk',
      reason,
      order: null,
      risk: { accepted: false, violations: risk.violations, checks: risk.checks },
      broker: null,
    });
    log('rejected', reason, r.risk, null);
    return r;
  }

  // Paper: no OANDA call — intent validated only
  if (mode === 'paper') {
    const r = baseResult({
      accepted: true,
      mode,
      stage: 'paper',
      reason: 'paper_no_broker_send',
      order: { simulated: true, intent: { symbol: sym, action: orderIntent.action, qty: risk.qty } },
      risk: { accepted: true, qty: risk.qty, riskAmount: risk.riskAmount, checks: risk.checks },
      broker: null,
    });
    log('accepted', r.reason, r.risk, { sent: false });
    return r;
  }

  // mode === 'live' — broker path
  let adapter;
  if (typeof options.createOandaAdapter === 'function') {
    adapter = options.createOandaAdapter();
  } else {
    const Cls = require(path.join(__dirname, '..', '..', 'backend', 'adapters', 'OandaAdapter'));
    adapter = new Cls({ env });
  }

  let health;
  try {
    if (!adapter.apiKey || !adapter.accountId) {
      throw new Error('OANDA_API_KEY or OANDA_ACCOUNT_ID missing');
    }
    await adapter.connect();
    health = await adapter.healthCheck();
  } catch (e) {
    const reason = e && e.message ? String(e.message).slice(0, 240) : 'broker_connect_failed';
    const r = baseResult({
      accepted: false,
      mode,
      stage: 'broker_health',
      reason,
      order: null,
      risk: { accepted: true, qty: risk.qty, riskAmount: risk.riskAmount },
      broker: { ok: false, error: reason },
    });
    log('rejected', reason, r.risk, r.broker);
    return r;
  }

  if (!health || (health.ok !== true && health.connected !== true)) {
    const reason = 'broker_health_not_ok';
    const r = baseResult({
      accepted: false,
      mode,
      stage: 'broker_health',
      reason,
      order: null,
      risk: { accepted: true, qty: risk.qty, riskAmount: risk.riskAmount },
      broker: health || { ok: false },
    });
    log('rejected', reason, r.risk, r.broker);
    return r;
  }

  let orderResult;
  try {
    orderResult = await adapter.placeOrder(orderIntent);
  } catch (e) {
    const reason = e && e.message ? String(e.message).slice(0, 240) : 'placeOrder_failed';
    const r = baseResult({
      accepted: false,
      mode,
      stage: 'place_order',
      reason,
      order: null,
      risk: { accepted: true, qty: risk.qty, riskAmount: risk.riskAmount },
      broker: { ok: false, health, error: reason },
    });
    log('rejected', reason, r.risk, r.broker);
    return r;
  }

  const r = baseResult({
    accepted: true,
    mode,
    stage: 'complete',
    reason: 'order_submitted',
    order: orderResult,
    risk: { accepted: true, qty: risk.qty, riskAmount: risk.riskAmount, checks: risk.checks },
    broker: {
      ok: true,
      environment: adapter.environment,
      tradeId: orderResult && orderResult.tradeId,
    },
  });
  log('accepted', r.reason, r.risk, r.broker);
  return r;
}

module.exports = {
  runOandaExecutionPipeline,
};
