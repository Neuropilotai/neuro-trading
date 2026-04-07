#!/usr/bin/env node
'use strict';

/**
 * Closed trade analytics — unit tests (no server).
 * Run: node tests/closedTradeAnalytics.test.js
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const closedTradeAnalyticsService = require('../backend/services/closedTradeAnalyticsService');

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cta-test-'));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function run() {
  console.log('closedTradeAnalytics tests…');

  // 1) buildClosedTradeRecord — PnL & % & holding
  const entry = '2026-04-07T23:13:31.235Z';
  const exit = '2026-04-07T23:16:34.100Z';
  const row = closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: 'XAUUSD',
    entryPriceAvg: 4814.84,
    exitPriceAvg: 4820.1,
    closedQuantity: 0.01,
    realizedPnL: (4820.1 - 4814.84) * 0.01,
    entryTimestamp: entry,
    exitTimestamp: exit,
    closeReason: 'SELL',
    priceSourceAtExit: 'live',
    stopLoss: 4700,
  });
  assert.strictEqual(row.side, 'LONG');
  assert.ok(Math.abs(row.realizedPnL - 0.0526) < 1e-9);
  assert.ok(row.realizedPnLPercent > 0);
  assert.strictEqual(row.holdingTimeSec, 183);
  assert.ok(Math.abs(row.holdingTimeMin - 3.05) < 0.01);
  assert.strictEqual(row.closeReason, 'SELL');
  assert.strictEqual(row.won, true);
  assert.strictEqual(row.bookValueClosed, 4814.84 * 0.01);
  assert.strictEqual(row.marketValueAtExit, 4820.1 * 0.01);
  assert.ok(row.rMultiple != null && Number.isFinite(row.rMultiple));

  // 2) JSONL append + load + partial sells = 3 lines
  await withTempDataDir(async () => {
    process.env.ENABLE_CLOSED_TRADE_ANALYTICS = 'true';
    for (let i = 0; i < 3; i++) {
      await closedTradeAnalyticsService.recordClosedTrade(
        closedTradeAnalyticsService.buildClosedTradeRecord({
          symbol: 'XAUUSD',
          entryPriceAvg: 100,
          exitPriceAvg: 100 + i,
          closedQuantity: 0.01,
          realizedPnL: (100 + i - 100) * 0.01,
          entryTimestamp: '2026-01-01T00:00:00.000Z',
          exitTimestamp: `2026-01-01T00:0${i + 1}:00.000Z`,
          closeReason: 'SELL',
          closeSequence: i + 1,
          tradeGroupId: 'tg_test',
        })
      );
    }
    const all = await closedTradeAnalyticsService.loadClosedTrades();
    assert.strictEqual(all.length, 3);
    const sym = await closedTradeAnalyticsService.listClosedTrades({ symbol: 'XAUUSD' });
    assert.strictEqual(sym.length, 3);
  });

  // 3) Stats — winRate, profitFactor, expectancy
  const trades = [
    closedTradeAnalyticsService.buildClosedTradeRecord({
      symbol: 'X',
      entryPriceAvg: 100,
      exitPriceAvg: 110,
      closedQuantity: 1,
      realizedPnL: 10,
      entryTimestamp: '2026-01-01T00:00:00.000Z',
      exitTimestamp: '2026-01-01T01:00:00.000Z',
      closeReason: 'SELL',
    }),
    closedTradeAnalyticsService.buildClosedTradeRecord({
      symbol: 'X',
      entryPriceAvg: 100,
      exitPriceAvg: 90,
      closedQuantity: 1,
      realizedPnL: -10,
      entryTimestamp: '2026-01-01T00:00:00.000Z',
      exitTimestamp: '2026-01-01T02:00:00.000Z',
      closeReason: 'SELL',
    }),
    closedTradeAnalyticsService.buildClosedTradeRecord({
      symbol: 'X',
      entryPriceAvg: 100,
      exitPriceAvg: 105,
      closedQuantity: 1,
      realizedPnL: 5,
      entryTimestamp: '2026-01-01T00:00:00.000Z',
      exitTimestamp: '2026-01-01T03:00:00.000Z',
      closeReason: 'CLOSE',
    }),
  ];
  const stats = closedTradeAnalyticsService.getClosedTradeStats(trades);
  assert.strictEqual(stats.count, 3);
  assert.strictEqual(stats.wins, 2);
  assert.strictEqual(stats.losses, 1);
  assert.ok(Math.abs(stats.winRate - (2 / 3) * 100) < 0.01);
  assert.strictEqual(stats.totalRealizedPnL, 5);
  assert.strictEqual(stats.grossProfit, 15);
  assert.strictEqual(stats.grossLoss, -10);
  assert.ok(stats.profitFactor != null && stats.profitFactor > 1);
  assert.ok(Math.abs(stats.expectancy - 5 / 3) < 1e-6);
  assert.strictEqual(stats.bestTrade, 10);
  assert.strictEqual(stats.worstTrade, -10);
  assert.ok(stats.avgHoldingTimeSec > 0);

  // 4) API-shaped stats object keys
  const keys = [
    'count',
    'wins',
    'losses',
    'winRate',
    'totalRealizedPnL',
    'grossProfit',
    'grossLoss',
    'profitFactor',
    'avgWin',
    'avgLoss',
    'expectancy',
    'bestTrade',
    'worstTrade',
    'avgHoldingTimeSec',
    'avgHoldingTimeMin',
  ];
  for (const k of keys) {
    assert.ok(k in stats, `missing stat ${k}`);
  }

  console.log('✅ closedTradeAnalytics tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
