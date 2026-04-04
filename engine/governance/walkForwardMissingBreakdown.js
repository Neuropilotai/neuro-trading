'use strict';

/**
 * Dashboard-only projection from promoted_children.json fields (wfMissingDiagnosticSummary +
 * rejectedByReason). Does not read batch files or wf_upstream_audit.json.
 *
 * NO_VALIDATION_SIBLING_FILTERED reflects upstream validation rows that exist but are outside
 * the promotable sibling pool; this is tracked for observability and should not by itself
 * trigger a pipeline anomaly alert.
 *
 * "Normal" / "anomalous" here are dashboard labels for WF missing subcauses only, not business validation.
 */

const WF_MISSING_ANOMALOUS_CUMULATIVE_THRESHOLD_PCT = 20;
const WF_MISSING_DOMINANT_ANOMALOUS_ALERT_PCT = 70;

/** Only this code is treated as non-anomalous for pipeline-priority alerting. */
const WF_MISSING_NORMAL_DASHBOARD_CODE = 'NO_VALIDATION_SIBLING_FILTERED';

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function isAnomalousSubcause(code) {
  const c = String(code || '');
  if (c === WF_MISSING_NORMAL_DASHBOARD_CODE) return false;
  return true;
}

/**
 * @param {object} input
 * @param {object} [input.rejectedByReason]
 * @param {object|null} [input.wfMissingDiagnosticSummary]
 * @returns {object|null} fields to merge onto promotionGuardSummary, or null if N/A
 */
function buildWalkForwardMissingBreakdown(input = {}) {
  const rejectedByReason =
    input.rejectedByReason && typeof input.rejectedByReason === 'object' ? input.rejectedByReason : {};
  const wfMissingTotal = safeNumber(rejectedByReason.REJECT_WALKFORWARD_MISSING, 0);
  if (wfMissingTotal <= 0) return null;

  const raw =
    input.wfMissingDiagnosticSummary && typeof input.wfMissingDiagnosticSummary === 'object'
      ? input.wfMissingDiagnosticSummary
      : null;
  if (!raw || Object.keys(raw).length === 0) return null;

  const counts = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = safeNumber(v, 0);
    if (n > 0) counts[String(k)] = Math.floor(n);
  }
  if (Object.keys(counts).length === 0) return null;

  const sumBreakdown = Object.values(counts).reduce((a, b) => a + b, 0);
  const unclassifiedCount = Math.max(0, wfMissingTotal - sumBreakdown);

  let anomalousCount = unclassifiedCount;
  let normalCount = 0;
  const anomalousCodes = [];
  for (const [code, cnt] of Object.entries(counts)) {
    if (isAnomalousSubcause(code)) {
      anomalousCount += cnt;
      anomalousCodes.push(code);
    } else {
      normalCount += cnt;
    }
  }

  const anomalousSharePct = wfMissingTotal > 0 ? round2((anomalousCount / wfMissingTotal) * 100) : 0;
  const normalSharePct = wfMissingTotal > 0 ? round2((normalCount / wfMissingTotal) * 100) : 0;

  const sortedKeys = Object.keys(counts).sort((a, b) => {
    const ca = counts[a];
    const cb = counts[b];
    if (cb !== ca) return cb - ca;
    return String(a).localeCompare(String(b));
  });
  const dominantCode = sortedKeys.length ? sortedKeys[0] : null;
  const dominantCount = dominantCode != null ? counts[dominantCode] : 0;
  const dominantSharePct =
    wfMissingTotal > 0 && dominantCode != null
      ? round2((dominantCount / wfMissingTotal) * 100)
      : 0;
  const dominantIsAnomalous = dominantCode != null ? isAnomalousSubcause(dominantCode) : false;

  const sharesPct = {};
  for (const [code, cnt] of Object.entries(counts)) {
    sharesPct[code] = wfMissingTotal > 0 ? round2((cnt / wfMissingTotal) * 100) : 0;
  }
  if (unclassifiedCount > 0) {
    sharesPct.__unclassified__ = wfMissingTotal > 0
      ? round2((unclassifiedCount / wfMissingTotal) * 100)
      : 0;
  }

  const alert =
    anomalousSharePct >= WF_MISSING_ANOMALOUS_CUMULATIVE_THRESHOLD_PCT ||
    (dominantIsAnomalous === true && dominantSharePct >= WF_MISSING_DOMINANT_ANOMALOUS_ALERT_PCT);

  const walkForwardMissingBreakdown = {
    enabled: true,
    total: wfMissingTotal,
    counts,
    sharesPct,
    sumBreakdown,
    unclassifiedCount,
    breakdownSumMismatch: sumBreakdown !== wfMissingTotal,
    dominantCode,
    dominantSharePct,
    dominantIsAnomalous,
    anomalousCodes,
    alert,
    alertCode: alert ? 'WF_MISSING_ANOMALOUS_SUBCAUSES' : null,
    alertReason: alert
      ? 'Walk-forward missing rejects are dominated by anomalous upstream subcauses (NOT_GENERATED / KEY_MISMATCH / UNKNOWN / unclassified gap), not by promotable filtering alone.'
      : null,
    thresholdPct: WF_MISSING_ANOMALOUS_CUMULATIVE_THRESHOLD_PCT,
    dominantAnomalousThresholdPct: WF_MISSING_DOMINANT_ANOMALOUS_ALERT_PCT,
  };

  return {
    walkForwardMissingBreakdown,
    walkForwardMissingAnomalousCount: anomalousCount,
    walkForwardMissingAnomalousSharePct: anomalousSharePct,
    walkForwardMissingNormalCount: normalCount,
    walkForwardMissingNormalSharePct: normalSharePct,
  };
}

