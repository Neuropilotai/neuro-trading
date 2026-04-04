#!/usr/bin/env node
'use strict';

/**
 * Smoke: paper_trades.jsonl lines from runPaperExecutionV1 carry cycleId + experimentId from env.
 * Uses a temp DATA_ROOT only (no TradingDrive).
 * Run: node engine/governance/smokePaperExecutionCycleIds.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { writeBinaryStore } = require('../datasetBinaryStore');
const { runPaperExecutionV1, resolvePaperExecCycleIds } = require('./runPaperExecutionV1');
const dataRoot = require('../dataRoot');

async function runCase(label, envSetup, expectCycleId, expectExperimentId) {
  const tmp = path.join(__dirname, '..', '..', `.tmp-smoke-cycle-ids-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.join(tmp, 'datasets', 'smoke'), { recursive: true });
  const binPath = path.join(tmp, 'datasets', 'smoke', 'smoke_5m.bin');
  await writeBinaryStore(binPath, {
    symbol: 'SMOKE',
    timeframe: '5m',
    candles: [
      { time: Date.parse('2026-01-01T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: Date.parse('2026-01-01T00:05:00.000Z'), open: 100, high: 103, low: 99.5, close: 102, volume: 1 },
    ],
  });
  fs.writeFileSync(
    path.join(tmp, 'datasets_manifest.json'),
    JSON.stringify({
      datasets: {
        SMOKE_5m: {
          symbol: 'SMOKE',
          timeframe: '5m',
          rows: 2,
          paths: { bin: binPath },
        },
      },
    }),
    'utf8'
  );
  fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'governance', 'paper_execution_v1_signals.json'),
    JSON.stringify({
      signals: [
        {
          datasetKey: 'SMOKE_5m',
          symbol: 'SMOKE',
          timeframe: '5m',
          barIndex: 0,
          entryPrice: 100,
          stopDistance: 1,
          direction: 'long',
          rMultiple: 2,
          strategyId: 'smoke_cycle_ids',
        },
      ],
    }),
    'utf8'
  );

  const prev = {
    NEUROPILOT_DATA_ROOT: process.env.NEUROPILOT_DATA_ROOT,
    NEUROPILOT_PAPER_EXEC_V1: process.env.NEUROPILOT_PAPER_EXEC_V1,
    NEUROPILOT_CYCLE_ID: process.env.NEUROPILOT_CYCLE_ID,
    EXPERIMENT_ID: process.env.EXPERIMENT_ID,
  };
  try {
    process.env.NEUROPILOT_DATA_ROOT = tmp;
    dataRoot.resetDataRoot();
    envSetup();
    process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';

    const ctx = resolvePaperExecCycleIds();
    assert.strictEqual(ctx.cycleId, expectCycleId, `${label} resolve cycleId`);
    assert.strictEqual(ctx.experimentId, expectExperimentId, `${label} resolve experimentId`);

    const r = runPaperExecutionV1({ dataRoot: tmp });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.appended, 1, label);

    const jsonlPath = path.join(tmp, 'governance', 'paper_trades.jsonl');
    const line = fs.readFileSync(jsonlPath, 'utf8').trim();
    const o = JSON.parse(line);
    assert.strictEqual(o.cycleId, expectCycleId, `${label} jsonl cycleId`);
    assert.strictEqual(o.experimentId, expectExperimentId, `${label} jsonl experimentId`);
    assert.ok(o.cycleId != null && String(o.cycleId).trim() !== '', `${label} cycleId non-empty`);
    assert.ok(o.experimentId != null && String(o.experimentId).trim() !== '', `${label} experimentId non-empty`);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    dataRoot.resetDataRoot();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  await runCase(
    'both-env',
    () => {
      process.env.NEUROPILOT_CYCLE_ID = 'ci_smoke_a';
      process.env.EXPERIMENT_ID = 'ei_smoke_b';
    },
    'ci_smoke_a',
    'ei_smoke_b'
  );

  await runCase(
    'experiment-only',
    () => {
      delete process.env.NEUROPILOT_CYCLE_ID;
      process.env.EXPERIMENT_ID = 'ei_only_smoke';
    },
    'ei_only_smoke',
    'ei_only_smoke'
  );

  await runCase(
    'cycle-only',
    () => {
      process.env.NEUROPILOT_CYCLE_ID = 'ci_only_smoke';
      delete process.env.EXPERIMENT_ID;
    },
    'ci_only_smoke',
    'ci_only_smoke'
  );

  await caseInvalidPromotedManifestIdentity();

  console.log('[smokePaperExecutionCycleIds] ALL OK');
}

async function caseInvalidPromotedManifestIdentity() {
  const tmp = path.join(__dirname, '..', '..', `.tmp-smoke-promo-id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(path.join(tmp, 'datasets', 'smoke'), { recursive: true });
  const binPath = path.join(tmp, 'datasets', 'smoke', 'smoke_5m.bin');
  await writeBinaryStore(binPath, {
    symbol: 'SMOKE',
    timeframe: '5m',
    candles: [
      { time: Date.parse('2026-01-01T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: Date.parse('2026-01-01T00:05:00.000Z'), open: 100, high: 103, low: 99.5, close: 102, volume: 1 },
    ],
  });
  fs.writeFileSync(
    path.join(tmp, 'datasets_manifest.json'),
    JSON.stringify({
      datasets: {
        SMOKE_5m: {
          symbol: 'SMOKE',
          timeframe: '5m',
          rows: 2,
          paths: { bin: binPath },
        },
      },
    }),
    'utf8'
  );
  fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'governance', 'paper_execution_v1_signals.json'),
    JSON.stringify({
      signals: [
        {
          datasetKey: 'SMOKE_5m',
          symbol: 'SMOKE',
          timeframe: '5m',
          barIndex: 0,
          stopDistance: 1,
          direction: 'long',
          rMultiple: 2,
          strategyId: 'promoted_mismatch_a',
          setupId: 'promoted_mismatch_b',
          signalSource: 'promoted_manifest',
        },
      ],
    }),
    'utf8'
  );

  const prev = {
    NEUROPILOT_DATA_ROOT: process.env.NEUROPILOT_DATA_ROOT,
    NEUROPILOT_PAPER_EXEC_V1: process.env.NEUROPILOT_PAPER_EXEC_V1,
    NEUROPILOT_CYCLE_ID: process.env.NEUROPILOT_CYCLE_ID,
    EXPERIMENT_ID: process.env.EXPERIMENT_ID,
  };
  const stderrLines = [];
  const origErr = console.error;
  console.error = (...args) => {
    stderrLines.push(args.map(String).join(' '));
    origErr.apply(console, args);
  };
  try {
    process.env.NEUROPILOT_DATA_ROOT = tmp;
    dataRoot.resetDataRoot();
    process.env.NEUROPILOT_PAPER_EXEC_V1 = '1';
    process.env.NEUROPILOT_CYCLE_ID = 'ci_promo_id_smoke';
    process.env.EXPERIMENT_ID = 'ei_promo_id_smoke';

    const r = runPaperExecutionV1({ dataRoot: tmp });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.appended, 0, 'invalid promoted_manifest must not append');
    assert.ok(
      stderrLines.some((line) => line.includes('promoted_manifest identity mismatch')),
      'stderr must contain promoted_manifest identity mismatch'
    );
    const jsonlPath = path.join(tmp, 'governance', 'paper_trades.jsonl');
    assert.strictEqual(fs.existsSync(jsonlPath), false, 'no trade file when nothing appended');
  } finally {
    console.error = origErr;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    dataRoot.resetDataRoot();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
