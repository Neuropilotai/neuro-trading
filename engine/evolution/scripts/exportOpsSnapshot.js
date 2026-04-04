#!/usr/bin/env node
'use strict';

/**
 * Export JSON snapshot for ops.neuropilot.dev (Option A).
 * Reads evolution_metrics.log and writes:
 *   ops-snapshot/latest.json
 *   ops-snapshot/trend.json
 *   ops-snapshot/alerts.json
 *   ops-snapshot/milestones.json
 *
 * Run after runEvolutionBaseline.sh (or whenever you want to refresh the snapshot).
 * Usage (from neuropilot_trading_v2):
 *   node engine/evolution/scripts/exportOpsSnapshot.js
 *   node engine/evolution/scripts/exportOpsSnapshot.js 50   # trend points (default 50)
 */

const fs = require('fs');
const path = require('path');

const { buildGovernanceDashboard } = require('../../governance/buildGovernanceDashboard');
const { computeStrategyValidationFromFile } = require('../../governance/computeStrategyValidationFramework');
const { enrichStrategyValidationHybridPromotion } = require('../../governance/computeHybridPromotionReview');
const { buildHybridReviewQueue } = require('../../governance/computeHybridReviewQueue');
const { buildExecutionStatusSnapshot } = require('../../execution/buildExecutionStatusSnapshot');
const {
  evaluateOpsAlerts,
  readCheckpoint,
} = require('../../execution/opsAlerts');
const { buildWalkForwardMissingBreakdown } = require('../../governance/walkForwardMissingBreakdown');
const { writeOwnerApprovalQueue } = require('../../execution/buildOwnerApprovalQueue');
const { writeOwnerApprovalSummary } = require('../../execution/buildOwnerApprovalSummary');
const datasetManifest = require(path.join(__dirname, '..', '..', 'data', 'datasetManifest'));
const datasetFreshnessEval = require(path.join(__dirname, '..', '..', 'data', 'datasetFreshnessEval'));
const {
  inferMarketClass,
  marketSessionStateForClass,
  buildFreshnessOwnerContext,
} = require(path.join(__dirname, '..', '..', 'governance', 'freshnessOwnerContext'));
const { buildPaperExecutionV1Observability } = require('../../governance/paperExecutionV1Observability');

const logPath = path.join(__dirname, '..', 'logs', 'evolution_metrics.log');

/** Same contract as datasetDegradedGuard / opsAlerts: env path is cwd-relative; default = repo ops-snapshot. */
function resolveOpsSnapshotDir() {
  const env = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (env && String(env).trim()) {
    return path.resolve(process.cwd(), String(env).trim());
  }
  return path.join(path.resolve(__dirname, '..', '..', '..'), 'ops-snapshot');
}

const outDir = resolveOpsSnapshotDir();

function loadData() {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const raw = fs.readFileSync(logPath, 'utf8').trim();
  const lines = raw ? raw.split('\n').filter(Boolean) : [];
  const data = [];
  for (const line of lines) {
    try {
      data.push(JSON.parse(line));
    } catch (_) {
      // skip malformed
    }
  }
  return data;
}

function writeJson(filename, obj) {
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  return filePath;
}

/**
 * Copy paper exec V1 anti-dup artefacts into ops-snapshot and write a small observability JSON
 * (same fields as dashboard metrics; ops hosts can read without NEUROPILOT_DATA_ROOT).
 */
function exportPaperExecV1ArtifactsForOps(generatedAtIso) {
  const govDir = path.join(datasetManifest.getDataRoot(), 'governance');
  const peo = buildPaperExecutionV1Observability(govDir);
  const names = ['paper_exec_seen_keys.json', 'paper_exec_v1_last_run.json'];
  const opsSnapshotRelativeCopies = {};
  for (const n of names) {
    const src = path.join(govDir, n);
    let rel = null;
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.copyFileSync(src, path.join(outDir, n));
        rel = n;
      }
    } catch (e) {
      console.warn('[exportOpsSnapshot] copy', n, 'failed:', e && e.message ? e.message : e);
    }
    opsSnapshotRelativeCopies[n] = rel;
  }
  writeJson('paper_exec_v1_observability.json', {
    ...peo,
    opsSnapshotRelativeCopies,
    generatedAt: generatedAtIso,
  });
  return peo;
}

function loadJsonOptionalFromDir(dir, filename) {
  const filePath = path.join(dir, filename);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Prefer canonical wfMissingDiagnostic*; fall back to legacy wfMissingSemantic* (historical snapshots). */
function pickWfMissingRejectCounts(pg, j) {
  const p = pg && typeof pg === 'object' ? pg : {};
  const root = j && typeof j === 'object' ? j : {};
  if (p.rejectedByWfMissingDiagnostic && typeof p.rejectedByWfMissingDiagnostic === 'object') {
    return p.rejectedByWfMissingDiagnostic;
  }
  if (p.rejectedByWfMissingSemantic && typeof p.rejectedByWfMissingSemantic === 'object') {
    return p.rejectedByWfMissingSemantic;
  }
  if (root.wfMissingDiagnosticCounts && typeof root.wfMissingDiagnosticCounts === 'object') {
    return root.wfMissingDiagnosticCounts;
  }
  if (root.wfMissingSemanticCounts && typeof root.wfMissingSemanticCounts === 'object') {
    return root.wfMissingSemanticCounts;
  }
  return {};
}

function pickWfMissingDiagnosticSummaryForSnapshot(j, rejectCounts) {
  const root = j && typeof j === 'object' ? j : {};
  const rc = rejectCounts && typeof rejectCounts === 'object' ? rejectCounts : {};
  const sum = root.wfMissingDiagnosticSummary && typeof root.wfMissingDiagnosticSummary === 'object'
    ? root.wfMissingDiagnosticSummary
    : null;
  if (sum && Object.keys(sum).length > 0) return sum;
  if (Object.keys(rc).length > 0) return rc;
  return sum || {};
}

function pickWfMissingEnabledFlags(j) {
  const root = j && typeof j === 'object' ? j : {};
  const on =
    root.wfMissingDiagnosticEnabled === true ||
    root.wfMissingSemanticEnabled === true;
  return { wfMissingDiagnosticEnabled: on, wfMissingSemanticEnabled: on };
}

/** Ensure both wfMissingDiagnostic and wfMissingSemantic on each row when either is set (legacy files). */
function mirrorWfMissingOnRejectionSamples(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const d = row.wfMissingDiagnostic != null ? row.wfMissingDiagnostic : row.wfMissingSemantic;
    if (d == null) return { ...row };
    return {
      ...row,
      wfMissingDiagnostic: d,
      wfMissingSemantic: row.wfMissingSemantic != null ? row.wfMissingSemantic : d,
    };
  });
}

function buildPromotionGuardSummary() {
  const filePath = path.join(datasetManifest.getDataRoot(), 'discovery', 'promoted_children.json');
  const fallback = {
    generatedAt: new Date().toISOString(),
    available: false,
    mode: null,
    target: 'paper',
    evaluated: 0,
    passed: 0,
    rejected: 0,
    rejectedByReason: {},
    rejectedByWfMissingDiagnostic: {},
    rejectedByWfMissingSemantic: {},
    rejectedSample: [],
    wfMissingDiagnosticSummary: {},
    wfMissingDiagnosticEnabled: false,
    wfMissingSemanticEnabled: false,
  };
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const pg = j && j.promotionGuard && typeof j.promotionGuard === 'object' ? j.promotionGuard : {};
    const rejectCounts = pickWfMissingRejectCounts(pg, j);
    const wfMissingDiagSummary = pickWfMissingDiagnosticSummaryForSnapshot(j, rejectCounts);
    const { wfMissingDiagnosticEnabled, wfMissingSemanticEnabled } = pickWfMissingEnabledFlags(j);
    const summary = {
      generatedAt: new Date().toISOString(),
      available: true,
      mode: j && j.learningMode ? j.learningMode : (pg.mode || null),
      target: j && j.promotionTargetEnvironment ? String(j.promotionTargetEnvironment) : 'paper',
      evaluated: Number(pg.evaluated || 0),
      passed: Number(pg.passed || 0),
      rejected: Number(pg.rejected || 0),
      rejectedByReason: pg.rejectedByReason && typeof pg.rejectedByReason === 'object'
        ? pg.rejectedByReason
        : {},
      rejectedByWfMissingDiagnostic: rejectCounts,
      rejectedByWfMissingSemantic: rejectCounts,
      wfMissingDiagnosticSummary: wfMissingDiagSummary,
      wfMissingDiagnosticEnabled,
      wfMissingSemanticEnabled,
      rejectedSample: mirrorWfMissingOnRejectionSamples(
        Array.isArray(j && j.rejectedCandidatesSample) ? j.rejectedCandidatesSample.slice(0, 30) : []
      ),
      thresholdsApplied: pg.thresholdsApplied && typeof pg.thresholdsApplied === 'object'
        ? pg.thresholdsApplied
        : null,
    };
    summary.contextGuardSummary = summarizeContextGuardRows(j);
    return summary;
  } catch (_) {
    return fallback;
  }
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round6(n) {
  return Number((safeNumber(n, 0)).toFixed(6));
}

