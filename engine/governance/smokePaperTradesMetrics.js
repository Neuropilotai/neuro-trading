#!/usr/bin/env node
'use strict';

/**
 * Smoke: paper trades metrics aggregation.
 * Run: node engine/governance/smokePaperTradesMetrics.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  computePaperTradesMetricsFromJsonlContent,
  computePaperTradesMetricsFromJsonlFile,
} = require('./computePaperTradesMetrics');

// Two trades for alpha: single-trade 100% win triggers promotion-mode
// excludedFromRanking (suspicious_high_win_rate_small_sample).
const line1 = JSON.stringify({
  paperExecutionSchemaVersion: '1.0.0',
  strategyId: 'ptm_smoke_alpha',
  reason: 'target',
  pnl: 2,
  exitTs: '2026-01-02T00:00:00.000Z',
  ts: '2026-01-02T00:00:00.000Z',
});
const line1b = JSON.stringify({
  paperExecutionSchemaVersion: '1.0.0',
  strategyId: 'ptm_smoke_alpha',
  reason: 'stop',
  pnl: -1,
  exitTs: '2026-01-02T01:00:00.000Z',
});
const line2 = JSON.stringify({
  paperExecutionSchemaVersion: '1.0.0',
  strategyId: 'ptm_smoke_beta',
  reason: 'stop',
  pnl: -1,
  exitTs: '2026-01-03T00:00:00.000Z',
});
const line3 = JSON.stringify({
  paperExecutionSchemaVersion: '1.0.0',
  strategyId: 'ptm_smoke_gamma',
  reason: 'time',
  pnl: 0,
  exitTs: '2026-01-04T00:00:00.000Z',
});

{
  const m = computePaperTradesMetricsFromJsonlContent([line1, line1b, line2, line3].join('\n'), {
    sourceJsonl: '/tmp/x.jsonl',
  });
  assert.strictEqual(m.validTradeCount, 4);
  assert.strictEqual(m.wins, 1);
  assert.strictEqual(m.losses, 2);
  assert.strictEqual(m.breakeven, 1);
  assert.strictEqual(m.winRate, 25);
  assert.strictEqual(m.totalPnl, 0);
  assert.strictEqual(m.byReason.target, 1);
  assert.strictEqual(m.byReason.stop, 2);
  assert.strictEqual(m.byReason.time, 1);
  assert.strictEqual(m.lastTradeTs, '2026-01-04T00:00:00.000Z');
  assert.strictEqual(m.status, 'ok');
}

{
  // Use line1b + line2: single-trade 100% win (line1 alone) is excluded from valid ops metrics.
  const bad = line1b + '\nnot json\n' + line2;
  const m = computePaperTradesMetricsFromJsonlContent(bad, {});
  assert.strictEqual(m.parseErrors, 1);
  assert.strictEqual(m.validTradeCount, 2);
  assert.strictEqual(m.status, 'has_parse_errors');
}

{
  const dir = path.join(__dirname, '..', '..', `.tmp-smoke-ptm-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'paper_trades.jsonl');
  fs.writeFileSync(fp, '', 'utf8');
  const m = computePaperTradesMetricsFromJsonlFile(fp);
  assert.strictEqual(m.sourceExists, true);
  assert.strictEqual(m.status, 'no_valid_trades');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('smokePaperTradesMetrics: all passed');
