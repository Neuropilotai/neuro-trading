#!/usr/bin/env node
'use strict';

/**
 * Hybrid Review Queue V1 — paper-only workflow ordering.
 * Consumes strategy_validation rows[].hybridPromotion (does NOT recompute eligibility).
 * No impact on strict scores, gates, promotableCount, or phaseTracker.
 */

const path = require('path');
const {
  INTERMEDIATE_REVIEW_STATUS,
  resolveHybridReviewCriteriaFromEnv,
} = require('./computeHybridPromotionReview');

const QUEUE_SCHEMA_VERSION = '1.0.0';
const CHECKPOINT_SCHEMA_VERSION = '1.0.0';

/** Where the previous-run checkpoint was loaded from (field summary.checkpointSource). */
const CHECKPOINT_SOURCE_DATA_ROOT = 'data_root_governance';
const CHECKPOINT_SOURCE_OPS_SNAPSHOT = 'ops_snapshot_mirror';
const CHECKPOINT_SOURCE_NONE = 'none';
const CHECKPOINT_SOURCE_LAYER_DISABLED = 'not_applicable_layer_disabled';

/** Dropped reason when a strategy leaves the review_candidate set while hybrid layer is active. */
const DROPPED_REASON = 'no longer review_candidate';

function round2(n) {
  return Number((Number(n)).toFixed(2));
}

/**
 * Queue-only priority (observational): learning + capped gap bonus + persistence bonus − strict shortfall penalty.
 * Clamped [0, 100]. Not used for governance.
 */
function computeQueuePriorityScore(rowLike, persistenceCount, minStrictScore) {
  const learningScore = Number(rowLike.learningScore);
  const ls = Number.isFinite(learningScore) ? learningScore : 0;
  const gapRaw = Number(rowLike.gap);
  const gap = Number.isFinite(gapRaw) ? gapRaw : 0;
  const gapBonus = Math.min(15, Math.max(0, gap));
  const pc = Math.max(0, Math.floor(Number(persistenceCount) || 0));
  const persistenceBonus = Math.min(10, pc * 2);
  const strict = Number(rowLike.score);
  const strictN = Number.isFinite(strict) ? strict : 0;
  const minS = Number.isFinite(Number(minStrictScore)) ? Number(minStrictScore) : 70;
  const shortfall = Math.max(0, minS - strictN);
  const strictShortfallPenalty = Math.min(20, shortfall * 0.8);
  let raw = ls + gapBonus + persistenceBonus - strictShortfallPenalty;
  raw = Math.max(0, Math.min(100, raw));
  const priorityScore = round2(raw);
  return {
    priorityScore,
    priorityBreakdown: {
      learningScore: round2(ls),
      gapBonus: round2(gapBonus),
      persistenceBonus: round2(persistenceBonus),
      strictShortfallPenalty: round2(strictShortfallPenalty),
      rawBeforeClamp: round2(ls + gapBonus + persistenceBonus - strictShortfallPenalty),
    },
  };
}

function readCheckpointFile(fs, filePath) {
  try {
    if (!fs.existsSync(filePath)) return { entriesById: new Map() };
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entriesById = new Map();
    const arr = Array.isArray(raw.entries) ? raw.entries : [];
    for (const e of arr) {
      if (!e || typeof e !== 'object' || !e.strategyId) continue;
      entriesById.set(String(e.strategyId), {
        strategyId: String(e.strategyId),
        lastSeenAt: e.lastSeenAt != null ? String(e.lastSeenAt) : '',
        persistenceCount: Math.max(0, Math.floor(Number(e.persistenceCount) || 0)),
        priorityScore: Number.isFinite(Number(e.priorityScore)) ? Number(e.priorityScore) : null,
      });
    }
    return { entriesById };
  } catch (_) {
    return { entriesById: new Map() };
  }
}

/** Primary: dataRoot/governance; fallback: ops snapshot dir (same machine export loop). */
function readCheckpoint(fs, governanceDir, opsSnapshotDir) {
  const gov = readCheckpointFile(fs, path.join(governanceDir, 'hybrid_review_queue_checkpoint.json'));
  if (gov.entriesById.size > 0) {
    return { entriesById: gov.entriesById, checkpointSource: CHECKPOINT_SOURCE_DATA_ROOT };
  }
  if (opsSnapshotDir && String(opsSnapshotDir).trim()) {
    const snap = readCheckpointFile(
      fs,
      path.join(opsSnapshotDir, 'hybrid_review_queue_checkpoint.json')
    );
    if (snap.entriesById.size > 0) {
      return { entriesById: snap.entriesById, checkpointSource: CHECKPOINT_SOURCE_OPS_SNAPSHOT };
    }
  }
  return { entriesById: new Map(), checkpointSource: CHECKPOINT_SOURCE_NONE };
}

