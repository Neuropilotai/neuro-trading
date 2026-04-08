#!/usr/bin/env node
'use strict';

/**
 * Paper execution realism — unit tests (no server).
 * Run: node tests/executionRealism.test.js
 */

const assert = require('assert');
const executionRealismService = require('../backend/services/executionRealismService');
const closedTradeAnalyticsService = require('../backend/services/closedTradeAnalyticsService');
const reinforcementLearningService = require('../backend/services/reinforcementLearningService');
const executionQualityService = require('../backend/services/executionQualityService');

async function run() {
  console.log('executionRealism tests…');

  const prevRealism = process.env.EXEC_REALISM_ENABLED;
  const prevMax = process.env.EXEC_REALISM_MAX_TOTAL_BPS;
  process.env.EXEC_REALISM_ENABLED = 'true';
  process.env.EXEC_REALISM_MAX_TOTAL_BPS = '80';

  // 1) BUY: effective fill worse than reference (higher price)
  const buyFill = executionRealismService.computeRealisticPaperFill({
    symbol: 'XAUUSD',
    side: 'BUY',
    requestedPrice: 2000,
    quantity: 1,
    notional: 2000,
    quote: { latencyMs: 40, source: 'live' },
    pricingMode: 'mark_quote_fresh',
  });
  assert.ok(buyFill.effectiveFillPrice >= buyFill.referencePrice);
  assert.ok(buyFill.effectiveFillPrice > buyFill.referencePrice);

  // 2) SELL: effective fill worse than reference (lower price)
  const sellFill = executionRealismService.computeRealisticPaperFill({
    symbol: 'XAUUSD',
    side: 'SELL',
    requestedPrice: 2000,
    quantity: 1,
    notional: 2000,
    quote: { latencyMs: 40, source: 'live' },
  });
  assert.ok(sellFill.effectiveFillPrice <= sellFill.referencePrice);
  assert.ok(sellFill.effectiveFillPrice < sellFill.referencePrice);

  // 3) Cost estimate stable and bounded
  const est = executionRealismService.computeExecutionCostEstimate({
    symbol: 'EURUSD',
    side: 'BUY',
    requestedPrice: 1.1,
    quantity: 10000,
    notional: 11000,
    quote: { latencyMs: 30 },
  });
  assert.ok(est.totalBps >= 0 && est.totalBps <= 80);
  assert.ok(est.totalCost >= 0);

  // 4) Gross vs net in closed-trade record
  const row = closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: 'XAUUSD',
    entryPriceAvg: 2000,
    exitPriceAvg: 2005,
    closedQuantity: 1,
    realizedPnL: 3,
    netRealizedPnL: 3,
    grossRealizedPnL: 5,
    totalExecutionCost: 2,
    entryTimestamp: '2026-01-01T00:00:00.000Z',
    exitTimestamp: '2026-01-01T01:00:00.000Z',
    closeReason: 'SELL',
  });
  assert.strictEqual(row.netRealizedPnL, 3);
  assert.strictEqual(row.grossRealizedPnL, 5);
  assert.strictEqual(row.realizedPnL, 3);

  // 5) Cost flip: gross winner, net loser
  const flip = closedTradeAnalyticsService.buildClosedTradeRecord({
    symbol: 'XAUUSD',
    entryPriceAvg: 100,
    exitPriceAvg: 101,
    closedQuantity: 1,
    realizedPnL: -0.5,
    netRealizedPnL: -0.5,
    grossRealizedPnL: 1,
    totalExecutionCost: 1.5,
    entryTimestamp: '2026-01-01T00:00:00.000Z',
    exitTimestamp: '2026-01-01T01:00:00.000Z',
    closeReason: 'SELL',
  });
  assert.ok(flip.grossRealizedPnL > 0);
  assert.ok(flip.netRealizedPnL < 0);
  assert.strictEqual(flip.won, false);

  // 6) Learning buckets prefer net over gross when netRealizedPnL set
  const buckets = reinforcementLearningService.buildStateBuckets([
    {
      symbol: 'EURUSD',
      strategy: 's1',
      regime: 'r',
      closedAtHourUTC: 10,
      exitTimestamp: '2026-01-01T00:00:00.000Z',
      realizedPnL: 10,
      netRealizedPnL: -2,
    },
  ]);
  const anyKey = Object.keys(buckets).find((k) => k.startsWith('strategy|'));
  assert.ok(anyKey);
  assert.ok(Math.abs(buckets[anyKey].totalRealizedPnL - -2) < 1e-9);

  // 7) Execution quality summary
  const q = executionQualityService.summarizeExecutionQuality([
    {
      symbol: 'XAUUSD',
      strategy: 'a',
      sessionTagAtEntry: 'asia',
      grossRealizedPnL: 10,
      netRealizedPnL: 8,
      realizedPnL: 8,
      totalExecutionCost: 2,
      executionCostBps: 15,
      spreadCostBps: 5,
      slippageCostBps: 6,
      feeCostBps: 4,
      fillQualityScore: 70,
    },
    {
      symbol: 'XAUUSD',
      strategy: 'a',
      grossRealizedPnL: 5,
      netRealizedPnL: -1,
      realizedPnL: -1,
      totalExecutionCost: 6,
      executionCostBps: 40,
      spreadCostBps: 10,
      slippageCostBps: 20,
      feeCostBps: 10,
      fillQualityScore: 30,
    },
  ]);
  assert.ok(q.tradeCount === 2);
  assert.ok(q.avgTotalExecutionCostBps != null);

  // 7b) Derive execution bps from dollars when bps columns missing (legacy rows)
  const derived = executionQualityService.summarizeExecutionQuality([
    {
      symbol: 'XAUUSD',
      strategy: 'legacy',
      closedQuantity: 1,
      exitPriceAvg: 100,
      totalExecutionCost: 0.5,
      grossRealizedPnL: 1,
      netRealizedPnL: 0.5,
      realizedPnL: 0.5,
      entryTimestamp: '2026-01-01T00:00:00.000Z',
      exitTimestamp: '2026-01-01T01:00:00.000Z',
    },
  ]);
  assert.strictEqual(derived.avgTotalExecutionCostBps, 50);

  const ob = executionQualityService.summarizeOpenBookPositions([
    {
      symbol: 'XAUUSD',
      quantity: 0.01,
      executionFrictionAtEntry: {
        spreadBps: 2,
        slippageBps: 1,
        impactBps: 0.5,
        feeBps: 1,
        totalBps: 4.5,
      },
    },
  ]);
  assert.strictEqual(ob.positionsWithFriction, 1);
  assert.strictEqual(ob.avgTotalExecutionCostBps, 4.5);

  const merged = executionQualityService.mergeClosedAndOpenExecutionSummary(
    {
      tradeCount: 0,
      avgSpreadCostBps: null,
      avgSlippageCostBps: null,
      avgFeeCostBps: null,
      avgTotalExecutionCostBps: null,
      avgCostToGrossRatio: null,
      percentTradesWhereCostsFlippedGrossWinToNetLoss: 0,
      percentTradesWithPoorFillQuality: 0,
      costAdjustedWinRate: null,
      grossWinRate: null,
      grossVsNetPnLGap: null,
      worstExecutionSymbols: [],
      worstExecutionStrategies: [],
      worstExecutionSessions: [],
      executionRealismWarnings: [],
    },
    ob
  );
  assert.strictEqual(merged.avgTotalExecutionCostBps, 4.5);
  assert.strictEqual(merged.openBookFillsSummaryGaps, true);

  // 8) Disabled realism: no drift
  process.env.EXEC_REALISM_ENABLED = 'false';
  const flat = executionRealismService.computeRealisticPaperFill({
    symbol: 'XAUUSD',
    side: 'BUY',
    requestedPrice: 100,
    quantity: 1,
    notional: 100,
  });
  assert.strictEqual(flat.effectiveFillPrice, flat.referencePrice);

  if (prevRealism === undefined) delete process.env.EXEC_REALISM_ENABLED;
  else process.env.EXEC_REALISM_ENABLED = prevRealism;
  if (prevMax === undefined) delete process.env.EXEC_REALISM_MAX_TOTAL_BPS;
  else process.env.EXEC_REALISM_MAX_TOTAL_BPS = prevMax;

  console.log('executionRealism tests: OK');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