/**
 * Recompute WF breakdown when snapshot is stale: merge promoted_children diagnostic summary if needed.
 * Contract: latest.json promotionGuardSummary wins over raw promoted_children; never replace a
 * walkForwardMissingBreakdown that already has enabled===true; only fill wfMissingDiagnosticSummary
 * from promoted_children when the snapshot omits it.
 * @param {object|null} promotionGuardLike - from latest.json promotionGuardSummary or fallback
 * @param {object|null} promotedChildrenJson - discovery/promoted_children.json
 */
function mergePromotionGuardWfBreakdown(promotionGuardLike, promotedChildrenJson) {
  const base =
    promotionGuardLike && typeof promotionGuardLike === 'object'
      ? { ...promotionGuardLike }
      : { available: false, rejectedByReason: {}, rejected: 0, evaluated: 0, passed: 0 };

  if (
    base.walkForwardMissingBreakdown &&
    base.walkForwardMissingBreakdown.enabled === true
  ) {
    return base;
  }

  let wfSum =
    base.wfMissingDiagnosticSummary && typeof base.wfMissingDiagnosticSummary === 'object'
      ? base.wfMissingDiagnosticSummary
      : null;
  if (!wfSum || !Object.keys(wfSum).length) {
    const j = promotedChildrenJson && typeof promotedChildrenJson === 'object' ? promotedChildrenJson : null;
    if (j && j.wfMissingDiagnosticSummary && typeof j.wfMissingDiagnosticSummary === 'object') {
      wfSum = j.wfMissingDiagnosticSummary;
    }
  }
  if (!wfSum || !Object.keys(wfSum).length) {
    const j = promotedChildrenJson && typeof promotedChildrenJson === 'object' ? promotedChildrenJson : null;
    if (j && j.wfMissingDiagnosticCounts && typeof j.wfMissingDiagnosticCounts === 'object') {
      wfSum = j.wfMissingDiagnosticCounts;
    } else if (j && j.wfMissingSemanticCounts && typeof j.wfMissingSemanticCounts === 'object') {
      wfSum = j.wfMissingSemanticCounts;
    }
  }
  if (!wfSum || !Object.keys(wfSum).length) {
    const j = promotedChildrenJson && typeof promotedChildrenJson === 'object' ? promotedChildrenJson : null;
    const pg = j && j.promotionGuard && typeof j.promotionGuard === 'object' ? j.promotionGuard : null;
    if (pg && pg.rejectedByWfMissingDiagnostic && typeof pg.rejectedByWfMissingDiagnostic === 'object') {
      wfSum = pg.rejectedByWfMissingDiagnostic;
    } else if (pg && pg.rejectedByWfMissingSemantic && typeof pg.rejectedByWfMissingSemantic === 'object') {
      wfSum = pg.rejectedByWfMissingSemantic;
    }
  }
  if (!wfSum || !Object.keys(wfSum).length) return base;

  const rejectedByReason =
    base.rejectedByReason && typeof base.rejectedByReason === 'object'
      ? base.rejectedByReason
      : promotedChildrenJson &&
          promotedChildrenJson.promotionGuard &&
          typeof promotedChildrenJson.promotionGuard === 'object' &&
          promotedChildrenJson.promotionGuard.rejectedByReason
        ? promotedChildrenJson.promotionGuard.rejectedByReason
        : {};

  const extra = buildWalkForwardMissingBreakdown({
    rejectedByReason,
    wfMissingDiagnosticSummary: wfSum,
  });
  if (!extra) {
    return { ...base, wfMissingDiagnosticSummary: wfSum };
  }
  return {
    ...base,
    wfMissingDiagnosticSummary: wfSum,
    ...extra,
  };
}

module.exports = {
  buildWalkForwardMissingBreakdown,
  mergePromotionGuardWfBreakdown,
  WF_MISSING_ANOMALOUS_CUMULATIVE_THRESHOLD_PCT,
  WF_MISSING_DOMINANT_ANOMALOUS_ALERT_PCT,
  WF_MISSING_NORMAL_DASHBOARD_CODE,
};
