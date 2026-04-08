'use strict';

/**
 * Live Execution Gate
 * Routes BUY/SELL/CLOSE through risk engine and broker adapter.
 * Uses REAL riskEngine and brokerAdapter from this codebase.
 *
 * TRADING_MODE: paper | dry_run | live
 * - paper: Uses paperTradingService only
 * - dry_run: Validates + logs, no execution
 * - live: Full execution via broker adapter
 *
 * Optional: NEUROPILOT_EXECUTION_PIPELINE_V1=1 wraps execution in
 * admission gate + preTradeRisk + journals (engine/execution/runExecutionPipeline.js).
 */

const path = require('path');
const riskEngine = require('./riskEngine');
const paperTradingService = require('./paperTradingService');
const priceFeedService = require('./priceFeedService');
const { getBrokerAdapter } = require(path.join(__dirname, '../adapters/brokerAdapterFactory'));

let emergencyStopActive = false;

/** Reads TRADING_MODE on each call (not frozen at module load). */
function readTradingMode(env = process.env) {
  return String(env.TRADING_MODE || 'paper').toLowerCase();
}

/** TRADING_ENABLED from env at read time (kill-switch layer separate from riskEngine singleton). */
function readEnvTradingEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.TRADING_ENABLED || '').trim().toLowerCase());
}

function setEmergencyStop(active) {
  emergencyStopActive = !!active;
}

function getTradingMode(env = process.env) {
  return readTradingMode(env);
}

function isTradingEnabled() {
  if (emergencyStopActive) return false;
  return riskEngine.isTradingEnabled();
}

/**
 * Get current equity (from broker or paper service)
 * Used by reconciliationService and kill-switch checks.
 */
async function getCurrentEquity() {
  const mode = readTradingMode();
  if (mode === 'paper' || mode === 'dry_run') {
    const summary = paperTradingService.getAccountSummary();
    return (
      summary.equity ??
      summary.totalValue ??
      summary.bookEquity ??
      summary.balance ??
      parseFloat(process.env.ACCOUNT_BALANCE || '500')
    );
  }
  try {
    const broker = getBrokerAdapter();
    const summary = await broker.getAccountSummary();
    return summary.equity ?? summary.totalValue ?? summary.bookEquity ?? summary.balance ?? 0;
  } catch (e) {
    console.warn('⚠️  liveExecutionGate.getCurrentEquity failed:', e?.message);
    return parseFloat(process.env.ACCOUNT_BALANCE || '500');
  }
}

/**
 * Get daily PnL from risk engine (real implementation)
 */
function getDailyPnL() {
  const stats = riskEngine.getStats();
  return stats?.dailyStats?.totalPnL ?? 0;
}

/**
 * Get open position count from risk engine (real implementation)
 */
function getOpenPositionCount() {
  const stats = riskEngine.getStats();
  return stats?.dailyStats?.openPositions ?? 0;
}

/**
 * Kill switch status: true = trading blocked
 */
function getKillSwitchStatus() {
  return emergencyStopActive || !riskEngine.isTradingEnabled();
}

function isPipelineV1Enabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NEUROPILOT_EXECUTION_PIPELINE_V1 || '').trim().toLowerCase()
  );
}

/**
 * Core path: backend riskEngine.validateOrder + paper / dry_run / live routing.
 * Used directly when pipeline V1 is off, or as executeOrderCore when pipeline is on.
 */
