#!/usr/bin/env node
'use strict';

/**
 * Paper ledger alignment + rebuild + durable state path (no server).
 * Run: node tests/paperLifecyclePersistence.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-'));
process.env.DATA_DIR = tmp;
process.env.LEDGER_DB_PATH = path.join(tmp, 'ledger.sqlite');
process.env.TRADING_ENABLED = 'true';
process.env.ENABLE_PAPER_TRADING = 'true';
process.env.ENABLE_TRADE_LEDGER = 'true';
process.env.ACCOUNT_BALANCE = '10000';
process.env.PAPER_STATE_REBUILD_ON_BOOT = 'true';
process.env.PAPER_REBUILD_EMPTY_LEDGER_RESETS = 'false';
process.env.EXEC_REALISM_ENABLED = 'false';
process.env.ENABLE_CLOSED_TRADE_ANALYTICS = 'false';
process.env.AUTO_LEARNING_POLICY_AFTER_CLOSED_TRADE = 'false';

const tradeLedger = require('../backend/db/tradeLedger');
const paperTradingService = require('../backend/services/paperTradingService');
const executionQualityService = require('../backend/services/executionQualityService');

async function run() {
  console.log('paperLifecyclePersistence tests…');

  await tradeLedger.initialize();
  paperTradingService.resetToInitialState();
  paperTradingService.account.balance = 10000;
  paperTradingService.account.initialBalance = 10000;

  const sym = 'XAUUSD';
  const px = 2000;
  const qty = 1;

  // 1) Autonomous-style entry + exit: ledger rows exist and rebuild works
  await paperTradingService.executeOrder({
    symbol: sym,
    action: 'BUY',
    quantity: qty,
    price: px,
    stopLoss: px * 0.99,
    takeProfit: px * 1.02,
    actionSource: 'autonomous_entry_engine',
    autonomousTag: true,
    strategy: 'auto-test-v1',
  });

  const filledAfterBuy = await tradeLedger.getFilledTrades();
  assert.ok(filledAfterBuy.length >= 1, 'ledger should have FILLED row after BUY');
  assert.strictEqual(filledAfterBuy[filledAfterBuy.length - 1].action.toUpperCase(), 'BUY');

  await paperTradingService.executeOrder({
    symbol: sym,
    action: 'SELL',
    quantity: qty,
    price: px,
    stopLoss: px * 0.99,
    takeProfit: px * 1.02,
    actionSource: 'autonomous_entry_engine',
    autonomousTag: true,
    strategy: 'auto-test-v1',
  });

  const filledAfterSell = await tradeLedger.getFilledTrades();
  assert.ok(filledAfterSell.length >= 2, 'ledger should have BUY+SELL FILLED');
  assert.strictEqual(paperTradingService.account.positions.has(sym), false);

  const exitsExecutedProxy = filledAfterSell.filter((t) =>
    ['SELL', 'CLOSE'].includes(String(t.action).toUpperCase())
  ).length;
  assert.ok(exitsExecutedProxy >= 1, 'at least one exit leg in ledger');

  paperTradingService.resetToInitialState();
  const rebuilt = await paperTradingService.rebuildStateFromLedger();
  assert.strictEqual(rebuilt, true);
  assert.strictEqual(paperTradingService.account.positions.has(sym), false);

  // 2) Webhook-style: pre-inserted ledger id must match paper execution
  const ledgerTradeId = `TRADE_WEBHOOK_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await tradeLedger.insertTrade({
    trade_id: ledgerTradeId,
    idempotency_key: `idemp_${ledgerTradeId}`,
    symbol: sym,
    action: 'BUY',
    quantity: qty,
    price: px,
    status: 'VALIDATED',
  });

  await paperTradingService.executeOrder({
    ledgerTradeId: ledgerTradeId,
    symbol: sym,
    action: 'BUY',
    quantity: qty,
    price: px,
    stopLoss: px * 0.99,
    takeProfit: px * 1.02,
    actionSource: 'webhook',
  });

  const row = await tradeLedger.getTrade(ledgerTradeId);
  assert.strictEqual(row.status, 'FILLED');

  // 2b) Webhook SELL: same ledgerTradeId alignment as BUY (pre-inserted row → FILLED)
  const sellWebhookId = `TRADE_WEBHOOK_SELL_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await tradeLedger.insertTrade({
    trade_id: sellWebhookId,
    idempotency_key: `idemp_${sellWebhookId}`,
    symbol: sym,
    action: 'SELL',
    quantity: qty,
    price: px,
    status: 'VALIDATED',
  });
  await paperTradingService.executeOrder({
    ledgerTradeId: sellWebhookId,
    symbol: sym,
    action: 'SELL',
    quantity: qty,
    price: px,
    stopLoss: px * 0.99,
    takeProfit: px * 1.02,
    actionSource: 'webhook',
  });
  const sellRow = await tradeLedger.getTrade(sellWebhookId);
  assert.strictEqual(sellRow.status, 'FILLED');
  assert.strictEqual(paperTradingService.account.positions.has(sym), false);

  // 2c) Autonomous CLOSE: ledger row + FILLED (same path as SELL; action CLOSE in SQLite)
  const sym2 = 'GBPUSD';
  const px2 = 1.26;
  const qty2 = 100;
  await paperTradingService.executeOrder({
    symbol: sym2,
    action: 'BUY',
    quantity: qty2,
    price: px2,
    stopLoss: px2 * 0.99,
    takeProfit: px2 * 1.02,
    actionSource: 'autonomous_entry_engine',
    autonomousTag: true,
    strategy: 'auto-test-v1',
  });
  assert.ok(paperTradingService.account.positions.has(sym2));
  const closeResult = await paperTradingService.executeOrder({
    symbol: sym2,
    action: 'CLOSE',
    quantity: qty2,
    price: px2,
    stopLoss: px2 * 0.99,
    takeProfit: px2 * 1.02,
    actionSource: 'autonomous_entry_engine',
    autonomousTag: true,
    strategy: 'auto-test-v1',
  });
  assert.strictEqual(closeResult.executionResult.action, 'CLOSE');
  assert.strictEqual(paperTradingService.account.positions.has(sym2), false);
  const filledAll = await tradeLedger.getFilledTrades();
  const closeLeg = filledAll.find((t) => String(t.trade_id) === String(closeResult.tradeId));
  assert.ok(closeLeg, 'CLOSE fill should have FILLED ledger row');
  assert.strictEqual(String(closeLeg.action).toUpperCase(), 'CLOSE');

  // 3) Empty FILLED ledger: do not reset account; load durable JSON when present
  paperTradingService.resetToInitialState();
  await tradeLedger.close();
  try {
    fs.unlinkSync(process.env.LEDGER_DB_PATH);
  } catch (e) {
    /* ignore */
  }
  tradeLedger.db = null;
  await tradeLedger.initialize();

  const statePath = paperTradingService.getPaperStateFilePath();
  const snapshot = {
    balance: 4500,
    initialBalance: 10000,
    totalPnL: 0,
    dailyPnL: 0,
    totalTrades: 2,
    positions: {
      EURUSD: {
        quantity: 1,
        avgPrice: 1.1,
        referenceAvgPrice: 1.1,
        entryTime: new Date().toISOString(),
        autonomousTag: true,
        entryFriction: { spread: 0, slippage: 0, fee: 0, impact: 0 },
        accumulatedEntryExecutionCost: 0,
      },
    },
    lastPriceBySymbol: { EURUSD: 1.1 },
    lastUpdated: new Date().toISOString(),
  };
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(statePath, JSON.stringify(snapshot, null, 2), 'utf8');

  await paperTradingService.initializeState();
  assert.strictEqual(
    paperTradingService.account.positions.has('EURUSD'),
    true,
    'file fallback should restore open position when ledger has no FILLED rows'
  );

  const filledEmpty = await tradeLedger.getFilledTrades();
  assert.strictEqual(filledEmpty.length, 0);
  assert.ok(
    paperTradingService.account.positions.size > 0 && filledEmpty.length === 0,
    'reconcile warning path: open book vs empty FILLED'
  );

  const summary = await executionQualityService.getExecutionQualitySummary({ limit: 5 });
  assert.ok(summary && typeof summary === 'object', 'execution summary');

  await tradeLedger.close();
  console.log('paperLifecyclePersistence tests passed.');
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
