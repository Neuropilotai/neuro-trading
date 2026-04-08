#!/usr/bin/env node
'use strict';

/**
 * Institutional analytics overview. Run: node tests/analyticsOverview.test.js
 */

const assert = require('assert');
const analyticsOverviewService = require('../backend/services/analyticsOverviewService');
const closedTradeAnalyticsService = require('../backend/services/closedTradeAnalyticsService');

async function run() {
  console.log('analyticsOverview tests…');

  // 1) No trades — core summaries build (avoid getAnalyticsOverview here so tests
  //    do not load paper/risk/SQLite; full overview is covered by the API in runtime).
  const execEmpty = analyticsOverviewService.buildExecutionQualitySummary([]);
  assert.strictEqual(execEmpty.tradeCount, 0);
  assert.strictEqual(execEmpty.partialCloses, 0);
  assert.strictEqual(execEmpty.fullCloses, 0);
  const stratEmpty = analyticsOverviewService.buildAttributionSummary([], ['strategy']);
  assert.deepStrictEqual(stratEmpty, []);
  const riskEmpty = analyticsOverviewService.buildRiskDiagnostics([], null);
  assert.ok('drawdownProxy' in riskEmpty);
  assert.ok(Array.isArray(riskEmpty.degradationFlags));

  // 2) Attribution by strategy + symbol
  const t1 = closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: 'XAUUSD',
    entryPriceAvg: 100,
    exitPriceAvg: 102,
    closedQuantity: 1,
    realizedPnL: 2,
    entryTimestamp: '2026-04-01T10:00:00.000Z',
    exitTimestamp: '2026-04-01T11:00:00.000Z',
    closeReason: 'SELL',
    strategy: 'strat-a',
    mfe: 3,
    mae: 0.5,
    efficiencyRatio: 0.5,
  });
  const t2 = closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: 'EURUSD',
    entryPriceAvg: 1.1,
    exitPriceAvg: 1.09,
    closedQuantity: 1,
    realizedPnL: -0.01,
    entryTimestamp: '2026-04-02T10:00:00.000Z',
    exitTimestamp: '2026-04-02T12:00:00.000Z',
    closeReason: 'SELL',
    strategy: 'strat-b',
    mfe: 0.02,
    mae: 0.05,
    efficiencyRatio: 0.1,
  });
  const stratAttr = analyticsOverviewService.buildAttributionSummary([t1, t2], ['strategy']);
  assert.strictEqual(stratAttr.length, 2);
  const symAttr = analyticsOverviewService.buildAttributionSummary([t1, t2], ['symbol']);
  assert.strictEqual(symAttr.length, 2);

  // 3) Lifecycle outliers ordering
  const tLo = closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: 'X',
    entryPriceAvg: 100,
    exitPriceAvg: 99,
    closedQuantity: 1,
    realizedPnL: -1,
    entryTimestamp: '2026-01-01T00:00:00.000Z',
    exitTimestamp: '2026-01-01T01:00:00.000Z',
    closeReason: 'SELL',
    mfe: 1,
    mae: 2,
    efficiencyRatio: 0.2,
    peakUnrealizedPnL: 10,
  });
  const tHi = closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: 'X',
    entryPriceAvg: 100,
    exitPriceAvg: 105,
    closedQuantity: 1,
    realizedPnL: 5,
    entryTimestamp: '2026-01-02T00:00:00.000Z',
    exitTimestamp: '2026-01-02T02:00:00.000Z',
    closeReason: 'SELL',
    mfe: 5,
    mae: 0.1,
    efficiencyRatio: 0.9,
    peakUnrealizedPnL: 6,
  });
  const out = analyticsOverviewService.buildLifecycleOutliers([tLo, tHi], { outlierLimit: 2 });
  assert.strictEqual(out.bestByRealizedPnL[0].realizedPnL, 5);
  assert.strictEqual(out.worstByRealizedPnL[0].realizedPnL, -1);
  assert.ok(out.worstMae[0].mae >= out.worstMae[out.worstMae.length - 1].mae);

  // 4) Risk diagnostics — stable numerics + keys
  const risk = analyticsOverviewService.buildRiskDiagnostics([t1, t2, tLo, tHi], null);
  assert.ok(risk.streaks);
  assert.ok('winStreak' in risk.streaks);
  assert.ok('lossStreak' in risk.streaks);
  assert.ok(Number.isFinite(risk.drawdownProxy));
  assert.ok(Array.isArray(risk.topUnderperformingStrategies));
  assert.ok(Array.isArray(risk.unstableRegimes));

  console.log('✅ analyticsOverview tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
