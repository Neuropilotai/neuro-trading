'use strict';

/**
 * Secure execution orchestrator V1: admission → pre-trade risk → execution core (injected).
 * Journals every outcome; updates metrics. No secrets logged.
 */

const { evaluateExecutionAdmissionGate } = require('./executionAdmissionGate');
const { evaluatePreTradeRisk } = require('./preTradeRiskEngine');
const {
  appendExecutionIntent,
  appendExecutionOrder,
  createClientOrderId,
  summarizeOrderIntent,
  summarizeBrokerPayload,
  bumpMetrics,
  incrementMetrics,
} = require('./executionPipelineJournals');
const path = require('path');

/** Canonical strategy id for journals: setupId if set, else strategyId. */
function journalStrategyFields(orderIntent) {
  const oi = orderIntent && typeof orderIntent === 'object' ? orderIntent : {};
  const setupId = oi.setupId != null ? String(oi.setupId) : null;
  const strategyId =
    oi.setupId != null
      ? String(oi.setupId)
      : oi.strategyId != null
        ? String(oi.strategyId)
        : null;
  return { strategyId, setupId };
}

function isPipelineV1Enabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.NEUROPILOT_EXECUTION_PIPELINE_V1 || '').trim().toLowerCase());
}

function buildDefaultPreTradeContext(orderIntent, options = {}) {
  if (options.preTradeContext && typeof options.preTradeContext === 'object') {
    return options.preTradeContext;
  }
  let equity = Number(options.accountBalance);
  if (!Number.isFinite(equity)) {
    equity = parseFloat(process.env.ACCOUNT_BALANCE || '500');
  }
  let openPositionsCount = 0;
  let tradesTodayTotal = 0;
  let dailyRealizedPnl = 0;
  try {
    const riskEngine = require(path.join(__dirname, '..', '..', 'backend', 'services', 'riskEngine'));
    const stats = riskEngine.getStats();
    openPositionsCount = stats?.dailyStats?.openPositions ?? 0;
    tradesTodayTotal = stats?.dailyStats?.tradeCount ?? 0;
    dailyRealizedPnl = stats?.dailyStats?.totalPnL ?? 0;
  } catch (_) {
    /* backend optional in isolated tests */
  }
  return {
    equity,
    openPositionsCount,
    tradesTodayTotal,
    dailyRealizedPnl,
    dailyUnrealizedPnl: 0,
    openCountByStrategy: {},
    openCountBySymbol: {},
    notionalExposureByAssetClass: {},
  };
}

/**
 * @param {object} options
 * @param {object} options.orderIntent
 * @param {number} [options.accountBalance]
 * @param {string} [options.timeframe]
 * @param {() => Promise<object>} options.executeOrderCore - liveExecutionGate internal (riskEngine + route)
 * @param {() => any} [options.getBrokerAdapter]
 * @param {object} [options.preTradeContext]
 * @param {boolean} [options.signalValid]
 * @param {object} [options.env]
 * @param {object} [options.journalOpts] - { dataRoot } for tests
 */
