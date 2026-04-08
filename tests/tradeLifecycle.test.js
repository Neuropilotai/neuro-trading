#!/usr/bin/env node
'use strict';

/**
 * Trade lifecycle + MFE/MAE (long). Run: node tests/tradeLifecycle.test.js
 */

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

function loadLifecycleFresh() {
  const p = require.resolve('../backend/services/tradeLifecycleService');
  delete require.cache[p];
  return require('../backend/services/tradeLifecycleService');
}

async function waitForFile(filePath, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function withTempDataDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tlc-test-'));
  const prevData = process.env.DATA_DIR;
  const prevEn = process.env.ENABLE_TRADE_LIFECYCLE;
  process.env.DATA_DIR = dir;
  process.env.ENABLE_TRADE_LIFECYCLE = 'true';
  try {
    await fn(dir);
  } finally {
    if (prevData === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevData;
    if (prevEn === undefined) delete process.env.ENABLE_TRADE_LIFECYCLE;
    else process.env.ENABLE_TRADE_LIFECYCLE = prevEn;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function run() {
  console.log('tradeLifecycle tests…');

  await withTempDataDir(async () => {
    const tls = loadLifecycleFresh();
    const tg = 'tg_mfe_1';
    tls.notifyBuyFilled({
      tradeGroupId: tg,
      symbol: 'XAUUSD',
      fillPrice: 100,
      avgPrice: 100,
      quantity: 0.01,
    });
    tls.notifyPriceTick('XAUUSD', 110);
    tls.notifyPriceTick('XAUUSD', 90);
    const exitTs = '2026-04-07T12:00:00.000Z';
    const { finalized } = tls.notifySellFill({
      tradeGroupId: tg,
      symbol: 'XAUUSD',
      exitPrice: 105,
      pnl: 0.05,
      newOpenQuantity: 0,
      exitTimestamp: exitTs,
    });
    assert.ok(finalized);
    assert.strictEqual(finalized.mfe, 10);
    assert.strictEqual(finalized.mae, 10);
    assert.ok(finalized.peakUnrealizedPnL >= 0.09);
    assert.ok(finalized.worstUnrealizedPnL <= -0.05);
    assert.ok(
      finalized.efficiencyRatio != null && finalized.efficiencyRatio < 1,
      'efficiency vs dollar MFE should be < 1 when exit below peak'
    );
  });

  await withTempDataDir(async () => {
    const tls = loadLifecycleFresh();
    const tg = 'tg_partial';
    tls.notifyBuyFilled({
      tradeGroupId: tg,
      symbol: 'EURUSD',
      fillPrice: 100,
      avgPrice: 100,
      quantity: 0.03,
    });
    let r = tls.notifySellFill({
      tradeGroupId: tg,
      symbol: 'EURUSD',
      exitPrice: 101,
      pnl: 0.01,
      newOpenQuantity: 0.02,
      exitTimestamp: '2026-04-07T10:00:00.000Z',
    });
    assert.strictEqual(r.finalized, null);
    r = tls.notifySellFill({
      tradeGroupId: tg,
      symbol: 'EURUSD',
      exitPrice: 101,
      pnl: 0.01,
      newOpenQuantity: 0.01,
      exitTimestamp: '2026-04-07T10:01:00.000Z',
    });
    assert.strictEqual(r.finalized, null);
    r = tls.notifySellFill({
      tradeGroupId: tg,
      symbol: 'EURUSD',
      exitPrice: 101,
      pnl: 0.01,
      newOpenQuantity: 0,
      exitTimestamp: '2026-04-07T10:02:00.000Z',
    });
    assert.ok(r.finalized);
    assert.strictEqual(r.finalized.cumulativeRealizedPnL, 0.03);
    const journal = path.join(process.env.DATA_DIR, 'trade_lifecycles.jsonl');
    const text = await waitForFile(journal);
    assert.ok(text.includes(tg));
  });

  console.log('✅ tradeLifecycle tests passed');
}

run().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
