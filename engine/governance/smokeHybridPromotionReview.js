#!/usr/bin/env node
'use strict';

/**
 * Smoke: hybrid promotion review layer (paper-only observability).
 * Run: node engine/governance/smokeHybridPromotionReview.js
 * With layer on for enrich integration: NEUROPILOT_HYBRID_PROMOTION_ENABLE=1 node ...
 */

const assert = require('assert');
const {
  computeHybridPromotionForRow,
  enrichStrategyValidationHybridPromotion,
  INTERMEDIATE_REVIEW_STATUS,
  NOT_REVIEW_STATUS,
  LAYER_DISABLED_STATUS,
  HYBRID_REVIEW_REQUIRED_LEARNING_TIER,
} = require('./computeHybridPromotionReview');

const V1_CRITERIA = {
  minLearningScore: 80,
  minStrictScore: 70,
  minTrades: 100,
  requiredLearningTier: HYBRID_REVIEW_REQUIRED_LEARNING_TIER,
};

const emaLike = {
  strategyId: 'EMA_pullback_v2',
  mode: 'promotion',
  tier: 'watchlist',
  score: 74,
  learningScore: 81,
  learningTier: 'strong_potential',
  trades: 1397,
  hardFails: [],
  warnings: [],
  excludedFromRanking: false,
  gap: 7,
};

const orbLike = {
  strategyId: 'ORB_breakout_v1',
  mode: 'promotion',
  tier: 'watchlist',
  score: 56,
  learningScore: 66,
  learningTier: 'moderate_potential',
  trades: 17,
  hardFails: [],
  warnings: [],
  excludedFromRanking: false,
};

const ctxOn = { globallyEnabled: true, criteria: V1_CRITERIA };
const ctxOff = { globallyEnabled: false, criteria: V1_CRITERIA };

{
  const hp = computeHybridPromotionForRow(emaLike, ctxOn);
  assert.strictEqual(hp.status, INTERMEDIATE_REVIEW_STATUS);
  assert.strictEqual(hp.eligible, true);
  assert.strictEqual(hp.enabled, true);
}

{
  const hp = computeHybridPromotionForRow(orbLike, ctxOn);
  assert.strictEqual(hp.eligible, false);
  assert.strictEqual(hp.status, NOT_REVIEW_STATUS);
  assert.ok(
    hp.reason.includes('trades') ||
      hp.reason.includes('learningTier') ||
      hp.reason.includes('learningScore'),
    `ORB-like reason should cite sample/learning gate: ${hp.reason}`
  );
}

{
  const hp = computeHybridPromotionForRow({ ...emaLike, tier: 'promote_candidate' }, ctxOn);
  assert.strictEqual(hp.eligible, false);
  assert.strictEqual(hp.status, NOT_REVIEW_STATUS);
  assert.ok(String(hp.reason).includes('promote_candidate'), hp.reason);
}

{
  const hp = computeHybridPromotionForRow({ ...emaLike, hardFails: ['too_few_trades_hard'] }, ctxOn);
  assert.strictEqual(hp.eligible, false);
  assert.ok(String(hp.reason).includes('hard fail'), hp.reason);
}

{
  const hp = computeHybridPromotionForRow(emaLike, ctxOff);
  assert.strictEqual(hp.status, LAYER_DISABLED_STATUS);
  assert.strictEqual(hp.eligible, false);
}

{
  const hp = computeHybridPromotionForRow(
    { ...emaLike, warnings: ['suspicious_high_win_rate_small_sample'] },
    ctxOn
  );
  assert.strictEqual(hp.eligible, false);
  assert.ok(String(hp.reason).includes('suspicious'), hp.reason);
}

{
  const hp = computeHybridPromotionForRow({ ...emaLike, excludedFromRanking: true, excludedReasons: ['x'] }, ctxOn);
  assert.strictEqual(hp.eligible, false);
  assert.ok(String(hp.reason).includes('ranking'), hp.reason);
}

const origEnable = process.env.NEUROPILOT_HYBRID_PROMOTION_ENABLE;
try {
  process.env.NEUROPILOT_HYBRID_PROMOTION_ENABLE = '1';
  const sv = { rows: [{ ...emaLike }] };
  const { hybridPromotionInsights } = enrichStrategyValidationHybridPromotion(sv, {
    generatedAt: '2026-01-01T00:00:00.000Z',
    evolutionTs: 'test-ts',
  });
  assert.strictEqual(hybridPromotionInsights.enabled, true);
  assert.strictEqual(hybridPromotionInsights.summary.reviewCandidateCount, 1);
  assert.strictEqual(hybridPromotionInsights.summary.topReviewCandidate, 'EMA_pullback_v2');
  assert.strictEqual(sv.rows[0].hybridPromotion.status, INTERMEDIATE_REVIEW_STATUS);
} finally {
  if (origEnable === undefined) delete process.env.NEUROPILOT_HYBRID_PROMOTION_ENABLE;
  else process.env.NEUROPILOT_HYBRID_PROMOTION_ENABLE = origEnable;
}

try {
  delete process.env.NEUROPILOT_HYBRID_PROMOTION_ENABLE;
  const sv2 = { rows: [{ ...emaLike }] };
  const { hybridPromotionInsights: hi2 } = enrichStrategyValidationHybridPromotion(sv2, {});
  assert.strictEqual(hi2.enabled, false);
  assert.strictEqual(hi2.summary.reviewCandidateCount, 0);
  assert.strictEqual(sv2.rows[0].hybridPromotion.status, LAYER_DISABLED_STATUS);
} finally {
  if (origEnable === undefined) delete process.env.NEUROPILOT_HYBRID_PROMOTION_ENABLE;
  else process.env.NEUROPILOT_HYBRID_PROMOTION_ENABLE = origEnable;
}

console.log('[smokeHybridPromotionReview] ok');
