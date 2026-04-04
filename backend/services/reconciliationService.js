'use strict';

/**
 * Reconciliation Service
 * Compares ledger vs broker; uses REAL riskEngine and liveExecutionGate.
 * NO invented getDailyPnL/getKillSwitchStatus — all mapped to existing services.
 */

const path = require('path');
const liveExecutionGate = require('./liveExecutionGate');
const tradeLedger = require(path.join(__dirname, '../db/tradeLedger'));
const { getBrokerAdapter } = require(path.join(__dirname, '../adapters/brokerAdapterFactory'));
const paperTradingService = require('./paperTradingService');

const TRADING_MODE = (process.env.TRADING_MODE || 'paper').toLowerCase();

/**
 * Get daily PnL — uses liveExecutionGate (which uses riskEngine.getStats().dailyStats.totalPnL)
 */
async function getDailyPnL() {
  return liveExecutionGate.getDailyPnL();
}

/**
 * Get current equity — uses liveExecutionGate (broker or paper)
 */
async function getCurrentEquity() {
  return liveExecutionGate.getCurrentEquity();
}

/**
 * Get open position count — uses liveExecutionGate (riskEngine.getStats().dailyStats.openPositions)
 */
function getOpenPositionCount() {
  return liveExecutionGate.getOpenPositionCount();
}

/**
 * Kill switch status — uses liveExecutionGate (riskEngine.isTradingEnabled())
 * Returns true if kill switch is ACTIVE (trading blocked)
 */
function getKillSwitchStatus() {
  return liveExecutionGate.getKillSwitchStatus();
}

/**
 * Reconcile ledger vs broker positions
 */
async function reconcile() {
  await tradeLedger.initialize();

  let brokerPositions = [];
  if (TRADING_MODE === 'paper') {
    const summary = paperTradingService.getAccountSummary();
    brokerPositions = summary.positions || [];
  } else {
    try {
      const broker = getBrokerAdapter();
      if (broker.isConnected()) {
        brokerPositions = await broker.getPositions();
      }
    } catch (e) {
      console.warn('⚠️  reconciliationService: broker getPositions failed:', e?.message);
    }
  }

  const openTrades = await tradeLedger.getFilledTrades();
  const ledgerPositions = new Map();
  for (const t of openTrades) {
    if (t.action === 'BUY') {
      const key = t.symbol;
      const existing = ledgerPositions.get(key) || { quantity: 0 };
      existing.quantity += parseFloat(t.quantity || 0);
      ledgerPositions.set(key, existing);
    } else if (t.action === 'SELL' || t.action === 'CLOSE') {
      const key = t.symbol;
      const existing = ledgerPositions.get(key) || { quantity: 0 };
      existing.quantity -= parseFloat(t.quantity || 0);
      ledgerPositions.set(key, existing);
    }
  }

  const discrepancies = [];
  for (const [symbol, ledger] of ledgerPositions) {
    const brokerPos = brokerPositions.find(p => (p.symbol || p.instrument) === symbol);
    const brokerQty = brokerPos ? (brokerPos.quantity ?? brokerPos.units ?? 0) : 0;
    if (Math.abs((ledger.quantity || 0) - brokerQty) > 0.0001) {
      discrepancies.push({ symbol, ledger: ledger.quantity, broker: brokerQty });
    }
  }

  return {
    ok: discrepancies.length === 0,
    discrepancies,
    ledgerPositionCount: ledgerPositions.size,
    brokerPositionCount: brokerPositions.length,
    killSwitch: getKillSwitchStatus(),
    dailyPnL: await getDailyPnL(),
    equity: await getCurrentEquity(),
  };
}

module.exports = {
  getDailyPnL,
  getCurrentEquity,
  getOpenPositionCount,
  getKillSwitchStatus,
  reconcile,
};
