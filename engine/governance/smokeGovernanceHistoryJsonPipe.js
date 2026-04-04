#!/usr/bin/env node
'use strict';

/**
 * Ensures `npm run --silent … -- --json` yields parseable JSON on stdout (no npm banner).
 * Complements PAPER_TRADES_METRICS_RUNBOOK.md §9 pipe note.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.join(__dirname, '..', '..');
const tmp = path.join(os.tmpdir(), `neuropilot-npm-json-pipe-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const indexPath = path.join(tmp, 'index.jsonl');
fs.writeFileSync(
  indexPath,
  JSON.stringify({
    unixEpoch: 1,
    snapshotAtIso: '2026-01-01T00:00:00.000Z',
    dashboardVersion: 'p8-v1',
    validTradeCount: 1,
    confidence: 'low',
    bestStrategyId: 's_a',
    worstStrategyId: 's_b',
    snapshotSizeBytes: 100,
  }) + '\n',
  'utf8'
);
const abs = path.resolve(indexPath);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(
  npmCmd,
  ['run', '--silent', 'governance:history-index-condensed', '--', '--json', '--tail', '5'],
  {
    cwd: pkgRoot,
    encoding: 'utf8',
    env: { ...process.env, NEUROPILOT_GOVERNANCE_HISTORY_INDEX: abs },
  }
);
assert.strictEqual(r.status, 0, r.stderr || r.stdout || 'npm spawn failed');
const trimmed = (r.stdout || '').trim();
assert.ok(trimmed.startsWith('{'), 'npm --silent stdout must start with JSON object');
const j = JSON.parse(trimmed);
assert.strictEqual(j.meta.sourceJsonPathUsed, abs);
assert.strictEqual(j.meta.missing, false);
assert.strictEqual(j.rows.length, 1);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('smokeGovernanceHistoryJsonPipe: ok');