function median(values) {
  const arr = (Array.isArray(values) ? values : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function alignmentState(row) {
  const a = row && row.contextAlignment && typeof row.contextAlignment === 'object'
    ? row.contextAlignment
    : null;
  if (!a) return 'unknown';
  if (a.hasRegimeMismatch === true || a.hasSessionMismatch === true) return 'misaligned';
  if (a.hasRegimeAlignment === true || a.hasSessionAlignment === true) return 'aligned';
  if (row && row.contextApplied === true) return 'neutral';
  return 'unknown';
}

function summarizeContextGuardRows(promotedChildrenJson) {
  const empty = {
    evaluated: 0,
    contextAppliedCount: 0,
    contextAppliedPct: 0,
    avgContextScoreDelta: 0,
    medianContextScoreDelta: 0,
    positiveDeltaCount: 0,
    negativeDeltaCount: 0,
    zeroDeltaCount: 0,
    avgAdjustedMinusBase: 0,
    alignmentCounts: {},
    topRejectReasons: [],
    generatedAt: new Date().toISOString(),
  };
  const j = promotedChildrenJson && typeof promotedChildrenJson === 'object'
    ? promotedChildrenJson
    : null;
  if (!j) return empty;

  const promotedRows = Array.isArray(j.strategies)
    ? j.strategies.map((s) => {
        const pg = s && s.promotionGuard && typeof s.promotionGuard === 'object' ? s.promotionGuard : {};
        return {
          eligible: true,
          reasons: Array.isArray(pg.reasons) ? pg.reasons : [],
          contextApplied: pg.contextApplied === true,
          contextAlignment: pg.contextAlignment || null,
          contextScoreDelta: safeNumber(pg.contextScoreDelta, safeNumber(pg.metricsSnapshot && pg.metricsSnapshot.contextScoreDelta, 0)),
          metricsSnapshot: pg.metricsSnapshot && typeof pg.metricsSnapshot === 'object' ? pg.metricsSnapshot : {},
        };
      })
    : [];
  const rejectedRows = Array.isArray(j.rejectedCandidatesSample) ? j.rejectedCandidatesSample : [];
  const rows = promotedRows.concat(rejectedRows);
  if (!rows.length) return empty;

  const deltas = [];
  const adjMinusBase = [];
  const alignmentCounts = { aligned: 0, neutral: 0, misaligned: 0, unknown: 0 };
  const rejectReasonCounts = {};
  let contextAppliedCount = 0;
  let positiveDeltaCount = 0;
  let negativeDeltaCount = 0;
  let zeroDeltaCount = 0;

  for (const row of rows) {
    const delta = safeNumber(
      row && row.contextScoreDelta,
      safeNumber(row && row.metricsSnapshot && row.metricsSnapshot.contextScoreDelta, 0)
    );
    deltas.push(delta);
    if (delta > 0) positiveDeltaCount += 1;
    else if (delta < 0) negativeDeltaCount += 1;
    else zeroDeltaCount += 1;

    const base = safeNumber(row && row.metricsSnapshot && row.metricsSnapshot.baseScore, 0);
    const adjusted = safeNumber(row && row.metricsSnapshot && row.metricsSnapshot.adjustedScore, base + delta);
    adjMinusBase.push(adjusted - base);

    if (row && row.contextApplied === true) contextAppliedCount += 1;
    const state = alignmentState(row);
    alignmentCounts[state] = (alignmentCounts[state] || 0) + 1;

    const isRejected = row && row.eligible === false;
    if (isRejected) {
      const reasons = Array.isArray(row.reasons) ? row.reasons : [];
      for (const reason of reasons) {
        const code = reason && reason.code != null ? String(reason.code) : '';
        if (!code) continue;
        rejectReasonCounts[code] = (rejectReasonCounts[code] || 0) + 1;
      }
    }
  }

  const topRejectReasons = Object.entries(rejectReasonCounts)
    .map(([code, count]) => ({ code, count: safeNumber(count, 0) }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 5);

  return {
    evaluated: rows.length,
    contextAppliedCount,
    contextAppliedPct: round6(rows.length > 0 ? (contextAppliedCount * 100) / rows.length : 0),
    avgContextScoreDelta: round6(deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0),
    medianContextScoreDelta: round6(median(deltas)),
    positiveDeltaCount,
    negativeDeltaCount,
    zeroDeltaCount,
    avgAdjustedMinusBase: round6(adjMinusBase.length ? adjMinusBase.reduce((a, b) => a + b, 0) / adjMinusBase.length : 0),
    alignmentCounts,
    topRejectReasons,
    generatedAt: new Date().toISOString(),
  };
}

function buildTopRejectedReasons(rejectedByReason, topN = 5) {
  const obj = rejectedByReason && typeof rejectedByReason === 'object' ? rejectedByReason : {};
  return Object.entries(obj)
    .map(([code, count]) => ({ code: String(code), count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, Math.max(1, Number(topN) || 5));
}

function computeDominantRejectReason(rejectedByReason) {
  const top = buildTopRejectedReasons(rejectedByReason, 1)[0] || null;
  const totalRejected = Object.values(
    rejectedByReason && typeof rejectedByReason === 'object' ? rejectedByReason : {}
  ).reduce((acc, x) => acc + (Number(x) || 0), 0);
  if (!top || totalRejected <= 0) {
    return {
      code: null,
      count: 0,
      sharePct: 0,
      alert: false,
      totalRejected: 0,
      thresholdPct: 70,
    };
  }
  const sharePct = Math.round(((top.count / totalRejected) * 100) * 100) / 100;
  return {
    code: top.code,
    count: top.count,
    sharePct,
    alert: sharePct >= 70,
    totalRejected,
    thresholdPct: 70,
  };
}

function buildStrategyInboxPayload() {
  const defaultPayload = { generatedAt: new Date().toISOString(), items: [] };
  const candidates = [
    path.join(datasetManifest.getDataRoot(), 'governance', 'strategy_inbox.json'),
    path.join(__dirname, '..', '..', 'governance', 'strategy_inbox.json'),
  ];
  const inboxPath = candidates.find((p) => fs.existsSync(p));
  if (!inboxPath) return defaultPayload;
  try {
    const raw = fs.readFileSync(inboxPath, 'utf8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);
    return {
      generatedAt: new Date().toISOString(),
      items: items.map((x) => ({
        strategyId: x && x.strategyId != null ? String(x.strategyId) : 'unknown',
        status: x && x.status != null ? String(x.status) : 'pending_review',
        addedAt: x && x.addedAt != null ? String(x.addedAt) : null,
        source: x && x.source != null ? String(x.source) : null,
        notes: x && x.notes != null ? String(x.notes) : null,
        priority: x && x.priority != null ? String(x.priority) : 'normal',
      })),
    };
  } catch (_) {
    return defaultPayload;
  }
}

/**
 * Dataset candle freshness from datasets_manifest.json (engine data root).
 * Lets ops UI distinguish “pipeline run recent” vs “XAUUSD bars actually fresh”.
 */
function mapFreshnessSource(entry) {
  const p = String(entry && entry.provider != null ? entry.provider : '').toLowerCase();
  if (p === 'yahoo') return 'yahoo';
  if (p === 'oanda') return 'oanda';
  if (p === 'binance') return 'binance';
  if (p === 'manual') return 'manual';
  if (p === 'cached') return 'fallback_cache';
  return p || 'unknown';
}

/**
 * Ops-only summary for datasets in `lagging` state (non-blocking).
 * Keys ordered worst age first.
 */
function buildLaggingSummaryFromRows(rows) {
  const lagging = (Array.isArray(rows) ? rows : []).filter((r) => r && r.status === 'lagging');
  const sorted = lagging.slice().sort((a, b) => {
    const ax = Number(a.dataset_age_minutes);
    const bx = Number(b.dataset_age_minutes);
    if (!Number.isFinite(ax) && !Number.isFinite(bx)) return 0;
    if (!Number.isFinite(ax)) return 1;
    if (!Number.isFinite(bx)) return -1;
    return bx - ax;
  });
  const count = sorted.length;
  if (count === 0) {
    return {
      count: 0,
      maxLagMinutes: null,
      keys: [],
      worstKey: null,
      worstDegradedThresholdMinutes: null,
      worstRatio: 0,
    };
  }
  const worst = sorted[0];
  const maxLag = Number(worst.dataset_age_minutes);
  const deg =
    worst.thresholds && Number.isFinite(Number(worst.thresholds.degradedMinutes))
      ? Number(worst.thresholds.degradedMinutes)
      : null;
  const worstRatio =
    deg != null && deg > 0 && Number.isFinite(maxLag) ? Math.round((maxLag / deg) * 10000) / 10000 : 0;
  return {
    count,
    maxLagMinutes: Number.isFinite(maxLag) ? maxLag : null,
    keys: sorted.map((r) => String(r.key || '').toUpperCase()),
    worstKey: worst.key != null ? String(worst.key).toUpperCase() : null,
    worstDegradedThresholdMinutes: deg,
    worstRatio,
  };
}

function buildDatasetFreshnessPayload() {
  const { datasets } = datasetManifest.readManifest();
  const bootstrapMap = datasetManifest.readLastBootstrapMap();
  const now = Date.now();
  const list = [];
  for (const [key, entry] of Object.entries(datasets || {})) {
    const lastTs = entry && entry.lastTs != null ? Number(entry.lastTs) : null;
    const ageMs = Number.isFinite(lastTs) ? now - lastTs : null;
    const datasetAgeMin =
      ageMs != null && Number.isFinite(ageMs) ? Math.round((ageMs / 60000) * 100) / 100 : null;
    const sym = entry.symbol || (key.split('_')[0] || '');
    const tf = entry.timeframe || '';
    const src = mapFreshnessSource(entry);
    const ev = datasetFreshnessEval.evaluateDatasetFreshness({
      symbol: sym,
      timeframe: tf,
      dataset_age_minutes: datasetAgeMin,
      dataset_last_candle_ts: Number.isFinite(lastTs) ? lastTs : null,
      source: src,
    });
    const prov = entry.provider != null ? entry.provider : null;
    const marketClass = inferMarketClass(sym, prov, key);
    const marketSessionState = marketSessionStateForClass(marketClass, now);
    list.push({
      key,
      symbol: sym,
      timeframe: tf,
      dataset_last_candle_ts: Number.isFinite(lastTs) ? lastTs : null,
      dataset_age_minutes: datasetAgeMin,
      provider_used: prov,
      marketClass,
      marketSessionState,
      rows: entry.rows != null ? entry.rows : null,
      manifest_last_update_at: entry.lastUpdateAt != null ? entry.lastUpdateAt : null,
      last_bootstrap: bootstrapMap[key] != null ? bootstrapMap[key] : null,
      status: ev.status,
      lastUpdate: ev.lastUpdate,
      source: ev.source,
      thresholds: ev.thresholds,
    });
  }
  list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const laggingSummary = buildLaggingSummaryFromRows(list);
  const datasetsByKey = {};
  for (const row of list) {
    datasetsByKey[String(row.key || '').toUpperCase()] = {
      status: row.status,
      lastUpdate: row.lastUpdate,
      source: row.source,
      thresholds: row.thresholds,
    };
  }
  const freshnessContext = buildFreshnessOwnerContext(list, now);
  return {
    generatedAt: new Date().toISOString(),
    datasets: list,
    datasetsByKey,
    laggingSummary,
    freshnessContext,
  };
}

function buildXauDatasetDiagnosticsPayload() {
  const tfOrder = ['5m', '15m', '1h'];
  const filePath = path.join(outDir, 'xau_dataset_diagnostics.json');
  try {
    if (!fs.existsSync(filePath)) return [];
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(j && j.items) ? j.items : [];
    const byTf = new Map();
    for (const r of rows) {
      if (!r || String(r.symbol || '').toUpperCase() !== 'XAUUSD') continue;
      const tf = String(r.timeframe || '').toLowerCase();
      if (!tfOrder.includes(tf)) continue;
      const reasonCodes = Array.isArray(r.reasonCodes) ? r.reasonCodes.map((x) => String(x)) : [];
      let primaryReason = r.primaryReason != null ? String(r.primaryReason) : null;
      if (!primaryReason) {
        primaryReason = reasonCodes.find((c) => c !== 'IN_DEGRADED_CRITICAL_SET') || null;
      }
      byTf.set(tf, {
        manifestKey: r.manifestKey != null ? String(r.manifestKey).toUpperCase() : `XAUUSD_${tf.toUpperCase()}`,
        symbol: 'XAUUSD',
        timeframe: tf,
        verdict: r.verdict != null ? String(r.verdict) : 'unknown',
        reasonCodes,
        primaryReason,
        ageMin: Number.isFinite(Number(r.ageMin)) ? Number(r.ageMin) : null,
        gapCount: Number.isFinite(Number(r.gapCount)) ? Number(r.gapCount) : 0,
        maxGapBars: Number.isFinite(Number(r.maxGapBars)) ? Number(r.maxGapBars) : 0,
        barCount: Number.isFinite(Number(r.barCount)) ? Number(r.barCount) : 0,
      });
    }
    return tfOrder.map((tf) => byTf.get(tf)).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function countPendingOwnerApprovals(ownerApprovalQueue) {
  const items = Array.isArray(ownerApprovalQueue && ownerApprovalQueue.items)
    ? ownerApprovalQueue.items
    : [];
  return items.filter((it) => {
    const st = safeString(it && it.status, '').toLowerCase();
    return st === 'pending' || st === 'pending_review';
  }).length;
}

/** Transition alerts that must not block owner_approval / execution_readiness (ops-only; see opsAlerts.js). */
const OWNER_PHASE_NON_BLOCKING_TRANSITION_CODES = new Set(['lagging_pressure']);

/**
 * @returns {{ total: number, blocking: number, nonBlockingIgnored: number }}
 */
function ownerTransitionAlertRollup(ownerTransitionAlerts) {
  const alerts = Array.isArray(ownerTransitionAlerts && ownerTransitionAlerts.alerts)
    ? ownerTransitionAlerts.alerts
    : [];
  let blocking = 0;
  let nonBlockingIgnored = 0;
  for (const a of alerts) {
    const code = safeString(a && a.code, '').trim().toLowerCase();
    if (OWNER_PHASE_NON_BLOCKING_TRANSITION_CODES.has(code)) nonBlockingIgnored += 1;
    else blocking += 1;
  }
  return { total: alerts.length, blocking, nonBlockingIgnored };
}

function buildProgressExecutorDryRunSummary() {
  const empty = {
    status: 'dry_run_unknown',
    evaluatedActionCount: 0,
    eligibleActionCount: 0,
    blockedOwnerCount: 0,
    blockedPolicyCount: 0,
    blockedQuotaCount: 0,
    skippedCount: 0,
    topEligibleActionIds: [],
    topBlockedActionIds: [],
  };
  const filePath = path.join(outDir, 'progress_executor_dry_run.json');
  try {
    if (!fs.existsSync(filePath)) return empty;
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(j && j.results) ? j.results : [];
    const topEligible = rows
      .filter((r) => r && r.decision === 'eligible')
      .sort((a, b) => {
        const pa = Number.isFinite(Number(a && a.inputPriority)) ? Number(a.inputPriority) : Number.MAX_SAFE_INTEGER;
        const pb = Number.isFinite(Number(b && b.inputPriority)) ? Number(b.inputPriority) : Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        return safeString(a && a.id).localeCompare(safeString(b && b.id));
      })
      .slice(0, 5)
      .map((r) => safeString(r && r.id))
      .filter(Boolean);
    const topBlocked = rows
      .filter((r) => r && (r.decision === 'blocked_owner' || r.decision === 'blocked_policy' || r.decision === 'blocked_quota'))
      .sort((a, b) => {
        const pa = Number.isFinite(Number(a && a.inputPriority)) ? Number(a.inputPriority) : Number.MAX_SAFE_INTEGER;
        const pb = Number.isFinite(Number(b && b.inputPriority)) ? Number(b.inputPriority) : Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb;
        return safeString(a && a.id).localeCompare(safeString(b && b.id));
      })
      .slice(0, 5)
      .map((r) => safeString(r && r.id))
      .filter(Boolean);
    return {
      status: safeString(j && j.status, 'dry_run_unknown'),
      evaluatedActionCount: safeNumber(j && j.evaluatedActionCount, rows.length),
      eligibleActionCount: safeNumber(j && j.eligibleActionCount, rows.filter((r) => r && r.decision === 'eligible').length),
      blockedOwnerCount: rows.filter((r) => r && r.decision === 'blocked_owner').length,
      blockedPolicyCount: rows.filter((r) => r && r.decision === 'blocked_policy').length,
      blockedQuotaCount: rows.filter((r) => r && r.decision === 'blocked_quota').length,
      skippedCount: safeNumber(j && j.skippedActionCount, rows.filter((r) => r && String(r.decision || '').startsWith('skipped_')).length),
      topEligibleActionIds: topEligible,
      topBlockedActionIds: topBlocked,
    };
  } catch (_) {
    return empty;
  }
}

function round2(n) {
  return Number((safeNumber(n, 0)).toFixed(2));
}

/**
 * Observability only: rank, gap, top/outlier lists. Mutates strategyValidation.rows in place.
 * Does not change strict score, tier, or promotableCount.
 */
function enrichStrategyValidationLearningObservability(strategyValidation, opts = {}) {
  const topN = Number(opts.topN) > 0 ? Math.floor(Number(opts.topN)) : 5;
  const outlierMinGap = Number(opts.outlierMinGap) > 0 ? Number(opts.outlierMinGap) : 10;
  const sv = strategyValidation && typeof strategyValidation === 'object' ? strategyValidation : {};
  const rows = Array.isArray(sv.rows) ? sv.rows : [];

  const withGap = rows.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const ls = Number(r.learningScore);
    const ss = Number(r.score);
    const gap =
      Number.isFinite(ls) && Number.isFinite(ss) ? Number((ls - ss).toFixed(4)) : null;
    return { ...r, strictVsLearningGap: gap, gap };
  });

  const sorted = [...withGap].filter((r) => r && typeof r === 'object').sort((a, b) => {
    const ld = safeNumber(b.learningScore, -1e9) - safeNumber(a.learningScore, -1e9);
    if (ld !== 0) return ld;
    return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
  });

  const rankMap = new Map();
  sorted.forEach((r, idx) => {
    rankMap.set(String(r.strategyId || ''), idx + 1);
  });

  sv.rows = withGap.map((r) => {
    if (!r || typeof r !== 'object') return r;
    return {
      ...r,
      learningScoreRank: rankMap.get(String(r.strategyId || '')) ?? null,
    };
  });

  const pickMini = (r) => ({
    strategyId: r.strategyId != null ? String(r.strategyId) : '',
    learningScore: Number.isFinite(Number(r.learningScore)) ? Number(r.learningScore) : null,
    score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
    gap: r.gap != null && Number.isFinite(Number(r.gap)) ? Number(r.gap) : null,
    learningTier: r.learningTier != null ? String(r.learningTier) : null,
    trades: Number.isFinite(Number(r.trades)) ? Number(r.trades) : null,
  });

  const learningTopStrategies = sorted.slice(0, topN).map(pickMini);
  const learningOutliers = sorted
    .filter((r) => r.gap != null && Number(r.gap) > outlierMinGap)
    .sort((a, b) => {
      const gd = safeNumber(b.gap, -1e9) - safeNumber(a.gap, -1e9);
      if (gd !== 0) return gd;
      return String(a.strategyId || '').localeCompare(String(b.strategyId || ''));
    })
    .map(pickMini);

  const n = sorted.length;
  let sumL = 0;
  let sumS = 0;
  let sumG = 0;
  let ng = 0;
  let minGap = null;
  let maxGap = null;
  for (const r of sorted) {
    if (Number.isFinite(Number(r.learningScore))) sumL += Number(r.learningScore);
    if (Number.isFinite(Number(r.score))) sumS += Number(r.score);
    if (r.gap != null && Number.isFinite(Number(r.gap))) {
      const g = Number(r.gap);
      sumG += g;
      ng += 1;
      if (minGap === null || g < minGap) minGap = g;
      if (maxGap === null || g > maxGap) maxGap = g;
    }
  }
  const summary = {
    avgLearningScore: n > 0 ? round2(sumL / n) : null,
    avgStrictScore: n > 0 ? round2(sumS / n) : null,
    avgGap: ng > 0 ? round2(sumG / ng) : null,
    minGap: minGap != null ? round2(minGap) : null,
    maxGap: maxGap != null ? round2(maxGap) : null,
    strategyCount: n,
    outlierThreshold: outlierMinGap,
    topN,
    sortTopBy: 'learningScore_desc_strategyId',
    gapFormula: 'learningScore_minus_strict_score',
  };

  sv.learningTopStrategies = learningTopStrategies;
  sv.learningOutliers = learningOutliers;
  sv.learningScoreSummary = summary;

  return {
    topStrategies: learningTopStrategies,
    outliers: learningOutliers,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

function buildValidationTargetMetadata(strategyValidation) {
  const payload = strategyValidation && typeof strategyValidation === 'object' ? strategyValidation : {};
  const upstreamTarget = payload.validationTarget && typeof payload.validationTarget === 'object'
    ? payload.validationTarget
    : {};
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const requiredRaw = upstreamTarget.requiredValidatedStrategies != null
    ? upstreamTarget.requiredValidatedStrategies
    : summary.requiredValidatedCount;
  const requiredValidatedStrategies = Number.isFinite(Number(requiredRaw))
    ? safeNumber(requiredRaw, null)
    : null;
  const isExplicit = upstreamTarget.isExplicit === true && requiredValidatedStrategies != null;
  return {
    requiredValidatedStrategies,
    source: isExplicit
      ? safeString(upstreamTarget.source, 'strategy_validation_framework')
      : 'strategy_validation_framework',
    isExplicit,
  };
}

function safeString(v, fallback = '') {
  return v == null ? fallback : String(v);
}

function positiveGap(required, current) {
  const req = safeNumber(required, 0);
  const cur = safeNumber(current, 0);
  return Math.max(0, req - cur);
}

function bool(v) {
  return v === true;
}

function gateScore(status, weight) {
  const w = Math.max(0, Math.floor(safeNumber(weight, 0)));
  if (status === 'ok') return w;
  if (status === 'degraded') return Math.floor(w * 0.5);
  return 0;
}

function buildGate(status, weight, summary, blocking) {
  const st = ['ok', 'degraded', 'blocked', 'unknown'].includes(status) ? status : 'unknown';
  const bl = blocking === true || st === 'blocked';
  return {
    status: st,
    weight,
    score: gateScore(st, weight),
    blocking: bl,
    summary: String(summary || ''),
  };
}

function buildPhaseTracker({
  runHealth,
  strategyValidation,
  promotionGuardSummary,
  ownerTransitionAlerts,
  ownerApprovalQueue,
  executionStatus,
}) {
  const staleCount = Array.isArray(runHealth && runHealth.staleDatasets) ? runHealth.staleDatasets.length : 0;
  const promotableCount = safeNumber(
    strategyValidation && strategyValidation.summary && strategyValidation.summary.promotableCount,
    0
  );
  const guardEvaluated = safeNumber(promotionGuardSummary && promotionGuardSummary.evaluated, 0);
  const guardRejected = safeNumber(promotionGuardSummary && promotionGuardSummary.rejected, 0);
  const ownerAlertRollup = ownerTransitionAlertRollup(ownerTransitionAlerts);
  const ownerBlockingAlertCount = ownerAlertRollup.blocking;
  const ownerQueueCount = countPendingOwnerApprovals(ownerApprovalQueue);
  const reconcHealthy = executionStatus && executionStatus.reconciliationHealthy === true;
  const brokerConnected = executionStatus && executionStatus.brokerConnected === true;

  const expl =
    strategyValidation &&
    strategyValidation.strictPaperGateExplainer &&
    typeof strategyValidation.strictPaperGateExplainer === 'object'
      ? strategyValidation.strictPaperGateExplainer
      : null;
  const validationBlockedSummary =
    promotableCount > 0
      ? null
      : expl && typeof expl.detail === 'string' && expl.detail.trim() !== ''
        ? `no paper promote_candidate — ${expl.detail} (strict tier, paper_trades.jsonl)`
        : 'no paper promote_candidate (strict tier, paper_trades.jsonl)';

  const gates = {
    dataFreshness: staleCount === 0
      ? buildGate('ok', 20, 'no stale datasets', false)
      : buildGate('blocked', 20, `${staleCount} stale dataset(s)`, true),
    validation: promotableCount > 0
      ? buildGate(
          'ok',
          25,
          `${promotableCount} paper promote_candidate strategy(ies) (paper_trades.jsonl strict tier)`,
          false
        )
      : buildGate(
          'blocked',
          25,
          validationBlockedSummary,
          true
        ),
    governance: guardEvaluated > 0
      ? (guardRejected > 0
        ? buildGate(
            'degraded',
            25,
            `batch/WF promotion guard: rejected ${guardRejected}/${guardEvaluated}`,
            false
          )
        : buildGate(
            'ok',
            25,
            `batch/WF promotion guard: evaluated ${guardEvaluated}, no rejects`,
            false
          ))
      : buildGate('unknown', 25, 'no batch/WF promotion guard evaluations', false),
    ownerApproval:
      ownerBlockingAlertCount > 0 || ownerQueueCount > 0
        ? buildGate(
            'blocked',
            20,
            `blocking transition alerts=${ownerBlockingAlertCount}, queuePending=${ownerQueueCount}`,
            true
          )
        : buildGate('ok', 20, 'no owner queue pending and no blocking transition alerts', false),
    execution: reconcHealthy && brokerConnected
      ? buildGate('ok', 10, 'broker connected and reconciliation healthy', false)
      : buildGate('degraded', 10, 'execution not fully ready', false),
  };

  const ordered = [
    ['data_freshness', gates.dataFreshness],
    ['validation', gates.validation],
    ['governance', gates.governance],
    ['owner_approval', gates.ownerApproval],
    ['execution_readiness', gates.execution],
  ];
  const firstBlocking = ordered.find(([, g]) => g.blocking === true) || null;
  const currentPhase = firstBlocking ? firstBlocking[0] : 'execution_readiness';
  const nextPhaseMap = {
    data_freshness: 'validation',
    validation: 'governance',
    governance: 'owner_approval',
    owner_approval: 'execution_readiness',
    execution_readiness: 'none',
  };
  const nextPhase = nextPhaseMap[currentPhase] || 'unknown';
  const totalWeight = ordered.reduce((acc, [, g]) => acc + safeNumber(g.weight, 0), 0);
  const achieved = ordered.reduce((acc, [, g]) => acc + safeNumber(g.score, 0), 0);
  const unlockProgressPct = totalWeight > 0 ? round2((achieved * 100) / totalWeight) : 0;
  const isUnlocked = firstBlocking == null;
  const blockingReasons = ordered
    .filter(([, g]) => g.blocking === true)
    .map(([name, g]) => `${name}:${g.summary}`);

  return {
    currentPhase,
    nextPhase,
    unlockProgressPct,
    isUnlocked,
    headlineStatus: isUnlocked ? 'ready' : 'blocked',
    primaryBlocker: blockingReasons.length ? blockingReasons[0] : null,
    blockingReasons,
    gates,
    ownerTransitionAlertRollup: {
      ...ownerAlertRollup,
      queuePending: ownerQueueCount,
      nonBlockingCodesIgnored: Array.from(OWNER_PHASE_NON_BLOCKING_TRANSITION_CODES),
    },
    /** Read-only projection hints: validation gate count ≠ promotionGuard.passed (distinct universes). */
    semanticHints: {
      validationGate:
        'paper_trades.jsonl strict promote_candidate (summary.promotableCount) — not promotionGuard.passed',
      governanceGate: 'batch/WF guard on promoted_children evaluation — distinct from paper tier',
    },
    generatedAt: new Date().toISOString(),
  };
}

function buildPhaseActionPlan({
  phaseTracker,
  runHealth,
  datasetFreshness,
  strategyValidation,
  promotionGuardSummary,
  ownerTransitionAlerts,
  ownerApprovalQueue,
  executionStatus,
}) {
  try {
    const pt = phaseTracker && typeof phaseTracker === 'object' ? phaseTracker : null;
    const currentPhase = safeString(pt && pt.currentPhase, 'unknown');
    const nextPhase = safeString(pt && pt.nextPhase, 'unknown');
    const blockers = Array.isArray(pt && pt.blockingReasons) ? pt.blockingReasons.map((x) => safeString(x)) : [];
    const gates = pt && pt.gates && typeof pt.gates === 'object' ? pt.gates : {};
    const actions = [];

    const staleRunCount = Array.isArray(runHealth && runHealth.staleDatasets) ? runHealth.staleDatasets.length : 0;
    const staleFreshnessCount = safeNumber(
      datasetFreshness && datasetFreshness.summary && datasetFreshness.summary.staleCount,
      0
    );
    const staleCount = Math.max(staleRunCount, staleFreshnessCount);

    const valSummary = strategyValidation && strategyValidation.summary && typeof strategyValidation.summary === 'object'
      ? strategyValidation.summary
      : {};
    const validatedCount = safeNumber(valSummary.validatedCount, null);
    const promotableCount = safeNumber(valSummary.promotableCount, 0);
    const validationTarget = strategyValidation &&
      strategyValidation.validationTarget &&
      typeof strategyValidation.validationTarget === 'object'
      ? strategyValidation.validationTarget
      : {};
    const validationRequiredRaw = validationTarget.requiredValidatedStrategies;
    const validationTargetExplicit = validationTarget.isExplicit === true;
    const validationRequired = validationTargetExplicit && Number.isFinite(Number(validationRequiredRaw))
      ? safeNumber(validationRequiredRaw, 0)
      : null;
    const validationCurrentRaw = strategyValidation &&
      strategyValidation.validationCurrent &&
      typeof strategyValidation.validationCurrent === 'object'
      ? strategyValidation.validationCurrent.validatedStrategies
      : null;
    const validationCurrent = Number.isFinite(Number(validationCurrentRaw))
      ? safeNumber(validationCurrentRaw, 0)
      : (validatedCount != null ? validatedCount : promotableCount);
    const validationMissing = validationRequired == null
      ? null
      : positiveGap(validationRequired, validationCurrent);

    const guardEvaluated = safeNumber(promotionGuardSummary && promotionGuardSummary.evaluated, 0);
    const guardPassed = safeNumber(promotionGuardSummary && promotionGuardSummary.passed, 0);
    const guardRejected = safeNumber(promotionGuardSummary && promotionGuardSummary.rejected, 0);
    const promotionRequiredRaw = promotionGuardSummary && promotionGuardSummary.requiredPromotions;
    const promotionRequired = Number.isFinite(Number(promotionRequiredRaw))
      ? safeNumber(promotionRequiredRaw, 0)
      : null;
    const promotionMissing = promotionRequired == null ? null : positiveGap(promotionRequired, guardPassed);
    const dominantReject = promotionGuardSummary &&
      promotionGuardSummary.dominantRejectReason &&
      typeof promotionGuardSummary.dominantRejectReason === 'object'
      ? promotionGuardSummary.dominantRejectReason
      : null;
    const dominantRejectAlert = bool(
      (promotionGuardSummary && promotionGuardSummary.dominantRejectReasonAlert) ||
      (dominantReject && dominantReject.alert)
    );

    const ownerQueueCount = countPendingOwnerApprovals(ownerApprovalQueue);
    const ownerAlertRollupPlan = ownerTransitionAlertRollup(ownerTransitionAlerts);
    const ownerBlockingAlertCount = ownerAlertRollupPlan.blocking;
    const ownerPendingCount = ownerQueueCount + ownerBlockingAlertCount;

    const executionReady = bool(executionStatus && executionStatus.reconciliationHealthy) &&
      bool(executionStatus && executionStatus.brokerConnected);

    const pushAction = (a) => {
      actions.push({
        id: safeString(a.id, 'unknown_action'),
        type: safeString(a.type, 'research_expansion'),
        title: safeString(a.title, 'Action'),
        reasonCode: safeString(a.reasonCode, 'UNSPECIFIED'),
        gate: safeString(a.gate, 'unknown'),
        priorityClass: safeNumber(a.priorityClass, 8),
        blockingType: safeString(a.blockingType, 'informational'),
        ownerApprovalRequired: bool(a.ownerApprovalRequired),
        status: safeString(a.status, 'planned'),
        required: a.required == null ? null : safeNumber(a.required, null),
        current: a.current == null ? null : safeNumber(a.current, null),
        missing: a.missing == null ? null : safeNumber(a.missing, null),
        unit: safeString(a.unit, 'unknown'),
        action: safeString(a.action, 'inspect_state'),
        suggestedSteps: Array.isArray(a.suggestedSteps) ? a.suggestedSteps.slice(0, 3).map((s) => safeString(s)) : [],
        successCondition: safeString(a.successCondition, ''),
        notes: safeString(a.notes, ''),
      });
    };

    if (staleCount > 0 || (gates.dataFreshness && gates.dataFreshness.blocking === true)) {
      pushAction({
        id: 'data_freshness_gap',
        type: 'data_repair',
        title: 'Refresh stale datasets',
        reasonCode: 'DATA_FRESHNESS_BLOCK',
        gate: 'dataFreshness',
        priorityClass: 4,
        blockingType: 'auto_fixable',
        ownerApprovalRequired: false,
        status: 'planned',
        required: 0,
        current: staleCount,
        missing: positiveGap(staleCount, 0),
        unit: 'critical_stale_datasets',
        action: 'refresh_required_datasets',
        suggestedSteps: [
          'Refresh stale required datasets',
          'Rebuild freshness summary',
          'Verify stale/degraded count returns to acceptable level',
        ],
        successCondition: 'No critical stale required dataset remains',
      });
    }

    if (validationRequired != null && validationMissing != null && validationMissing > 0) {
      pushAction({
        id: 'validation_count_gap',
        type: 'validation_growth',
        title: 'Add validated strategies',
        reasonCode: 'VALIDATION_COUNT_GAP',
        gate: 'validation',
        priorityClass: 3,
        blockingType: 'auto_fixable',
        ownerApprovalRequired: false,
        status: 'planned',
        required: validationRequired,
        current: validationCurrent,
        missing: validationMissing,
        unit: 'strategies',
        action: 'acquire_and_validate_strategies',
        suggestedSteps: [
          'Generate or import additional candidate strategies',
          'Run validation for the missing count',
          'Recompute validation summary',
        ],
        successCondition: 'Validated strategy count reaches the explicit required threshold',
        notes: 'Target sourced from validationTarget.requiredValidatedStrategies',
      });
    } else if (gates.validation && gates.validation.blocking === true && promotableCount <= 0) {
      pushAction({
        id: 'validation_unknown_gap',
        type: 'validation_growth',
        title: 'Review strict paper promote_candidate readiness',
        reasonCode: 'VALIDATION_READINESS_REVIEW',
        gate: 'validation',
        priorityClass: 3,
        blockingType: 'informational',
        ownerApprovalRequired: false,
        status: 'planned',
        required: null,
        current: promotableCount,
        missing: null,
        unit: 'paper_promote_candidate_count',
        action: 'inspect_paper_promotion_tier',
        suggestedSteps: [
          'Inspect governance/paper_trades.jsonl and promotion-mode tier rules',
          'Compare with batch/WF promotion guard (promoted_children) — separate metric',
          'Re-export ops snapshot after paper trade or tier context changes',
        ],
        successCondition: 'Paper strict tier vs batch guard distinction is explicit for operators',
        notes: 'promotableCount here is paper promote_candidate only; promotionGuard.passed is batch/WF',
      });
    }

    if (promotionRequired != null && promotionMissing != null && promotionMissing > 0) {
      pushAction({
        id: 'promotion_gap',
        type: 'promotion_growth',
        title: 'Increase promotion-ready candidates',
        reasonCode: 'PROMOTION_TARGET_GAP',
        gate: 'governance',
        priorityClass: 5,
        blockingType: 'auto_fixable',
        ownerApprovalRequired: false,
        status: 'planned',
        required: promotionRequired,
        current: guardPassed,
        missing: promotionMissing,
        unit: 'promotions',
        action: 'generate_promotable_candidates',
        suggestedSteps: [
          'Expand candidate search for promotion-ready strategies',
          'Run promotion guard on new candidates',
          'Recompute promoted children summary',
        ],
        successCondition: 'Promotion-ready count reaches required threshold',
      });
    } else if (dominantRejectAlert || (gates.governance && gates.governance.status === 'degraded' && guardRejected > 0)) {
      pushAction({
        id: 'governance_reject_dominance',
        type: 'governance_resolution',
        title: 'Reduce reject dominance',
        reasonCode: dominantRejectAlert ? 'DOMINANT_REJECT_REASON' : 'PROMOTION_QUALITY_GAP',
        gate: 'governance',
        priorityClass: 2,
        blockingType: 'mixed',
        ownerApprovalRequired: false,
        status: 'planned',
        required: 0,
        current: guardRejected,
        missing: positiveGap(guardRejected, 0),
        unit: 'rejections',
        action: 'reduce_reject_dominance',
        suggestedSteps: [
          'Inspect dominant rejection reason in promotion guard summary',
          'Run targeted candidate batch aligned with guard criteria',
          'Recompute promotion guard summary',
        ],
        successCondition: 'Dominant reject reason alert is no longer active',
      });
    }

    if (ownerPendingCount > 0 || (gates.ownerApproval && gates.ownerApproval.blocking === true)) {
      pushAction({
        id: 'owner_approval_gap',
        type: 'owner_decision',
        title: 'Obtain owner approval',
        reasonCode: 'OWNER_APPROVAL_PENDING',
        gate: 'ownerApproval',
        priorityClass: 1,
        blockingType: 'owner_gated',
        ownerApprovalRequired: true,
        status: 'blocked_pending_owner',
        required: 0,
        current: ownerPendingCount,
        missing: positiveGap(ownerPendingCount, 0),
        unit: 'pending_approvals',
        action: 'request_owner_decision',
        suggestedSteps: [
          'Review pending owner approval item',
          'Approve or reject the queued transition',
          'Re-export owner approval snapshot',
        ],
        successCondition: 'No owner approval required for the next phase',
      });
    }

    if (!executionReady || (gates.execution && gates.execution.status === 'degraded')) {
      pushAction({
        id: 'execution_gap',
        type: 'execution_recovery',
        title: 'Recover execution health',
        reasonCode: 'EXECUTION_STATUS_BLOCK',
        gate: 'execution',
        priorityClass: 6,
        blockingType: 'auto_fixable',
        ownerApprovalRequired: false,
        status: 'planned',
        required: 0,
        current: executionReady ? 0 : 1,
        missing: executionReady ? 0 : 1,
        unit: 'execution_blockers',
        action: 'recover_execution_pipeline',
        suggestedSteps: [
          'Inspect execution status failure',
          'Repair the failing runtime/export step',
          'Re-run the latest ops export',
        ],
        successCondition: 'Execution pipeline returns to healthy state',
      });
    }

    const dedup = new Map();
    for (const a of actions) {
      if (!dedup.has(a.id)) dedup.set(a.id, a);
    }
    const sorted = Array.from(dedup.values()).sort((a, b) => {
      if (a.priorityClass !== b.priorityClass) return a.priorityClass - b.priorityClass;
      const am = a.missing == null ? -1 : safeNumber(a.missing, -1);
      const bm = b.missing == null ? -1 : safeNumber(b.missing, -1);
      if (am !== bm) return bm - am;
      return a.id.localeCompare(b.id);
    });
    const trimmed = sorted.slice(0, 8).map((a, idx) => {
      const out = { ...a, priority: idx + 1 };
      delete out.priorityClass;
      return out;
    });

    const primaryObjective = trimmed.length > 0 ? trimmed[0] : null;
    const primaryTechnicalBlocker = safeString(
      (pt && pt.primaryBlocker) || (blockers.length ? blockers[0] : ''),
      ''
    ) || null;
    const primaryExecutionBlocker = primaryObjective
      ? {
          id: safeString(primaryObjective.id, 'unknown_action'),
          reasonCode: safeString(primaryObjective.reasonCode, 'UNSPECIFIED'),
          gate: safeString(primaryObjective.gate, 'unknown'),
          ownerApprovalRequired: bool(primaryObjective.ownerApprovalRequired),
          blockingType: safeString(primaryObjective.blockingType, 'informational'),
          title: safeString(primaryObjective.title, 'Action'),
        }
      : null;
    const blockerAlignment = primaryTechnicalBlocker == null || primaryExecutionBlocker == null
      ? 'none'
      : (primaryTechnicalBlocker.toLowerCase().includes(String(primaryExecutionBlocker.gate || '').toLowerCase())
        ? 'aligned'
        : 'diverged');
    const ownerApprovalRequired = trimmed.some((a) => a.ownerApprovalRequired === true);
    const blockingActions = trimmed.filter((a) => ['auto_fixable', 'owner_gated', 'mixed'].includes(a.blockingType));
    const autoFixable = blockingActions.length === 0
      ? true
      : blockingActions.every((a) => a.blockingType === 'auto_fixable' || a.blockingType === 'mixed');

    let status = 'unknown';
    if (trimmed.length === 0) status = 'monitoring';
    else if (primaryObjective && primaryObjective.ownerApprovalRequired === true) status = 'blocked_by_owner';
    else if (trimmed.some((a) => a.blockingType === 'auto_fixable' || a.blockingType === 'mixed')) {
      status = 'ready_for_auto_progress';
    } else {
      status = 'idle';
    }

    let summary = 'No actionable gap detected from current artifacts';
    if (status === 'blocked_by_owner') {
      const parts = [];
      if (ownerQueueCount > 0) {
        parts.push(`${ownerQueueCount} queued approval(s)`);
      }
      if (ownerBlockingAlertCount > 0) {
        parts.push(`${ownerBlockingAlertCount} blocking transition alert(s)`);
      }
      summary =
        parts.length > 0
          ? `Next phase blocked: ${parts.join(' + ')}`
          : 'Next phase blocked by owner gate (see phase tracker)';
    } else if (trimmed.length > 0) {
      const top = trimmed.slice(0, 2).map((a) => a.title).join(' + ');
      summary = `Next phase requires: ${top}`;
    }
    if (blockerAlignment === 'diverged' && primaryTechnicalBlocker) {
      summary += ` (technical blocker: ${primaryTechnicalBlocker})`;
    }

    return {
      mode: 'passive_planning',
      status,
      currentPhase,
      nextPhase,
      goal: nextPhase && nextPhase !== 'unknown' ? `unlock_${nextPhase}` : 'unlock_next_phase',
      summary,
      primaryObjective,
      primaryTechnicalBlocker,
      primaryExecutionBlocker,
      blockerAlignment,
      autoFixable,
      ownerApprovalRequired,
      recommendedActionCount: trimmed.length,
      actions: trimmed,
      generatedAt: new Date().toISOString(),
    };
  } catch (_) {
    return {
      mode: 'passive_planning',
      status: 'unknown',
      currentPhase: 'unknown',
      nextPhase: 'unknown',
      goal: 'unlock_next_phase',
      summary: 'Insufficient data to build action plan',
      primaryObjective: null,
      primaryTechnicalBlocker: null,
      primaryExecutionBlocker: null,
      blockerAlignment: 'none',
      autoFixable: true,
      ownerApprovalRequired: false,
      recommendedActionCount: 0,
      actions: [],
      generatedAt: new Date().toISOString(),
    };
  }
}

if (process.env.NEUROPILOT_DEBUG_EXPORT_OPS === '1' || String(process.env.NEUROPILOT_DEBUG_EXPORT_OPS || '').toLowerCase() === 'true') {
  console.error(
    JSON.stringify({
      event: 'export_ops_snapshot_paths',
      cwd: process.cwd(),
      opsSnapshotDir: outDir,
      dataRoot: datasetManifest.getDataRoot(),
      manifestPath: path.join(datasetManifest.getDataRoot(), 'datasets_manifest.json'),
    })
  );
}

const data = loadData();
const generatedAt = new Date().toISOString();
const paperExecV1ObsForLatest = exportPaperExecV1ArtifactsForOps(generatedAt);
const trendPoints = Math.max(1, Math.min(200, Number(process.argv[2]) || 50));
const strategyValidation = computeStrategyValidationFromFile(
  path.join(datasetManifest.getDataRoot(), 'governance', 'paper_trades.jsonl')
);
strategyValidation.validationTarget = buildValidationTargetMetadata(strategyValidation);
if (!strategyValidation.validationCurrent || typeof strategyValidation.validationCurrent !== 'object') {
  strategyValidation.validationCurrent = {
    validatedStrategies: safeNumber(
      strategyValidation &&
      strategyValidation.summary &&
      strategyValidation.summary.promotableCount,
      0
    ),
  };
}
const learningInsights = enrichStrategyValidationLearningObservability(strategyValidation, {
  topN: Number(process.env.NEUROPILOT_LEARNING_INSIGHTS_TOP_N) || 5,
  outlierMinGap: Number(process.env.NEUROPILOT_LEARNING_OUTLIER_GAP) || 10,
});
const evolutionTsForHybrid = data.length > 0 ? data[data.length - 1].ts : null;
const { hybridPromotionInsights, auditRecord: hybridPromotionAudit } = enrichStrategyValidationHybridPromotion(
  strategyValidation,
  { generatedAt, evolutionTs: evolutionTsForHybrid }
);
try {
  const govAuditDir = path.join(datasetManifest.getDataRoot(), 'governance');
  fs.mkdirSync(govAuditDir, { recursive: true });
  fs.writeFileSync(
    path.join(govAuditDir, 'hybrid_promotion_review.json'),
    JSON.stringify(hybridPromotionAudit, null, 2),
    'utf8'
  );
} catch (err) {
  console.warn('[exportOpsSnapshot] hybrid_promotion_review.json write failed:', err && err.message ? err.message : err);
}
writeJson('strategy_validation.json', strategyValidation);
writeJson('hybrid_promotion_insights.json', hybridPromotionInsights);
const hybridReviewQueue = buildHybridReviewQueue({
  strategyValidation,
  hybridPromotionInsights,
  generatedAt,
  evolutionTs: evolutionTsForHybrid,
  dataRoot: datasetManifest.getDataRoot(),
  opsSnapshotDir: outDir,
  fs,
});
writeJson('hybrid_review_queue.json', hybridReviewQueue);
const promotionGuardSummary = buildPromotionGuardSummary();
const promotionGuardTopRejectedReasons = buildTopRejectedReasons(
  promotionGuardSummary.rejectedByReason,
  5
);
const dominantRejectReason = computeDominantRejectReason(
  promotionGuardSummary.rejectedByReason
);
promotionGuardSummary.dominantRejectReason = dominantRejectReason;
promotionGuardSummary.dominantRejectReasonAlert = Boolean(dominantRejectReason.alert);
const wfMissingBreakdownFields = buildWalkForwardMissingBreakdown({
  rejectedByReason: promotionGuardSummary.rejectedByReason,
  wfMissingDiagnosticSummary:
    promotionGuardSummary.wfMissingDiagnosticSummary &&
    Object.keys(promotionGuardSummary.wfMissingDiagnosticSummary).length > 0
      ? promotionGuardSummary.wfMissingDiagnosticSummary
      : null,
});
if (wfMissingBreakdownFields) {
  Object.assign(promotionGuardSummary, wfMissingBreakdownFields);
}
const contextGuardSummary = promotionGuardSummary.contextGuardSummary || summarizeContextGuardRows(null);
writeJson('promotion_guard_summary.json', promotionGuardSummary);
const strategyInbox = buildStrategyInboxPayload();
writeJson('strategy_inbox.json', strategyInbox);

// ---------- latest.json ----------
const last = data.length > 0 ? data[data.length - 1] : null;
const datasetFreshness = buildDatasetFreshnessPayload();
writeJson('datasets_freshness.json', datasetFreshness);

try {
  const { writeTickerDiscoveryOpsSnapshot } = require('../../governance/buildTickerDiscoverySnapshot');
  writeTickerDiscoveryOpsSnapshot({
    opsSnapshotDir: outDir,
    generatedAt,
    dataRoot: datasetManifest.getDataRoot(),
  });
  console.log('  ticker_discovery.json (market-intelligence V1)');
} catch (err) {
  console.warn(
    '[exportOpsSnapshot] ticker_discovery.json skipped:',
    err && err.message ? err.message : err
  );
}

try {
  const { buildExecutionPipelineSnapshotPayload } = require('../../execution/buildExecutionPipelineSnapshot');
  const ep = buildExecutionPipelineSnapshotPayload({ generatedAt, env: process.env });
  writeJson('execution_pipeline.json', ep);
  console.log('  execution_pipeline.json (execution pipeline V1 metrics)');
} catch (err) {
  console.warn(
    '[exportOpsSnapshot] execution_pipeline.json skipped:',
    err && err.message ? err.message : err
  );
}

const executionStatus = buildExecutionStatusSnapshot();
writeJson('execution_status.json', executionStatus);
const xauDatasetDiagnostics = buildXauDatasetDiagnosticsPayload();
const progressExecutorDryRunSummary = buildProgressExecutorDryRunSummary();

const runHealth = loadJsonOptionalFromDir(outDir, 'run_health.json');
const checkpointPrev = readCheckpoint();
const transitionEval = evaluateOpsAlerts(executionStatus, runHealth, checkpointPrev, datasetFreshness);
writeJson('owner_transition_alerts.json', {
  generatedAt,
  baselineOnly: Boolean(transitionEval.baselineOnly),
  alerts: transitionEval.alerts,
});

writeOwnerApprovalQueue(outDir, generatedAt);
writeOwnerApprovalSummary(outDir, generatedAt);
const ownerTransitionAlerts = loadJsonOptionalFromDir(outDir, 'owner_transition_alerts.json');
const ownerApprovalQueue = loadJsonOptionalFromDir(outDir, 'owner_approval_queue.json');
const phaseTracker = buildPhaseTracker({
  runHealth,
  strategyValidation,
  promotionGuardSummary,
  ownerTransitionAlerts,
  ownerApprovalQueue,
  executionStatus,
});
const phaseActionPlan = buildPhaseActionPlan({
  phaseTracker,
  runHealth,
  datasetFreshness,
  strategyValidation,
  promotionGuardSummary,
  ownerTransitionAlerts,
  ownerApprovalQueue,
  executionStatus,
});

if (last) {
  writeJson('latest.json', {
    ts: last.ts,
    champions: last.champions,
    validated: last.validated,
    delta: last.delta,
    wildcardPromotions: last.wildcardPromotions,
    diversityCapped: last.diversityCapped,
    maxChampionsInOneFamily: last.maxChampionsInOneFamily,
    consistencyOk: last.consistencyOk,
    learningScore: last.learningScore ?? null,
    explorationScore: last.explorationScore ?? null,
    adaptationScore: last.adaptationScore ?? null,
    marketRegime: last.marketRegime ?? null,
    marketVolatility: last.marketVolatility ?? null,
    marketTrend: last.marketTrend ?? null,
    effectiveMinDelta: last.effectiveMinDelta ?? null,
    effectiveMaxPromotions: last.effectiveMaxPromotions ?? null,
    stagnationIsStagnating: last.stagnationIsStagnating ?? null,
    stagnationAvgDelta: last.stagnationAvgDelta ?? null,
    stagnationZeroPromotions: last.stagnationZeroPromotions ?? null,
    evolutionGuard: last.evolutionGuard ?? null,
    generatedAt,
    datasetFreshness,
    strategyValidationSummary: strategyValidation.summary || null,
    strategyTopPromotable: strategyValidation.topPromotable || [],
    strategyTopWatchlist: strategyValidation.topWatchlist || [],
    strategyTransitionCandidates: strategyValidation.transitionCandidates || [],
    strategyValidationFunnel: strategyValidation.validationFunnel || null,
    strategyValidationBlockers: strategyValidation.whatBlocksPromotion || null,
    strategyInbox,
    strategyValidationModesSummary: strategyValidation.modes
      ? {
          research: strategyValidation.modes.research?.summary || null,
          promotion: strategyValidation.modes.promotion?.summary || null,
        }
      : null,
    promotionGuardSummary,
    contextGuardSummary,
    promotionGuardTopRejectedReasons,
    phaseTracker,
    phaseActionPlan,
    progressExecutorDryRunSummary,
    xauDatasetDiagnostics,
    executionStatus,
    learningInsights,
    hybridPromotionInsights,
    hybridReviewQueue,
    paperExecutionV1Observability: paperExecV1ObsForLatest,
  });
}

// ---------- trend.json ----------
const slice = data.slice(-trendPoints);
writeJson('trend.json', {
  points: slice.length,
  rows: slice.map((r) => ({
    ts: r.ts,
    delta: r.delta,
    champions: r.champions,
    validated: r.validated,
    wildcardPromotions: r.wildcardPromotions ?? 0,
    diversityCapped: r.diversityCapped,
    maxChampionsInOneFamily: r.maxChampionsInOneFamily,
    consistencyOk: r.consistencyOk,
    evolutionGuard: r.evolutionGuard ?? null,
  })),
  laggingCount: datasetFreshness.laggingSummary != null ? datasetFreshness.laggingSummary.count : 0,
  generatedAt,
});

// ---------- alerts.json ----------
const ALERT_DELTA = -0.003;
const ALERT_WILDCARD_RUNS = 10;
const ALERT_MAX_FAMILY = 4;
const lastN = data.slice(-Math.max(ALERT_WILDCARD_RUNS, 1));
const delta = last ? (last.delta ?? 0) : 0;
const wcInactive =
  lastN.length >= ALERT_WILDCARD_RUNS &&
  lastN.every((r) => (r.wildcardPromotions || 0) === 0);
const maxFamily = last ? (last.maxChampionsInOneFamily || 0) : 0;

const items = [];
if (delta < ALERT_DELTA) {
  items.push({ type: 'delta', status: 'alert', message: `Delta fortement négatif (${delta})` });
} else {
  items.push({ type: 'delta', status: 'ok', message: 'Delta acceptable' });
}
if (wcInactive) {
  items.push({
    type: 'wildcard',
    status: 'alert',
    message: `Wildcard inactif sur ${lastN.length} runs`,
  });
} else {
  items.push({ type: 'wildcard', status: 'ok', message: 'Wildcard actif ou peu de runs' });
}
if (maxFamily > ALERT_MAX_FAMILY) {
  items.push({
    type: 'diversity',
    status: 'alert',
    message: `Concentration famille élevée (${maxFamily})`,
  });
} else {
  items.push({ type: 'diversity', status: 'ok', message: 'Diversité stable' });
}
if (last && last.consistencyOk === false) {
  items.push({ type: 'audit', status: 'alert', message: 'Audit FAILED' });
} else {
  items.push({ type: 'audit', status: 'ok', message: 'Audit OK' });
}

const wfBrAlert =
  promotionGuardSummary.walkForwardMissingBreakdown &&
  promotionGuardSummary.walkForwardMissingBreakdown.alert === true;
if (wfBrAlert) {
  items.push({
    type: 'promotion_guard_wf_missing',
    status: 'alert',
    code: 'WF_MISSING_ANOMALOUS_SUBCAUSES',
    severity: 'warn',
    message:
      promotionGuardSummary.walkForwardMissingBreakdown.alertReason ||
      'Walk-forward missing rejects show anomalous upstream subcauses (NOT_GENERATED / KEY_MISMATCH / UNKNOWN); see walkForwardMissingBreakdown in promotion guard summary.',
  });
}

writeJson('alerts.json', {
  generatedAt,
  items,
});

// ---------- milestones.json ----------
const firstWildcard = data.find((r) => (r.wildcardPromotions || 0) > 0);
const deltas = data.map((r) => r.delta).filter((d) => d != null && Number.isFinite(d));
const bestDelta = deltas.length ? Math.max(...deltas) : null;
const worstDelta = deltas.length ? Math.min(...deltas) : null;
const maxChampions = data.length ? Math.max(...data.map((r) => r.champions || 0)) : 0;
const maxFamilyConcentration = data.length
  ? Math.max(...data.map((r) => r.maxChampionsInOneFamily || 0))
  : 0;

writeJson('milestones.json', {
  firstWildcardTs: firstWildcard ? firstWildcard.ts : null,
  bestDelta,
  worstDelta,
  maxChampions,
  maxFamilyConcentration,
  generatedAt,
});

console.log('Ops snapshot written to', outDir);
console.log(
  '  latest.json, trend.json, alerts.json, milestones.json, datasets_freshness.json, ticker_discovery.json, execution_pipeline.json, strategy_validation.json, hybrid_promotion_insights.json, hybrid_review_queue.json, execution_status.json, owner_transition_alerts.json, owner_approval_queue.json, paper_exec_v1_observability.json (+ governance paper_exec_* copies when present)'
);

try {
  const g = buildGovernanceDashboard({ outDir });
  console.log('  governance_dashboard.json, governance_dashboard.html (P8.1) · discovery/promoted_manifest_coverage.json via dashboard build');
  console.log('   ', g.htmlPath);
} catch (err) {
  console.warn('[WARN] P8 governance dashboard:', err && err.message ? err.message : err);
}