function writeCheckpoint(fs, governanceDir, payload, opsSnapshotDir) {
  const body = JSON.stringify(payload, null, 2);
  try {
    fs.mkdirSync(governanceDir, { recursive: true });
    fs.writeFileSync(path.join(governanceDir, 'hybrid_review_queue_checkpoint.json'), body, 'utf8');
  } catch (err) {
    console.warn('[hybridReviewQueue] checkpoint write (dataRoot) failed:', err && err.message ? err.message : err);
  }
  if (opsSnapshotDir && String(opsSnapshotDir).trim()) {
    try {
      fs.mkdirSync(opsSnapshotDir, { recursive: true });
      fs.writeFileSync(path.join(opsSnapshotDir, 'hybrid_review_queue_checkpoint.json'), body, 'utf8');
    } catch (err) {
      console.warn('[hybridReviewQueue] checkpoint write (ops-snapshot) failed:', err && err.message ? err.message : err);
    }
  }
}

function writeQueueFile(fs, governanceDir, payload) {
  const p = path.join(governanceDir, 'hybrid_review_queue.json');
  fs.mkdirSync(governanceDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * @param {object} opts
 * @param {object} opts.strategyValidation
 * @param {object} opts.hybridPromotionInsights
 * @param {string} opts.generatedAt
 * @param {string|null} [opts.evolutionTs]
 * @param {string} opts.dataRoot
 * @param {string} [opts.opsSnapshotDir] — mirror checkpoint for export dir (persistence when dataRoot is remote)
 * @param {typeof import('fs')} opts.fs
 */
function buildHybridReviewQueue(opts) {
  const strategyValidation = opts.strategyValidation && typeof opts.strategyValidation === 'object'
    ? opts.strategyValidation
    : {};
  const hybridPromotionInsights =
    opts.hybridPromotionInsights && typeof opts.hybridPromotionInsights === 'object'
      ? opts.hybridPromotionInsights
      : {};
  const generatedAt = opts.generatedAt != null ? String(opts.generatedAt) : new Date().toISOString();
  const evolutionTs = opts.evolutionTs != null ? opts.evolutionTs : null;
  const dataRoot = opts.dataRoot != null ? String(opts.dataRoot) : '';
  const opsSnapshotDir = opts.opsSnapshotDir != null ? String(opts.opsSnapshotDir) : '';
  const fs = opts.fs || require('fs');

  const governanceDir = path.join(dataRoot, 'governance');
  const layerEnabled = hybridPromotionInsights.enabled === true;
  const criteriaDefaults = resolveHybridReviewCriteriaFromEnv();

  const criteria = {
    source: 'strategy_validation.rows.hybridPromotion',
    statusIncluded: INTERMEDIATE_REVIEW_STATUS,
    minStrictScoreForPriorityPenalty: criteriaDefaults.minStrictScore,
  };

  function buildSummary(overrides) {
    return {
      total: overrides.total != null ? overrides.total : 0,
      newCount: overrides.newCount != null ? overrides.newCount : 0,
      persistentCount: overrides.persistentCount != null ? overrides.persistentCount : 0,
      droppedCount: overrides.droppedCount != null ? overrides.droppedCount : 0,
      topPriorityStrategyId:
        overrides.topPriorityStrategyId !== undefined ? overrides.topPriorityStrategyId : null,
      generatedAt: overrides.generatedAt != null ? String(overrides.generatedAt) : generatedAt,
      layerEnabled: overrides.layerEnabled === true,
      checkpointSource:
        overrides.checkpointSource != null ? String(overrides.checkpointSource) : CHECKPOINT_SOURCE_NONE,
    };
  }

  if (!layerEnabled) {
    const idle = {
      schemaVersion: QUEUE_SCHEMA_VERSION,
      generatedAt,
      evolutionTs,
      layerEnabled: false,
      summary: buildSummary({
        generatedAt,
        layerEnabled: false,
        checkpointSource: CHECKPOINT_SOURCE_LAYER_DISABLED,
      }),
      criteria,
      rows: [],
      dropped: [],
      checkpointUnchanged: true,
      note: 'Hybrid promotion layer disabled; checkpoint not updated to avoid spurious dropped entries.',
    };
    try {
      writeQueueFile(fs, governanceDir, idle);
    } catch (err) {
      console.warn('[hybridReviewQueue] write idle queue failed:', err && err.message ? err.message : err);
    }
    return idle;
  }

  const rows = Array.isArray(strategyValidation.rows) ? strategyValidation.rows : [];
  const candidates = rows.filter(
    (r) =>
      r &&
      typeof r === 'object' &&
      r.hybridPromotion &&
      r.hybridPromotion.status === INTERMEDIATE_REVIEW_STATUS &&
      r.hybridPromotion.eligible === true
  );

  const { entriesById: prevById, checkpointSource } = readCheckpoint(fs, governanceDir, opsSnapshotDir);
  const currentIds = new Set(candidates.map((r) => String(r.strategyId || '')).filter(Boolean));

  const dropped = [];
  for (const [sid, prev] of prevById.entries()) {
    if (!currentIds.has(sid)) {
      dropped.push({
        strategyId: sid,
        lastSeenAt: prev.lastSeenAt || generatedAt,
        previousPersistenceCount: Math.max(0, Math.floor(prev.persistenceCount || 0)),
        reason: DROPPED_REASON,
      });
    }
  }

  dropped.sort((a, b) => {
    const ta = String(a.lastSeenAt || '');
    const tb = String(b.lastSeenAt || '');
    if (ta !== tb) return tb.localeCompare(ta);
    return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
  });

  const minStrict =
    candidates[0] &&
    candidates[0].hybridPromotion &&
    candidates[0].hybridPromotion.criteria &&
    Number.isFinite(Number(candidates[0].hybridPromotion.criteria.minStrictScore))
      ? Number(candidates[0].hybridPromotion.criteria.minStrictScore)
      : criteriaDefaults.minStrictScore;

  const queueRows = [];
  let newCount = 0;
  let persistentCount = 0;

  for (const r of candidates) {
    const sid = String(r.strategyId || '');
    if (!sid) continue;
    const prev = prevById.get(sid);
    let queueStatus;
    let persistenceCount;
    if (!prev) {
      queueStatus = 'new';
      persistenceCount = 1;
      newCount += 1;
    } else {
      queueStatus = 'persistent';
      persistenceCount = Math.max(1, Math.floor(prev.persistenceCount || 0) + 1);
      persistentCount += 1;
    }

    const gap =
      r.gap != null && Number.isFinite(Number(r.gap))
        ? Number(r.gap)
        : Number.isFinite(Number(r.learningScore)) && Number.isFinite(Number(r.score))
          ? round2(Number(r.learningScore) - Number(r.score))
          : null;

    const { priorityScore, priorityBreakdown } = computeQueuePriorityScore(
      { ...r, gap: gap != null ? gap : r.gap },
      persistenceCount,
      minStrict
    );

    const reason =
      r.hybridPromotion && r.hybridPromotion.reason != null
        ? String(r.hybridPromotion.reason)
        : '';

    queueRows.push({
      strategyId: sid,
      strictScore: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
      strictTier: r.tier != null ? String(r.tier) : null,
      learningScore: Number.isFinite(Number(r.learningScore)) ? Number(r.learningScore) : null,
      learningTier: r.learningTier != null ? String(r.learningTier) : null,
      gap,
      hybridStatus: INTERMEDIATE_REVIEW_STATUS,
      queueStatus,
      persistenceCount,
      priorityScore,
      priorityBreakdown,
      reason,
    });
  }

  queueRows.sort((a, b) => {
    const pd = safeNum(b.priorityScore, -1e9) - safeNum(a.priorityScore, -1e9);
    if (pd !== 0) return pd;
    const ld = safeNum(b.learningScore, -1e9) - safeNum(a.learningScore, -1e9);
    if (ld !== 0) return ld;
    return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
  });

  const topPriorityStrategyId = queueRows.length ? queueRows[0].strategyId : null;

  const checkpointPayload = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    updatedAt: generatedAt,
    evolutionTs,
    entries: queueRows
      .map((q) => ({
        strategyId: q.strategyId,
        lastSeenAt: generatedAt,
        persistenceCount: q.persistenceCount,
        priorityScore: q.priorityScore,
      }))
      .sort((a, b) => String(a.strategyId).localeCompare(String(b.strategyId))),
  };

  const payload = {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    generatedAt,
    evolutionTs,
    layerEnabled: true,
    summary: buildSummary({
      total: queueRows.length,
      newCount,
      persistentCount,
      droppedCount: dropped.length,
      topPriorityStrategyId,
      generatedAt,
      layerEnabled: true,
      checkpointSource,
    }),
    criteria,
    rows: queueRows,
    dropped,
  };

  try {
    writeQueueFile(fs, governanceDir, payload);
    writeCheckpoint(fs, governanceDir, checkpointPayload, opsSnapshotDir);
  } catch (err) {
    console.warn('[hybridReviewQueue] write failed:', err && err.message ? err.message : err);
  }

  return payload;
}

function safeNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = {
  QUEUE_SCHEMA_VERSION,
  CHECKPOINT_SCHEMA_VERSION,
  CHECKPOINT_SOURCE_DATA_ROOT,
  CHECKPOINT_SOURCE_OPS_SNAPSHOT,
  CHECKPOINT_SOURCE_NONE,
  CHECKPOINT_SOURCE_LAYER_DISABLED,
  buildHybridReviewQueue,
  computeQueuePriorityScore,
  DROPPED_REASON,
};
