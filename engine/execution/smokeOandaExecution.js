#!/usr/bin/env node
'use strict';

/**
 * OANDA V2 pipeline smoke (no network unless you remove mock).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const dataRoot = require('../dataRoot');
const { runOandaExecutionPipeline } = require('./runOandaExecutionPipeline');

const orderBase = {
  symbol: 'EUR_USD',
  action: 'BUY',
  quantity: 1000,
  price: 1.1,
  stopLoss: 1.08,
  takeProfit: 1.14,
  setupId: 'test_strategy_oanda',
};

function mockAdapter() {
  return {
    apiKey: 'mock',
    accountId: 'mock',
    environment: 'practice',
    async connect() {
      this.connected = true;
    },
    async healthCheck() {
      return { ok: true, connected: true, broker: 'OANDA_MOCK' };
    },
    async placeOrder(oi) {
      return {
        success: true,
        tradeId: 'MOCK_FILL_1',
        executionResult: {
          symbol: oi.symbol,
          filledQuantity: oi.quantity,
          fillPrice: oi.price,
          pnl: 0,
          executedAt: new Date().toISOString(),
        },
      };
    },
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-oanda-v2-'));
  const prevRoot = process.env.NEUROPILOT_DATA_ROOT;
  process.env.NEUROPILOT_DATA_ROOT = tmp;
  dataRoot.resetDataRoot();

  const journalOpts = { dataRoot: tmp };
  const riskCtx = {
    equity: 100000,
    openCountGlobal: 0,
    openCountForStrategy: 0,
    tradesToday: 0,
    dailyRealizedPnl: 0,
  };

  try {
    // 1) paper → OK, no broker
    const e1 = {
      NEUROPILOT_EXECUTION_MODE: 'paper',
      ACCOUNT_BALANCE: '100000',
    };
    const r1 = await runOandaExecutionPipeline(orderBase, {
      env: e1,
      journalOpts,
      riskContext: riskCtx,
    });
    assert.strictEqual(r1.accepted, true);
    assert.strictEqual(r1.mode, 'paper');
    assert.strictEqual(r1.broker, null);
    console.log('[smokeOandaExecution] 1 paper OK');

    // 2) live without ENABLE_LIVE_TRADING=1 → BLOCK
    const e2 = {
      NEUROPILOT_EXECUTION_MODE: 'live',
      ENABLE_LIVE_TRADING: 'true',
      ACCOUNT_BALANCE: '100000',
    };
    const r2 = await runOandaExecutionPipeline(orderBase, {
      env: e2,
      journalOpts,
      riskContext: riskCtx,
    });
    assert.strictEqual(r2.accepted, false);
    assert.strictEqual(r2.mode, 'blocked');
    console.log('[smokeOandaExecution] 2 live without =1 BLOCK OK');

    // 3) live + ENABLE_LIVE_TRADING=1 but risk fail → BLOCK
    const e3 = {
      NEUROPILOT_EXECUTION_MODE: 'live',
      ENABLE_LIVE_TRADING: '1',
      NEUROPILOT_OANDA_LIVE_ALLOW_STRATEGY_IDS: 'test_strategy_oanda',
      ACCOUNT_BALANCE: '100000',
    };
    const badOrder = { ...orderBase, stopLoss: 1.0999 };
    const r3 = await runOandaExecutionPipeline(badOrder, {
      env: e3,
      journalOpts,
      riskContext: riskCtx,
    });
    assert.strictEqual(r3.accepted, false);
    assert.strictEqual(r3.stage, 'risk');
    console.log('[smokeOandaExecution] 3 live risk fail BLOCK OK');

    // 4) live + risk OK + practice (mock adapter) → OK
    const e4 = {
      NEUROPILOT_EXECUTION_MODE: 'live',
      ENABLE_LIVE_TRADING: '1',
      OANDA_ENV: 'practice',
      NEUROPILOT_OANDA_LIVE_ALLOW_STRATEGY_IDS: 'test_strategy_oanda',
      ACCOUNT_BALANCE: '100000',
    };
    const r4 = await runOandaExecutionPipeline(orderBase, {
      env: e4,
      journalOpts,
      riskContext: riskCtx,
      createOandaAdapter: mockAdapter,
    });
    assert.strictEqual(r4.accepted, true);
    assert.strictEqual(r4.stage, 'complete');
    assert.ok(r4.order && r4.order.tradeId);
    console.log('[smokeOandaExecution] 4 live + practice mock OK');

    const intents = path.join(tmp, 'governance', 'execution_intents.jsonl');
    assert.ok(fs.existsSync(intents));
    const n = fs.readFileSync(intents, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.ok(n >= 4);
    console.log('[smokeOandaExecution] journal lines:', n);

    console.log('[smokeOandaExecution] ALL OK');
  } finally {
    if (prevRoot === undefined) delete process.env.NEUROPILOT_DATA_ROOT;
    else process.env.NEUROPILOT_DATA_ROOT = prevRoot;
    dataRoot.resetDataRoot();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
