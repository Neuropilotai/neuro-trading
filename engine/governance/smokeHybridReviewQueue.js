#!/usr/bin/env node
'use strict';

/**
 * Smoke: Hybrid Review Queue V1 (consumes hybridPromotion only).
 * Run: node engine/governance/smokeHybridReviewQueue.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const {
  buildHybridReviewQueue,
  CHECKPOINT_SOURCE_NONE,
  CHECKPOINT_SOURCE_DATA_ROOT,
  CHECKPOINT_SOURCE_OPS_SNAPSHOT,
  CHECKPOINT_SOURCE_LAYER_DISABLED,
} = require('./computeHybridReviewQueue');
const { INTERMEDIATE_REVIEW_STATUS } = require('./computeHybridPromotionReview');

const insightsOn = { enabled: true, summary: {}, rows: [] };
const insightsOff = { enabled: false, summary: {}, rows: [] };

function makeRow(sid, overrides) {
  const o = overrides || {};
  return {
    strategyId: sid,
    mode: 'promotion',
    tier: o.tier || 'watchlist',
    score: o.score ?? 74,
    learningScore: o.learningScore ?? 81,
    learningTier: 'strong_potential',
    trades: 500,
    gap: o.gap ?? 7,
    hybridPromotion: {
      enabled: true,
      status: INTERMEDIATE_REVIEW_STATUS,
      eligible: true,
      reason: 'test',
      criteria: {
        minLearningScore: 80,
        minStrictScore: 70,
        minTrades: 100,
        requiredLearningTier: 'strong_potential',
      },
    },
  };
}

function readCheckpointEntries(dataRoot) {
  const p = path.join(dataRoot, 'governance', 'hybrid_review_queue_checkpoint.json');
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(j.entries) ? j.entries : [];
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrq-seq-'));
  const gen = (i) => `2026-03-28T12:${String(i).padStart(2, '0')}:00.000Z`;

  let q = buildHybridReviewQueue({
    strategyValidation: { rows: [makeRow('EMA_pullback_v2')] },
    hybridPromotionInsights: insightsOn,
    generatedAt: gen(1),
    evolutionTs: null,
    dataRoot: tmp,
    fs,
  });
  assert.strictEqual(q.summary.total, 1);
  assert.strictEqual(q.rows[0].queueStatus, 'new');
  assert.strictEqual(q.rows[0].persistenceCount, 1);
  assert.strictEqual(q.summary.checkpointSource, CHECKPOINT_SOURCE_NONE);
  assert.strictEqual(q.summary.layerEnabled, true);
  assert.ok(q.summary.generatedAt);

  q = buildHybridReviewQueue({
    strategyValidation: { rows: [makeRow('EMA_pullback_v2')] },
    hybridPromotionInsights: insightsOn,
    generatedAt: gen(2),
    evolutionTs: null,
    dataRoot: tmp,
    fs,
  });
  assert.strictEqual(q.rows[0].queueStatus, 'persistent');
  assert.strictEqual(q.rows[0].persistenceCount, 2);
  assert.strictEqual(q.summary.checkpointSource, CHECKPOINT_SOURCE_DATA_ROOT);

  q = buildHybridReviewQueue({
    strategyValidation: { rows: [] },
    hybridPromotionInsights: insightsOn,
    generatedAt: gen(3),
    evolutionTs: null,
    dataRoot: tmp,
    fs,
  });
  assert.strictEqual(q.summary.total, 0);
  assert.strictEqual(q.dropped.length, 1);
  assert.strictEqual(q.dropped[0].strategyId, 'EMA_pullback_v2');
  assert.strictEqual(q.dropped[0].reason, 'no longer review_candidate');

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrq-off-'));
  buildHybridReviewQueue({
    strategyValidation: { rows: [makeRow('EMA_pullback_v2')] },
    hybridPromotionInsights: insightsOn,
    generatedAt: '2026-03-28T13:00:00.000Z',
    evolutionTs: null,
    dataRoot: tmp,
    fs,
  });
  const entBefore = readCheckpointEntries(tmp);
  assert.strictEqual(entBefore.length, 1);

  const qIdle = buildHybridReviewQueue({
    strategyValidation: { rows: [] },
    hybridPromotionInsights: insightsOff,
    generatedAt: '2026-03-28T13:01:00.000Z',
    evolutionTs: null,
    dataRoot: tmp,
    fs,
  });
  assert.strictEqual(qIdle.layerEnabled, false);
  assert.strictEqual(qIdle.summary.layerEnabled, false);
  assert.strictEqual(qIdle.summary.checkpointSource, CHECKPOINT_SOURCE_LAYER_DISABLED);
  assert.strictEqual(qIdle.rows.length, 0);
  assert.strictEqual(qIdle.dropped.length, 0);
  const entAfter = readCheckpointEntries(tmp);
  assert.strictEqual(entAfter.length, 1, 'checkpoint must be preserved when hybrid layer disabled');
  assert.strictEqual(entAfter[0].strategyId, 'EMA_pullback_v2');

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrq-pri-'));
  const high = makeRow('HIGH_pri', { learningScore: 90, score: 75, gap: 15 });
  const low = makeRow('LOW_pri', { learningScore: 80, score: 70, gap: 5 });
  const q = buildHybridReviewQueue({
    strategyValidation: { rows: [low, high] },
    hybridPromotionInsights: insightsOn,
    generatedAt: '2026-03-28T14:00:00.000Z',
    evolutionTs: null,
    dataRoot: tmp,
    fs,
  });
  assert.strictEqual(q.summary.topPriorityStrategyId, 'HIGH_pri');
  assert.strictEqual(q.rows[0].strategyId, 'HIGH_pri');
  assert.ok(q.rows[0].priorityScore >= q.rows[1].priorityScore);

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrq-mirror-'));
  const snap = path.join(tmp, 'snap');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(
    path.join(snap, 'hybrid_review_queue_checkpoint.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      updatedAt: '2026-03-28T10:00:00.000Z',
      entries: [
        {
          strategyId: 'MIRROR_sid',
          lastSeenAt: '2026-03-28T10:00:00.000Z',
          persistenceCount: 1,
          priorityScore: 50,
        },
      ],
    }),
    'utf8'
  );
  const q = buildHybridReviewQueue({
    strategyValidation: { rows: [makeRow('MIRROR_sid')] },
    hybridPromotionInsights: insightsOn,
    generatedAt: '2026-03-28T16:00:00.000Z',
    evolutionTs: null,
    dataRoot: path.join(tmp, 'no_gov_checkpoint'),
    opsSnapshotDir: snap,
    fs,
  });
  assert.strictEqual(q.summary.checkpointSource, CHECKPOINT_SOURCE_OPS_SNAPSHOT);

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

console.log('[smokeHybridReviewQueue] ok');
