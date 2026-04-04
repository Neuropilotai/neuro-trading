#!/usr/bin/env node
'use strict';

/**
 * Smoke: Wave1 paper signal builder — AI generated setups vs example fallback.
 * Run: node engine/governance/smokeBuildPaperExecutionV1SignalsWave1.js
 *
 * Validation manuelle (DATA_ROOT réel) après rebuild:
 *   jq '[.signals[] | select((.signalSource // "") == "")] | length' "$NEUROPILOT_DATA_ROOT/governance/paper_execution_v1_signals.json"
 *   jq '.signals | map(.signalSource) | unique' "$NEUROPILOT_DATA_ROOT/governance/paper_execution_v1_signals.json"
 *   jq '[.signals[] | select((.setupId|not) or (.strategyId|not) or (.rMultiple|not) or (.direction|not))] | length' "$NEUROPILOT_DATA_ROOT/governance/paper_execution_v1_signals.json"
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeBinaryStore } = require('../datasetBinaryStore');
const riskEngine = require('../execution/executionRiskEngine');
const {
  buildWave1PaperSignalsFromGenerated,
  loadMutationSetupsFromGeneratedDir,
  runBuildWave1PaperSignalsFile,
  isExamplePaperSignal,
  loadExampleFallbackSignals,
  resolveRMultipleFromSetup,
  resolveStrategyIdFromSetup,
  normalizeHistorySignalForMerge,
  filterNormalizeHistorySignalsForMerge,
  applyMaxSignalsPerStrategyId,
  PROMOTED_MANIFEST_SIGNAL_SOURCE,
  PROMOTED_MANIFEST_INTERNAL_DEDUP_COLLISION,
} = require('./buildPaperExecutionV1SignalsWave1');

{
  const prev = process.env.NEUROPILOT_WAVE1_SYMBOLS;
  process.env.NEUROPILOT_WAVE1_SYMBOLS = 'BTCUSDT:5m,ETHUSDT:15M';
  const s = riskEngine.parseWave1SymbolSet();
  assert.ok(s.has('BTCUSDT') && s.has('ETHUSDT'));
  assert.ok(!s.has('BTCUSDT:5M'));
  if (prev === undefined) delete process.env.NEUROPILOT_WAVE1_SYMBOLS;
  else process.env.NEUROPILOT_WAVE1_SYMBOLS = prev;
}

// --- Helpers on synthetic setup (no I/O) ---
{
  const setup = {
    setupId: 'mut_smoke_open_abc',
    strategyId: '',
    rules: { session_phase: 'open', rMultiple: 1.35 },
  };
  assert.strictEqual(resolveStrategyIdFromSetup(setup), 'mut_smoke_open_abc');
  const r = resolveRMultipleFromSetup(setup, 'seed');
  assert.ok(r >= 1.2 && r <= 1.5, `rMultiple from rules: ${r}`);
}
{
  const setup = { setupId: 'mut_x', rules: {}, rMultiple: 1.22 };
  const r = resolveRMultipleFromSetup(setup, 'seed');
  assert.strictEqual(r, 1.22);
}

// --- Case 1: valid AI setup + manifest + bin → non-example signal, setup rMultiple ---
async function case1ValidAiSetup() {
  const prevSym = process.env.NEUROPILOT_WAVE1_SYMBOLS;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-wave1-smoke-'));
  const root = tmp;
  const genDir = path.join(root, 'generated_strategies');
  const dsDir = path.join(root, 'datasets', 'btcusdt');
  fs.mkdirSync(genDir, { recursive: true });
  fs.mkdirSync(dsDir, { recursive: true });

  const binRel = 'datasets/btcusdt/btcusdt_5m.bin';
  const binAbs = path.join(root, binRel);
  const candles = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 500; i++) {
    candles.push({
      time: t0 + i * 300_000,
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100,
      volume: 1,
    });
  }
  await writeBinaryStore(binAbs, { symbol: 'BTCUSDT', timeframe: '5m', candles });

  const manifest = {
    datasets: {
      BTCUSDT_5m: {
        symbol: 'BTCUSDT',
        timeframe: '5m',
        rows: 500,
        paths: { bin: binRel },
      },
    },
  };
  fs.writeFileSync(path.join(root, 'datasets_manifest.json'), JSON.stringify(manifest), 'utf8');

  const setupDoc = {
    setupId: 'mut_wave1_smoke_eligible',
    rules: { body_pct_min: 0.5, close_strength_min: 0.55, volume_ratio: 1.1 },
    rMultiple: 1.34,
  };
  fs.writeFileSync(
    path.join(genDir, 'setup_mut_wave1_smoke.json'),
    JSON.stringify(setupDoc, null, 2),
    'utf8'
  );

  try {
    process.env.NEUROPILOT_WAVE1_SYMBOLS = 'BTCUSDT';
    const { signals, audit } = buildWave1PaperSignalsFromGenerated({ dataRoot: root });
    assert.ok(signals.length >= 1, 'expected at least one AI signal');
    const s0 = signals[0];
    assert.ok(!isExamplePaperSignal(s0), 'must not be example_*');
    assert.strictEqual(s0.setupId, 'mut_wave1_smoke_eligible');
    assert.strictEqual(s0.strategyId, 'mut_wave1_smoke_eligible');
    assert.strictEqual(s0.rMultiple, 1.34);
    assert.strictEqual(s0.signalSource, 'generated_strategies');
    assert.ok(audit.generated_setups_loaded >= 1);
    assert.ok(audit.generated_setups_eligible >= 1);
  } finally {
    if (prevSym === undefined) delete process.env.NEUROPILOT_WAVE1_SYMBOLS;
    else process.env.NEUROPILOT_WAVE1_SYMBOLS = prevSym;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Case 2: invalid setup files skipped, no throw ---
function case2InvalidSkipped() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-wave1-smoke-'));
  const genDir = path.join(tmp, 'generated_strategies');
  fs.mkdirSync(genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, 'setup_mut_bad.json'), '{ not json', 'utf8');
  fs.writeFileSync(
    path.join(genDir, 'setup_mut_noid.json'),
    JSON.stringify({ rules: {} }),
    'utf8'
  );

  let threw = false;
  try {
    const r = loadMutationSetupsFromGeneratedDir(genDir, 80);
    assert.strictEqual(r.setups.length, 0);
    assert.ok(r.skippedInvalid >= 1);
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, false);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Case 3: no AI, no meta → example fallback ---
function case3FallbackExample() {
  const prevForce = process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS;
  const prevSym = process.env.NEUROPILOT_WAVE1_SYMBOLS;
  const prevFromGen = process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-wave1-smoke-'));
  try {
    fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'generated_strategies'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'discovery', 'meta_ranking.json'),
      JSON.stringify({ strategies: [] }),
      'utf8'
    );
    fs.writeFileSync(path.join(tmp, 'datasets_manifest.json'), JSON.stringify({ datasets: {} }), 'utf8');

    process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS = '1';
    process.env.NEUROPILOT_WAVE1_SYMBOLS = 'BTCUSDT';
    delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;

    const r = runBuildWave1PaperSignalsFile({ dataRoot: tmp });
    assert.strictEqual(r.ok, true);
    assert.ok(r.built >= 1);
    assert.strictEqual(r.audit.fallbackExamplesUsed, true);
    assert.strictEqual(r.audit.primarySource, 'example_fallback');
    const out = JSON.parse(
      fs.readFileSync(path.join(tmp, 'governance', 'paper_execution_v1_signals.json'), 'utf8')
    );
    assert.ok(Array.isArray(out.signals));
    assert.ok(isExamplePaperSignal(out.signals[0]));
    for (const s of out.signals) {
      assert.ok(typeof s.signalSource === 'string' && s.signalSource.length > 0);
    }
  } finally {
    if (prevForce === undefined) delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS;
    else process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS = prevForce;
    if (prevSym === undefined) delete process.env.NEUROPILOT_WAVE1_SYMBOLS;
    else process.env.NEUROPILOT_WAVE1_SYMBOLS = prevSym;
    if (prevFromGen === undefined) delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;
    else process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED = prevFromGen;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Fixture loader returns example-shaped rows ---
{
  const ex = loadExampleFallbackSignals();
  assert.ok(ex.length >= 1);
  assert.ok(isExamplePaperSignal(ex[0]));
}

// --- Legacy merge: infer signalSource or drop (no null / untraceable rows) ---
function case4LegacySourceNormalization() {
  const n1 = normalizeHistorySignalForMerge({
    setupId: 'mut_legacy_row',
    strategyId: 'EMA_pullback_v2',
    rMultiple: 1.31,
    direction: 'long',
  });
  assert.ok(n1 && n1.signal.signalSource === 'generated_strategies', n1 && n1.signal.signalSource);
  assert.strictEqual(n1.sourceInferred, true);

  const n2 = normalizeHistorySignalForMerge({
    setupId: 'pattern_meta_only',
    strategyId: 'EMA_pullback_v2',
    rMultiple: 1.31,
    direction: 'long',
  });
  assert.ok(n2 && n2.signal.signalSource === 'meta_ranking');

  assert.strictEqual(
    normalizeHistorySignalForMerge({
      setupId: 'opaque',
      strategyId: 'opaque2',
      rMultiple: 1.31,
      direction: 'long',
    }),
    null
  );

  const tagged = normalizeHistorySignalForMerge({
    setupId: 'any',
    strategyId: 'EMA_pullback_v2',
    rMultiple: 1.31,
    direction: 'long',
    signalSource: 'meta_ranking',
  });
  assert.ok(tagged && tagged.signal.signalSource === 'meta_ranking');
  assert.strictEqual(tagged.sourceInferred, false);

  const batch = filterNormalizeHistorySignalsForMerge([
    { setupId: 'same', strategyId: 'same', rMultiple: 1.22, direction: 'long', rules: { z: 1 } },
    { setupId: 'x', strategyId: 'y', rMultiple: 1.22, direction: 'long' },
  ]);
  assert.strictEqual(batch.legacy_signals_normalized, 1);
  assert.strictEqual(batch.legacy_signals_dropped_missing_source, 1);
}

function case5EmaPerStrategyCap() {
  const sigs = [
    { strategyId: 'EMA_pullback_v2', i: 1 },
    { strategyId: 'ORB_breakout_v1', i: 2 },
    { strategyId: 'EMA_pullback_v2', i: 3 },
    { strategyId: 'EMA_pullback_v2', i: 4 },
  ];
  const capped = applyMaxSignalsPerStrategyId(sigs, { EMA_pullback_v2: 1 });
  assert.strictEqual(capped.length, 2, 'keep 1 EMA + 1 ORB');
  assert.strictEqual(capped.filter((s) => s.strategyId === 'EMA_pullback_v2').length, 1);
  assert.strictEqual(capped[0].i, 1);
  assert.strictEqual(capped[1].i, 2);
}

async function writeMinimalBinAndManifest(tmp) {
  const dsDir = path.join(tmp, 'datasets', 'btcusdt');
  fs.mkdirSync(dsDir, { recursive: true });
  const binRel = 'datasets/btcusdt/btcusdt_5m.bin';
  const binAbs = path.join(tmp, binRel);
  const candles = [
    { time: Date.parse('2026-01-01T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: Date.parse('2026-01-01T00:05:00.000Z'), open: 100, high: 103, low: 99.5, close: 102, volume: 1 },
  ];
  await writeBinaryStore(binAbs, { symbol: 'BTCUSDT', timeframe: '5m', candles });
  const manifest = {
    datasets: {
      BTCUSDT_5m: {
        symbol: 'BTCUSDT',
        timeframe: '5m',
        rows: 2,
        paths: { bin: binRel },
      },
    },
  };
  fs.writeFileSync(path.join(tmp, 'datasets_manifest.json'), JSON.stringify(manifest), 'utf8');
}

/** One valid promoted_manifest item (dedupe-stable with forcedWave1). */
function manifestItemDupSmoke() {
  return {
    setupId: 'mut_promo_manifest_smoke',
    strategyId: 'mut_promo_manifest_smoke',
    rules: { a: 1 },
    datasetKey: 'BTCUSDT_5m',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    barIndex: 0,
    entryAtBarClose: true,
    stopDistance: 0.25,
    direction: 'long',
    rMultiple: 1.5,
    maxBarsHeld: 500,
  };
}

