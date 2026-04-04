#!/usr/bin/env node
'use strict';

/**
 * V1.1 smoke: TRADING_ENABLED is evaluated at call time on the same riskEngine singleton.
 * Do not re-require riskEngine between the 0 → 1 → 0 steps.
 *
 * Only TRADING_ENABLED is runtime; other RiskEngine env fields stay snapshot at module load.
 * ENABLE_RISK_ENGINE must be true at first require so validateOrder exercises the kill switch path.
 */

const assert = require('assert');

const prevEnable = process.env.ENABLE_RISK_ENGINE;
process.env.ENABLE_RISK_ENGINE = 'true';

const riskEngine = require('./riskEngine');

const minimalOrder = {
  symbol: 'SMOKE_SYM',
  action: 'BUY',
  quantity: 1,
  price: 100,
  stopLoss: 99,
  takeProfit: 101,
};

async function main() {
  const prev = process.env.TRADING_ENABLED;

  try {
    assert.strictEqual(riskEngine.enabled, true, 'smoke expects ENABLE_RISK_ENGINE=true at load');

    process.env.TRADING_ENABLED = '0';
    assert.strictEqual(riskEngine.isTradingEnabled(), false);
    let v = await riskEngine.validateOrder(minimalOrder, 100000);
    assert.strictEqual(v.allowed, false, 'validateOrder must block when TRADING_ENABLED off');

    process.env.TRADING_ENABLED = '1';
    assert.strictEqual(riskEngine.isTradingEnabled(), true);
    v = await riskEngine.validateOrder(minimalOrder, 100000);
    assert.strictEqual(v.allowed, true, 'validateOrder must allow minimal order when TRADING_ENABLED on');

    process.env.TRADING_ENABLED = '0';
    assert.strictEqual(riskEngine.isTradingEnabled(), false);
    v = await riskEngine.validateOrder(minimalOrder, 100000);
    assert.strictEqual(v.allowed, false, 'validateOrder must block again after TRADING_ENABLED turned off');

    const stats = riskEngine.getStats();
    assert.strictEqual(stats.tradingEnabled, false);

    console.log('[smokeRiskEngineTradingEnabledRuntime] ALL OK');
  } finally {
    if (prev === undefined) delete process.env.TRADING_ENABLED;
    else process.env.TRADING_ENABLED = prev;
    if (prevEnable === undefined) delete process.env.ENABLE_RISK_ENGINE;
    else process.env.ENABLE_RISK_ENGINE = prevEnable;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
