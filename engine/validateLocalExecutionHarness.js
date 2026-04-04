#!/usr/bin/env node
'use strict';

/**
 * End-to-end validation: adaptive quant pipeline → signalAdapter → webhookBridge → POST
 * to http://localhost:3014/webhook/tradingview. Verifies response includes orderIntent or
 * expected rejection (e.g. kill switch). TRADING_ENABLED=false kept; no live trading.
 *
 * Prerequisites:
 *   - Webhook server running at http://localhost:3014
 *   - TRADINGVIEW_WEBHOOK_SECRET set in server env and passed to harness (same value)
 *
 * Run from repo root:
 *   node neuropilot_trading_v2/engine/validateLocalExecutionHarness.js
 */

const backtestRunner = require('./backtestRunner');
const performanceAnalyzer = require('./performanceAnalyzer');
const strategyRanking = require('./strategyRanking');
const localExecutionHarness = require('./localExecutionHarness');

const BASE_URL = 'http://localhost:3014';

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

function hasOrderIntentOrExpectedRejection(responseBody, httpStatus) {
  if (!responseBody || typeof responseBody !== 'object') return false;
  if (responseBody.orderIntent && typeof responseBody.orderIntent === 'object') return true;
  const msg = (responseBody.message || responseBody.error || '').toString();
  if (httpStatus === 403 && /Trading is disabled|kill switch/i.test(msg)) return true;
  if (httpStatus === 200 && (responseBody.orderIntent || responseBody.executed !== undefined)) return true;
  return false;
}

async function main() {
  console.log('1. Building ranking from adaptive backtest...');
  const candles = makeCandles(120);
  const account = { equity: 500, dailyPnL: 0, openPositions: 0 };
  const symbol = 'XAUUSD';

  const backtestResult = backtestRunner.run(candles, account, symbol, '2m', {
    barTimestamp: { baseMs: Date.UTC(2026, 0, 1), intervalMs: 120000 },
  });
  const analysis = performanceAnalyzer.analyze(backtestResult.records);
  const ranking = strategyRanking.rank(analysis);

  console.log('2. Running adaptive pipeline → signalAdapter → webhookBridge → POST...');
  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  const result = await localExecutionHarness.run(candles, account, ranking, symbol, {
    baseUrl: BASE_URL,
    secret: secret || undefined,
  });

  console.log('\n--- Full result ---');
  console.log('valid:', result.valid);
  console.log('httpStatus:', result.httpStatus);
  console.log('responseBody:', JSON.stringify(result.responseBody, null, 2));

  if (result.executionPayload) {
    console.log('\n--- Execution payload (sent) ---');
    console.log('  action:', result.executionPayload.action);
    console.log('  quantity:', result.executionPayload.quantity);
    console.log('  price:', result.executionPayload.price);
  }

  const ok =
    result.valid &&
    result.httpStatus != null &&
    result.responseBody != null &&
    hasOrderIntentOrExpectedRejection(result.responseBody, result.httpStatus);

  if (ok) {
    console.log('\n✅ Validation passed: response includes orderIntent or expected rejection (e.g. kill switch).');
    process.exit(0);
  }

  if (!result.valid) {
    console.log('\n❌ Validation failed: pipeline or payload invalid (no request sent).');
    process.exit(1);
  }
  if (result.httpStatus === 401) {
    console.log('\n❌ Validation failed: webhook auth rejected. Set TRADINGVIEW_WEBHOOK_SECRET to match server.');
    process.exit(1);
  }
  if (result.httpStatus === 500 && result.responseBody && /TRADINGVIEW_WEBHOOK_SECRET|authentication not configured/i.test(JSON.stringify(result.responseBody))) {
    console.log('\n❌ Validation failed: server requires TRADINGVIEW_WEBHOOK_SECRET. Set it in server env and pass same value (e.g. export TRADINGVIEW_WEBHOOK_SECRET=your-secret).');
    process.exit(1);
  }
  if (result.httpStatus === 0) {
    console.log('\n❌ Validation failed: request error (server not reachable?).');
    process.exit(1);
  }
  if (!hasOrderIntentOrExpectedRejection(result.responseBody, result.httpStatus)) {
    console.log('\n❌ Validation failed: response did not include orderIntent or expected rejection message.');
    process.exit(1);
  }

  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
