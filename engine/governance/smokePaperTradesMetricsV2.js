#!/usr/bin/env node
'use strict';

/**
 * Smoke: Paper trades metrics V2 (multi-day, multi-strategy, empty).
 * Run: npm run test:paper-trades-metrics-v2-smoke
 */

const assert = require('assert');
const { computePaperTradesMetricsV2FromContent } = require('./computePaperTradesMetricsV2');

const base = (over) => ({
  paperExecutionSchemaVersion: '1.0.0',
  pnl: 1,
  reason: 'target',
  ...over,
});

// --- Multi-day (UTC) ---
{
  const lines = [
    base({
      exitTs: '2026-01-10T12:00:00.000Z',
      strategyId: 's1',
      cycleId: 'c1',
      pnl: 2,
    }),
    base({
      exitTs: '2026-01-11T15:00:00.000Z',
      strategyId: 's1',
      cycleId: 'c1',
      pnl: -1,
      reason: 'stop',
    }),
  ];
  const content = lines.map((x) => JSON.stringify(x)).join('\n');
  const { full } = computePaperTradesMetricsV2FromContent(content, { sourceJsonl: '/x', sourceFilePresent: true });
  assert.strictEqual(full.byDay.length, 2);
  const d10 = full.byDay.find((b) => b.day === '2026-01-10');
  const d11 = full.byDay.find((b) => b.day === '2026-01-11');
  assert.ok(d10 && d10.trades === 1 && d10.wins === 1);
  assert.ok(d11 && d11.trades === 1 && d11.losses === 1);
}

// --- Multi-strategy + best/worst ---
{
  const lines = [
    base({ strategyId: 'alpha', pnl: 5, exitTs: '2026-02-01T00:00:00.000Z' }),
    base({ strategyId: 'alpha', pnl: 1, exitTs: '2026-02-01T01:00:00.000Z' }),
    base({ strategyId: 'beta', pnl: -3, exitTs: '2026-02-01T02:00:00.000Z' }),
  ];
  const content = lines.map((x) => JSON.stringify(x)).join('\n');
  const { full } = computePaperTradesMetricsV2FromContent(content, { sourceFilePresent: true });
  assert.strictEqual(full.byStrategy.length, 2);
  assert.strictEqual(full.bestStrategy.strategyId, 'alpha');
  assert.strictEqual(full.worstStrategy.strategyId, 'beta');
  assert.strictEqual(full.byStrategy[0].strategyId, 'alpha');
}

// --- By cycle ---
{
  const lines = [
    base({ cycleId: 'exp_a', experimentId: 'ignored', exitTs: '2026-03-01T00:00:00.000Z' }),
    base({ experimentId: 'exp_b', exitTs: '2026-03-01T01:00:00.000Z' }),
  ];
  const content = lines.map((x) => JSON.stringify(x)).join('\n');
  const { full } = computePaperTradesMetricsV2FromContent(content, { sourceFilePresent: true });
  assert.strictEqual(full.byCycle.length, 2);
  assert.ok(full.byCycle.some((b) => b.cycleKey === 'exp_a'));
  assert.ok(full.byCycle.some((b) => b.cycleKey === 'exp_b'));
}

// --- Empty dataset ---
{
  const { full, byDayFile } = computePaperTradesMetricsV2FromContent('', {
    sourceFilePresent: false,
  });
  assert.strictEqual(full.validTradeCount, 0);
  assert.strictEqual(full.byDay.length, 0);
  assert.strictEqual(full.bestStrategy, null);
  assert.strictEqual(byDayFile.buckets.length, 0);
}

// --- Parse error line ignored for buckets but counted ---
{
  const content = `${JSON.stringify(base({ exitTs: '2026-04-01T00:00:00.000Z' }))}\nnot json\n`;
  const { full } = computePaperTradesMetricsV2FromContent(content, { sourceFilePresent: true });
  assert.strictEqual(full.parseErrors, 1);
  assert.strictEqual(full.validTradeCount, 1);
  assert.strictEqual(full.byDay.length, 1);
}

console.log('smokePaperTradesMetricsV2: all passed');
