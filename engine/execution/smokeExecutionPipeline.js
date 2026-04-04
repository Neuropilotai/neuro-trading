#!/usr/bin/env node
'use strict';

/**
 * Smoke: pipeline end-to-end with temp governance dir (no real broker).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const dataRoot = require('../dataRoot');
const { runExecutionPipeline, mapPipelineToGateResult } = require('./runExecutionPipeline');

const mockBrokerOk = {
  healthCheck: async () => ({ connected: true, ok: true, broker: 'Mock' }),
};

const mockBrokerBad = {
  healthCheck: async () => ({ connected: false, ok: false, broker: 'Mock' }),
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-ex-pipe-'));
  const prev = process.env.NEUROPILOT_DATA_ROOT;
  process.env.NEUROPILOT_DATA_ROOT = tmp;
  dataRoot.resetDataRoot();

  const journalOpts = { dataRoot: tmp };

  try {
    const orderIntent = {
      symbol: 'BTCUSDT',
      action: 'BUY',
      quantity: 0.01,
      price: 50000,
      stopLoss: 49000,
      takeProfit: 52000,
      setupId: 'test_setup',
    };

    process.env.TRADING_MODE = 'paper';
    process.env.BROKER = 'paper';

    const isolatedCtx = {
      equity: 1_000_000,
      openPositionsCount: 0,
      tradesTodayTotal: 0,
      dailyRealizedPnl: 0,
      dailyUnrealizedPnl: 0,
      openCountByStrategy: {},
      openCountBySymbol: {},
      notionalExposureByAssetClass: {},
    };

    const p1 = await runExecutionPipeline({
      orderIntent,
      preTradeContext: isolatedCtx,
      getBrokerAdapter: () => mockBrokerOk,
      executeOrderCore: async () => ({
        success: true,
        tradeId: 'MOCK_1',
        executionResult: { fillPrice: 50000, filledQuantity: 0.01, pnl: 0, executedAt: new Date().toISOString() },
      }),
      journalOpts,
      env: { ...process.env, TRADING_MODE: 'paper', BROKER: 'paper' },
    });
    assert.strictEqual(p1.finalStatus, 'accepted');
    const g1 = mapPipelineToGateResult(p1);
    assert.strictEqual(g1.success, true);
    assert.strictEqual(g1.tradeId, 'MOCK_1');
    console.log('[smokeExecutionPipeline] paper accepted OK');

    process.env.TRADING_MODE = 'live';
    process.env.NEUROPILOT_EXECUTION_MODE = 'paper';
    process.env.BROKER = 'oanda';
    const p2 = await runExecutionPipeline({
      orderIntent,
      preTradeContext: isolatedCtx,
      getBrokerAdapter: () => mockBrokerOk,
      executeOrderCore: async () => ({ success: true, tradeId: 'x' }),
      journalOpts,
      env: {
        TRADING_MODE: 'live',
        NEUROPILOT_EXECUTION_MODE: 'paper',
        BROKER: 'oanda',
      },
    });
    assert.strictEqual(p2.finalStatus, 'blocked_policy');
    console.log('[smokeExecutionPipeline] live blocked by policy (not armed) OK');

    process.env.NEUROPILOT_EXECUTION_MODE = 'live';
    process.env.ENABLE_LIVE_TRADING = '1';
    process.env.TRADING_ENABLED = 'true';
    const p3 = await runExecutionPipeline({
      orderIntent,
      preTradeContext: isolatedCtx,
      getBrokerAdapter: () => mockBrokerBad,
      executeOrderCore: async () => ({ success: true, tradeId: 'x' }),
      journalOpts,
      env: {
        TRADING_MODE: 'live',
        NEUROPILOT_EXECUTION_MODE: 'live',
        ENABLE_LIVE_TRADING: '1',
        TRADING_ENABLED: 'true',
        BROKER: 'oanda',
        OANDA_API_KEY: 'k',
        OANDA_ACCOUNT_ID: 'a',
      },
    });
    assert.strictEqual(p3.finalStatus, 'blocked_policy');
    console.log('[smokeExecutionPipeline] live blocked by broker health OK');

    const p4 = await runExecutionPipeline({
      orderIntent: { ...orderIntent, stopLoss: 49999 },
      preTradeContext: isolatedCtx,
      getBrokerAdapter: () => mockBrokerOk,
      executeOrderCore: async () => ({ success: true, tradeId: 'x' }),
      journalOpts,
      env: { ...process.env, TRADING_MODE: 'paper', BROKER: 'paper' },
    });
    assert.strictEqual(p4.finalStatus, 'blocked_risk');
    console.log('[smokeExecutionPipeline] blocked by risk OK');

    const p5 = await runExecutionPipeline({
      orderIntent,
      preTradeContext: isolatedCtx,
      getBrokerAdapter: () => mockBrokerOk,
      executeOrderCore: async () => ({ success: false, reason: 'backend_risk' }),
      journalOpts,
      env: { ...process.env, TRADING_MODE: 'paper', BROKER: 'paper' },
    });
    assert.strictEqual(p5.finalStatus, 'rejected');
    console.log('[smokeExecutionPipeline] stub core reject OK');

    const intentsFile = path.join(tmp, 'governance', 'execution_intents.jsonl');
    assert.ok(fs.existsSync(intentsFile));
    const lines = fs.readFileSync(intentsFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 4);
    console.log('[smokeExecutionPipeline] journals present OK');

    // Lock-in: strategyId without setupId must appear correctly in execution_intents.jsonl
    const orderStrategyIdOnly = {
      symbol: 'ETHUSDT',
      action: 'BUY',
      quantity: 0.1,
      price: 3000,
      stopLoss: 2900,
      takeProfit: 3200,
      strategyId: 'STRAT_ID_NO_SETUP',
    };
    const pJournal = await runExecutionPipeline({
      orderIntent: orderStrategyIdOnly,
      preTradeContext: isolatedCtx,
      getBrokerAdapter: () => mockBrokerOk,
      executeOrderCore: async () => ({
        success: true,
        tradeId: 'MOCK_JOURNAL_ID',
        executionResult: { fillPrice: 3000, filledQuantity: 0.1, pnl: 0, executedAt: new Date().toISOString() },
      }),
      journalOpts,
      env: { ...process.env, TRADING_MODE: 'paper', BROKER: 'paper' },
    });
    assert.strictEqual(pJournal.finalStatus, 'accepted');
    const linesAfter = fs.readFileSync(intentsFile, 'utf8').trim().split('\n').filter(Boolean);
    const rows = linesAfter.map((l) => JSON.parse(l));
    const journalRow = rows.find(
      (r) => r.finalDecision === 'accepted' && r.strategyId === 'STRAT_ID_NO_SETUP'
    );
    assert.ok(journalRow, 'expected accepted intent row with strategyId from strategyId-only intent');
    assert.strictEqual(
      journalRow.setupId,
      null,
      'setupId must be null when only strategyId was provided'
    );
    const orderRows = fs
      .readFileSync(path.join(tmp, 'governance', 'execution_orders.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const orderRow = orderRows.find((r) => r.strategyId === 'STRAT_ID_NO_SETUP');
    assert.ok(orderRow, 'execution_orders.jsonl should carry strategyId when setupId absent');
    console.log('[smokeExecutionPipeline] journal strategyId-only (no setupId) OK');

    console.log('[smokeExecutionPipeline] ALL OK');
  } finally {
    if (prev === undefined) delete process.env.NEUROPILOT_DATA_ROOT;
    else process.env.NEUROPILOT_DATA_ROOT = prev;
    dataRoot.resetDataRoot();
    process.env.TRADING_MODE = 'paper';
    process.env.BROKER = 'paper';
    delete process.env.NEUROPILOT_EXECUTION_MODE;
    delete process.env.ENABLE_LIVE_TRADING;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