async function executeOrderCore(orderIntent, options = {}) {
  const env = options.env || process.env;
  const accountBalance = options.accountBalance ?? (await getCurrentEquity(env));

  const validation = await riskEngine.validateOrder(orderIntent, accountBalance);
  if (!validation.allowed) {
    return {
      success: false,
      reason: validation.reason,
      tradeId: null,
      executionResult: null,
    };
  }

  const tm = readTradingMode(env);
  if (tm === 'live') {
    const executionModeGuard = require('./executionModeGuard');
    const liveCheck = executionModeGuard.evaluateLiveExecutionAllowed(orderIntent, { env });
    if (!liveCheck.allowed) {
      const securityAuditService = require('./securityAuditService');
      securityAuditService.appendAuditSync({
        eventType: 'blocked_live_attempt',
        severity: 'critical',
        actorType: 'system',
        outcome: 'blocked',
        reason: liveCheck.reason,
        symbol: orderIntent.symbol,
        executionMode: executionModeGuard.readExecutionMode(env),
        metadata: { source: 'liveExecutionGate', code: liveCheck.code },
      });
      return {
        success: false,
        reason: liveCheck.reason || 'live_execution_blocked',
        tradeId: null,
        executionResult: null,
      };
    }
  }

  if (tm === 'dry_run') {
    console.log(
      `[liveExecutionGate] DRY_RUN: ${orderIntent.action} ${orderIntent.symbol} qty=${orderIntent.quantity} @ ${orderIntent.price}`
    );
    return {
      success: true,
      dryRun: true,
      tradeId: `DRY_${Date.now()}`,
      executionResult: {
        action: orderIntent.action,
        symbol: orderIntent.symbol,
        filledQuantity: orderIntent.quantity,
        fillPrice: orderIntent.price,
        pnl: 0,
        executedAt: new Date().toISOString(),
      },
    };
  }

  if (tm === 'paper') {
    try {
      await priceFeedService.ensureFreshQuote(orderIntent.symbol);
    } catch (e) {
      console.warn(`⚠️  priceFeed ensureFreshQuote: ${e?.message}`);
    }
    const result = await paperTradingService.executeOrder(orderIntent);
    return {
      success: true,
      tradeId: result.tradeId,
      executionResult: result.executionResult,
    };
  }

  // live: use broker adapter
  const broker = getBrokerAdapter();
  if (!broker.isEnabled() || !broker.isConnected()) {
    try {
      await broker.connect();
    } catch (e) {
      return {
        success: false,
        reason: `Broker not connected: ${e?.message}`,
        tradeId: null,
        executionResult: null,
      };
    }
  }

  try {
    const result = await broker.placeOrder(orderIntent);
    if (result.executionResult) {
      await riskEngine.recordTrade({
        action: orderIntent.action,
        symbol: orderIntent.symbol,
        quantity: result.executionResult.filledQuantity,
        price: result.executionResult.fillPrice,
        pnl: result.executionResult.pnl ?? 0,
      });
    }
    return {
      success: true,
      tradeId: result.tradeId ?? result.executionResult?.tradeId,
      executionResult: result.executionResult,
    };
  } catch (e) {
    console.error('❌ liveExecutionGate broker execution failed:', e?.message);
    return {
      success: false,
      reason: e?.message,
      tradeId: null,
      executionResult: null,
    };
  }
}

/**
 * Execute order through gate: validate → route to paper or live
 */
async function executeOrder(orderIntent, options = {}) {
  if (isPipelineV1Enabled()) {
    const { runExecutionPipeline, mapPipelineToGateResult } = require(path.join(
      __dirname,
      '..',
      '..',
      'engine',
      'execution',
      'runExecutionPipeline'
    ));
    const env = options.env || process.env;
    const accountBalance = options.accountBalance ?? (await getCurrentEquity(env));
    const pipelineResult = await runExecutionPipeline({
      orderIntent,
      accountBalance,
      timeframe: options.timeframe,
      signalValid: options.signalValid !== false,
      getBrokerAdapter,
      executeOrderCore: () => executeOrderCore(orderIntent, { ...options, accountBalance, env }),
      journalOpts: options.journalOpts,
      env,
    });
    return mapPipelineToGateResult(pipelineResult);
  }

  return executeOrderCore(orderIntent, { ...options, env: options.env || process.env });
}

module.exports = {
  getTradingMode,
  readTradingMode,
  readEnvTradingEnabled,
  isTradingEnabled,
  setEmergencyStop,
  getCurrentEquity,
  getDailyPnL,
  getOpenPositionCount,
  getKillSwitchStatus,
  executeOrder,
  executeOrderCore,
  isPipelineV1Enabled,
};
