#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { evaluatePreTradeRisk } = require('./preTradeRiskEngine');

function baseIntent(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    action: 'BUY',
    quantity: 1,
    price: 100,
    stopLoss: 98,
    takeProfit: 104,
    setupId: 'ORB_breakout_v1',
    ...overrides,
  };
}

function baseCtx(overrides = {}) {
  return {
    equity: 10000,
    openPositionsCount: 0,
    tradesTodayTotal: 0,
    dailyRealizedPnl: 0,
    dailyUnrealizedPnl: 0,
    openCountByStrategy: {},
    openCountBySymbol: {},
    notionalExposureByAssetClass: {},
    ...overrides,
  };
}

const envBase = {
  NEUROPILOT_PRETRADE_MAX_RISK_PER_TRADE_PCT: '5',
  NEUROPILOT_PRETRADE_MAX_NOTIONAL: '1000000',
  NEUROPILOT_PRETRADE_MAX_CONCURRENT_POSITIONS: '20',
  NEUROPILOT_PRETRADE_MIN_STOP_DISTANCE_PCT: '0.05',
};

function run() {
  const r1 = evaluatePreTradeRisk(baseIntent(), baseCtx(), envBase);
  assert.strictEqual(r1.accepted, true);
  assert.ok(r1.sizingDecision && r1.sizingDecision.notional === 100);
  console.log('[smokePreTradeRiskEngine] valid sizing OK');

  const r2 = evaluatePreTradeRisk(
    baseIntent({ stopLoss: null }),
    baseCtx(),
    envBase
  );
  assert.strictEqual(r2.accepted, false);
  assert.ok(r2.violations.some((v) => v.includes('stop')));
  console.log('[smokePreTradeRiskEngine] reject no stop OK');

  const r3 = evaluatePreTradeRisk(
    baseIntent(),
    baseCtx({ openPositionsCount: 100 }),
    { ...envBase, NEUROPILOT_PRETRADE_MAX_CONCURRENT_POSITIONS: '2' }
  );
  assert.strictEqual(r3.accepted, false);
  assert.ok(r3.violations.some((v) => v.includes('concurrent')));
  console.log('[smokePreTradeRiskEngine] reject max concurrent OK');

  const r4 = evaluatePreTradeRisk(
    baseIntent(),
    baseCtx({ dailyRealizedPnl: -800, dailyUnrealizedPnl: 0 }),
    { ...envBase, NEUROPILOT_PRETRADE_MAX_DAILY_DRAWDOWN_PCT: '5' }
  );
  assert.strictEqual(r4.accepted, false);
  assert.ok(r4.violations.some((v) => v.includes('drawdown')));
  console.log('[smokePreTradeRiskEngine] reject daily loss OK');

  const now = Date.now();
  const cooldownEnv = {
    ...envBase,
    NEUROPILOT_PRETRADE_COOLDOWN_MS_STRATEGY: '3600000',
    NEUROPILOT_PRETRADE_COOLDOWN_MS_SYMBOL: '3600000',
  };

  const r5 = evaluatePreTradeRisk(
    baseIntent({ setupId: 'COOL_STRAT_A' }),
    baseCtx({
      lastTradeTsByStrategy: { COOL_STRAT_A: now },
    }),
    cooldownEnv
  );
  assert.strictEqual(r5.accepted, false);
  assert.ok(r5.violations.some((v) => v.startsWith('strategy_cooldown_active:COOL_STRAT_A')));
  console.log('[smokePreTradeRiskEngine] strategy cooldown keyed by strategyId OK');

  const r6 = evaluatePreTradeRisk(
    baseIntent({ setupId: 'COOL_STRAT_B' }),
    baseCtx({
      lastTradeTsByStrategy: { COOL_STRAT_A: now },
    }),
    cooldownEnv
  );
  assert.strictEqual(r6.accepted, true);
  console.log('[smokePreTradeRiskEngine] other strategy not affected by cooldown map OK');

  const r7 = evaluatePreTradeRisk(
    baseIntent({ setupId: 'sym_cool', symbol: 'ADAUSDT' }),
    baseCtx({
      lastTradeTsBySymbol: { ADAUSDT: now },
    }),
    cooldownEnv
  );
  assert.strictEqual(r7.accepted, false);
  assert.ok(r7.violations.some((v) => v.startsWith('symbol_cooldown_active:ADAUSDT')));
  console.log('[smokePreTradeRiskEngine] symbol cooldown keyed by uppercase symbol OK');

  const r8 = evaluatePreTradeRisk(
    baseIntent({ setupId: 'sym_cool2', symbol: 'DOTUSDT' }),
    baseCtx({
      lastTradeTsBySymbol: { ADAUSDT: now },
    }),
    cooldownEnv
  );
  assert.strictEqual(r8.accepted, true);
  console.log('[smokePreTradeRiskEngine] other symbol not affected by cooldown map OK');

  console.log('[smokePreTradeRiskEngine] ALL OK');
}

run();
