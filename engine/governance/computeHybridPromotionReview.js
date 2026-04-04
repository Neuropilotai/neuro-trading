#!/usr/bin/env node
'use strict';

/**
 * Paper-only hybrid review layer: flags strategies for reinforced human review.
 * Does NOT promote, unlock gates, or alter strict scores / tiers / promotableCount.
 *
 * Intermediate status name (rename by changing this constant only):
 */
const INTERMEDIATE_REVIEW_STATUS = 'review_candidate';
const NOT_REVIEW_STATUS = 'not_review_candidate';
const LAYER_DISABLED_STATUS = 'disabled';

/** V1 thresholds — single source; env overrides optional. */
const HYBRID_REVIEW_MIN_LEARNING_SCORE = 80;
const HYBRID_REVIEW_MIN_STRICT_SCORE = 70;
const HYBRID_REVIEW_MIN_TRADES = 100;
const HYBRID_REVIEW_REQUIRED_LEARNING_TIER = 'strong_potential';
const HYBRID_SUSPICIOUS_WARN = 'suspicious_high_win_rate_small_sample';
const HYBRID_ALLOWED_MODES = new Set(['promotion']);

function envTruthy(name) {
  const v = process.env[name];
  if (v == null || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function isHybridPromotionGloballyEnabled() {
  return envTruthy('NEUROPILOT_HYBRID_PROMOTION_ENABLE');
}

function resolveHybridReviewCriteriaFromEnv() {
  return {
    minLearningScore: envNumber('NEUROPILOT_HYBRID_REVIEW_MIN_LEARNING_SCORE', HYBRID_REVIEW_MIN_LEARNING_SCORE),
    minStrictScore: envNumber('NEUROPILOT_HYBRID_REVIEW_MIN_STRICT_SCORE', HYBRID_REVIEW_MIN_STRICT_SCORE),
    minTrades: envNumber('NEUROPILOT_HYBRID_REVIEW_MIN_TRADES', HYBRID_REVIEW_MIN_TRADES),
    requiredLearningTier: HYBRID_REVIEW_REQUIRED_LEARNING_TIER,
  };
}

function numOk(v) {
  return Number.isFinite(Number(v));
}

/**
 * @param {object} row - promotion-mode strategy_validation row
 * @param {{ globallyEnabled: boolean, criteria: object }} ctx
 */
function computeHybridPromotionForRow(row, ctx) {
  const { globallyEnabled, criteria } = ctx;
  const c = criteria && typeof criteria === 'object' ? criteria : resolveHybridReviewCriteriaFromEnv();

  const baseCriteria = {
    minLearningScore: c.minLearningScore,
    minStrictScore: c.minStrictScore,
    minTrades: c.minTrades,
    requiredLearningTier: c.requiredLearningTier,
  };

  const hardFails = Array.isArray(row.hardFails) ? row.hardFails : [];
  const warnings = Array.isArray(row.warnings) ? row.warnings : [];
  const mode = row.mode != null ? String(row.mode) : 'promotion';
  const tier = row.tier != null ? String(row.tier) : '';
  const learningTier = row.learningTier != null ? String(row.learningTier) : '';
  const trades = Number(row.trades);
  const ls = Number(row.learningScore);
  const ss = Number(row.score);
  const excludedFromRanking = row.excludedFromRanking === true;

  const modeOk = HYBRID_ALLOWED_MODES.has(mode);
  const alreadyPromotable = tier === 'promote_candidate';
  const hardFailsOk = hardFails.length === 0;
  const suspiciousWarnOk = !warnings.includes(HYBRID_SUSPICIOUS_WARN);
  const rankingOk = !excludedFromRanking;
  const learningScoreOk = numOk(ls) && ls >= c.minLearningScore;
  const strictScoreOk = numOk(ss) && ss >= c.minStrictScore;
  const tradesOk = numOk(trades) && trades >= c.minTrades;
  const learningTierOk = learningTier === c.requiredLearningTier;

  const checks = {
    layerEnabled: globallyEnabled,
    modeOk,
    learningScoreOk,
    strictScoreOk,
    tradesOk,
    hardFailsOk,
    /** true when tier is not strict promote_candidate (required for hybrid review). */
    notYetStrictPromotableOk: !alreadyPromotable,
    learningTierOk,
    suspiciousWarnOk,
    rankingOk,
  };

  if (!globallyEnabled) {
    return {
      enabled: false,
      status: LAYER_DISABLED_STATUS,
      eligible: false,
      reason: 'hybrid review layer disabled (set NEUROPILOT_HYBRID_PROMOTION_ENABLE=1 to enable)',
      criteria: baseCriteria,
      checks,
    };
  }

  if (!modeOk) {
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: `mode not eligible for hybrid review (expected promotion, got ${mode})`,
      criteria: baseCriteria,
      checks,
    };
  }

  if (alreadyPromotable) {
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: 'already strict promote_candidate — not a hybrid review target',
      criteria: baseCriteria,
      checks,
    };
  }

  if (!hardFailsOk) {
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: `hard fails present: ${hardFails.join(', ')}`,
      criteria: baseCriteria,
      checks,
    };
  }

  if (!rankingOk) {
    const er = Array.isArray(row.excludedReasons) ? row.excludedReasons.join(', ') : 'ranking exclusion';
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: `excluded from ranking (${er})`,
      criteria: baseCriteria,
      checks,
    };
  }

  if (!suspiciousWarnOk) {
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: `quality warn blocks hybrid review (${HYBRID_SUSPICIOUS_WARN})`,
      criteria: baseCriteria,
      checks,
    };
  }

  if (!learningScoreOk) {
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: `learningScore below threshold (need >= ${c.minLearningScore})`,
      criteria: baseCriteria,
      checks,
    };
  }

  if (!strictScoreOk) {
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: `strict score below hybrid review floor (need >= ${c.minStrictScore})`,
      criteria: baseCriteria,
      checks,
    };
  }

  if (!tradesOk) {
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: `insufficient trades for hybrid review (need >= ${c.minTrades})`,
      criteria: baseCriteria,
      checks,
    };
  }

  if (!learningTierOk) {
    return {
      enabled: true,
      status: NOT_REVIEW_STATUS,
      eligible: false,
      reason: `learningTier must be ${c.requiredLearningTier} (got ${learningTier || 'n/a'})`,
      criteria: baseCriteria,
      checks,
    };
  }

  return {
    enabled: true,
    status: INTERMEDIATE_REVIEW_STATUS,
    eligible: true,
    reason: 'learning strong_potential, strict near threshold, no hard fails, sample ok',
    criteria: baseCriteria,
    checks,
  };
}

