#!/usr/bin/env node
'use strict';

/**
 * Smoke: session-aware owner freshness context (deterministic timestamps).
 * Run: node engine/governance/smokeFreshnessOwnerContext.js
 *   or: npm run test:freshness-owner-context-smoke
 */

const assert = require('assert');
const {
  inferMarketClass,
  marketSessionStateForClass,
  buildFreshnessOwnerContext,
} = require('./freshnessOwnerContext');
const { ownerStaleAgeForThreshold } = require('../execution/ownerFreshnessEffectiveAge');

// Saturday 2026-03-28 ~10:30 ET (EDT)
const WEEKEND_ET_MS = new Date('2026-03-28T14:30:00.000Z').getTime();

// Tuesday 2026-03-24 ~14:00 UTC = 10:00 ET
const TUESDAY_OPEN_MS = new Date('2026-03-24T14:00:00.000Z').getTime();

{
  assert.strictEqual(inferMarketClass('SPY', 'yahoo'), 'us_equity');
  assert.strictEqual(inferMarketClass('BTCUSDT', 'binance'), 'crypto');
  assert.strictEqual(inferMarketClass('XAUUSD', 'oanda'), 'fx_or_metal');
  assert.strictEqual(
    inferMarketClass('XAUUSD', 'yahoo'),
    'fx_or_metal',
    'XAU/XAG: fx_or_metal before provider-specific yahoo branch'
  );
  assert.strictEqual(
    inferMarketClass('GC=F', 'yahoo', 'XAUUSD_1h'),
    'fx_or_metal',
    'XAU/XAG: dataset key head wins when upstream symbol differs (Owner only)'
  );
  assert.strictEqual(
    marketSessionStateForClass(
      inferMarketClass('XAUUSD', 'yahoo', 'XAUUSD_5m'),
      WEEKEND_ET_MS
    ),
    'closed_anticipated'
  );
  const st = marketSessionStateForClass('us_equity', WEEKEND_ET_MS);
  assert.strictEqual(st, 'closed_anticipated');
  assert.strictEqual(marketSessionStateForClass('crypto', WEEKEND_ET_MS), 'open');
}

{
  const rows = [
    {
      key: 'SPY_5m',
      symbol: 'SPY',
      dataset_age_minutes: 2000,
      marketSessionState: 'closed_anticipated',
    },
    {
      key: 'QQQ_5m',
      symbol: 'QQQ',
      dataset_age_minutes: 1900,
      marketSessionState: 'closed_anticipated',
    },
  ];
  const ctx = buildFreshnessOwnerContext(rows, WEEKEND_ET_MS);
  assert.strictEqual(ctx.rawMaxDatasetAgeMinutes, 2000);
  assert.strictEqual(ctx.effectiveMaxDatasetAgeMinutesForOwner, 0);
  assert.strictEqual(ctx.staleSuppressedForClosedSession, true);
  assert.ok(ctx.staleSuppressedReason);

  const fresh = { datasets: rows, freshnessContext: ctx };
  assert.strictEqual(ownerStaleAgeForThreshold(fresh), 0);
}

{
  const rows = [
    {
      key: 'SPY_5m',
      symbol: 'SPY',
      dataset_age_minutes: 2000,
      marketSessionState: 'open',
    },
    {
      key: 'BTCUSDT_5m',
      symbol: 'BTCUSDT',
      dataset_age_minutes: 50,
      marketSessionState: 'open',
    },
  ];
  const ctx = buildFreshnessOwnerContext(rows, TUESDAY_OPEN_MS);
  assert.strictEqual(ctx.effectiveMaxDatasetAgeMinutesForOwner, 2000);
  assert.strictEqual(ctx.staleSuppressedForClosedSession, false);

  const fresh = { datasets: rows, freshnessContext: ctx };
  assert.strictEqual(ownerStaleAgeForThreshold(fresh), 2000);
}

{
  const fresh = {
    datasets: [{ dataset_age_minutes: 500, marketSessionState: 'open' }],
    freshnessContext: { effectiveMaxDatasetAgeMinutesForOwner: null },
  };
  assert.strictEqual(
    ownerStaleAgeForThreshold(fresh),
    500,
    'null effective must not coerce to 0 via Number(null); fallback raw'
  );
}

console.log('[smokeFreshnessOwnerContext] ok');