async function runExecutionPipeline(options = {}) {
  const env = options.env || process.env;
  const ts = new Date().toISOString();
  const orderIntent = options.orderIntent || {};
  const { strategyId: journalStrategyId, setupId: journalSetupId } = journalStrategyFields(orderIntent);
  const clientOrderId = createClientOrderId({
    strategyId: journalStrategyId || orderIntent.strategyId || orderIntent.setupId,
    symbol: orderIntent.symbol,
    ts: Date.now(),
  });
  const getBroker = options.getBrokerAdapter;
  const jopts = options.journalOpts || {};

  const out = {
    accepted: false,
    stage: 'init',
    mode: String(env.TRADING_MODE || 'paper').toLowerCase(),
    broker: String(env.BROKER || 'paper').toLowerCase(),
    clientOrderId,
    gate: null,
    risk: null,
    brokerResult: null,
    execution: null,
    finalStatus: 'blocked',
    reasons: [],
  };

  bumpMetrics(jopts, { lastOrderAttemptAt: ts });

  const gate = await evaluateExecutionAdmissionGate({
    orderIntent,
    getBrokerAdapter: getBroker,
    signalValid: options.signalValid !== false,
    timeframe: options.timeframe,
    env,
  });
  out.gate = gate;

  if (!gate.allowed) {
    out.stage = 'admission';
    out.finalStatus = 'blocked_policy';
    out.reasons = gate.reasons || [];
    incrementMetrics(jopts, { blocked: 1, blockedByPolicy: 1 });
    bumpMetrics(jopts, { lastBlockedReason: 'policy' });
    appendExecutionIntent(
      {
        ts,
        modeRequested: out.mode,
        modeApplied: gate.mode,
        strategyId: gate.strategyId || journalStrategyId,
        setupId: journalSetupId,
        symbol: gate.symbol || null,
        timeframe: options.timeframe || null,
        side: orderIntent.action,
        broker: out.broker,
        clientOrderId,
        orderIntent: summarizeOrderIntent(orderIntent),
        riskResult: null,
        gateResult: { allowed: false, reasons: gate.reasons },
        finalDecision: 'blocked_policy',
        blockedReason: (gate.reasons && gate.reasons[0]) || 'policy',
        brokerResponse: null,
      },
      jopts
    );
    return out;
  }

  const pctx = buildDefaultPreTradeContext(orderIntent, options);
  const risk = evaluatePreTradeRisk(orderIntent, pctx, env);
  out.risk = risk;

  if (!risk.accepted) {
    out.stage = 'pre_trade_risk';
    out.finalStatus = 'blocked_risk';
    out.reasons = risk.violations || [];
    incrementMetrics(jopts, { blocked: 1, blockedByRisk: 1 });
    bumpMetrics(jopts, { lastBlockedReason: 'risk' });
    appendExecutionIntent(
      {
        ts,
        modeRequested: out.mode,
        modeApplied: gate.mode,
        strategyId: journalStrategyId,
        setupId: journalSetupId,
        symbol: orderIntent.symbol,
        timeframe: options.timeframe || null,
        side: orderIntent.action,
        broker: out.broker,
        clientOrderId,
        orderIntent: summarizeOrderIntent(orderIntent),
        riskResult: { accepted: false, violations: risk.violations, checks: risk.checks },
        gateResult: { allowed: true, reasons: gate.reasons },
        finalDecision: 'blocked_risk',
        blockedReason: (risk.violations && risk.violations[0]) || 'risk',
        brokerResponse: null,
      },
      jopts
    );
    return out;
  }

  out.stage = 'execution';

  if (typeof options.executeOrderCore !== 'function') {
    out.finalStatus = 'failed';
    out.reasons = ['executeOrderCore_missing'];
    incrementMetrics(jopts, { failed: 1 });
    appendExecutionIntent(
      {
        ts,
        modeRequested: out.mode,
        modeApplied: gate.mode,
        strategyId: journalStrategyId,
        setupId: journalSetupId,
        symbol: orderIntent.symbol,
        timeframe: options.timeframe || null,
        side: orderIntent.action,
        broker: out.broker,
        clientOrderId,
        orderIntent: summarizeOrderIntent(orderIntent),
        riskResult: { accepted: true, checks: risk.checks },
        gateResult: { allowed: true },
        finalDecision: 'failed_configuration',
        blockedReason: 'executeOrderCore_missing',
        brokerResponse: null,
      },
      jopts
    );
    return out;
  }

  let exec;
  try {
    exec = await options.executeOrderCore();
  } catch (e) {
    out.finalStatus = 'failed';
    out.reasons = [e && e.message ? String(e.message).slice(0, 200) : 'execution_threw'];
    incrementMetrics(jopts, { failed: 1, brokerErrors: 1 });
    appendExecutionIntent(
      {
        ts,
        modeRequested: out.mode,
        modeApplied: gate.mode,
        strategyId: journalStrategyId,
        setupId: journalSetupId,
        symbol: orderIntent.symbol,
        timeframe: options.timeframe || null,
        side: orderIntent.action,
        broker: out.broker,
        clientOrderId,
        orderIntent: summarizeOrderIntent(orderIntent),
        riskResult: { accepted: true },
        gateResult: { allowed: true },
        finalDecision: 'failed',
        blockedReason: null,
        brokerResponse: { error: out.reasons[0] },
      },
      jopts
    );
    return out;
  }

  out.execution = exec;
  out.brokerResult = summarizeBrokerPayload(exec);

  if (!exec || exec.success === false) {
    out.finalStatus = 'rejected';
    out.reasons = [exec && exec.reason ? String(exec.reason) : 'execution_rejected'];
    incrementMetrics(jopts, { blocked: 1 });
    bumpMetrics(jopts, { lastBlockedReason: 'execution' });
    appendExecutionIntent(
      {
        ts,
        modeRequested: out.mode,
        modeApplied: gate.mode,
        strategyId: journalStrategyId,
        setupId: journalSetupId,
        symbol: orderIntent.symbol,
        timeframe: options.timeframe || null,
        side: orderIntent.action,
        broker: out.broker,
        clientOrderId,
        orderIntent: summarizeOrderIntent(orderIntent),
        riskResult: { accepted: true },
        gateResult: { allowed: true },
        finalDecision: 'rejected_execution_core',
        blockedReason: out.reasons[0],
        brokerResponse: out.brokerResult,
      },
      jopts
    );
    return out;
  }

  out.accepted = true;
  out.finalStatus = 'accepted';
  out.reasons = ['ok'];
  incrementMetrics(jopts, { accepted: 1 });
  bumpMetrics(jopts, {
    lastAcceptedOrderAt: new Date().toISOString(),
  });

  appendExecutionIntent(
    {
      ts,
      modeRequested: out.mode,
      modeApplied: gate.mode,
      strategyId: journalStrategyId,
      setupId: journalSetupId,
      symbol: orderIntent.symbol,
      timeframe: options.timeframe || null,
      side: orderIntent.action,
      broker: out.broker,
      clientOrderId,
      orderIntent: summarizeOrderIntent(orderIntent),
      riskResult: { accepted: true, sizingDecision: risk.sizingDecision },
      gateResult: { allowed: true },
      finalDecision: 'accepted',
      blockedReason: null,
      brokerResponse: out.brokerResult,
    },
    jopts
  );

  appendExecutionOrder(
    {
      ts: new Date().toISOString(),
      broker: out.broker,
      orderId: exec.tradeId != null ? String(exec.tradeId) : null,
      clientOrderId,
      strategyId: journalStrategyId,
      symbol: orderIntent.symbol,
      side: orderIntent.action,
      qty: orderIntent.quantity,
      orderType: 'intent_market',
      status: exec.dryRun ? 'dry_run' : 'submitted',
      livePaper: out.mode === 'live' ? 'live' : 'paper',
      brokerPayloadSummary: out.brokerResult,
    },
    jopts
  );

  return out;
}

function mapPipelineToGateResult(pipelineResult) {
  const pr = pipelineResult || {};
  const ex = pr.execution;
  if (pr.finalStatus === 'accepted' && ex && ex.success !== false) {
    return {
      success: true,
      tradeId: ex.tradeId,
      executionResult: ex.executionResult,
      dryRun: Boolean(ex.dryRun),
      clientOrderId: pr.clientOrderId,
      pipeline: { stage: pr.stage, finalStatus: pr.finalStatus },
    };
  }
  const reason =
    (pr.reasons && pr.reasons.join('; ')) ||
    pr.blockedReason ||
    (pr.gate && pr.gate.reasons && pr.gate.reasons.join('; ')) ||
    'pipeline_blocked';
  return {
    success: false,
    reason,
    tradeId: null,
    executionResult: null,
    clientOrderId: pr.clientOrderId,
    pipeline: {
      stage: pr.stage,
      finalStatus: pr.finalStatus,
      gate: pr.gate,
      risk: pr.risk ? { accepted: pr.risk.accepted, violations: pr.risk.violations } : null,
    },
  };
}

module.exports = {
  runExecutionPipeline,
  mapPipelineToGateResult,
  isPipelineV1Enabled,
  buildDefaultPreTradeContext,
};
