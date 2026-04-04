#!/usr/bin/env node
'use strict';

/**
 * Mutation paper learning v1 — contract smoke (compute + artefact schema).
 * npm run test:paper-mutation-learning-smoke
 *
 * 1) Feature off: buildMutationsConfigResult(..., null) — fourth arg optional; env gate is in next-gen
 *    (NEUROPILOT_MUTATION_PAPER_LEARNING unset → no compute, no artefact write).
 * 2) Feature on + skip: temp jsonl + generated dir → skipped + stats.mappedTrades + artefact doc.
 * 3) Feature on + apply: two mutation types, enough trades → !skipped + multipliers + artefact doc.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  computePaperMutationLearning,
  buildMutationPaperLearningArtifactDoc,
  normalizeStrategyIdentityKey,
  buildGeneratedStrategyAliasIndex,
  resolvePaperTradeToGeneratedStrategy,
} = require('./paperMutationLearning');
const { buildMutationsConfigResult } = require('./buildNextGenerationFromChampions');

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function trade(strategyId, pnl) {
  return {
    paperExecutionSchemaVersion: '1.0.0',
    strategyId,
    pnl,
  };
}

// --- (1) Fourth argument optional; null = no paper-driven profile adjust ---
{
  const mutRes = buildMutationsConfigResult(
    { setupId: 'smoke_parent', momentumMetaScore: 0.5 },
    'smoke_parent',
    null,
    null
  );
  assert.ok(Array.isArray(mutRes.mutations));
  assert.ok(mutRes.mutations.length >= 1);
}

// --- stats.mappedTrades always numeric; stable skip shape (no root mappedTrades) ---
{
  const r = computePaperMutationLearning({ dataRoot: null });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.stats.mappedTrades, 0);
  assert.strictEqual(typeof r.multipliers, 'object');
  assert.strictEqual(r.minMul, 0.8);
  assert.strictEqual(r.maxMul, 1.35);
  assert.ok(r.generatedAt);
  const doc = buildMutationPaperLearningArtifactDoc(r);
  assert.strictEqual(doc.skipped, true);
  assert.strictEqual(doc.applied, false);
  assert.strictEqual(doc.stats.mappedTrades, 0);
  assert.strictEqual(doc.minMul, 0.8);
  assert.strictEqual(doc.maxMul, 1.35);
  assert.deepStrictEqual(doc.multipliers, {});
  assert.strictEqual(r.stats.unmappedTrades, 0);
  assert.strictEqual(r.stats.ambiguousTrades, 0);
  assert.strictEqual(r.stats.conflictingIdentityTrades, 0);
}

// --- skip: enough trades, zero mapping ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pml-skip-'));
  const governanceDir = path.join(dir, 'governance');
  const generatedDir = path.join(dir, 'generated_strategies');
  fs.mkdirSync(governanceDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });

  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push(line(trade(`unmapped_strategy_${i}`, i % 3 === 0 ? -0.5 : 0.5)));
  }
  fs.writeFileSync(path.join(governanceDir, 'paper_trades.jsonl'), rows.join(''), 'utf8');

  const prevMin = process.env.MUTATION_PAPER_LEARNING_MIN_TRADES;
  process.env.MUTATION_PAPER_LEARNING_MIN_TRADES = '20';
  try {
    const r = computePaperMutationLearning({
      dataRoot: dir,
      governanceDir,
      generatedDir,
    });
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.reason, 'insufficient_mapped_trades');
    assert.strictEqual(r.stats.mappedTrades, 0);
    assert.strictEqual(r.stats.unmappedTrades, 25);
    assert.strictEqual(r.tradeCount, 25);
    assert.ok(r.minPerType != null);
    const doc = buildMutationPaperLearningArtifactDoc(r);
    assert.strictEqual(doc.skipped, true);
    assert.strictEqual(doc.applied, false);
    assert.strictEqual(doc.reason, 'insufficient_mapped_trades');
    assert.strictEqual(doc.stats.mappedTrades, 0);
    assert.strictEqual(doc.tradeCount, 25);
    assert.strictEqual(doc.minMul, r.minMul);
    assert.strictEqual(doc.maxMul, r.maxMul);
    assert.deepStrictEqual(doc.multipliers, {});
  } finally {
    if (prevMin === undefined) delete process.env.MUTATION_PAPER_LEARNING_MIN_TRADES;
    else process.env.MUTATION_PAPER_LEARNING_MIN_TRADES = prevMin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- apply: two types, mapped trades meet thresholds ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pml-ok-'));
  const governanceDir = path.join(dir, 'governance');
  const generatedDir = path.join(dir, 'generated_strategies');
  fs.mkdirSync(governanceDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });

  fs.writeFileSync(
    path.join(generatedDir, 'setup_mut_sid_regime.json'),
    JSON.stringify({
      setupId: 'sid_regime',
      mutationType: 'regime_flip',
      rules: { regime: 'trend' },
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(generatedDir, 'setup_mut_sid_session.json'),
    JSON.stringify({
      setupId: 'sid_session',
      mutationType: 'session_flip',
      rules: { session_phase: 'open' },
    }),
    'utf8'
  );

  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push(line(trade('sid_regime', 0.2)));
  }
  for (let i = 0; i < 12; i++) {
    rows.push(line(trade('sid_session', -0.1)));
  }
  fs.writeFileSync(path.join(governanceDir, 'paper_trades.jsonl'), rows.join(''), 'utf8');

  const prevMin = process.env.MUTATION_PAPER_LEARNING_MIN_TRADES;
  const prevPer = process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE;
  process.env.MUTATION_PAPER_LEARNING_MIN_TRADES = '20';
  process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE = '3';
  try {
    const r = computePaperMutationLearning({
      dataRoot: dir,
      governanceDir,
      generatedDir,
    });
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.reason, null);
    assert.strictEqual(r.stats.mappedTrades, 24);
    const mbSum = Object.values(r.stats.matchedBy).reduce((a, b) => a + b, 0);
    assert.strictEqual(mbSum, 24);
    assert.ok(r.multipliers);
    assert.strictEqual(typeof r.multipliers.regime_flip, 'number');
    assert.strictEqual(typeof r.multipliers.session_flip, 'number');
    const doc = buildMutationPaperLearningArtifactDoc(r);
    assert.strictEqual(doc.skipped, false);
    assert.strictEqual(doc.applied, true);
    assert.strictEqual(doc.stats.mappedTrades, 24);
    assert.ok(doc.multipliers);
  } finally {
    if (prevMin === undefined) delete process.env.MUTATION_PAPER_LEARNING_MIN_TRADES;
    else process.env.MUTATION_PAPER_LEARNING_MIN_TRADES = prevMin;
    if (prevPer === undefined) delete process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE;
    else process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE = prevPer;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- next-gen does not write artefact on compute throw; defensive skip doc still stable ---
{
  const doc = buildMutationPaperLearningArtifactDoc({
    skipped: true,
    reason: 'insufficient_mapped_trades',
    generatedAt: '2026-01-01T00:00:00.000Z',
    tradeCount: 25,
    minTotal: 20,
    minPerType: 3,
    minMul: 0.8,
    maxMul: 1.35,
    multipliers: {},
    stats: { mappedTrades: 0 },
  });
  assert.strictEqual(doc.reason, 'insufficient_mapped_trades');
  assert.strictEqual(doc.minMul, 0.8);
  assert.strictEqual(doc.maxMul, 1.35);
}

// --- Identity index: setupId / strategyId / basename / name / ambiguity / conflict ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pml-id-'));
  const gen = path.join(dir, 'generated_strategies');
  fs.mkdirSync(gen, { recursive: true });

  fs.writeFileSync(
    path.join(gen, 'setup_mut_canon_base.json'),
    JSON.stringify({
      setupId: 'mut_canon_base',
      mutationType: 'parameter_jitter',
      rules: {},
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(gen, 'setup_mut_internal_only.json'),
    JSON.stringify({
      setupId: 'internal_xyz',
      mutationType: 'session_flip',
      rules: {},
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(gen, 'setup_mut_byname.json'),
    JSON.stringify({
      setupId: 'sid_byname',
      name: 'Unique Smoke Name',
      mutationType: 'regime_flip',
      rules: {},
    }),
    'utf8'
  );

  const idx = buildGeneratedStrategyAliasIndex(gen);

  const r1 = resolvePaperTradeToGeneratedStrategy(
    { setupId: 'mut_canon_base', pnl: 0 },
    idx
  );
  assert.strictEqual(r1.mutationType, 'parameter_jitter');
  assert.strictEqual(r1.conflict, false);

  const r2 = resolvePaperTradeToGeneratedStrategy(
    { strategyId: 'mut_canon_base', pnl: 0 },
    idx
  );
  assert.strictEqual(r2.mutationType, 'parameter_jitter');

  const r3 = resolvePaperTradeToGeneratedStrategy(
    { strategyId: 'internal_only', pnl: 0 },
    idx
  );
  assert.strictEqual(r3.mutationType, 'session_flip');

  const r4 = resolvePaperTradeToGeneratedStrategy(
    { name: 'unique smoke name', pnl: 0 },
    idx
  );
  assert.strictEqual(r4.mutationType, 'regime_flip');

  fs.writeFileSync(
    path.join(gen, 'setup_mut_dup_a.json'),
    JSON.stringify({
      setupId: 'dup_a',
      name: 'SharedAlias',
      mutationType: 'forced_family_shift',
      rules: {},
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(gen, 'setup_mut_dup_b.json'),
    JSON.stringify({
      setupId: 'dup_b',
      name: 'SharedAlias',
      mutationType: 'parameter_jitter',
      rules: {},
    }),
    'utf8'
  );
  const idxAmb = buildGeneratedStrategyAliasIndex(gen);
  const r5 = resolvePaperTradeToGeneratedStrategy({ name: 'SharedAlias', pnl: 0 }, idxAmb);
  assert.strictEqual(r5.mutationType, null);
  assert.strictEqual(r5.sawAmbiguous, true);

  const idx2 = buildGeneratedStrategyAliasIndex(gen);
  const r6 = resolvePaperTradeToGeneratedStrategy(
    { setupId: 'mut_canon_base', strategyId: 'internal_xyz', pnl: 0 },
    idx2
  );
  assert.strictEqual(r6.mutationType, null);
  assert.strictEqual(r6.conflict, true);

  assert.strictEqual(normalizeStrategyIdentityKey('  Foo.JSON  '), 'foo');

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Positive expectancy floor boost (n >= min confidence, controlled by maxMul) ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pml-boost-'));
  const governanceDir = path.join(dir, 'governance');
  const generatedDir = path.join(dir, 'generated_strategies');
  fs.mkdirSync(governanceDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });

  fs.writeFileSync(
    path.join(generatedDir, 'setup_mut_sid_regime.json'),
    JSON.stringify({
      setupId: 'sid_regime',
      mutationType: 'regime_flip',
      rules: {},
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(generatedDir, 'setup_mut_sid_session.json'),
    JSON.stringify({
      setupId: 'sid_session',
      mutationType: 'session_flip',
      rules: {},
    }),
    'utf8'
  );

  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(line(trade('sid_regime', 0.01)));
  for (let i = 0; i < 25; i++) rows.push(line(trade('sid_session', 0.02)));
  fs.writeFileSync(path.join(governanceDir, 'paper_trades.jsonl'), rows.join(''), 'utf8');

  const prevMin = process.env.MUTATION_PAPER_LEARNING_MIN_TRADES;
  const prevPer = process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE;
  const prevConf = process.env.NEUROPILOT_PAPER_LOSS_MIN_TRADES_CONFIDENCE;
  process.env.MUTATION_PAPER_LEARNING_MIN_TRADES = '20';
  process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE = '3';
  process.env.NEUROPILOT_PAPER_LOSS_MIN_TRADES_CONFIDENCE = '20';
  try {
    const r = computePaperMutationLearning({
      dataRoot: dir,
      governanceDir,
      generatedDir,
    });
    assert.strictEqual(r.skipped, false);
    assert.ok(r.multipliers.regime_flip >= 1.05 - 1e-9);
    assert.ok(r.multipliers.session_flip > r.multipliers.regime_flip);
  } finally {
    if (prevMin === undefined) delete process.env.MUTATION_PAPER_LEARNING_MIN_TRADES;
    else process.env.MUTATION_PAPER_LEARNING_MIN_TRADES = prevMin;
    if (prevPer === undefined) delete process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE;
    else process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE = prevPer;
    if (prevConf === undefined) delete process.env.NEUROPILOT_PAPER_LOSS_MIN_TRADES_CONFIDENCE;
    else process.env.NEUROPILOT_PAPER_LOSS_MIN_TRADES_CONFIDENCE = prevConf;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Loss patterns (opt-in): negative expectancy + n threshold → multiplier damped, clamped to <= 1 ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pml-losspat-'));
  const governanceDir = path.join(dir, 'governance');
  const generatedDir = path.join(dir, 'generated_strategies');
  fs.mkdirSync(governanceDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });

  fs.writeFileSync(
    path.join(generatedDir, 'setup_mut_sid_regime.json'),
    JSON.stringify({
      setupId: 'sid_regime',
      mutationType: 'regime_flip',
      rules: {},
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(generatedDir, 'setup_mut_sid_session.json'),
    JSON.stringify({
      setupId: 'sid_session',
      mutationType: 'session_flip',
      rules: {},
    }),
    'utf8'
  );

  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(line(trade('sid_regime', -0.1)));
  for (let i = 0; i < 25; i++) rows.push(line(trade('sid_session', -0.2)));
  fs.writeFileSync(path.join(governanceDir, 'paper_trades.jsonl'), rows.join(''), 'utf8');

  const prevMin = process.env.MUTATION_PAPER_LEARNING_MIN_TRADES;
  const prevPer = process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE;
  const prevLoss = process.env.NEUROPILOT_PAPER_LOSS_PATTERNS;
  process.env.MUTATION_PAPER_LEARNING_MIN_TRADES = '20';
  process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE = '3';
  process.env.NEUROPILOT_PAPER_LOSS_PATTERNS = '1';
  try {
    const r = computePaperMutationLearning({
      dataRoot: dir,
      governanceDir,
      generatedDir,
    });
    assert.strictEqual(r.skipped, false);
    assert.ok(r.stats.paperLossPatterns && r.stats.paperLossPatterns.applied === true);
    assert.ok(r.multipliers.regime_flip < 1);
    assert.ok(r.multipliers.session_flip < 1);
  } finally {
    if (prevMin === undefined) delete process.env.MUTATION_PAPER_LEARNING_MIN_TRADES;
    else process.env.MUTATION_PAPER_LEARNING_MIN_TRADES = prevMin;
    if (prevPer === undefined) delete process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE;
    else process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE = prevPer;
    if (prevLoss === undefined) delete process.env.NEUROPILOT_PAPER_LOSS_PATTERNS;
    else process.env.NEUROPILOT_PAPER_LOSS_PATTERNS = prevLoss;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('smokePaperMutationLearning: OK');