async function case6PromotedManifestValidMerge() {
  const prevForce = process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS;
  const prevSym = process.env.NEUROPILOT_WAVE1_SYMBOLS;
  const prevFromGen = process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-wave1-smoke-'));
  try {
    fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'generated_strategies'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'discovery', 'meta_ranking.json'),
      JSON.stringify({ strategies: [] }),
      'utf8'
    );
    await writeMinimalBinAndManifest(tmp);
    fs.writeFileSync(
      path.join(tmp, 'discovery', 'promoted_manifest.json'),
      JSON.stringify({
        manifestSchemaVersion: 1,
        items: [manifestItemDupSmoke()],
      }),
      'utf8'
    );

    process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS = '1';
    process.env.NEUROPILOT_WAVE1_SYMBOLS = 'BTCUSDT';
    delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;

    const r = runBuildWave1PaperSignalsFile({ dataRoot: tmp });
    assert.strictEqual(r.ok, true);
    const out = JSON.parse(
      fs.readFileSync(path.join(tmp, 'governance', 'paper_execution_v1_signals.json'), 'utf8')
    );
    assert.ok(out.promotedManifestMerge, 'promotedManifestMerge exists');
    assert.strictEqual(out.promotedManifestMerge.promotedManifestSignalsOut, 1);
    const promoted = (out.signals || []).filter(
      (s) => s && s.signalSource === PROMOTED_MANIFEST_SIGNAL_SOURCE
    );
    assert.strictEqual(promoted.length, 1);
    assert.strictEqual(promoted[0].strategyId, promoted[0].setupId);
  } finally {
    if (prevForce === undefined) delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS;
    else process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS = prevForce;
    if (prevSym === undefined) delete process.env.NEUROPILOT_WAVE1_SYMBOLS;
    else process.env.NEUROPILOT_WAVE1_SYMBOLS = prevSym;
    if (prevFromGen === undefined) delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;
    else process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED = prevFromGen;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function case7PromotedManifestInternalDedupCollision() {
  const prevForce = process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS;
  const prevSym = process.env.NEUROPILOT_WAVE1_SYMBOLS;
  const prevFromGen = process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-wave1-smoke-'));
  try {
    fs.mkdirSync(path.join(tmp, 'governance'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'generated_strategies'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'discovery'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'discovery', 'meta_ranking.json'),
      JSON.stringify({ strategies: [] }),
      'utf8'
    );
    await writeMinimalBinAndManifest(tmp);
    const dup = manifestItemDupSmoke();
    fs.writeFileSync(
      path.join(tmp, 'discovery', 'promoted_manifest.json'),
      JSON.stringify({
        manifestSchemaVersion: 1,
        items: [dup, { ...dup }],
      }),
      'utf8'
    );

    process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS = '1';
    process.env.NEUROPILOT_WAVE1_SYMBOLS = 'BTCUSDT';
    delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;

    const r = runBuildWave1PaperSignalsFile({ dataRoot: tmp });
    assert.strictEqual(r.ok, true);
    const out = JSON.parse(
      fs.readFileSync(path.join(tmp, 'governance', 'paper_execution_v1_signals.json'), 'utf8')
    );
    const promoted = (out.signals || []).filter(
      (s) => s && s.signalSource === PROMOTED_MANIFEST_SIGNAL_SOURCE
    );
    assert.strictEqual(promoted.length, 0, 'no promoted_manifest rows after internal collision');
    assert.ok(
      (out.promotedManifestMerge.mergeRejectedCount || 0) > 0,
      'mergeRejectedCount > 0'
    );
    const rej = out.promotedManifestMerge.mergeRejected || [];
    assert.ok(
      rej.some((x) => x && x.reasonCode === PROMOTED_MANIFEST_INTERNAL_DEDUP_COLLISION),
      'reasonCode PROMOTED_MANIFEST_INTERNAL_DEDUP_COLLISION'
    );
  } finally {
    if (prevForce === undefined) delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS;
    else process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS = prevForce;
    if (prevSym === undefined) delete process.env.NEUROPILOT_WAVE1_SYMBOLS;
    else process.env.NEUROPILOT_WAVE1_SYMBOLS = prevSym;
    if (prevFromGen === undefined) delete process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED;
    else process.env.NEUROPILOT_WAVE1_FORCE_SIGNALS_FROM_GENERATED = prevFromGen;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  await case1ValidAiSetup();
  case2InvalidSkipped();
  case3FallbackExample();
  case4LegacySourceNormalization();
  case5EmaPerStrategyCap();
  await case6PromotedManifestValidMerge();
  await case7PromotedManifestInternalDedupCollision();
  console.log('[smokeBuildPaperExecutionV1SignalsWave1] ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