function pickInsightRow(row, hp) {
  const gap =
    row.gap != null && Number.isFinite(Number(row.gap))
      ? Number(row.gap)
      : numOk(row.learningScore) && numOk(row.score)
        ? Number((Number(row.learningScore) - Number(row.score)).toFixed(4))
        : null;
  return {
    strategyId: row.strategyId != null ? String(row.strategyId) : '',
    strictScore: numOk(row.score) ? Number(row.score) : null,
    strictTier: row.tier != null ? String(row.tier) : null,
    learningScore: numOk(row.learningScore) ? Number(row.learningScore) : null,
    learningTier: row.learningTier != null ? String(row.learningTier) : null,
    gap,
    status: hp.status,
    eligible: hp.eligible === true,
    reason: hp.reason != null ? String(hp.reason) : '',
  };
}

/**
 * Mutates strategyValidation.rows[].hybridPromotion; returns payload for latest.json + audit.
 */
function enrichStrategyValidationHybridPromotion(strategyValidation, meta = {}) {
  const globallyEnabled = isHybridPromotionGloballyEnabled();
  const criteria = resolveHybridReviewCriteriaFromEnv();
  const sv = strategyValidation && typeof strategyValidation === 'object' ? strategyValidation : {};
  const rows = Array.isArray(sv.rows) ? sv.rows : [];
  const ctx = { globallyEnabled, criteria };

  const insightRows = [];
  const reviewList = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const hp = computeHybridPromotionForRow(row, ctx);
    row.hybridPromotion = hp;
    const ir = pickInsightRow(row, hp);
    insightRows.push(ir);
    if (hp.eligible && hp.status === INTERMEDIATE_REVIEW_STATUS) {
      reviewList.push({
        strategyId: ir.strategyId,
        reason: hp.reason,
        checks: hp.checks,
        strictScore: ir.strictScore,
        learningScore: ir.learningScore,
        gap: ir.gap,
      });
    }
  }

  insightRows.sort((a, b) => {
    const ld = safeNum(b.learningScore, -1e9) - safeNum(a.learningScore, -1e9);
    if (ld !== 0) return ld;
    return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
  });

  reviewList.sort((a, b) => {
    const ld = safeNum(b.learningScore, -1e9) - safeNum(a.learningScore, -1e9);
    if (ld !== 0) return ld;
    return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
  });

  const reviewCandidateCount = reviewList.length;
  const topReviewCandidate = reviewList.length ? reviewList[0].strategyId : null;

  const generatedAt = meta.generatedAt != null ? String(meta.generatedAt) : new Date().toISOString();
  const evolutionTs = meta.evolutionTs != null ? meta.evolutionTs : null;

  const hybridPromotionInsights = {
    enabled: globallyEnabled,
    globalStatus: globallyEnabled ? 'active' : 'disabled',
    summary: {
      reviewCandidateCount,
      topReviewCandidate,
      totalPromotionRows: rows.length,
      criteria: {
        minLearningScore: criteria.minLearningScore,
        minStrictScore: criteria.minStrictScore,
        minTrades: criteria.minTrades,
        requiredLearningTier: criteria.requiredLearningTier,
      },
    },
    rows: insightRows,
    generatedAt,
    evolutionTs,
  };

  const auditRecord = {
    schemaVersion: 1,
    generatedAt,
    evolutionTs,
    layerEnabled: globallyEnabled,
    intermediateStatusName: INTERMEDIATE_REVIEW_STATUS,
    criteria: hybridPromotionInsights.summary.criteria,
    summary: {
      reviewCandidateCount,
      topReviewCandidate,
      totalPromotionRows: rows.length,
    },
    reviewCandidates: reviewList,
  };

  return { hybridPromotionInsights, auditRecord };
}

function safeNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = {
  INTERMEDIATE_REVIEW_STATUS,
  NOT_REVIEW_STATUS,
  LAYER_DISABLED_STATUS,
  HYBRID_REVIEW_MIN_LEARNING_SCORE,
  HYBRID_REVIEW_MIN_STRICT_SCORE,
  HYBRID_REVIEW_MIN_TRADES,
  HYBRID_REVIEW_REQUIRED_LEARNING_TIER,
  HYBRID_SUSPICIOUS_WARN,
  isHybridPromotionGloballyEnabled,
  resolveHybridReviewCriteriaFromEnv,
  computeHybridPromotionForRow,
  enrichStrategyValidationHybridPromotion,
};
