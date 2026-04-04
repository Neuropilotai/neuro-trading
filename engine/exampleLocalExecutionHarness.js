#!/usr/bin/env node
'use strict';

/**
 * Example: run Local Execution Harness (adaptive pipeline → webhook POST to local server).
 * Requires neuropilot_trading_v2 webhook server running at http://localhost:3014.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleLocalExecutionHarness.js
 */
const backtestRunner = require('./backtestRunner');
const performanceAnalyzer = require('./performanceAnalyzer');
const strategyRanking = require('./strategyRanking');
const localExecutionHarness = require('./localExecutionHarness');

function makeCandles(n, base = 2640) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base + i * 0.3 + (Math.random() - 0.5) * 2;
    const c = o + (Math.random() - 0.2) * 4;
    out.push({
      open: o,
      high: Math.max(o, c) + Math.random() * 2,
      low: Math.min(o, c) - Math.random() * 2,
      close: c,
      volume: 1000 + Math.floor(Math.random() * 500),
      time: Date.UTC(2026, 0, 1) + i * 120000,
    });
  }
  return out;
}

const candles = makeCandles(120);
const account = { equity: 500, dailyPnL: 0, openPositions: 0 };
const symbol = 'XAUUSD';

async function main() {
  const backtestResult = backtestRunner.run(candles, account, symbol, '2m', {
    barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 120000 },
  });
  const analysis = performanceAnalyzer.analyze(backtestResult.records);
  const ranking = strategyRanking.rank(analysis);

  const result = await localExecutionHarness.run(candles, account, ranking, symbol, {
    baseUrl: 'http://localhost:3014',
    secret: process.env.TRADINGVIEW_WEBHOOK_SECRET || undefined,
  });

  console.log('Local execution result:');
  console.log('  valid:', result.valid);
  console.log('  httpStatus:', result.httpStatus);
  console.log('  responseBody:', result.responseBody);
  if (result.executionPayload) {
    console.log('  executionPayload.action:', result.executionPayload.action);
    console.log('  executionPayload.quantity:', result.executionPayload.quantity);
  }
  if (result.httpStatus === 0 && result.responseBody && result.responseBody.error) {
    console.log('\nTip: Ensure webhook server is running and TRADINGVIEW_WEBHOOK_SECRET is set to match server.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
