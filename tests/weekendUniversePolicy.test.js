#!/usr/bin/env node
'use strict';

const assert = require('assert');
const weekendUniversePolicy = require('../backend/services/weekendUniversePolicy');
const dynamicUniverseManager = require('../backend/services/dynamicUniverseManager');

function run() {
  console.log('weekendUniversePolicy tests…');

  const satUtc = new Date(Date.UTC(2026, 3, 11, 15, 0, 0));
  assert.strictEqual(weekendUniversePolicy.isWeekendForUniverse(satUtc, { universeTimezone: 'UTC' }), true);

  const wedUtc = new Date(Date.UTC(2026, 3, 8, 15, 0, 0));
  assert.strictEqual(weekendUniversePolicy.isWeekendForUniverse(wedUtc, { universeTimezone: 'UTC' }), false);

  assert.strictEqual(
    weekendUniversePolicy.getTradingSchedule('BTCUSD', dynamicUniverseManager.SYMBOL_METADATA),
    '24x7'
  );
  assert.strictEqual(
    weekendUniversePolicy.getTradingSchedule('EURUSD', dynamicUniverseManager.SYMBOL_METADATA),
    'weekdays'
  );

  const eligible = [
    { symbol: 'EURUSD', totalScore: 0.9, eligible: true, decision: 'candidate' },
    { symbol: 'BTCUSD', totalScore: 0.7, eligible: true, decision: 'candidate' },
    { symbol: 'ETHUSD', totalScore: 0.65, eligible: true, decision: 'candidate' },
  ];

  const wk = weekendUniversePolicy.applyWeekendUniversePolicy(eligible, {
    config: {
      weekendPolicyEnabled: true,
      weekendOnly24x7: true,
      weekendKeepNon24x7InWatchlist: false,
      universeTimezone: 'UTC',
    },
    symbolMetadata: dynamicUniverseManager.SYMBOL_METADATA,
    now: satUtc,
    maxActive: 2,
    maxWatchlist: 1,
  });

  assert.ok(wk.weekendPolicy.active);
  assert.ok(wk.activeSymbols.includes('BTCUSD'));
  assert.ok(!wk.activeSymbols.includes('EURUSD'));
  assert.strictEqual(wk.reasonsPatch.EURUSD.includes('excluded_non_24x7_on_weekend'), true);

  const off = weekendUniversePolicy.applyWeekendUniversePolicy(eligible, {
    config: { weekendPolicyEnabled: false },
    symbolMetadata: dynamicUniverseManager.SYMBOL_METADATA,
    now: satUtc,
    maxActive: 2,
    maxWatchlist: 1,
  });
  assert.strictEqual(off.activeSymbols[0], 'EURUSD');

  const build = dynamicUniverseManager.buildDynamicUniverse({
    config: {
      maxActiveSymbols: 3,
      maxWatchlistSymbols: 1,
      baseSymbols: ['BTCUSD', 'EURUSD'],
      extraSymbols: [],
      weekendPolicyEnabled: true,
      weekendOnly24x7: true,
      universeTimezone: 'UTC',
      writeSnapshot: false,
      macroWriteSnapshot: false,
      macroEnabled: false,
    },
    now: satUtc,
  });
  assert.strictEqual(build.ok, true);
  assert.ok(build.weekendPolicy);
  assert.deepStrictEqual(build.activeSymbols, ['BTCUSD']);

  console.log('✅ weekendUniversePolicy tests passed');
}

run();
