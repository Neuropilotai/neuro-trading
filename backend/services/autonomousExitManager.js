'use strict';

const liveExecutionGate = require('./liveExecutionGate');
const paperTradingService = require('./paperTradingService');
const priceFeedService = require('./priceFeedService');

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function parseExitEnv() {
  return {
    enableTimeStop: String(process.env.AUTO_EXIT_ENABLE_TIME_STOP || 'true').toLowerCase() !== 'false',
    defaultMaxHoldMin: parseInt(process.env.AUTO_EXIT_DEFAULT_MAX_HOLD_MINUTES || '90', 10),
    enableTrailing: String(process.env.AUTO_EXIT_ENABLE_TRAILING_STOP || 'false').toLowerCase() === 'true',
    trailingTriggerR: parseFloat(process.env.AUTO_EXIT_TRAILING_TRIGGER_R || '1.2'),
    trailingLockR: parseFloat(process.env.AUTO_EXIT_TRAILING_LOCK_R || '0.4'),
  };
}

function parseISOms(s) {
  const t = Date.parse(String(s || ''));
  return Number.isFinite(t) ? t : null;
}

function evaluateAutonomousExit(position, marketState = {}) {
  const E = parseExitEnv();
  const px = Number(marketState.price);
  const avg = Number(position?.avgPrice);
  const stop = Number(position?.stopLoss);
  const take = Number(position?.takeProfit);
  const nowMs = parseISOms(marketState.now || new Date().toISOString()) || Date.now();
  const entryMs = parseISOms(position?.entryTime) || nowMs;
  const heldMin = (nowMs - entryMs) / 60000;
  const maxHold = Number(position?.maxHoldingMinutes) || E.defaultMaxHoldMin;
  const reasons = [];
  let shouldExit = false;
  let exitType = null;

  if (!(px > 0 && avg > 0)) {
    return { shouldExit: false, exitType: null, reasons: ['insufficient_market_data'], heldMinutes: round4(heldMin) };
  }
  if (Number.isFinite(stop) && stop > 0 && px <= stop) {
    shouldExit = true;
    exitType = 'stop_loss';
    reasons.push('stop_loss_hit');
  } else if (Number.isFinite(take) && take > 0 && px >= take) {
    shouldExit = true;
    exitType = 'take_profit';
    reasons.push('take_profit_hit');
  } else if (E.enableTimeStop && heldMin >= maxHold) {
    shouldExit = true;
    exitType = 'time_stop';
    reasons.push('max_holding_time_reached');
  }

  if (!shouldExit && E.enableTrailing) {
    const risk = Number.isFinite(stop) && stop > 0 ? Math.abs(avg - stop) : avg * 0.004;
    const pnlR = risk > 1e-9 ? (px - avg) / risk : 0;
    if (pnlR >= E.trailingTriggerR) {
      reasons.push('trailing_stop_armed');
    }
  }

  return {
    shouldExit,
    exitType,
    reasons,
    heldMinutes: round4(heldMin),
  };
}

function buildExitOrderIntent(position, marketState, exitEval) {
  return {
    symbol: String(position.symbol || '').toUpperCase(),
    action: 'CLOSE',
    quantity: Number(position.quantity) || 0,
    price: round4(Number(marketState.price)),
    stopLoss: position.stopLoss || null,
    takeProfit: position.takeProfit || null,
    strategy: String(position.autonomousStrategy || position.strategy || 'auto-exit-v1'),
    actionSource: 'autonomous_entry_engine',
    regime: position.regime || null,
    metadata: {
      source: 'autonomous_entry_engine',
      autonomousExitType: exitEval.exitType,
      autonomousExitReasons: exitEval.reasons,
      autonomousCandidateId: position.autonomousCandidateId || null,
    },
    autonomousTag: true,
  };
}

async function runAutonomousExitCycle(options = {}) {
  const gate = options.liveExecutionGate || liveExecutionGate;
  const summary = paperTradingService.getAccountSummary();
  const positions = (summary.positions || []).filter((p) => p.autonomousTag === true);
  const records = [];
  for (const p of positions) {
    let quote;
    try {
      quote = await priceFeedService.ensureFreshQuote(p.symbol);
    } catch (e) {
      quote = priceFeedService.getQuoteSync(p.symbol);
    }
    const marketState = {
      price: Number(quote?.price) || Number(p.lastPrice) || Number(p.avgPrice),
      now: new Date().toISOString(),
    };
    const evalResult = evaluateAutonomousExit(p, marketState);
    if (!evalResult.shouldExit) {
      records.push({
        symbol: p.symbol,
        exited: false,
        reason: 'hold',
        eval: evalResult,
      });
      continue;
    }

    const orderIntent = buildExitOrderIntent(p, marketState, evalResult);
    let exitResult;
    try {
      if (String(gate.getTradingMode ? gate.getTradingMode() : 'paper').toLowerCase() !== 'paper') {
        exitResult = { success: false, reason: 'autonomous_exit_paper_only' };
      } else {
        exitResult = await gate.executeOrder(orderIntent, {
          accountBalance: Number(summary.equity) || Number(summary.balance) || 0,
        });
      }
    } catch (e) {
      exitResult = { success: false, reason: e.message };
    }
    records.push({
      symbol: p.symbol,
      exited: exitResult?.success === true,
      reason: evalResult.exitType,
      eval: evalResult,
      execution: exitResult,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    openAutonomousPositions: positions.length,
    exitsExecuted: records.filter((r) => r.exited).length,
    records,
  };
}

module.exports = {
  parseExitEnv,
  evaluateAutonomousExit,
  buildExitOrderIntent,
  runAutonomousExitCycle,
};
