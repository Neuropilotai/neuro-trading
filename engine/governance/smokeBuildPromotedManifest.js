#!/usr/bin/env node
'use strict';

/**
 * Smoke: promoted manifest setup resolution (JSON + setup_*.js under generated_strategies).
 * Run: node engine/governance/smokeBuildPromotedManifest.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadSetupBySetupIdMap, buildPromotedManifest } = require('./buildPromotedManifest');

const longId =
  'familyexp_familyexp_mut_smoke_manifest_js_only_setupid_not_in_filename_suffix_abc123';

{
  const tmp = path.join(__dirname, '..', '..', `.tmp-smoke-promoted-manifest-${Date.now()}`);
  const gen = path.join(tmp, 'generated_strategies');
  fs.mkdirSync(gen, { recursive: true });
  const jsBody = `'use strict';
module.exports = {
  setupId: ${JSON.stringify(longId)},
  name: 'name_is_not_used_when_setupId_present',
  source: 'familyexp_smoke',
  rules: { direction: 'long', smokeFlag: true }
};
`;
  fs.writeFileSync(path.join(gen, 'setup_familyexp_001.js'), jsBody, 'utf8');
  const map = loadSetupBySetupIdMap(gen);
  const row = map.get(longId);
  assert.ok(row, 'loadSetupBySetupIdMap should index setup_*.js by module.setupId');
  assert.strictEqual(row.rules && row.rules.smokeFlag, true);
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = path.join(__dirname, '..', '..', `.tmp-smoke-promoted-manifest-${Date.now()}`);
  const gen = path.join(tmp, 'generated_strategies');
  const disc = path.join(tmp, 'discovery');
  fs.mkdirSync(gen, { recursive: true });
  fs.mkdirSync(disc, { recursive: true });
  fs.writeFileSync(
    path.join(disc, 'promoted_children.json'),
    JSON.stringify({
      strategies: [
        {
          setupId: 'definitely_missing_setup_xyz',
          rules: { a: 1 },
        },
      ],
    }),
    'utf8'
  );
  const prev = process.env.NEUROPILOT_WAVE1_SYMBOLS;
  process.env.NEUROPILOT_WAVE1_SYMBOLS = 'BTCUSDT';
  try {
    const r = buildPromotedManifest({
      dataRoot: tmp,
      discoveryDir: disc,
      generatedDir: gen,
      write: false,
    });
    const row = r.skipped.find((s) => s.reasonCode === 'SETUP_FILE_NOT_FOUND');
    assert.ok(row, 'expected SETUP_FILE_NOT_FOUND skip');
    assert.ok(row.detail && typeof row.detail === 'object', 'detail should be diagnostic object');
    assert.strictEqual(row.detail.lookupSetupId, 'definitely_missing_setup_xyz');
    assert.strictEqual(row.detail.searchedRoot, path.resolve(gen));
    assert.ok(Array.isArray(row.detail.candidatePathsSample));
    assert.strictEqual(typeof row.detail.indexedSetupCount, 'number');
    assert.strictEqual(row.detail.indexedSetupCount, 0);
  } finally {
    if (prev === undefined) delete process.env.NEUROPILOT_WAVE1_SYMBOLS;
    else process.env.NEUROPILOT_WAVE1_SYMBOLS = prev;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

{
  const tmp = path.join(__dirname, '..', '..', `.tmp-smoke-promoted-manifest-${Date.now()}`);
  const gen = path.join(tmp, 'generated_strategies');
  const disc = path.join(tmp, 'discovery');
  const gov = path.join(tmp, 'governance');
  fs.mkdirSync(gen, { recursive: true });
  fs.mkdirSync(disc, { recursive: true });
  fs.mkdirSync(gov, { recursive: true });

  const setupId = 'smoke_gate_setup_bad_totalpnl';
  fs.writeFileSync(
    path.join(gen, `setup_mut_${setupId}.json`),
    JSON.stringify({
      setupId,
      rules: { direction: 'long', smokeGate: true },
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmp, 'datasets_manifest.json'),
    JSON.stringify({
      datasets: {},
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(gov, 'paper_trades_metrics_by_strategy.json'),
    JSON.stringify({
      aggregation: 'by_strategy',
      buckets: [
        {
          strategyId: setupId,
          trades: 200,
          totalPnl: -5000,
          avgPnl: -25,
          winRate: 20,
        },
      ],
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(disc, 'promoted_children.json'),
    JSON.stringify({
      strategies: [
        {
          setupId,
          rules: { direction: 'long', smokeGate: true },
        },
      ],
    }),
    'utf8'
  );

  const prev = {
    symbols: process.env.NEUROPILOT_WAVE1_SYMBOLS,
    en: process.env.NEUROPILOT_MANIFEST_PAPER_GATE_ENABLE,
    minTrades: process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TRADES,
    minTotal: process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TOTAL_PNL,
    minAvg: process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_AVG_PNL,
    minWin: process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_WIN_RATE,
  };
  process.env.NEUROPILOT_WAVE1_SYMBOLS = 'BTCUSDT';
  process.env.NEUROPILOT_MANIFEST_PAPER_GATE_ENABLE = '1';
  process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TRADES = '100';
  process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TOTAL_PNL = '-1000';
  process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_AVG_PNL = '-0.05';
  process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_WIN_RATE = '30';
  try {
    const r = buildPromotedManifest({
      dataRoot: tmp,
      discoveryDir: disc,
      generatedDir: gen,
      write: false,
    });
    assert.strictEqual(r.items.length, 0);
    const row = r.skipped.find((s) => s.reasonCode === 'PAPER_GATE_TOTAL_PNL_TOO_LOW');
    assert.ok(row, 'expected PAPER_GATE_TOTAL_PNL_TOO_LOW skip');
    assert.ok(row.detail && typeof row.detail === 'object');
    assert.strictEqual(row.detail.trades, 200);
    assert.strictEqual(row.detail.totalPnl, -5000);
    assert.ok(row.detail.thresholdsApplied && row.detail.thresholdsApplied.minTotalPnl === -1000);
    assert.ok(r.doc && r.doc.paperGate && r.doc.paperGate.enabled === true);
    assert.strictEqual(r.doc.paperGate.skippedByReason.PAPER_GATE_TOTAL_PNL_TOO_LOW, 1);
  } finally {
    if (prev.symbols === undefined) delete process.env.NEUROPILOT_WAVE1_SYMBOLS;
    else process.env.NEUROPILOT_WAVE1_SYMBOLS = prev.symbols;
    if (prev.en === undefined) delete process.env.NEUROPILOT_MANIFEST_PAPER_GATE_ENABLE;
    else process.env.NEUROPILOT_MANIFEST_PAPER_GATE_ENABLE = prev.en;
    if (prev.minTrades === undefined) delete process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TRADES;
    else process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TRADES = prev.minTrades;
    if (prev.minTotal === undefined) delete process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TOTAL_PNL;
    else process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_TOTAL_PNL = prev.minTotal;
    if (prev.minAvg === undefined) delete process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_AVG_PNL;
    else process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_AVG_PNL = prev.minAvg;
    if (prev.minWin === undefined) delete process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_WIN_RATE;
    else process.env.NEUROPILOT_MANIFEST_PAPER_GATE_MIN_WIN_RATE = prev.minWin;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('smokeBuildPromotedManifest: all passed');
