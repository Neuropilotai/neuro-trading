#!/usr/bin/env node
'use strict';

/**
 * P8 / P8.1 — Governance / Research dashboard
 * Aggregates latest governance artefacts into ops-snapshot for a single operational view.
 *
 * Outputs (default: neuropilot_trading_v2/ops-snapshot/):
 *   - governance_dashboard.json
 *   - governance_dashboard.html  (self-contained, open locally; data embedded as base64)
 *
 * Usage (from neuropilot_trading_v2):
 *   node engine/governance/buildGovernanceDashboard.js
 *
 * NEUROPILOT_DATA_ROOT respected (same as data engine).
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const p5Metrics = require('../observability/p5Metrics');
const policyMetrics = require('../observability/policyMetrics');
const governorMetrics = require('../observability/governorMetrics');
const p7Metrics = require('../observability/p7Metrics');
const p7GuardMetrics = require('../observability/p7GuardMetrics');
const { computeGovernanceHealth } = require('./computeGovernanceHealth');
const { computeGovernanceAlertDigest } = require('./computeGovernanceAlertDigest');
const { computeEvolutionSummary } = require('./computeEvolutionSummary');
const { computePolicyInterpretation } = require('./computePolicyInterpretation');
const { computePaperTradesMetricsFromJsonlFile } = require('./computePaperTradesMetrics');
const { computePaperTradesMetricsV2FromFile } = require('./computePaperTradesMetricsV2');
const {
  attachPaperExecutionV1ToMetrics,
  mergePaperExecutionV1IntoV2Full,
} = require('./paperExecutionV1Observability');
const { computePaperLearningInsights } = require('./computePaperLearningInsights');
const { appendPaperTradesParseAlert } = require('./appendPaperTradesParseAlerts');
const { mergePromotionGuardWfBreakdown } = require('./walkForwardMissingBreakdown');
const { buildPromotedManifestCoverage } = require('./buildPromotedManifestCoverage');

const DASHBOARD_VERSION = 'p8.19-v1';

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function tailArray(arr, n) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(-Math.max(0, n));
}

function toPositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function readHistoryEntries(filePath) {
  const j = safeReadJson(filePath);
  if (!j) return [];
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.entries)) return j.entries;
  return [];
}

/** Infer P7.1 application from governor history decisionReasons when mini report per experiment is missing. */
function inferTrendMemoryAppliedFromReasons(reasons) {
  if (!Array.isArray(reasons)) return null;
  const str = reasons.map((r) => String(r));
  if (str.some((r) => r.includes('trend_memory_p7_1'))) return true;
  if (str.some((r) => r.includes('trend_memory_apply:skipped'))) return false;
  return null;
}

/**
 * Last N governor snapshots (newest first), enriched with verdict / TM when
 * discovery/reports/governance_mini_report_<experimentId>.json exists.
 */
function buildRunHistoryShort(discoveryDir, limit = 10) {
  const histPath = path.join(discoveryDir, 'portfolio_governor_history.json');
  const entries = tailArray(readHistoryEntries(histPath), Math.max(1, Math.min(20, limit)));
  const rows = entries.map((row) => {
    const expId = row.experimentId || null;
    const reportPath = path.join(
      discoveryDir,
      'reports',
      `governance_mini_report_${expId}.json`
    );
    const rep = expId ? safeReadJson(reportPath) : null;
    const govTm = rep && rep.trendMemoryApply && rep.trendMemoryApply.governor;
    let applied = null;
    if (govTm && typeof govTm.appliedFromTrendMemory === 'boolean') {
      applied = govTm.appliedFromTrendMemory;
    } else {
      applied = inferTrendMemoryAppliedFromReasons(row.decisionReasons);
    }
    return {
      at: row.at || null,
      experimentId: expId,
      governanceStatus: row.governanceStatus || null,
      verdict: rep && rep.verdict != null ? rep.verdict : null,
      cycle_valid: row.cycle_valid,
      targetExposure: row.targetExposure,
      appliedFromTrendMemory: applied,
    };
  });
  return rows.reverse();
}

function pickGovernorSummary(g) {
  if (!g || typeof g !== 'object') return null;
  return {
    experimentId: g.experimentId || null,
    cycleId: g.cycleId || null,
    governorVersion: g.governorVersion || null,
    governanceStatus: g.governanceStatus || null,
    cycle_valid: g.cycle_valid,
    promotionMode: g.promotionMode || null,
    targetExposure: g.targetExposure,
    maxNewAllocations: g.maxNewAllocations,
    admissionThresholdMultiplier: g.admissionThresholdMultiplier,
    holdCash: g.holdCash,
    generatedAt: g.generatedAt || null,
    trendMemoryApply: g.trendMemoryApply || null,
  };
}

function pickMutationSummary(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    experimentId: p.experimentId || null,
    cycleId: p.cycleId || null,
    policyVersion: p.policyVersion || null,
    generatedAt: p.generatedAt || null,
    trendMemoryApply: p.trendMemoryApply || null,
    byMutationType: p.byMutationType || null,
    familiesToExpandCount: Array.isArray(p.familiesToExpand)
      ? p.familiesToExpand.length
      : p.familiesToExpand === 'all'
        ? 'all'
        : 0,
  };
}

function pickTrendMemorySummary(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    trendMemoryVersion: t.trendMemoryVersion || null,
    generatedAt: t.generatedAt || null,
    producingCycleId: t.producingCycleId || null,
    windowSize: t.windowSize,
    experimentsConsidered: t.experimentsConsidered || [],
    signals: t.signals || null,
    suggestions: t.suggestions || null,
    coverageWarning: t.coverageWarning || null,
    appliedFromTrendMemory: t.appliedFromTrendMemory,
    safety: t.safety || null,
  };
}

/** Prefer wfMissingDiagnostic*; fall back to legacy wfMissingSemantic* for older promoted_children.json. */
function pickWfMissingSummaryFromPromoted(p) {
  if (!p || typeof p !== 'object') return {};
  if (
    p.wfMissingDiagnosticSummary &&
    typeof p.wfMissingDiagnosticSummary === 'object' &&
    Object.keys(p.wfMissingDiagnosticSummary).length > 0
  ) {
    return p.wfMissingDiagnosticSummary;
  }
  if (
    p.wfMissingDiagnosticCounts &&
    typeof p.wfMissingDiagnosticCounts === 'object' &&
    Object.keys(p.wfMissingDiagnosticCounts).length > 0
  ) {
    return p.wfMissingDiagnosticCounts;
  }
  if (
    p.wfMissingSemanticCounts &&
    typeof p.wfMissingSemanticCounts === 'object' &&
    Object.keys(p.wfMissingSemanticCounts).length > 0
  ) {
    return p.wfMissingSemanticCounts;
  }
  const pg = p.promotionGuard && typeof p.promotionGuard === 'object' ? p.promotionGuard : null;
  if (pg && pg.rejectedByWfMissingDiagnostic && typeof pg.rejectedByWfMissingDiagnostic === 'object') {
    return pg.rejectedByWfMissingDiagnostic;
  }
  if (pg && pg.rejectedByWfMissingSemantic && typeof pg.rejectedByWfMissingSemantic === 'object') {
    return pg.rejectedByWfMissingSemantic;
  }
  return p.wfMissingDiagnosticSummary && typeof p.wfMissingDiagnosticSummary === 'object'
    ? p.wfMissingDiagnosticSummary
    : {};
}

function pickMiniReportSummary(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    reportVersion: m.reportVersion || null,
    generatedAt: m.generatedAt || null,
    experimentId: m.experimentId || null,
    cycleId: m.cycleId || null,
    governanceStatus: m.governanceStatus || null,
    verdict: m.verdict || null,
    dataRoot: m.dataRoot || null,
    identity: m.identity || null,
    supervisor: m.supervisor || null,
    portfolioGovernor: m.portfolioGovernor || null,
    trendMemoryApply: m.trendMemoryApply || null,
    registry: m.registry || null,
    exitSummary: m.exitSummary || null,
  };
}

function isAccessDeniedError(err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : '';
  return code === 'EPERM' || code === 'EACCES' || /operation not permitted/i.test(msg);
}

function buildGovernanceDashboard(opts = {}) {
  const root = opts.dataRoot || dataRoot.getDataRoot();
  const discoveryDir = path.join(root, 'discovery');
  const governanceDir = path.join(root, 'governance');
  const championDir = path.join(root, 'champion_setups');
  const championRegistryPath = path.join(championDir, 'champion_registry.json');
  const nextGenReportPath = path.join(discoveryDir, 'next_generation_report.json');

  let p5Res = null;
  try {
    p5Res = p5Metrics.refreshP5Metrics({ dataRoot: root });
  } catch (e) {
    if (isAccessDeniedError(e)) {
      const msg = e && e.message ? String(e.message) : 'access denied';
      console.warn(`[WARN] P5 metrics read skipped: ${msg}`);
      p5Res = null;
    } else {
      throw e;
    }
  }
  let policyRes = null;
  try {
    policyRes = policyMetrics.refreshPolicyMetrics({ dataRoot: root });
  } catch (e) {
    if (isAccessDeniedError(e)) {
      const msg = e && e.message ? String(e.message) : 'access denied';
      console.warn(`[WARN] policy metrics read skipped: ${msg}`);
      policyRes = null;
    } else {
      throw e;
    }
  }
  let governorRes = null;
  try {
    governorRes = governorMetrics.refreshGovernorMetrics({ dataRoot: root });
  } catch (e) {
    if (isAccessDeniedError(e)) {
      const msg = e && e.message ? String(e.message) : 'access denied';
      console.warn(`[WARN] governor metrics read skipped: ${msg}`);
      governorRes = null;
    } else {
      throw e;
    }
  }
  let p7Res = null;
  try {
    p7Res = p7Metrics.refreshP7Metrics({ dataRoot: root });
  } catch (e) {
    if (isAccessDeniedError(e)) {
      const msg = e && e.message ? String(e.message) : 'access denied';
      console.warn(`[WARN] p7 metrics read skipped: ${msg}`);
      p7Res = null;
    } else {
      throw e;
    }
  }
  const p7GuardRes = p7GuardMetrics.refreshP7GuardMetrics({ dataRoot: root });

  const mini = safeReadJson(path.join(discoveryDir, 'governance_mini_report.json'));
  const championRegistry = safeReadJson(championRegistryPath);
  const nextGenerationReport = safeReadJson(nextGenReportPath);
  const governor = safeReadJson(path.join(discoveryDir, 'portfolio_governor.json'));
  const mutationPolicy = safeReadJson(path.join(discoveryDir, 'mutation_policy.json'));
  const trendMemory = safeReadJson(path.join(discoveryDir, 'run_trend_memory.json'));
  const registry = safeReadJson(path.join(governanceDir, 'experiment_registry.json'));

  const experiments = registry && Array.isArray(registry.experiments) ? registry.experiments : [];
  const experimentsRecent = experiments.slice(-20).reverse().map((e) => ({
    experimentId: e.experimentId,
    startedAt: e.startedAt,
    valid: e.valid,
    artifactStages: Array.isArray(e.artifacts)
      ? e.artifacts.map((a) => (a && a.stage) || 'unknown')
      : [],
  }));

  const governorHistPath = path.join(discoveryDir, 'portfolio_governor_history.json');
  const trendHistPath = path.join(discoveryDir, 'run_trend_memory_history.json');
  const governorHistoryTail = tailArray(readHistoryEntries(governorHistPath), 10).map((row) => ({
    at: row.at,
    experimentId: row.experimentId,
    governanceStatus: row.governanceStatus,
    promotionMode: row.promotionMode,
    targetExposure: row.targetExposure,
    maxNewAllocations: row.maxNewAllocations,
  }));
  const trendMemoryHistoryTail = tailArray(readHistoryEntries(trendHistPath), 8).map((row) => ({
    at: row.at,
    trendMemoryVersion: row.trendMemoryVersion,
    experimentsConsidered: row.experimentsConsidered,
    signals: row.signals,
  }));

  const runHistoryShort = buildRunHistoryShort(discoveryDir, 10);

  const generatedAt = new Date().toISOString();

  const p5Health =
    p5Metrics.p5HealthFromPayload(p5Res && p5Res.payload) || {
      p5MetricsSchemaVersion: null,
      lastStatus: null,
      okRate: null,
      skipRate: null,
      mismatchCount: null,
      lastObserved: null,
      cycleAlignment: 'unknown',
      lastAlertReason: null,
      lastMismatchAt: null,
      lastParseErrorAt: null,
    };
  const policyHealth =
    policyMetrics.policyHealthFromPayload(policyRes && policyRes.payload) || {
      policyMetricsSchemaVersion: null,
      lastExplorationWeight: null,
      lastExploitationWeight: null,
      lastDiversity: null,
      source: null,
      driftDetected: false,
      lastAlertReason: null,
      lastObserved: null,
      lastParseErrorAt: null,
    };
  const governorHealth =
    governorMetrics.governorHealthFromPayload(governorRes && governorRes.payload) || {
      governorMetricsSchemaVersion: null,
      lastDecision: null,
      lastReason: null,
      lastMode: null,
      policySource: null,
      decisionChangeDetected: false,
      lastAlertReason: null,
      lastObserved: null,
      lastParseErrorAt: null,
    };
  const p7Health =
    p7Metrics.p7HealthFromPayload(p7Res && p7Res.payload) || {
      p7MetricsSchemaVersion: null,
      lastStatus: null,
      lastSource: null,
      lastWindowSize: null,
      lastReportsConsidered: null,
      lastReportsLoaded: null,
      lastApplyCount: null,
      coverageRate: null,
      degradedRate: null,
      emptyRate: null,
      lastAlertReason: null,
      lastObserved: null,
      lastParseErrorAt: null,
    };

  const governanceHealth = computeGovernanceHealth({
    p5Health,
    policyHealth,
    governorHealth,
    p7Health,
    dashboardVersion: DASHBOARD_VERSION,
    generatedAt,
  });

  const outDirEarly =
    opts.outDir ||
    path.join(__dirname, '..', '..', 'ops-snapshot');
  const jsonPathEarly = path.join(outDirEarly, 'governance_dashboard.json');
  const executionStatusEarly = safeReadJson(path.join(outDirEarly, 'execution_status.json'));
  const latestSnapshotEarly = safeReadJson(path.join(outDirEarly, 'latest.json'));
  const hybridPromotionInsightsEarly =
    latestSnapshotEarly &&
    latestSnapshotEarly.hybridPromotionInsights &&
    typeof latestSnapshotEarly.hybridPromotionInsights === 'object'
      ? latestSnapshotEarly.hybridPromotionInsights
      : safeReadJson(path.join(outDirEarly, 'hybrid_promotion_insights.json'));
  const hybridReviewQueueEarly =
    latestSnapshotEarly &&
    latestSnapshotEarly.hybridReviewQueue &&
    typeof latestSnapshotEarly.hybridReviewQueue === 'object'
      ? latestSnapshotEarly.hybridReviewQueue
      : safeReadJson(path.join(outDirEarly, 'hybrid_review_queue.json'));
  const progressExecutorExecutionEarly = safeReadJson(
    path.join(outDirEarly, 'progress_executor_execution.json')
  );
  const progressExecutorDryRunEarly = safeReadJson(
    path.join(outDirEarly, 'progress_executor_dry_run.json')
  );
  const promotedChildren = safeReadJson(path.join(discoveryDir, 'promoted_children.json'));
  const liveStaleThresholdMinutes = toPositiveInt(
    process.env.NEUROPILOT_LIVE_STALE_MINUTES,
    120
  );
  let previousActiveAlertsCount = null;
  if (fs.existsSync(jsonPathEarly)) {
    const prevDash = safeReadJson(jsonPathEarly);
    const prevDig = prevDash && prevDash.governanceAlertDigest;
    if (prevDig && Array.isArray(prevDig.activeAlerts)) {
      previousActiveAlertsCount = prevDig.activeAlerts.length;
    }
  }

  const governanceAlertDigest = computeGovernanceAlertDigest({
    governanceHealth,
    p5Health,
    policyHealth,
    governorHealth,
    p7Health,
    previousActiveAlertsCount,
    generatedAt,
    dashboardVersion: DASHBOARD_VERSION,
  });

  const policyInterpretation = computePolicyInterpretation({
    policyHealth,
    miniReport: mini,
  });

  const evolutionSummary = computeEvolutionSummary({
    championRegistry,
    nextGenerationReport,
    paths: {
      championRegistry: championRegistryPath,
      nextGenerationReport: nextGenerationReport
        ? nextGenReportPath
        : null,
    },
  });

  const paperTradesJsonlPath = path.join(governanceDir, 'paper_trades.jsonl');
  const paperTradesMetrics = attachPaperExecutionV1ToMetrics(
    computePaperTradesMetricsFromJsonlFile(paperTradesJsonlPath),
    governanceDir
  );
  ensureDir(governanceDir);
  fs.writeFileSync(
    path.join(governanceDir, 'paper_trades_metrics.json'),
    JSON.stringify(paperTradesMetrics, null, 2),
    'utf8'
  );
  if (paperTradesMetrics.parseErrors > 0) {
    appendPaperTradesParseAlert(governanceDir, paperTradesMetrics);
  }

  const paperTradesV2Bundle = computePaperTradesMetricsV2FromFile(paperTradesJsonlPath);
  const paperTradesMetricsV2Full = mergePaperExecutionV1IntoV2Full(
    paperTradesV2Bundle.full,
    governanceDir
  );
  fs.writeFileSync(
    path.join(governanceDir, 'paper_trades_metrics_by_day.json'),
    JSON.stringify(paperTradesV2Bundle.byDayFile, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(governanceDir, 'paper_trades_metrics_by_cycle.json'),
    JSON.stringify(paperTradesV2Bundle.byCycleFile, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(governanceDir, 'paper_trades_metrics_by_strategy.json'),
    JSON.stringify(paperTradesV2Bundle.byStrategyFile, null, 2),
    'utf8'
  );

  const promotedManifestCoverageRes = buildPromotedManifestCoverage({
    dataRoot: root,
    write: true,
    paperTradesByStrategyFile: paperTradesV2Bundle.byStrategyFile,
    paperTradesByDayFile: paperTradesV2Bundle.byDayFile,
    paperTradesByCycleFile: paperTradesV2Bundle.byCycleFile,
  });
  const promotedManifestCoverage = promotedManifestCoverageRes.doc;

  const paperLearningInsights = computePaperLearningInsights(
    paperTradesMetrics,
    paperTradesV2Bundle.full
  );
  fs.writeFileSync(
    path.join(governanceDir, 'paper_learning_insights.json'),
    JSON.stringify(paperLearningInsights, null, 2),
    'utf8'
  );

  const promotionGuardBase =
    (latestSnapshotEarly && latestSnapshotEarly.promotionGuardSummary) ||
    (promotedChildren && promotedChildren.promotionGuard
      ? {
          available: true,
          mode: promotedChildren.learningMode || promotedChildren.promotionGuard.mode || null,
          target: promotedChildren.promotionTargetEnvironment || 'paper',
          evaluated: Number(promotedChildren.promotionGuard.evaluated || 0),
          passed: Number(promotedChildren.promotionGuard.passed || 0),
          rejected: Number(promotedChildren.promotionGuard.rejected || 0),
          rejectedByReason: promotedChildren.promotionGuard.rejectedByReason || {},
          thresholdsApplied: promotedChildren.promotionGuard.thresholdsApplied || null,
          rejectedSample: Array.isArray(promotedChildren.rejectedCandidatesSample)
            ? promotedChildren.rejectedCandidatesSample.slice(0, 30)
            : [],
          wfMissingDiagnosticSummary: pickWfMissingSummaryFromPromoted(promotedChildren),
        }
      : { available: false, target: 'paper', evaluated: 0, passed: 0, rejected: 0 });
  const promotionGuardMerged = mergePromotionGuardWfBreakdown(promotionGuardBase, promotedChildren);

  const payload = {
    dashboardVersion: DASHBOARD_VERSION,
    generatedAt,
    dataRoot: root,
    sources: {
      governance_mini_report: path.join(discoveryDir, 'governance_mini_report.json'),
      portfolio_governor: path.join(discoveryDir, 'portfolio_governor.json'),
      mutation_policy: path.join(discoveryDir, 'mutation_policy.json'),
      run_trend_memory: path.join(discoveryDir, 'run_trend_memory.json'),
      experiment_registry: path.join(governanceDir, 'experiment_registry.json'),
      last_completed_cycle: path.join(governanceDir, 'last_completed_cycle.json'),
      p5_cycle_events: path.join(governanceDir, 'p5_cycle_events.log'),
      p5_metrics: path.join(governanceDir, 'p5_metrics.json'),
      p5_alerts: path.join(governanceDir, 'p5_alerts.log'),
      policy_metrics_events: path.join(governanceDir, 'policy_metrics_events.log'),
      policy_metrics: path.join(governanceDir, 'policy_metrics.json'),
      policy_alerts: path.join(governanceDir, 'policy_alerts.log'),
      governor_metrics_events: path.join(governanceDir, 'governor_metrics_events.log'),
      governor_metrics: path.join(governanceDir, 'governor_metrics.json'),
      governor_alerts: path.join(governanceDir, 'governor_alerts.log'),
      p7_metrics_events: path.join(governanceDir, 'p7_metrics_events.log'),
      p7_metrics: path.join(governanceDir, 'p7_metrics.json'),
      p7_alerts: path.join(governanceDir, 'p7_alerts.log'),
      p7_guard_events: path.join(governanceDir, 'p7_guard_events.log'),
      p7_guard_metrics: path.join(governanceDir, 'p7_guard_metrics.json'),
      paper_trades_jsonl: paperTradesJsonlPath,
      paper_trades_metrics: path.join(governanceDir, 'paper_trades_metrics.json'),
      paper_trades_metrics_by_day: path.join(governanceDir, 'paper_trades_metrics_by_day.json'),
      paper_trades_metrics_by_cycle: path.join(governanceDir, 'paper_trades_metrics_by_cycle.json'),
      paper_trades_metrics_by_strategy: path.join(governanceDir, 'paper_trades_metrics_by_strategy.json'),
      paper_exec_seen_keys: path.join(governanceDir, 'paper_exec_seen_keys.json'),
      paper_exec_v1_last_run: path.join(governanceDir, 'paper_exec_v1_last_run.json'),
      paper_exec_v1_observability_ops: path.join(outDirEarly, 'paper_exec_v1_observability.json'),
      paper_learning_insights: path.join(governanceDir, 'paper_learning_insights.json'),
      champion_registry: championRegistryPath,
      next_generation_report: nextGenReportPath,
      promoted_children: path.join(discoveryDir, 'promoted_children.json'),
      promoted_manifest: path.join(discoveryDir, 'promoted_manifest.json'),
      promoted_manifest_coverage: path.join(discoveryDir, 'promoted_manifest_coverage.json'),
    },
    lastRun: {
      miniReport: pickMiniReportSummary(mini),
      portfolioGovernor: pickGovernorSummary(governor),
      mutationPolicy: pickMutationSummary(mutationPolicy),
      trendMemory: pickTrendMemorySummary(trendMemory),
    },
    experimentsRecent,
    runHistoryShort,
    governorHistoryTail,
    trendMemoryHistoryTail,
    p5Health,
    policyHealth,
    governorHealth,
    p7Health,
    governanceHealth,
    governanceAlertDigest,
    policyInterpretation,
    paperTradesMetrics,
    paperTradesMetricsV2: paperTradesMetricsV2Full,
    paperLearningInsights,
    p7GuardMetrics: p7GuardRes && p7GuardRes.payload ? p7GuardRes.payload : null,
    liveExecutionStatus:
      (latestSnapshotEarly && latestSnapshotEarly.executionStatus) ||
      executionStatusEarly ||
      null,
    xauDatasetDiagnostics:
      (latestSnapshotEarly && Array.isArray(latestSnapshotEarly.xauDatasetDiagnostics))
        ? latestSnapshotEarly.xauDatasetDiagnostics
        : [],
    phaseTracker:
      (latestSnapshotEarly && latestSnapshotEarly.phaseTracker && typeof latestSnapshotEarly.phaseTracker === 'object')
        ? latestSnapshotEarly.phaseTracker
        : null,
    phaseActionPlan:
      (latestSnapshotEarly &&
      latestSnapshotEarly.phaseActionPlan &&
      typeof latestSnapshotEarly.phaseActionPlan === 'object')
        ? latestSnapshotEarly.phaseActionPlan
        : null,
    learningInsights:
      latestSnapshotEarly &&
      latestSnapshotEarly.learningInsights &&
      typeof latestSnapshotEarly.learningInsights === 'object'
        ? latestSnapshotEarly.learningInsights
        : null,
    hybridPromotionInsights:
      hybridPromotionInsightsEarly && typeof hybridPromotionInsightsEarly === 'object'
        ? hybridPromotionInsightsEarly
        : null,
    hybridReviewQueue:
      hybridReviewQueueEarly && typeof hybridReviewQueueEarly === 'object'
        ? hybridReviewQueueEarly
        : null,
    progressExecutorDryRunSummary:
      (latestSnapshotEarly &&
      latestSnapshotEarly.progressExecutorDryRunSummary &&
      typeof latestSnapshotEarly.progressExecutorDryRunSummary === 'object')
        ? latestSnapshotEarly.progressExecutorDryRunSummary
        : (progressExecutorDryRunEarly && typeof progressExecutorDryRunEarly === 'object'
          ? {
              status: progressExecutorDryRunEarly.status || 'dry_run_unknown',
              evaluatedActionCount: Number(progressExecutorDryRunEarly.evaluatedActionCount || 0),
              eligibleActionCount: Number(progressExecutorDryRunEarly.eligibleActionCount || 0),
              blockedOwnerCount: (Array.isArray(progressExecutorDryRunEarly.results) ? progressExecutorDryRunEarly.results : [])
                .filter((r) => r && r.decision === 'blocked_owner').length,
              blockedPolicyCount: (Array.isArray(progressExecutorDryRunEarly.results) ? progressExecutorDryRunEarly.results : [])
                .filter((r) => r && r.decision === 'blocked_policy').length,
              blockedQuotaCount: (Array.isArray(progressExecutorDryRunEarly.results) ? progressExecutorDryRunEarly.results : [])
                .filter((r) => r && r.decision === 'blocked_quota').length,
              skippedCount: Number(progressExecutorDryRunEarly.skippedActionCount || 0),
              topEligibleActionIds: (Array.isArray(progressExecutorDryRunEarly.results) ? progressExecutorDryRunEarly.results : [])
                .filter((r) => r && r.decision === 'eligible')
                .map((r) => String(r.id || ''))
                .filter(Boolean)
                .slice(0, 5),
              topBlockedActionIds: (Array.isArray(progressExecutorDryRunEarly.results) ? progressExecutorDryRunEarly.results : [])
                .filter((r) =>
                  r &&
                  (r.decision === 'blocked_owner' || r.decision === 'blocked_policy' || r.decision === 'blocked_quota')
                )
                .map((r) => String(r.id || ''))
                .filter(Boolean)
                .slice(0, 5),
            }
          : null),
    progressExecutorExecution:
      progressExecutorExecutionEarly && typeof progressExecutorExecutionEarly === 'object'
        ? progressExecutorExecutionEarly
        : null,
    liveRuntime: {
      staleThresholdMinutes: liveStaleThresholdMinutes,
    },
    promotionGuard: promotionGuardMerged,
    evolutionSummary,
    promotedManifestCoverage,
  };

  const outDir = outDirEarly;
  ensureDir(outDir);
  const jsonPath = jsonPathEarly;
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NeuroPilot — Governance dashboard (P8.1)</title>
  <style>
    :root { --bg:#0f1419; --card:#1a2332; --text:#e7ecf3; --muted:#8b9bb4; --ok:#3ecf8e; --warn:#e9c46a; --bad:#ef476f; --accent:#4cc9f0; }
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 1.25rem; line-height: 1.45; }
    h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
    .sub { color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem; }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    section { background: var(--card); border-radius: 10px; padding: 1rem 1.1rem; border: 1px solid #2a3545; }
    h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); margin: 0 0 0.75rem; }
    .badge { display: inline-block; padding: 0.22rem 0.55rem; border-radius: 6px; font-size: 0.78rem; font-weight: 600; border: 1px solid transparent; }
    .status-pair { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; vertical-align: middle; }
    .status-pair.ok .badge { background: rgba(62,207,142,0.18); color: var(--ok); border-color: rgba(62,207,142,0.35); }
    .status-pair.degraded .badge { background: rgba(233,196,106,0.18); color: var(--warn); border-color: rgba(233,196,106,0.35); }
    .status-pair.blocked .badge { background: rgba(239,71,111,0.2); color: var(--bad); border-color: rgba(239,71,111,0.4); }
    .status-pair.neutral .badge { background: rgba(139,155,180,0.12); color: var(--muted); border-color: #2a3545; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #2a3545; vertical-align: top; }
    th { color: var(--muted); font-weight: 500; }
    pre { margin: 0; font-size: 0.72rem; overflow: auto; max-height: 220px; background: #0b0f14; padding: 0.6rem; border-radius: 6px; color: #c5d4e8; }
    .mono { font-family: ui-monospace, monospace; }
    ul { margin: 0.25rem 0 0 1rem; padding: 0; font-size: 0.85rem; color: var(--muted); }
    .header-last-run { border: 1px solid #2d3b52; box-shadow: 0 0 0 1px rgba(76,201,240,0.08); }
    .header-last-run h2 { margin-bottom: 0.5rem; }
    .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.5rem 1rem; font-size: 0.88rem; }
    .kv div { min-width: 0; }
    .kv .lbl { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .kv .val { font-weight: 600; word-break: break-all; }
    .hero-tm { border-left: 4px solid var(--accent); background: linear-gradient(90deg, rgba(76,201,240,0.08), transparent); }
    .hero-tm h2 { color: var(--accent); }
    .source-row { display: flex; align-items: flex-start; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .source-path { flex: 1; min-width: 200px; margin: 0; padding: 0.35rem 0.5rem; font-size: 0.72rem; background: #0b0f14; border: 1px solid #2a3545; border-radius: 6px; color: #c5d4e8; font-family: ui-monospace, monospace; }
    .btn-copy { cursor: pointer; font-size: 0.72rem; padding: 0.35rem 0.65rem; border-radius: 6px; border: 1px solid #3d4d62; background: #243044; color: var(--text); white-space: nowrap; }
    .btn-copy:hover { border-color: var(--accent); color: var(--accent); }
    .btn-copy.copied { border-color: var(--ok); color: var(--ok); }
    .muted { color: var(--muted); }
    .history-table td.mono { font-size: 0.74rem; }
  </style>
</head>
<body>
  <h1>Governance / Research dashboard</h1>
  <p class="sub mono" id="meta"></p>

  <section class="header-last-run" id="lastRunHeader" style="margin-bottom:1rem;"></section>
  <section id="governanceAlertDigestBanner" style="margin-bottom:1rem;"></section>
  <section id="policyInterpretationBanner" style="margin-bottom:1rem;"></section>
  <section id="p7GuardBanner" style="margin-bottom:1rem;"></section>
  <section id="promotionGuardBanner" style="margin-bottom:1rem;"></section>
  <section id="phaseTrackerBanner" style="margin-bottom:1rem;"></section>
  <section id="learningInsightsBanner" style="margin-bottom:1rem;"></section>
  <section id="hybridPromotionInsightsBanner" style="margin-bottom:1rem;"></section>
  <section id="hybridReviewQueueBanner" style="margin-bottom:1rem;"></section>
  <section id="progressExecutorBanner" style="margin-bottom:1rem;"></section>
  <section id="evolutionSummaryBanner" style="margin-bottom:1rem;"></section>
  <section id="paperTradesMetricsBanner" style="margin-bottom:1rem;"></section>
  <section id="paperExecV1ObservabilityBanner" style="margin-bottom:1rem;"></section>
  <section id="paperTradesV2Banner" style="margin-bottom:1rem;"></section>
  <section id="promotedManifestCoverageBanner" style="margin-bottom:1rem;"></section>
  <section id="paperLearningInsightsBanner" style="margin-bottom:1rem;"></section>
  <section id="governanceHealthBanner" style="margin-bottom:1rem;"></section>
  <section id="liveExecutionBanner" style="margin-bottom:1rem;"></section>
  <section id="xauDataBanner" style="margin-bottom:1rem;"></section>
  <section class="hero-tm" id="heroTrendMemory" style="margin-bottom:1rem;"></section>
  <section id="sourcesSection" style="margin-bottom:1rem;"></section>
  <section id="runHistorySection" style="margin-bottom:1rem;"></section>

  <div class="grid" id="cards"></div>
  <section style="margin-top:1rem;">
    <h2>Experiment registry (recent)</h2>
    <p class="muted" style="font-size:0.8rem;margin:0 0 0.5rem;">Artifact stages from experiment_registry.json</p>
    <div id="exp"></div>
  </section>
  <section style="margin-top:1rem;">
    <h2>Raw payload (JSON)</h2>
    <pre id="raw"></pre>
  </section>
  <script>
  (function(){
    var payload = JSON.parse(atob('${b64}'));
    document.getElementById('meta').textContent =
      payload.dashboardVersion + ' · generatedAt=' + payload.generatedAt + ' · dataRoot=' + payload.dataRoot;

    function esc(s) {
      if (s == null || s === '') return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function statusPairClass(gs, verdict) {
      var gsU = (gs || '').toUpperCase();
      var vU = (verdict || '').toUpperCase();
      if (gsU === 'BLOCKED' || vU === 'FAIL' || vU === 'BLOCKED') return 'blocked';
      if (gsU === 'DEGRADED') return 'degraded';
      if (gsU === 'OK' && (vU === 'PASS' || !verdict)) return 'ok';
      if (gsU === 'OK' || vU === 'PASS') return 'ok';
      return 'neutral';
    }

    function alignedBadges(gs, verdict) {
      var g = gs || 'n/a';
      var v = verdict != null && verdict !== '' ? verdict : 'n/a';
      var cls = statusPairClass(gs, verdict);
      return '<span class="status-pair ' + cls + '">' +
        '<span class="badge mono">' + esc(g) + '</span>' +
        '<span class="badge mono">' + esc(v) + '</span>' +
        '</span>';
    }

    function runtimeModeBadges(mode) {
      if (mode === 'idle') {
        return '<span class="status-pair ok"><span class="badge mono">Lab active</span></span> ' +
          '<span class="status-pair neutral"><span class="badge mono">Live idle</span></span>';
      }
      if (mode === 'stale') {
        return '<span class="status-pair ok"><span class="badge mono">Lab active</span></span> ' +
          '<span class="status-pair degraded"><span class="badge mono">Live stale</span></span>';
      }
      return '<span class="status-pair ok"><span class="badge mono">Lab active</span></span> ' +
        '<span class="status-pair ok"><span class="badge mono">Live active</span></span>';
    }

    function parseTsMs(v) {
      if (v == null || v === '') return null;
      var t = Date.parse(String(v));
      return Number.isFinite(t) ? t : null;
    }

    function fmtBool(v) {
      if (v === true) return 'true';
      if (v === false) return 'false';
      return 'n/a';
    }

    function fmtApplied(v) {
      if (v === true) return 'applied';
      if (v === false) return 'skipped';
      return 'n/a';
    }

    var mini = payload.lastRun && payload.lastRun.miniReport;
    var gov = payload.lastRun && payload.lastRun.portfolioGovernor;
    var pol = payload.lastRun && payload.lastRun.mutationPolicy;
    var tm = payload.lastRun && payload.lastRun.trendMemory;
    var tma = mini && mini.trendMemoryApply;

    var expId = (mini && mini.experimentId) || (gov && gov.experimentId) || 'n/a';
    var gs = mini && mini.governanceStatus != null ? mini.governanceStatus : (gov && gov.governanceStatus);
    var verdict = mini && mini.verdict != null ? mini.verdict : null;
    var cycleOk = mini && mini.supervisor && typeof mini.supervisor.cycle_valid === 'boolean'
      ? mini.supervisor.cycle_valid
      : (gov && typeof gov.cycle_valid === 'boolean' ? gov.cycle_valid : null);
    var targetEx = gov && gov.targetExposure != null ? gov.targetExposure : 'n/a';
    var govTm = gov && gov.trendMemoryApply;
    var appliedTm = govTm && typeof govTm.appliedFromTrendMemory === 'boolean'
      ? govTm.appliedFromTrendMemory
      : (tma && tma.governor && typeof tma.governor.appliedFromTrendMemory === 'boolean'
        ? tma.governor.appliedFromTrendMemory
        : null);
    var live = payload.liveExecutionStatus || {};
    var staleThresholdMinutes = Number(payload.liveRuntime && payload.liveRuntime.staleThresholdMinutes) || 120;
    var staleThresholdMs = staleThresholdMinutes * 60 * 1000;
    var fillsLedgerCount = Number(live.fillsLedgerCount || 0);
    var openPositionsCount = Number(live.openPositionsCount || 0);
    var openTradesCount = Number(live.openTradesCount || 0);
    var pendingOrdersCount = Number(live.pendingOrdersCount || 0);
    var candidates = [];
    var _t = parseTsMs(live.lastReconciledAt); if (_t != null) candidates.push(_t);
    _t = parseTsMs(live.periodPnlComputedAt); if (_t != null) candidates.push(_t);
    _t = parseTsMs(live.lastError && live.lastError.at); if (_t != null) candidates.push(_t);
    _t = parseTsMs(live.lastOrder && live.lastOrder.shadowAt); if (_t != null) candidates.push(_t);
    var recentEvents = Array.isArray(live.recentEvents) ? live.recentEvents : [];
    for (var i = 0; i < recentEvents.length; i += 1) {
      var ev = recentEvents[i] || {};
      _t = parseTsMs(ev.at || ev.ts || ev.time || ev.createdAt || ev.updatedAt);
      if (_t != null) candidates.push(_t);
    }
    var lastLiveEventTsMs = candidates.length ? Math.max.apply(null, candidates) : null;
    var lastLiveEventTs = lastLiveEventTsMs != null ? new Date(lastLiveEventTsMs).toISOString() : null;
    var staleAgeMinutes = lastLiveEventTsMs != null
      ? Math.round((((Date.now() - lastLiveEventTsMs) / 60000) * 100)) / 100
      : null;
    var hasEverLiveData =
      fillsLedgerCount > 0 ||
      Number(live.matchedFillsCount || 0) > 0 ||
      Number(live.unmatchedFillsCount || 0) > 0 ||
      Number(live.tradesTodayLive || 0) > 0 ||
      Number(live.shadowEventsToday || 0) > 0 ||
      openPositionsCount > 0 ||
      openTradesCount > 0 ||
      pendingOrdersCount > 0 ||
      Number(live.executedKeysTodayCount || 0) > 0 ||
      (live.periodPnlSource && String(live.periodPnlSource).toLowerCase() !== 'none') ||
      !!(live.lastOrder && (live.lastOrder.liveOrderId || live.lastOrder.shadowAt)) ||
      recentEvents.length > 0 ||
      lastLiveEventTsMs != null;
    var liveState = 'idle';
    if (hasEverLiveData) {
      if (lastLiveEventTsMs != null && (Date.now() - lastLiveEventTsMs) <= staleThresholdMs) {
        liveState = 'active';
      } else {
        liveState = 'stale';
      }
    }

    var headerHtml = '<h2>Last run</h2><div class="kv">' +
      '<div><div class="lbl">experimentId</div><div class="val mono">' + esc(expId) + '</div></div>' +
      '<div><div class="lbl">governance + verdict</div><div class="val">' + alignedBadges(gs, verdict) + '</div></div>' +
      '<div><div class="lbl">cycle_valid</div><div class="val">' + esc(fmtBool(cycleOk)) + '</div></div>' +
      '<div><div class="lbl">targetExposure</div><div class="val mono">' + esc(targetEx) + '</div></div>' +
      '<div><div class="lbl">runtime mode</div><div class="val">' + runtimeModeBadges(liveState) + '</div></div>' +
      '<div><div class="lbl">trend memory apply</div><div class="val">' + esc(fmtApplied(appliedTm)) +
        (appliedTm === true ? ' <span class="muted">(governor)</span>' : '') + '</div></div>' +
      '</div>';
    document.getElementById('lastRunHeader').innerHTML = headerHtml;

    var dig = payload.governanceAlertDigest || {};
    var digStatus = dig.status || 'healthy';
    var digPairCls = digStatus === 'critical' ? 'blocked' : (digStatus === 'warning' ? 'degraded' : 'ok');
    var digTop = dig.topAlert != null && dig.topAlert !== '' ? dig.topAlert : '—';
    var digCrit = dig.criticalCount != null ? dig.criticalCount : 0;
    var digWarn = dig.warningCount != null ? dig.warningCount : 0;
    var digTrend = dig.recentTrend || 'unknown';
    var digComp = Array.isArray(dig.componentsInAlert) ? dig.componentsInAlert.join(', ') : '—';
    var digLast = dig.lastAnomalyAt != null ? dig.lastAnomalyAt : '—';
    document.getElementById('governanceAlertDigestBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid var(--warn);padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.4rem;">Alert digest</h2>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">digest status</div><div class="val"><span class="status-pair ' + digPairCls + '"><span class="badge mono">' + esc(digStatus) + '</span></span></div></div>' +
      '<div><div class="lbl">topAlert</div><div class="val mono">' + esc(digTop) + '</div></div>' +
      '<div><div class="lbl">critical / warning</div><div class="val mono">' + esc(String(digCrit)) + ' / ' + esc(String(digWarn)) + '</div></div>' +
      '<div><div class="lbl">recent trend</div><div class="val mono">' + esc(digTrend) + '</div></div>' +
      '<div><div class="lbl">components in alert</div><div class="val mono">' + esc(digComp) + '</div></div>' +
      '<div><div class="lbl">lastAnomalyAt</div><div class="val mono">' + esc(digLast) + '</div></div>' +
      '</div>' +
      '<p class="muted" style="font-size:0.7rem;margin:0.45rem 0 0;">Contract: engine/governance/GOVERNANCE_ALERT_DIGEST_SCHEMA.md · schema ' + esc(dig.governanceAlertDigestSchemaVersion || 'n/a') + '</p>' +
      '</section>';

    var pi = payload.policyInterpretation || {};
    var piSt = pi.status || 'normal';
    var piHtml = '';
    if (piSt !== 'normal') {
      var piBorder = 'var(--warn)';
      var piTitle = 'Policy interpretation';
      if (piSt === 'expected_by_config') {
        piBorder = 'var(--ok)';
        piTitle = 'Policy interpretation — expected by config';
      } else if (piSt === 'investigate') {
        piBorder = 'var(--bad)';
        piTitle = 'Policy interpretation — investigate';
      } else if (piSt === 'unknown') {
        piBorder = '#e9c46a';
        piTitle = 'Policy interpretation — unknown context';
      }
      piHtml =
        '<section class="header-last-run" style="border-left:4px solid ' + piBorder + ';padding:0.65rem 1rem;">' +
        '<h2 style="margin-bottom:0.4rem;">' + esc(piTitle) + '</h2>' +
        '<p style="margin:0;font-size:0.85rem;"><strong class="mono">' + esc(piSt) + '</strong>' +
        (pi.reason ? ' <span class="muted">·</span> <span class="mono">' + esc(pi.reason) + '</span>' : '') +
        '</p>' +
        (pi.userHint
          ? '<p class="muted" style="margin:0.4rem 0 0;font-size:0.8rem;">' + esc(pi.userHint) + '</p>'
          : '') +
        '<p class="muted" style="font-size:0.68rem;margin:0.35rem 0 0;">Contract: engine/governance/POLICY_INTERPRETATION_SCHEMA.md · schema ' +
        esc(pi.policyInterpretationSchemaVersion || 'n/a') + '</p>' +
        '</section>';
    }
    document.getElementById('policyInterpretationBanner').innerHTML = piHtml;

    var pg = payload.p7GuardMetrics || {};
    var pgGuardCls = pg.enabled === true ? 'ok' : 'neutral';
    var pgGuardLabel = pg.enabled === true ? 'enabled' : 'disabled';
    var pgLastAct = pg.lastAction != null ? pg.lastAction : '—';
    var pgLastAl = pg.lastAlert != null ? pg.lastAlert : '—';
    var pgAtt = pg.attenuateRate != null ? pg.attenuateRate : 0;
    var pgSk = pg.skipRate != null ? pg.skipRate : 0;
    var pgN = pg.eventsConsidered != null ? pg.eventsConsidered : 0;
    document.getElementById('p7GuardBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #6c7a89;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.4rem;">P7 guard (mutation trend)</h2>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">guard</div><div class="val"><span class="status-pair ' + pgGuardCls + '"><span class="badge mono">' + esc(pgGuardLabel) + '</span></span></div></div>' +
      '<div><div class="lbl">last action</div><div class="val mono">' + esc(pgLastAct) + '</div></div>' +
      '<div><div class="lbl">last p7Alert (from event)</div><div class="val mono">' + esc(pgLastAl) + '</div></div>' +
      '<div><div class="lbl">attenuate% / skip%</div><div class="val mono">' + esc(String(Math.round(pgAtt * 10000) / 100)) + '% / ' + esc(String(Math.round(pgSk * 10000) / 100)) + '%</div></div>' +
      '<div><div class="lbl">sample (events)</div><div class="val mono">' + esc(String(pgN)) + '</div></div>' +
      '</div>' +
      '<p class="muted" style="font-size:0.7rem;margin:0.45rem 0 0;">Contract: engine/observability/P7_GUARD_METRICS_SCHEMA.md · schema ' + esc(pg.p7GuardMetricsSchemaVersion || 'n/a') + '</p>' +
      '</section>';

    var pguard = payload.promotionGuard || {};
    var pgAvail = pguard.available !== false;
    var pgEval = Number(pguard.evaluated || 0);
    var pgPass = Number(pguard.passed || 0);
    var pgRej = Number(pguard.rejected || 0);
    var pgPassRate = pgEval > 0 ? (Math.round((pgPass / pgEval) * 10000) / 100) : 0;
    var pgPairCls = !pgAvail ? 'neutral' : (pgRej > 0 ? 'degraded' : 'ok');
    var pgReasonsObj = pguard.rejectedByReason && typeof pguard.rejectedByReason === 'object'
      ? pguard.rejectedByReason
      : {};
    var pgTopReasons = Object.keys(pgReasonsObj)
      .map(function(k){ return { code: k, count: Number(pgReasonsObj[k] || 0) }; })
      .sort(function(a,b){ return (b.count - a.count) || String(a.code).localeCompare(String(b.code)); })
      .slice(0, 5);
    var pgReasonsRows = '';
    for (var pr = 0; pr < pgTopReasons.length; pr += 1) {
      var rr = pgTopReasons[pr];
      pgReasonsRows += '<tr><td class="mono">' + esc(rr.code) + '</td><td class="mono">' + esc(String(rr.count)) + '</td></tr>';
    }
    var pgMode = pguard.mode || 'n/a';
    var pgTarget = pguard.target || 'paper';
    var domReject = pguard.dominantRejectReason || payload.dominantRejectReason || {};
    var domCode = domReject.code || 'n/a';
    var domShare = Number(domReject.sharePct || 0);
    var domCount = Number(domReject.count || 0);
    var domAlert = pguard.dominantRejectReasonAlert === true || payload.dominantRejectReasonAlert === true || domReject.alert === true;
    var domLabel = domCode === 'n/a'
      ? 'Dominant reject reason: n/a'
      : ('Dominant reject reason: ' + domCode + ' (' + domShare + '%, count=' + domCount + ')');
    var domColor = domAlert ? 'var(--warn)' : 'var(--muted)';
    var wfBr = pguard.walkForwardMissingBreakdown && pguard.walkForwardMissingBreakdown.enabled === true
      ? pguard.walkForwardMissingBreakdown
      : null;
    var wfLine = '';
    if (wfBr && wfBr.counts && typeof wfBr.counts === 'object') {
      var wfParts = [];
      var ck = Object.keys(wfBr.counts).sort();
      for (var wi = 0; wi < ck.length; wi += 1) {
        var wk = ck[wi];
        var wp = wfBr.sharesPct && wfBr.sharesPct[wk] != null ? wfBr.sharesPct[wk] : 0;
        wfParts.push(esc(wk.replace(/^NO_VALIDATION_SIBLING_/, '')) + ' ' + esc(String(wp)) + '%');
      }
      if (wfBr.unclassifiedCount > 0) {
        var uPct = wfBr.sharesPct && wfBr.sharesPct.__unclassified__ != null ? wfBr.sharesPct.__unclassified__ : 0;
        wfParts.push('unclassified ' + esc(String(uPct)) + '%');
      }
      wfLine = '<p class="muted" style="font-size:0.76rem;margin:0.45rem 0 0;">WF missing diagnostic breakdown (REJECT_WALKFORWARD_MISSING): ' + wfParts.join(', ') + '</p>';
      if (wfBr.alert === true) {
        wfLine += '<p class="mono" style="font-size:0.76rem;margin:0.35rem 0 0;color:var(--warn);">WF diagnostic alert: ' + esc(wfBr.alertCode || 'WF_MISSING_ANOMALOUS_SUBCAUSES') + '</p>';
      }
    }
    document.getElementById('promotionGuardBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #7d8ca0;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.35rem;">Promotion guard (batch / WF)</h2>' +
      '<p class="muted" style="font-size:0.74rem;margin:0 0 0.5rem;line-height:1.35;">Candidate evaluation on promoted_children / batch runs — not the paper_trades.jsonl strict promote_candidate tier.</p>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">status</div><div class="val"><span class="status-pair ' + pgPairCls + '"><span class="badge mono">' + esc(pgAvail ? 'active' : 'missing') + '</span></span></div></div>' +
      '<div><div class="lbl">mode / target</div><div class="val mono">' + esc(pgMode) + ' / ' + esc(pgTarget) + '</div></div>' +
      '<div><div class="lbl">evaluated / passed / rejected</div><div class="val mono">' + esc(String(pgEval)) + ' / ' + esc(String(pgPass)) + ' / ' + esc(String(pgRej)) + '</div></div>' +
      '<div><div class="lbl">pass rate</div><div class="val mono">' + esc(String(pgPassRate)) + '%</div></div>' +
      '</div>' +
      '<p class="mono" style="font-size:0.78rem;margin:0.45rem 0 0;color:' + domColor + ';">' + esc(domLabel) + '</p>' +
      '<p class="muted" style="font-size:0.78rem;margin:0.5rem 0 0;">Top rejected reasons</p>' +
      '<table style="margin-top:0.35rem;font-size:0.8rem;"><thead><tr><th>code</th><th>count</th></tr></thead><tbody>' +
      (pgReasonsRows || '<tr><td colspan="2" class="muted">—</td></tr>') + '</tbody></table>' +
      wfLine +
      '</section>';

    var phaseTracker = payload.phaseTracker && typeof payload.phaseTracker === 'object' ? payload.phaseTracker : {};
    var phaseActionPlan = payload.phaseActionPlan && typeof phaseActionPlan === 'object' ? phaseActionPlan : {};
    var currentPhase = phaseTracker.currentPhase || 'unknown';
    var progressPct = Number(phaseTracker.unlockProgressPct || 0);
    var primaryBlocker = phaseTracker.primaryBlocker || null;
    var blockerMsg = primaryBlocker && typeof primaryBlocker === 'object'
      ? (primaryBlocker.message || primaryBlocker.code || 'none')
      : (primaryBlocker || 'none');
    var nextAction = phaseActionPlan.nextAction && typeof phaseActionPlan.nextAction === 'object'
      ? (phaseActionPlan.nextAction.summary || phaseActionPlan.nextAction.type || 'none')
      : 'none';
    var phaseCls = progressPct >= 90 ? 'ok' : (progressPct >= 50 ? 'degraded' : 'blocked');
    var sem = phaseTracker.semanticHints && typeof phaseTracker.semanticHints === 'object' ? phaseTracker.semanticHints : null;
    var phaseSemHtml = '';
    if (sem && (sem.validationGate || sem.governanceGate)) {
      if (sem.validationGate) {
        phaseSemHtml += '<p class="muted" style="font-size:0.72rem;margin:0.35rem 0 0;line-height:1.35;">Validation gate: ' + esc(sem.validationGate) + '</p>';
      }
      if (sem.governanceGate) {
        phaseSemHtml += '<p class="muted" style="font-size:0.72rem;margin:0.25rem 0 0;line-height:1.35;">Governance gate: ' + esc(sem.governanceGate) + '</p>';
      }
    }
    document.getElementById('phaseTrackerBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #6b8eb8;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.4rem;">Phase progression</h2>' +
      '<p class="mono" style="font-size:0.8rem;margin:0;">' +
      '<span class="status-pair ' + phaseCls + '"><span class="badge mono">' + esc(currentPhase) + '</span></span>' +
      ' · unlock=' + esc(String(progressPct)) + '%' +
      ' · blocker=' + esc(String(blockerMsg)) +
      ' · next=' + esc(String(nextAction)) +
      '</p>' +
      phaseSemHtml +
      '</section>';

    var li = payload.learningInsights && typeof payload.learningInsights === 'object'
      ? payload.learningInsights
      : null;
    var liTop = li && Array.isArray(li.topStrategies) ? li.topStrategies : [];
    var liOut = li && Array.isArray(li.outliers) ? li.outliers : [];
    var liSum = li && li.summary && typeof li.summary === 'object' ? li.summary : {};
    function gapCell(g) {
      if (g == null || !Number.isFinite(Number(g))) return '<span class="muted">—</span>';
      var n = Number(g);
      var cls = n > 0 ? 'ok' : (n < 0 ? 'blocked' : 'neutral');
      var sign = n > 0 ? '+' : '';
      return '<span class="status-pair ' + cls + '"><span class="badge mono">' + esc(sign + String(n)) + '</span></span>';
    }
    var liRows = '';
    for (var lii = 0; lii < liTop.length; lii += 1) {
      var lr = liTop[lii] || {};
      liRows +=
        '<tr><td class="mono">' + esc(lr.strategyId || '') + '</td>' +
        '<td class="mono">' + esc(lr.learningScore != null ? String(lr.learningScore) : '—') + '</td>' +
        '<td class="mono">' + esc(lr.score != null ? String(lr.score) : '—') + '</td>' +
        '<td>' + gapCell(lr.gap) + '</td>' +
        '<td class="mono">' + esc(lr.learningTier || '—') + '</td>' +
        '<td class="mono">' + esc(lr.trades != null ? String(lr.trades) : '—') + '</td></tr>';
    }
    var liOutRows = '';
    for (var lo = 0; lo < liOut.length; lo += 1) {
      var ox = liOut[lo] || {};
      liOutRows +=
        '<tr><td class="mono">' + esc(ox.strategyId || '') + '</td>' +
        '<td class="mono">' + esc(ox.gap != null ? String(ox.gap) : '—') + '</td>' +
        '<td class="mono">' + esc(ox.learningScore != null ? String(ox.learningScore) : '—') + '</td>' +
        '<td class="mono">' + esc(ox.score != null ? String(ox.score) : '—') + '</td></tr>';
    }
    document.getElementById('learningInsightsBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #5a7d9a;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.35rem;">Learning insights (non-blocking)</h2>' +
      '<p class="muted" style="font-size:0.74rem;margin:0 0 0.5rem;line-height:1.35;">' +
      'Learning score is observational and does not affect promotion gates or strict promote_candidate.</p>' +
      '<p class="muted" style="font-size:0.68rem;margin:0 0 0.5rem;line-height:1.35;">' +
      'Gap (observational) = learningScore − strict score. Positive = learning higher than strict.</p>' +
      (li
        ? '<div class="kv" style="font-size:0.82rem;margin-bottom:0.65rem;">' +
          '<div><div class="lbl">avg learning / strict / gap</div><div class="val mono">' +
          esc(liSum.avgLearningScore != null ? String(liSum.avgLearningScore) : '—') + ' / ' +
          esc(liSum.avgStrictScore != null ? String(liSum.avgStrictScore) : '—') + ' / ' +
          esc(liSum.avgGap != null ? String(liSum.avgGap) : '—') +
          '</div></div>' +
          '<div><div class="lbl">gap range (min / max)</div><div class="val mono">' +
          esc(liSum.minGap != null ? String(liSum.minGap) : '—') + ' / ' +
          esc(liSum.maxGap != null ? String(liSum.maxGap) : '—') +
          '</div></div>' +
          '<div><div class="lbl">strategies / outlier threshold</div><div class="val mono">' +
          esc(String(liSum.strategyCount != null ? liSum.strategyCount : 0)) + ' / gap &gt; ' +
          esc(String(liSum.outlierThreshold != null ? liSum.outlierThreshold : 10)) +
          '</div></div></div>' +
          '<p class="lbl" style="margin:0 0 0.35rem;">Top learning strategies</p>' +
          '<p class="muted" style="font-size:0.66rem;margin:0 0 0.35rem;line-height:1.35;">' +
          'Sorted by learningScore (desc); tie-break strategyId (deterministic).</p>' +
          '<table style="font-size:0.8rem;width:100%;"><thead><tr>' +
          '<th>strategyId</th><th>learning</th><th>strict</th><th>gap</th><th>learningTier</th><th>trades</th>' +
          '</tr></thead><tbody>' +
          (liRows || '<tr><td colspan="6" class="muted">No rows (empty topStrategies).</td></tr>') + '</tbody></table>' +
          '<p class="lbl" style="margin:0.65rem 0 0.35rem;">Outliers (strict vs learning gap)</p>' +
          '<p class="muted" style="font-size:0.66rem;margin:0 0 0.35rem;line-height:1.35;">' +
          'Sorted by gap (desc); same threshold as summary.</p>' +
          '<table style="font-size:0.8rem;width:100%;"><thead><tr>' +
          '<th>strategyId</th><th>gap</th><th>learning</th><th>strict</th></tr></thead><tbody>' +
          (liOutRows || '<tr><td colspan="4" class="muted">none</td></tr>') + '</tbody></table>' +
          '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">Source: latest.json learningInsights · strategy_validation.json rows</p>'
        : '<p class="muted" style="font-size:0.82rem;margin:0;">No learning insights data available (missing learningInsights in latest.json). Run <span class="mono">node engine/evolution/scripts/exportOpsSnapshot.js</span> after an evolution row exists.</p>') +
      '</section>';

    var hp = payload.hybridPromotionInsights && typeof payload.hybridPromotionInsights === 'object'
      ? payload.hybridPromotionInsights
      : null;
    var hpSum = hp && hp.summary && typeof hp.summary === 'object' ? hp.summary : {};
    var hpCrit = hpSum.criteria && typeof hpSum.criteria === 'object' ? hpSum.criteria : {};
    var hpRows = hp && Array.isArray(hp.rows) ? hp.rows : [];
    var hpTable = '';
    for (var hpi = 0; hpi < hpRows.length; hpi += 1) {
      var hr = hpRows[hpi] || {};
      var stCls = hr.status === 'review_candidate' ? 'ok' : (hr.status === 'disabled' ? 'neutral' : 'degraded');
      hpTable +=
        '<tr><td class="mono">' + esc(hr.strategyId || '') + '</td>' +
        '<td class="mono">' + esc(hr.strictScore != null ? String(hr.strictScore) : '—') + '</td>' +
        '<td class="mono">' + esc(hr.strictTier || '—') + '</td>' +
        '<td class="mono">' + esc(hr.learningScore != null ? String(hr.learningScore) : '—') + '</td>' +
        '<td class="mono">' + esc(hr.learningTier || '—') + '</td>' +
        '<td>' + gapCell(hr.gap) + '</td>' +
        '<td><span class="status-pair ' + stCls + '"><span class="badge mono">' + esc(hr.status || '—') + '</span></span></td>' +
        '<td style="max-width:240px;font-size:0.76rem;">' + esc(hr.reason || '') + '</td></tr>';
    }
    document.getElementById('hybridPromotionInsightsBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #a674d9;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.35rem;">Hybrid promotion (paper-only, non-blocking)</h2>' +
      '<p class="muted" style="font-size:0.74rem;margin:0 0 0.5rem;line-height:1.35;">' +
      'Hybrid review candidates are observational only and do not affect strict promotion gates, promotableCount, or phase progression.</p>' +
      (hp
        ? '<div class="kv" style="font-size:0.82rem;margin-bottom:0.65rem;">' +
          '<div><div class="lbl">layer / review candidates</div><div class="val mono">' +
          esc(hp.enabled ? 'enabled' : 'disabled') + ' / ' + esc(String(hpSum.reviewCandidateCount != null ? hpSum.reviewCandidateCount : 0)) +
          '</div></div>' +
          '<div><div class="lbl">top review candidate</div><div class="val mono">' +
          esc(hpSum.topReviewCandidate || '—') +
          '</div></div>' +
          '<div><div class="lbl">criteria (learning ≥ / strict ≥ / trades ≥)</div><div class="val mono">' +
          esc(String(hpCrit.minLearningScore != null ? hpCrit.minLearningScore : '—')) + ' / ' +
          esc(String(hpCrit.minStrictScore != null ? hpCrit.minStrictScore : '—')) + ' / ' +
          esc(String(hpCrit.minTrades != null ? hpCrit.minTrades : '—')) +
          '</div></div>' +
          '<div><div class="lbl">required learningTier</div><div class="val mono">' +
          esc(hpCrit.requiredLearningTier || '—') +
          '</div></div></div>' +
          '<table style="font-size:0.78rem;width:100%;"><thead><tr>' +
          '<th>strategyId</th><th>strict</th><th>tier</th><th>learning</th><th>learningTier</th><th>gap</th><th>hybrid status</th><th>reason</th>' +
          '</tr></thead><tbody>' +
          (hpTable || '<tr><td colspan="8" class="muted">—</td></tr>') + '</tbody></table>' +
          '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">Source: latest.json or hybrid_promotion_insights.json · set <span class="mono">NEUROPILOT_HYBRID_PROMOTION_ENABLE=1</span> to compute candidates</p>'
        : '<p class="muted" style="font-size:0.82rem;margin:0;">No hybrid promotion insights (run <span class="mono">node engine/evolution/scripts/exportOpsSnapshot.js</span>).</p>') +
      '</section>';

    var hrq = payload.hybridReviewQueue && typeof payload.hybridReviewQueue === 'object'
      ? payload.hybridReviewQueue
      : null;
    var hrqSum = hrq && hrq.summary && typeof hrq.summary === 'object' ? hrq.summary : {};
    var hrqRows = hrq && Array.isArray(hrq.rows) ? hrq.rows : [];
    var hrqDropped = hrq && Array.isArray(hrq.dropped) ? hrq.dropped : [];
    var hrqTable = '';
    for (var hri = 0; hri < hrqRows.length; hri += 1) {
      var qr = hrqRows[hri] || {};
      var qCls = qr.queueStatus === 'new' ? 'ok' : (qr.queueStatus === 'persistent' ? 'degraded' : 'neutral');
      hrqTable +=
        '<tr><td class="mono">' + esc(qr.strategyId || '') + '</td>' +
        '<td class="mono">' + esc(qr.strictScore != null ? String(qr.strictScore) : '—') + '</td>' +
        '<td class="mono">' + esc(qr.strictTier || '—') + '</td>' +
        '<td class="mono">' + esc(qr.learningScore != null ? String(qr.learningScore) : '—') + '</td>' +
        '<td class="mono">' + esc(qr.learningTier || '—') + '</td>' +
        '<td>' + gapCell(qr.gap) + '</td>' +
        '<td><span class="status-pair ' + qCls + '"><span class="badge mono">' + esc(qr.queueStatus || '—') + '</span></span></td>' +
        '<td class="mono">' + esc(qr.persistenceCount != null ? String(qr.persistenceCount) : '—') + '</td>' +
        '<td class="mono">' + esc(qr.priorityScore != null ? String(qr.priorityScore) : '—') + '</td>' +
        '<td style="max-width:200px;font-size:0.74rem;">' + esc(qr.reason || '') + '</td></tr>';
    }
    var hrqDropTable = '';
    for (var hrd = 0; hrd < hrqDropped.length; hrd += 1) {
      var dr = hrqDropped[hrd] || {};
      hrqDropTable +=
        '<tr><td class="mono">' + esc(dr.strategyId || '') + '</td>' +
        '<td class="mono">' + esc(dr.previousPersistenceCount != null ? String(dr.previousPersistenceCount) : '—') + '</td>' +
        '<td class="mono">' + esc(dr.lastSeenAt || '—') + '</td>' +
        '<td style="font-size:0.74rem;">' + esc(dr.reason || '') + '</td></tr>';
    }
    var hrqAuditLine = '';
    if (hrq && hrq.summary && typeof hrq.summary === 'object') {
      var hs = hrq.summary;
      hrqAuditLine =
        '<div class="kv" style="font-size:0.78rem;margin-bottom:0.55rem;">' +
        '<div><div class="lbl">generatedAt (summary)</div><div class="val mono">' +
        esc(hs.generatedAt || hrq.generatedAt || '—') + '</div></div>' +
        '<div><div class="lbl">layerEnabled</div><div class="val mono">' + esc(String(hs.layerEnabled === true)) + '</div></div>' +
        '<div><div class="lbl">checkpointSource</div><div class="val mono">' + esc(hs.checkpointSource || '—') + '</div></div></div>';
    }
    var hrqBody = '';
    if (!hrq) {
      hrqBody = '<p class="muted" style="font-size:0.82rem;margin:0;">No hybrid review queue data (run export or open <span class="mono">hybrid_review_queue.json</span>).</p>';
    } else if (hrq.layerEnabled === false) {
      hrqBody =
        hrqAuditLine +
        '<p class="muted" style="font-size:0.82rem;margin:0 0 0.5rem;">Hybrid layer disabled — queue inactive; checkpoint not updated.</p>' +
        '<p class="muted" style="font-size:0.74rem;margin:0;">' + esc(hrq.note || '') + '</p>';
    } else if (!hrqRows.length) {
      hrqBody =
        hrqAuditLine +
        '<div class="kv" style="font-size:0.82rem;margin-bottom:0.65rem;">' +
        '<div><div class="lbl">total / new / persistent / dropped</div><div class="val mono">' +
        esc(String(hrqSum.total != null ? hrqSum.total : 0)) + ' / ' +
        esc(String(hrqSum.newCount != null ? hrqSum.newCount : 0)) + ' / ' +
        esc(String(hrqSum.persistentCount != null ? hrqSum.persistentCount : 0)) + ' / ' +
        esc(String(hrqSum.droppedCount != null ? hrqSum.droppedCount : 0)) +
        '</div></div></div>' +
        '<p class="muted" style="font-size:0.82rem;margin:0 0 0.5rem;">No hybrid review candidates in this snapshot.</p>' +
        (hrqDropped.length
          ? '<p class="lbl" style="margin:0 0 0.35rem;">Dropped since last export</p>' +
            '<table style="font-size:0.74rem;width:100%;"><thead><tr>' +
            '<th>strategyId</th><th>prev persist</th><th>lastSeenAt</th><th>reason</th></tr></thead><tbody>' +
            hrqDropTable + '</tbody></table>' +
            '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">Source: latest.json or hybrid_review_queue.json</p>'
          : '');
    } else {
      hrqBody =
        hrqAuditLine +
        '<div class="kv" style="font-size:0.82rem;margin-bottom:0.65rem;">' +
        '<div><div class="lbl">total / new / persistent / dropped</div><div class="val mono">' +
        esc(String(hrqSum.total != null ? hrqSum.total : 0)) + ' / ' +
        esc(String(hrqSum.newCount != null ? hrqSum.newCount : 0)) + ' / ' +
        esc(String(hrqSum.persistentCount != null ? hrqSum.persistentCount : 0)) + ' / ' +
        esc(String(hrqSum.droppedCount != null ? hrqSum.droppedCount : 0)) +
        '</div></div>' +
        '<div><div class="lbl">top priority</div><div class="val mono">' +
        esc(hrqSum.topPriorityStrategyId || '—') +
        '</div></div></div>' +
        '<table style="font-size:0.76rem;width:100%;"><thead><tr>' +
        '<th>strategyId</th><th>strict</th><th>tier</th><th>learning</th><th>learningTier</th><th>gap</th><th>queue</th><th>persist #</th><th>priority</th><th>reason</th>' +
        '</tr></thead><tbody>' + hrqTable + '</tbody></table>' +
        (hrqDropped.length
          ? '<p class="lbl" style="margin:0.65rem 0 0.35rem;">Dropped since last export</p>' +
            '<table style="font-size:0.74rem;width:100%;"><thead><tr>' +
            '<th>strategyId</th><th>prev persist</th><th>lastSeenAt</th><th>reason</th></tr></thead><tbody>' +
            hrqDropTable + '</tbody></table>'
          : '') +
        '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">Source: latest.json or hybrid_review_queue.json</p>';
    }
    document.getElementById('hybridReviewQueueBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #7eb8da;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.35rem;">Hybrid review queue (paper-only, non-blocking)</h2>' +
      '<p class="muted" style="font-size:0.74rem;margin:0 0 0.5rem;line-height:1.35;">' +
      'Hybrid review queue is observational only and does not affect strict promotion gates, promotableCount, or phase progression.</p>' +
      hrqBody +
      '</section>';

    var pe = payload.progressExecutorExecution && typeof payload.progressExecutorExecution === 'object'
      ? payload.progressExecutorExecution
      : {};
    var peDry = payload.progressExecutorDryRunSummary && typeof payload.progressExecutorDryRunSummary === 'object'
      ? payload.progressExecutorDryRunSummary
      : {};
    var peStatus = pe.status || 'n/a';
    var peCls = peStatus === 'executor_success' ? 'ok' : (peStatus === 'executor_idle' ? 'degraded' : 'blocked');
    var peActionId = pe.executedActionId || 'n/a';
    var peActionType = pe.executedActionType || 'n/a';
    var peReason = pe.reason || 'n/a';
    var peAttempted = pe.attemptedRealHook === true ? 'yes' : (pe.attemptedRealHook === false ? 'no' : 'n/a');
    var peHook = pe.realHookName || 'n/a';
    var peFallback = pe.fallbackReason || null;
    var peExecMode = null;
    if (pe.executedActionType === 'validation_growth' && pe.validationMode) {
      peExecMode = String(pe.validationMode);
    } else if (pe.executedActionType === 'data_repair' && pe.dataRepairMode) {
      peExecMode = String(pe.dataRepairMode);
    }
    var peDrStatus = peDry.status || 'n/a';
    var peDrEligible = Number(peDry.eligibleActionCount || 0);
    var peDrBlockedPolicy = Number(peDry.blockedPolicyCount || 0);
    var peDrBlockedQuota = Number(peDry.blockedQuotaCount || 0);
    document.getElementById('progressExecutorBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #5d7fa8;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.4rem;">Progress executor</h2>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">status</div><div class="val"><span class="status-pair ' + peCls + '"><span class="badge mono">' + esc(peStatus) + '</span></span></div></div>' +
      '<div><div class="lbl">last action</div><div class="val mono">' + esc(peActionId) + '</div></div>' +
      '<div><div class="lbl">type</div><div class="val mono">' + esc(peActionType) + '</div></div>' +
      '<div><div class="lbl">reason</div><div class="val mono">' + esc(peReason) + '</div></div>' +
      '<div><div class="lbl">attempted real hook</div><div class="val mono">' + esc(peAttempted) + '</div></div>' +
      '<div><div class="lbl">hook</div><div class="val mono">' + esc(peHook) + '</div></div>' +
      (peExecMode ? '<div><div class="lbl">execution mode</div><div class="val mono">' + esc(peExecMode) + '</div></div>' : '') +
      '<div><div class="lbl">dry-run status</div><div class="val mono">' + esc(peDrStatus) + '</div></div>' +
      '<div><div class="lbl">eligible / blocked policy / blocked quota</div><div class="val mono">' + esc(String(peDrEligible)) + ' / ' + esc(String(peDrBlockedPolicy)) + ' / ' + esc(String(peDrBlockedQuota)) + '</div></div>' +
      '</div>' +
      (peFallback ? '<p class="muted mono" style="font-size:0.74rem;margin:0.45rem 0 0;">fallbackReason=' + esc(peFallback) + '</p>' : '') +
      '</section>';

    var ev = payload.evolutionSummary || {};
    var evIn = ev.inputs || null;
    var evCh = evIn && evIn.championsCount != null ? String(evIn.championsCount) : 'n/a';
    var evTot = evIn && evIn.setupsCount != null ? String(evIn.setupsCount) : 'n/a';
    var evProm = evIn && evIn.mutationsPromoted != null ? String(evIn.mutationsPromoted) : 'n/a';
    var evChild = evIn && evIn.childrenGenerated != null ? String(evIn.childrenGenerated) : 'n/a';
    document.getElementById('evolutionSummaryBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #8899a6;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.4rem;">Evolution summary (lab only)</h2>' +
      '<p class="mono" style="font-size:0.76rem;margin:0 0 0.65rem;word-break:break-all;color:#c5d4e8;">' + esc(ev.evolutionSummaryLine || 'n/a') + '</p>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">elite</div><div class="val mono">' + esc(ev.elite || 'n/a') + '</div></div>' +
      '<div><div class="lbl">mutation</div><div class="val mono">' + esc(ev.mutation || 'n/a') + '</div></div>' +
      '<div><div class="lbl">promotion</div><div class="val mono">' + esc(ev.promotion || 'n/a') + '</div></div>' +
      '<div><div class="lbl">diversity</div><div class="val mono">' + esc(ev.diversity || 'n/a') + '</div></div>' +
      '<div><div class="lbl">pruning</div><div class="val mono">' + esc(ev.pruning || 'n/a') + '</div></div>' +
      '<div><div class="lbl">exploration</div><div class="val mono">' + esc(ev.exploration || 'n/a') + '</div></div>' +
      '<div><div class="lbl">champions / setups</div><div class="val mono">' + esc(evCh) + ' / ' + esc(evTot) + '</div></div>' +
      '<div><div class="lbl">promoted / children</div><div class="val mono">' + esc(evProm) + ' / ' + esc(evChild) + '</div></div>' +
      '</div>' +
      '<p class="muted" style="font-size:0.7rem;margin:0.45rem 0 0;">Legend: engine/evolution/CHAMPION_SNAPSHOT_LEGEND.md · engine/governance/EVOLUTION_SUMMARY_SCHEMA.md · schema ' + esc(ev.evolutionSummarySchemaVersion || 'n/a') + '</p>' +
      '</section>';

    var ptm = payload.paperTradesMetrics || {};
    var ptmSt = ptm.status || 'empty_or_missing';
    var ptmBorder = ptmSt === 'has_parse_errors' ? 'var(--bad)' : (ptm.validTradeCount > 0 ? 'var(--ok)' : '#6c7a89');
    var ptmRawTrades = ptm.rawValidTradeCount != null ? ptm.rawValidTradeCount : (ptm.validTradeCount != null ? ptm.validTradeCount : 0);
    var ptmExcludedNonProd = ptm.excludedNonProductionTrades != null ? ptm.excludedNonProductionTrades : 0;
    var ptmExcludedStrict = ptm.excludedByValidationTrades != null ? ptm.excludedByValidationTrades : 0;
    var ptmReasonRows = '';
    var br = ptm.byReason && typeof ptm.byReason === 'object' ? ptm.byReason : {};
    Object.keys(br).sort().forEach(function(k) {
      ptmReasonRows += '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + esc(String(br[k])) + '</td></tr>';
    });
    document.getElementById('paperTradesMetricsBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid ' + ptmBorder + ';padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.4rem;">Paper trades (Execution V1)</h2>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">status</div><div class="val mono">' + esc(ptmSt) + '</div></div>' +
      '<div><div class="lbl">source exists</div><div class="val mono">' + esc(String(!!ptm.sourceExists)) + '</div></div>' +
      '<div><div class="lbl">lines / parse errors</div><div class="val mono">' + esc(String(ptm.lineCount != null ? ptm.lineCount : 0)) + ' / ' + esc(String(ptm.parseErrors != null ? ptm.parseErrors : 0)) + '</div></div>' +
      '<div><div class="lbl">raw / excluded NP / excluded strict</div><div class="val mono">' + esc(String(ptmRawTrades)) + ' / ' + esc(String(ptmExcludedNonProd)) + ' / ' + esc(String(ptmExcludedStrict)) + '</div></div>' +
      '<div><div class="lbl">valid trades (closed)</div><div class="val mono">' + esc(String(ptm.validTradeCount != null ? ptm.validTradeCount : 0)) + '</div></div>' +
      '<div><div class="lbl">wins / losses / flat</div><div class="val mono">' + esc(String(ptm.wins != null ? ptm.wins : 0)) + ' / ' + esc(String(ptm.losses != null ? ptm.losses : 0)) + ' / ' + esc(String(ptm.breakeven != null ? ptm.breakeven : 0)) + '</div></div>' +
      '<div><div class="lbl">win rate</div><div class="val mono">' + esc(ptm.winRate != null ? String(ptm.winRate) + '%' : 'n/a') + '</div></div>' +
      '<div><div class="lbl">total pnl / avg</div><div class="val mono">' + esc(ptm.totalPnl != null ? String(ptm.totalPnl) : 'n/a') + ' / ' + esc(ptm.avgPnl != null ? String(ptm.avgPnl) : 'n/a') + '</div></div>' +
      '<div><div class="lbl">last trade ts</div><div class="val mono" style="font-size:0.72rem">' + esc(ptm.lastTradeTs || '—') + '</div></div>' +
      '</div>' +
      '<p class="muted" style="font-size:0.78rem;margin:0.5rem 0 0;">By reason (exit)</p>' +
      '<table style="margin-top:0.35rem;font-size:0.8rem;"><thead><tr><th>reason</th><th>count</th></tr></thead><tbody>' +
      (ptmReasonRows || '<tr><td colspan="2" class="muted">—</td></tr>') + '</tbody></table>' +
      '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">Source: governance/paper_trades.jsonl · metrics file refreshed on dashboard build · engine/governance/PAPER_TRADES_METRICS_SCHEMA.md · schema ' + esc(ptm.paperTradesMetricsSchemaVersion || 'n/a') + '</p>' +
      '</section>';

    var peo = ptm.paperExecutionV1Observability || {};
    var peoPersist = peo.paperExecPersistentThrottleEnabled === true ? 'on' : (peo.paperExecPersistentThrottleEnabled === false ? 'off' : 'n/a');
    var peoBar = peo.paperExecBarThrottleEnabled === true ? 'on' : (peo.paperExecBarThrottleEnabled === false ? 'off' : 'n/a');
    document.getElementById('paperExecV1ObservabilityBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #6b8cae;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.35rem;">Paper Execution V1 — throttles</h2>' +
      '<p class="muted" style="font-size:0.72rem;margin:0 0 0.5rem;">Per-run + persistent duplicate skips (last runner invocation). Trades never appended are not in JSONL metrics totals.</p>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">persistent throttle</div><div class="val mono">' + esc(peoPersist) + '</div></div>' +
      '<div><div class="lbl">per-run bar throttle</div><div class="val mono">' + esc(peoBar) + '</div></div>' +
      '<div><div class="lbl">seen-keys store file</div><div class="val mono">' + esc(peo.paperExecSeenKeysStorePresent === true ? 'present' : (peo.paperExecSeenKeysStorePresent === false ? 'missing' : '—')) + '</div></div>' +
      '<div><div class="lbl">last-run summary file</div><div class="val mono">' + esc(peo.paperExecLastRunPresent === true ? 'present' : (peo.paperExecLastRunPresent === false ? 'missing' : '—')) + '</div></div>' +
      '<div><div class="lbl">seen keys count</div><div class="val mono">' + esc(String(peo.seenKeysCount != null ? peo.seenKeysCount : '—')) + '</div></div>' +
      '<div><div class="lbl">last run appended</div><div class="val mono">' + esc(String(peo.effectiveAppendedLastRun != null ? peo.effectiveAppendedLastRun : '—')) + '</div></div>' +
      '<div><div class="lbl">last run skipped (per-run dup)</div><div class="val mono">' + esc(String(peo.duplicateSkippedRunLastRun != null ? peo.duplicateSkippedRunLastRun : '—')) + '</div></div>' +
      '<div><div class="lbl">last run skipped (persistent dup)</div><div class="val mono">' + esc(String(peo.duplicateSkippedPersistentLastRun != null ? peo.duplicateSkippedPersistentLastRun : '—')) + '</div></div>' +
      '<div><div class="lbl">last run writtenAt</div><div class="val mono" style="font-size:0.72rem">' + esc(peo.writtenAt || '—') + '</div></div>' +
      '</div>' +
      '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">' + esc(peo.note || '') + '</p>' +
      '</section>';

    function reasonMini(br) {
      if (!br || typeof br !== 'object') return '—';
      var ks = Object.keys(br).sort();
      if (!ks.length) return '—';
      return ks.map(function(k) { return k + ':' + br[k]; }).join(', ');
    }
    function truncMid(s, max) {
      var t = s == null ? '' : String(s);
      var m = Number(max) || 0;
      if (m < 5 || t.length <= m) return t;
      var left = Math.ceil((m - 3) / 2);
      var right = Math.floor((m - 3) / 2);
      return t.slice(0, left) + '...' + t.slice(t.length - right);
    }
    var v2 = payload.paperTradesMetricsV2 || {};
    var rawTrades = v2.rawValidTradeCount != null ? v2.rawValidTradeCount : (v2.validTradeCount != null ? v2.validTradeCount : 0);
    var excludedNonProd = v2.excludedNonProductionTrades != null ? v2.excludedNonProductionTrades : 0;
    var excludedStrict = v2.excludedByValidationTrades != null ? v2.excludedByValidationTrades : 0;
    var validOpsTrades = v2.validTradeCount != null ? v2.validTradeCount : 0;
    var recentActiveDaysN = Number(process.env.NEUROPILOT_DASHBOARD_RECENT_ACTIVE_DAYS || 7);
    if (!Number.isFinite(recentActiveDaysN) || recentActiveDaysN < 1) recentActiveDaysN = 7;
    recentActiveDaysN = Math.floor(recentActiveDaysN);
    var minTradesForDisplay = 50;
    var suspiciousDayMinTrades = 20;
    var byDayAll = Array.isArray(v2.byDay) ? v2.byDay.slice() : [];
    byDayAll.sort(function(a, b) { return String(a.day || '').localeCompare(String(b.day || '')); });
    var byDayKnown = byDayAll.filter(function(b) { return b && b.day !== 'unknown'; });
    var byDayRecentActive = byDayKnown.slice(Math.max(0, byDayKnown.length - recentActiveDaysN));
    var suspiciousDaySet = Object.create(null);
    byDayAll.forEach(function(b) {
      if (!b || b.day === 'unknown') return;
      var tr = Number(b.trades);
      var wr = Number(b.winRate);
      if (!Number.isFinite(tr) || tr < suspiciousDayMinTrades) return;
      if (!Number.isFinite(wr)) return;
      if (wr === 100 || wr === 0) suspiciousDaySet[String(b.day)] = wr === 100 ? 'suspicious_full_win_day' : 'suspicious_full_loss_day';
    });
    var dayRowsGlobal = byDayAll.map(function(b) {
      var d = String(b.day);
      var flag = suspiciousDaySet[d] ? ' <span class="badge mono" title="' + esc(suspiciousDaySet[d]) + '">' + esc(suspiciousDaySet[d]) + '</span>' : '';
      return '<tr><td class="mono">' + esc(d) + flag + '</td><td class="mono">' + esc(String(b.trades)) + '</td><td class="mono">' +
        esc(b.winRate != null ? String(b.winRate) + '%' : 'n/a') + '</td><td class="mono">' +
        esc(b.totalPnl != null ? String(b.totalPnl) : 'n/a') + '</td><td class="mono" style="font-size:0.72rem" title="' + esc(reasonMini(b.byReason)) + '">' +
        esc(truncMid(reasonMini(b.byReason), 56)) + '</td></tr>';
    }).join('');
    var dayRowsRecent = byDayRecentActive.map(function(b) {
      var d = String(b.day);
      var flag = suspiciousDaySet[d] ? ' <span class="badge mono" title="' + esc(suspiciousDaySet[d]) + '">' + esc(suspiciousDaySet[d]) + '</span>' : '';
      return '<tr><td class="mono">' + esc(d) + flag + '</td><td class="mono">' + esc(String(b.trades)) + '</td><td class="mono">' +
        esc(b.winRate != null ? String(b.winRate) + '%' : 'n/a') + '</td><td class="mono">' +
        esc(b.totalPnl != null ? String(b.totalPnl) : 'n/a') + '</td><td class="mono" style="font-size:0.72rem" title="' + esc(reasonMini(b.byReason)) + '">' +
        esc(truncMid(reasonMini(b.byReason), 56)) + '</td></tr>';
    }).join('');
    var byCycleAll = Array.isArray(v2.byCycle) ? v2.byCycle.slice() : [];
    byCycleAll.sort(function(a, b) { return String(a.cycleKey || '').localeCompare(String(b.cycleKey || '')); });
    var byCycleKnown = byCycleAll.filter(function(b) { return b && b.cycleKey !== '_unknown_cycle'; });
    var knownCyclesLimit = Number(process.env.NEUROPILOT_DASHBOARD_KNOWN_CYCLES_LIMIT || 20);
    if (!Number.isFinite(knownCyclesLimit) || knownCyclesLimit < 1) knownCyclesLimit = 20;
    knownCyclesLimit = Math.floor(knownCyclesLimit);
    var byCycleKnownTop = byCycleKnown.slice().sort(function(a, b) {
      var t = Number(b && b.trades) - Number(a && a.trades);
      if (t !== 0) return t;
      return Number(b && b.totalPnl) - Number(a && a.totalPnl);
    }).slice(0, knownCyclesLimit);
    var recentKnownCycleTrades = 0;
    var recentKnownCycleWins = 0;
    byCycleKnownTop.forEach(function(b) {
      var t = Number(b && b.trades);
      var w = Number(b && b.wins);
      if (Number.isFinite(t) && t > 0) recentKnownCycleTrades += t;
      if (Number.isFinite(w) && w >= 0) recentKnownCycleWins += w;
    });
    var recentKnownCycleWinRate =
      recentKnownCycleTrades > 0 ? Math.round((recentKnownCycleWins / recentKnownCycleTrades) * 10000) / 100 : null;
    var recentKnownCycleTotalPnl = byCycleKnownTop.reduce(function(acc, b) {
      var p = Number(b && b.totalPnl);
      return Number.isFinite(p) ? acc + p : acc;
    }, 0);
    var unknownCycleRow = byCycleAll.find(function(b) { return b && b.cycleKey === '_unknown_cycle'; }) || null;
    var unknownCycleShare = unknownCycleRow && validOpsTrades > 0 ? (Number(unknownCycleRow.trades || 0) / Number(validOpsTrades || 1)) : null;
    var cycRowsGlobal = byCycleAll.map(function(b) {
      var key = String(b.cycleKey);
      var legacyTag = key === '_unknown_cycle'
        ? ' <span class="badge mono degraded" title="legacy / incomplete cycle attribution">legacy / incomplete cycle attribution</span>'
        : '';
      return '<tr><td class="mono" title="' + esc(key) + '">' + esc(truncMid(key, 48)) + legacyTag + '</td><td class="mono">' + esc(String(b.trades)) + '</td><td class="mono">' +
        esc(b.winRate != null ? String(b.winRate) + '%' : 'n/a') + '</td><td class="mono">' +
        esc(b.totalPnl != null ? String(b.totalPnl) : 'n/a') + '</td><td class="mono" style="font-size:0.72rem" title="' + esc(reasonMini(b.byReason)) + '">' +
        esc(truncMid(reasonMini(b.byReason), 56)) + '</td></tr>';
    }).join('');
    var cycRowsKnown = byCycleKnownTop.map(function(b) {
      var key = String(b.cycleKey);
      return '<tr><td class="mono" title="' + esc(key) + '">' + esc(truncMid(key, 48)) + '</td><td class="mono">' + esc(String(b.trades)) + '</td><td class="mono">' +
        esc(b.winRate != null ? String(b.winRate) + '%' : 'n/a') + '</td><td class="mono">' +
        esc(b.totalPnl != null ? String(b.totalPnl) : 'n/a') + '</td><td class="mono" style="font-size:0.72rem" title="' + esc(reasonMini(b.byReason)) + '">' +
        esc(truncMid(reasonMini(b.byReason), 56)) + '</td></tr>';
    }).join('');
    var stratEligible = (Array.isArray(v2.byStrategy) ? v2.byStrategy : []).filter(function(b) {
      return Number(b && b.trades) >= minTradesForDisplay;
    });
    var stratRows = stratEligible.slice(0, 20).map(function(b) {
      var sid = String(b.strategyId || '');
      return '<tr><td class="mono" title="' + esc(sid) + '">' + esc(truncMid(sid, 46)) + '</td><td class="mono">' + esc(String(b.trades)) + '</td><td class="mono">' +
        esc(b.winRate != null ? String(b.winRate) + '%' : 'n/a') + '</td><td class="mono">' +
        esc(b.totalPnl != null ? String(b.totalPnl) : 'n/a') + '</td><td class="mono">' +
        esc(b.avgPnl != null ? String(b.avgPnl) : 'n/a') + '</td><td class="mono" style="font-size:0.72rem" title="' + esc(reasonMini(b.byReason)) + '">' +
        esc(truncMid(reasonMini(b.byReason), 56)) + '</td></tr>';
    }).join('');
    document.getElementById('paperTradesV2Banner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #5a6570;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.35rem;">Paper trades by day / cycle / strategy (V2)</h2>' +
      '<p class="muted" style="font-size:0.72rem;margin:0 0 0.5rem;">UTC day from exitTs or ts · cycle = cycleId or experimentId · derived read-only from JSONL</p>' +
      '<div class="kv" style="font-size:0.8rem;margin:0.25rem 0 0.55rem;">' +
      '<div><div class="lbl">Raw trades</div><div class="val mono">' + esc(String(rawTrades)) + '</div></div>' +
      '<div><div class="lbl">Excluded non-production</div><div class="val mono">' + esc(String(excludedNonProd)) + '</div></div>' +
      '<div><div class="lbl">Excluded by strict validation</div><div class="val mono">' + esc(String(excludedStrict)) + '</div></div>' +
      '<div><div class="lbl">Valid operational trades</div><div class="val mono">' + esc(String(validOpsTrades)) + '</div></div>' +
      '<div><div class="lbl">_unknown_cycle trades / share</div><div class="val mono">' +
        esc(String(unknownCycleRow ? unknownCycleRow.trades : 0)) + ' / ' +
        esc(unknownCycleShare != null ? String(Math.round(unknownCycleShare * 10000) / 100) + '%' : 'n/a') + '</div></div>' +
      '<div><div class="lbl">Last run — dup skip (run / persistent)</div><div class="val mono">' +
        esc(String(peo.duplicateSkippedRunLastRun != null ? peo.duplicateSkippedRunLastRun : '—')) + ' / ' +
        esc(String(peo.duplicateSkippedPersistentLastRun != null ? peo.duplicateSkippedPersistentLastRun : '—')) + '</div></div>' +
      '</div>' +
      '<h3 style="font-size:0.78rem;color:var(--accent);margin:0.35rem 0 0.25rem;">Global paper history</h3>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>day</th><th>trades</th><th>win%</th><th>totalPnl</th><th>reasons</th></tr></thead><tbody>' +
      (dayRowsGlobal || '<tr><td colspan="5" class="muted">—</td></tr>') + '</tbody></table>' +
      '<h3 style="font-size:0.78rem;color:var(--accent);margin:0.65rem 0 0.25rem;">Global cycle buckets</h3>' +
      '<p class="muted" style="font-size:0.72rem;margin:0 0 0.35rem;">_unknown_cycle is shown for transparency but is legacy/incomplete attribution; do not use it alone for recent calibration.</p>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>cycle</th><th>trades</th><th>win%</th><th>totalPnl</th><th>reasons</th></tr></thead><tbody>' +
      (cycRowsGlobal || '<tr><td colspan="5" class="muted">—</td></tr>') + '</tbody></table>' +
      '<h3 style="font-size:0.78rem;color:var(--accent);margin:0.65rem 0 0.25rem;">Recent / known-cycle paper view</h3>' +
      '<p class="muted" style="font-size:0.72rem;margin:0 0 0.35rem;">Recent active days (last ' + esc(String(recentActiveDaysN)) + ' with trades) + known cycle buckets (top ' + esc(String(knownCyclesLimit)) + ' by trades).</p>' +
      '<div class="kv" style="font-size:0.8rem;margin:0.2rem 0 0.45rem;">' +
      '<div><div class="lbl">known-cycle trades (shown)</div><div class="val mono">' + esc(String(recentKnownCycleTrades)) + '</div></div>' +
      '<div><div class="lbl">known-cycle win% (shown)</div><div class="val mono">' + esc(recentKnownCycleWinRate != null ? String(recentKnownCycleWinRate) + '%' : 'n/a') + '</div></div>' +
      '<div><div class="lbl">known-cycle totalPnl (shown)</div><div class="val mono">' + esc(String(Math.round(recentKnownCycleTotalPnl * 1e8) / 1e8)) + '</div></div>' +
      '</div>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>recent active day</th><th>trades</th><th>win%</th><th>totalPnl</th><th>reasons</th></tr></thead><tbody>' +
      (dayRowsRecent || '<tr><td colspan="5" class="muted">—</td></tr>') + '</tbody></table>' +
      '<table style="font-size:0.8rem;width:100%;margin-top:0.45rem;"><thead><tr><th>known cycle</th><th>trades</th><th>win%</th><th>totalPnl</th><th>reasons</th></tr></thead><tbody>' +
      (cycRowsKnown || '<tr><td colspan="5" class="muted">—</td></tr>') + '</tbody></table>' +
      '<h3 style="font-size:0.78rem;color:var(--accent);margin:0.65rem 0 0.25rem;">Top strategies (eligible sample)</h3>' +
      '<p class="muted" style="font-size:0.72rem;margin:0 0 0.35rem;">Only strategies with trades >= ' + esc(String(minTradesForDisplay)) + ' are shown.</p>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>strategyId</th><th>trades</th><th>win%</th><th>totalPnl</th><th>avgPnl</th><th>reasons</th></tr></thead><tbody>' +
      (stratRows || '<tr><td colspan="6" class="muted">—</td></tr>') + '</tbody></table>' +
      '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">engine/governance/PAPER_TRADES_METRICS_V2_SCHEMA.md · schema ' + esc(v2.paperTradesMetricsV2SchemaVersion || 'n/a') + '</p>' +
      '</section>';

    var pmc = payload.promotedManifestCoverage || {};
    var pmcSkip = pmc.skippedByReason && typeof pmc.skippedByReason === 'object' ? pmc.skippedByReason : {};
    var pmcSkipRows = Object.keys(pmcSkip).sort().map(function(k) {
      return '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + esc(String(pmcSkip[k])) + '</td></tr>';
    }).join('');
    var pmcItems = pmc.itemsBySetupId && typeof pmc.itemsBySetupId === 'object' ? pmc.itemsBySetupId : {};
    var pmcItemRows = Object.keys(pmcItems).sort(function(a, b) {
      return (pmcItems[b] - pmcItems[a]) || a.localeCompare(b);
    }).slice(0, 40).map(function(k) {
      return '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + esc(String(pmcItems[k])) + '</td></tr>';
    }).join('');
    var pmcM = pmc.paperTradesMetricsByStrategy && pmc.paperTradesMetricsByStrategy.byStrategyId
      ? pmc.paperTradesMetricsByStrategy.byStrategyId
      : {};
    var pmcMetRows = Object.keys(pmcM).sort().map(function(k) {
      var v = pmcM[k];
      if (!v) {
        return '<tr><td class="mono">' + esc(k) + '</td><td colspan="6" class="muted">no paper metrics row</td></tr>';
      }
      return '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + esc(v.trades != null ? String(v.trades) : '—') + '</td><td class="mono">' +
        esc(v.wins != null ? String(v.wins) : '—') + '</td><td class="mono">' + esc(v.losses != null ? String(v.losses) : '—') + '</td><td class="mono">' +
        esc(v.winRate != null ? String(v.winRate) + '%' : '—') + '</td><td class="mono">' +
        esc(v.totalPnl != null ? String(v.totalPnl) : '—') + '</td><td class="mono">' +
        esc(v.avgPnl != null ? String(v.avgPnl) : '—') + '</td></tr>';
    }).join('');
    var pcoh = pmc.promotedCohortPaperSummary && typeof pmc.promotedCohortPaperSummary === 'object'
      ? pmc.promotedCohortPaperSummary
      : {};
    var plead = pmc.promotedCohortPaperLeaders && typeof pmc.promotedCohortPaperLeaders === 'object'
      ? pmc.promotedCohortPaperLeaders
      : { winners: [], losers: [] };
    var pmcNoManifestPaper =
      (pmc.manifestDistinctSetupIdsCount != null ? Number(pmc.manifestDistinctSetupIdsCount) : 0) > 0 &&
      (pcoh.distinctSetupIdsWithPaper != null ? Number(pcoh.distinctSetupIdsWithPaper) : 0) === 0;
    var pg = pmc.paperGate && typeof pmc.paperGate === 'object' ? pmc.paperGate : {};
    var pgEnabled = pg.enabled === true ? 'enabled' : 'disabled';
    var pgThr = pg.thresholdsApplied && typeof pg.thresholdsApplied === 'object' ? pg.thresholdsApplied : {};
    var pgSkip = pg.skippedByReason && typeof pg.skippedByReason === 'object' ? pg.skippedByReason : {};
    var pgSkipRows = Object.keys(pgSkip).sort().map(function(k) {
      return '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + esc(String(pgSkip[k])) + '</td></tr>';
    }).join('');
    function pmcLeaderRows(arr) {
      if (!Array.isArray(arr) || !arr.length) {
        return '<tr><td colspan="4" class="muted">—</td></tr>';
      }
      return arr.map(function(r) {
        return '<tr><td class="mono">' + esc(r.setupId || '') + '</td><td class="mono">' + esc(r.trades != null ? String(r.trades) : '—') + '</td><td class="mono">' +
          esc(r.winRate != null ? String(r.winRate) + '%' : '—') + '</td><td class="mono">' + esc(r.totalPnl != null ? String(r.totalPnl) : '—') + '</td></tr>';
      }).join('');
    }
    var pcohDistinctPaper = pcoh.distinctSetupIdsWithPaper != null ? Number(pcoh.distinctSetupIdsWithPaper) : NaN;
    if (!(pcohDistinctPaper >= 0)) pcohDistinctPaper = 0;
    var pmcPnlTopKv = '';
    var pmcPnlLeaderTables = '';
    if (pcohDistinctPaper === 0) {
      pmcPnlTopKv =
        '<div><div class="lbl">top winner (setupId / pnl)</div><div class="val mono" style="font-size:0.72rem">' + esc('—') + ' · ' + esc('—') + '</div></div>' +
        '<div><div class="lbl">top loser (setupId / pnl)</div><div class="val mono" style="font-size:0.72rem">' + esc('—') + ' · ' + esc('—') + '</div></div>';
      pmcPnlLeaderTables =
        '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Top winners (manifest cohort)</p>' +
        '<table style="font-size:0.78rem;width:100%;"><thead><tr><th>setupId</th><th>trades</th><th>win%</th><th>totalPnl</th></tr></thead><tbody>' +
        pmcLeaderRows(plead.winners) + '</tbody></table>' +
        '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Top losers (manifest cohort)</p>' +
        '<table style="font-size:0.78rem;width:100%;"><thead><tr><th>setupId</th><th>trades</th><th>win%</th><th>totalPnl</th></tr></thead><tbody>' +
        pmcLeaderRows(plead.losers) + '</tbody></table>';
    } else if (pcohDistinctPaper === 1) {
      var singleRow = (Array.isArray(plead.winners) && plead.winners[0]) ? plead.winners[0]
        : ((Array.isArray(plead.losers) && plead.losers[0]) ? plead.losers[0] : null);
      var sid1 = singleRow && singleRow.setupId != null ? String(singleRow.setupId) : (pcoh.topWinnerSetupId != null ? String(pcoh.topWinnerSetupId) : '—');
      var tp1 = singleRow && singleRow.totalPnl != null ? String(singleRow.totalPnl) : (pcoh.topWinnerTotalPnl != null ? String(pcoh.topWinnerTotalPnl) : '—');
      var tr1 = singleRow && singleRow.trades != null ? String(singleRow.trades) : '—';
      var wr1 = singleRow && singleRow.winRate != null ? String(singleRow.winRate) + '%' : '—';
      pmcPnlTopKv =
        '<div><div class="lbl">cohort ranking</div><div class="val mono" style="font-size:0.72rem">' + esc('single manifested setup only — ranking N/A') + '</div></div>' +
        '<div><div class="lbl">only setup (setupId / trades / win% / pnl)</div><div class="val mono" style="font-size:0.72rem">' + esc(sid1) + ' · ' + esc(tr1) + ' · ' + esc(wr1) + ' · ' + esc(tp1) + '</div></div>';
      var singleArr = singleRow ? [singleRow] : [];
      pmcPnlLeaderTables =
        '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Manifest cohort (single setup — not a ranked list)</p>' +
        '<table style="font-size:0.78rem;width:100%;"><thead><tr><th>setupId</th><th>trades</th><th>win%</th><th>totalPnl</th></tr></thead><tbody>' +
        pmcLeaderRows(singleArr) + '</tbody></table>';
    } else {
      pmcPnlTopKv =
        '<div><div class="lbl">top winner (setupId / pnl)</div><div class="val mono" style="font-size:0.72rem">' + esc(pcoh.topWinnerSetupId != null ? String(pcoh.topWinnerSetupId) : '—') + ' · ' + esc(pcoh.topWinnerTotalPnl != null ? String(pcoh.topWinnerTotalPnl) : '—') + '</div></div>' +
        '<div><div class="lbl">top loser (setupId / pnl)</div><div class="val mono" style="font-size:0.72rem">' + esc(pcoh.topLoserSetupId != null ? String(pcoh.topLoserSetupId) : '—') + ' · ' + esc(pcoh.topLoserTotalPnl != null ? String(pcoh.topLoserTotalPnl) : '—') + '</div></div>';
      pmcPnlLeaderTables =
        '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Top winners (manifest cohort)</p>' +
        '<table style="font-size:0.78rem;width:100%;"><thead><tr><th>setupId</th><th>trades</th><th>win%</th><th>totalPnl</th></tr></thead><tbody>' +
        pmcLeaderRows(plead.winners) + '</tbody></table>' +
        '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Top losers (manifest cohort)</p>' +
        '<table style="font-size:0.78rem;width:100%;"><thead><tr><th>setupId</th><th>trades</th><th>win%</th><th>totalPnl</th></tr></thead><tbody>' +
        pmcLeaderRows(plead.losers) + '</tbody></table>';
    }
    var pmcMerge = pmc.paperExecutionSignalsPromotedManifestMerge;
    var pmcMergeHtml = !pmcMerge
      ? '<p class="muted" style="font-size:0.78rem;margin:0;">No promotedManifestMerge on paper_execution_v1_signals.json (rebuild signals).</p>'
      : '<div class="kv" style="font-size:0.8rem;margin:0.25rem 0 0.5rem;">' +
        '<div><div class="lbl">manifestPresent</div><div class="val mono">' + esc(String(!!pmcMerge.manifestPresent)) + '</div></div>' +
        '<div><div class="lbl">signals in / out</div><div class="val mono">' + esc(String(pmcMerge.promotedManifestSignalsIn)) + ' / ' + esc(String(pmcMerge.promotedManifestSignalsOut)) + '</div></div>' +
        '<div><div class="lbl">mergeRejected / staleRemoved</div><div class="val mono">' + esc(String(pmcMerge.mergeRejectedCount)) + ' / ' + esc(String(pmcMerge.staleRemovedCount)) + '</div></div>' +
        '</div>';
    var prc = pmc.paperRealityCheck && typeof pmc.paperRealityCheck === 'object' ? pmc.paperRealityCheck : {};
    var pmcPrcHtml = '';
    if (prc.paperRealityCheckSchemaVersion == null) {
      pmcPrcHtml =
        '<p class="muted" style="font-size:0.72rem;margin:0.35rem 0 0;">Paper reality check: not present (rebuild promoted_manifest_coverage / dashboard).</p>';
    } else {
      var prcParts = [];
      if (prc.singleManifestedSetupWithPaper) prcParts.push('single_setup_with_paper');
      if (prc.manifestCohortTooNarrowForRanking) prcParts.push('cohort_too_narrow_for_ranking');
      if (prc.unknownCycleDominant) prcParts.push('unknown_cycle_dominant');
      if (prc.cycleCoverageLow) prcParts.push('cycle_coverage_low');
      if (prc.highSingleSetupConcentration) prcParts.push('high_single_setup_concentration');
      var shareStr =
        prc.tradesMissingCycleKeyShare != null
          ? String(Math.round(prc.tradesMissingCycleKeyShare * 10000) / 100) + '%'
          : 'n/a';
      var sus = Array.isArray(prc.suspiciousDays) ? prc.suspiciousDays : [];
      var susShow = Math.min(12, sus.length);
      var susT = sus.slice(0, susShow).map(function(d) {
        return '<tr><td class="mono">' + esc(d.day) + '</td><td class="mono">' + esc(String(d.trades)) + '</td><td class="mono">' +
          esc(d.winRate != null ? String(d.winRate) + '%' : '—') + '</td><td class="mono">' + esc(d.reasonCode || '') + '</td></tr>';
      }).join('');
      var concNote = '';
      if (prc.highSingleSetupConcentrationDetail && prc.highSingleSetupConcentrationDetail.setupId) {
        concNote =
          ' · concentration: <span class="mono">' + esc(String(prc.highSingleSetupConcentrationDetail.setupId)) + '</span> ' +
          esc(String(prc.highSingleSetupConcentrationDetail.tradesSharePercent != null ? prc.highSingleSetupConcentrationDetail.tradesSharePercent : '—')) +
          '% of cohort trades';
      }
      pmcPrcHtml =
        '<h3 style="font-size:0.78rem;color:var(--accent);margin:0.65rem 0 0.25rem;">Paper reality check</h3>' +
        '<p class="muted" style="font-size:0.72rem;margin:0 0 0.35rem;">' +
        'flags: <span class="mono">' + esc(prcParts.length ? prcParts.join(', ') : 'none') + '</span> · ' +
        'missing-cycle share (V2 eligible): <span class="mono">' + esc(shareStr) + '</span> · ' +
        'by_day / by_cycle inputs: <span class="mono">' + esc(String(prc.sources && prc.sources.byDayFilePresent)) + '</span> / <span class="mono">' +
        esc(String(prc.sources && prc.sources.byCycleFilePresent)) + '</span>' +
        concNote +
        '</p>' +
        (sus.length
          ? '<table style="font-size:0.78rem;width:100%;"><thead><tr><th>day (UTC)</th><th>trades</th><th>win%</th><th>reasonCode</th></tr></thead><tbody>' +
            susT + '</tbody></table>' +
            (sus.length > susShow
              ? '<p class="muted" style="font-size:0.68rem;margin:0.25rem 0 0;">+' + esc(String(sus.length - susShow)) + ' more in discovery/promoted_manifest_coverage.json → paperRealityCheck.suspiciousDays</p>'
              : '')
          : '<p class="muted" style="font-size:0.72rem;margin:0;">No suspicious days (0% or 100% win rate with ≥ min trades), or by_day absent.</p>');
    }
    document.getElementById('promotedManifestCoverageBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #4a908a;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.35rem;">Promoted manifest coverage</h2>' +
      '<p class="muted" style="font-size:0.72rem;margin:0 0 0.5rem;">promoted_children → promoted_manifest → paper signals (promoted_manifest) · metrics slice by setupId</p>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">promoted distinct setupIds</div><div class="val mono">' + esc(String(pmc.promotedDistinctSetupIdsCount != null ? pmc.promotedDistinctSetupIdsCount : 0)) + '</div></div>' +
      '<div><div class="lbl">manifest distinct setupIds</div><div class="val mono">' + esc(String(pmc.manifestDistinctSetupIdsCount != null ? pmc.manifestDistinctSetupIdsCount : 0)) + '</div></div>' +
      '<div><div class="lbl">manifest items / manifest skipped</div><div class="val mono">' + esc(String(pmc.manifestItemCount != null ? pmc.manifestItemCount : 0)) + ' / ' + esc(String(pmc.manifestSkippedCount != null ? pmc.manifestSkippedCount : 0)) + '</div></div>' +
      '<div><div class="lbl">paper file rows (signalSource)</div><div class="val mono">' + esc(String(pmc.promotedManifestSignalRowsInPaperFile != null ? pmc.promotedManifestSignalRowsInPaperFile : 0)) + ' · distinct ' + esc(String(pmc.distinctSetupIdsInPromotedManifestSignals != null ? pmc.distinctSetupIdsInPromotedManifestSignals : 0)) + '</div></div>' +
      '</div>' +
      '<h3 style="font-size:0.78rem;color:var(--accent);margin:0.65rem 0 0.25rem;">Paper gate</h3>' +
      '<div class="kv" style="font-size:0.8rem;margin:0.25rem 0 0.55rem;">' +
      '<div><div class="lbl">status</div><div class="val mono">' + esc(pgEnabled) + '</div></div>' +
      '<div><div class="lbl">thresholds (trades / totalPnl / avgPnl / winRate)</div><div class="val mono">' +
        esc(String(pgThr.minTrades != null ? pgThr.minTrades : '—')) + ' / ' +
        esc(String(pgThr.minTotalPnl != null ? pgThr.minTotalPnl : '—')) + ' / ' +
        esc(String(pgThr.minAvgPnl != null ? pgThr.minAvgPnl : '—')) + ' / ' +
        esc(String(pgThr.minWinRate != null ? pgThr.minWinRate : '—')) + '</div></div>' +
      '<div><div class="lbl">evaluated setups</div><div class="val mono">' + esc(String(pg.evaluatedStrategies != null ? pg.evaluatedStrategies : 0)) + '</div></div>' +
      '<div><div class="lbl">no paper row</div><div class="val mono">' + esc(String(pg.noPaperMetricsRowCount != null ? pg.noPaperMetricsRowCount : 0)) + '</div></div>' +
      '<div><div class="lbl">below min trades (non-blocking)</div><div class="val mono">' + esc(String(pg.belowMinTradesCount != null ? pg.belowMinTradesCount : 0)) + '</div></div>' +
      '</div>' +
      '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Paper gate skipped by reason</p>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>reasonCode</th><th>count</th></tr></thead><tbody>' +
      (pgSkipRows || '<tr><td colspan="2" class="muted">—</td></tr>') + '</tbody></table>' +
      pmcPrcHtml +
      '<h3 style="font-size:0.78rem;color:var(--accent);margin:0.65rem 0 0.25rem;">Promoted cohort PnL</h3>' +
      '<p class="muted" style="font-size:0.7rem;margin:0 0 0.35rem;">Manifested setupIds only (promoted_manifest items) · not global paper · source: promoted_manifest_coverage.json</p>' +
      (pmcNoManifestPaper
        ? '<p class="muted" style="font-size:0.78rem;margin:0 0 0.5rem;">no paper metrics for manifested setupIds</p>'
        : '') +
      '<div class="kv" style="font-size:0.8rem;margin:0.25rem 0 0.55rem;">' +
      '<div><div class="lbl">cohort totalPnl</div><div class="val mono">' + esc(pcoh.totalPnl != null ? String(pcoh.totalPnl) : 'n/a') + '</div></div>' +
      '<div><div class="lbl">avg pnl / trade</div><div class="val mono">' + esc(pcoh.avgPnlPerTrade != null ? String(pcoh.avgPnlPerTrade) : 'n/a') + '</div></div>' +
      '<div><div class="lbl">cohort trades</div><div class="val mono">' + esc(String(pcoh.trades != null ? pcoh.trades : 0)) + '</div></div>' +
      '<div><div class="lbl">avg win rate (across setups w/ trades)</div><div class="val mono">' + esc(pcoh.avgWinRateAcrossSetups != null ? String(pcoh.avgWinRateAcrossSetups) + '%' : 'n/a') + '</div></div>' +
      '<div><div class="lbl">manifest setupIds with paper / without</div><div class="val mono">' + esc(String(pcoh.distinctSetupIdsWithPaper != null ? pcoh.distinctSetupIdsWithPaper : '—')) + ' / ' + esc(String(pcoh.distinctSetupIdsWithoutPaper != null ? pcoh.distinctSetupIdsWithoutPaper : '—')) + '</div></div>' +
      pmcPnlTopKv +
      '<div><div class="lbl">skipped from manifest (producer)</div><div class="val mono">' + esc(String(pmc.manifestSkippedCount != null ? pmc.manifestSkippedCount : '—')) + '</div></div>' +
      '</div>' +
      pmcPnlLeaderTables +
      pmcMergeHtml +
      '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Manifest producer skipped (reason → count)</p>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>reasonCode</th><th>count</th></tr></thead><tbody>' +
      (pmcSkipRows || '<tr><td colspan="2" class="muted">—</td></tr>') + '</tbody></table>' +
      '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">itemsBySetupId (manifest items per setupId, top 40)</p>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>setupId</th><th>item count</th></tr></thead><tbody>' +
      (pmcItemRows || '<tr><td colspan="2" class="muted">—</td></tr>') + '</tbody></table>' +
      '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Paper metrics by strategy (slice for promoted ∪ manifest setupIds)</p>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>setupId</th><th>trades</th><th>wins</th><th>losses</th><th>win%</th><th>totalPnl</th><th>avgPnl</th></tr></thead><tbody>' +
      (pmcMetRows || '<tr><td colspan="7" class="muted">—</td></tr>') + '</tbody></table>' +
      '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">discovery/promoted_manifest_coverage.json · schema v' + esc(pmc.coverageSchemaVersion != null ? String(pmc.coverageSchemaVersion) : 'n/a') + '</p>' +
      '</section>';

    var pli = payload.paperLearningInsights || {};
    var pliConf = pli.confidence || 'low';
    var pliConfCls = pliConf === 'high' ? 'ok' : (pliConf === 'medium' ? 'degraded' : 'neutral');
    var rankRows = (pli.strategyRanking || []).slice(0, 15).map(function(r) {
      return '<tr><td class="mono">' + esc(r.strategyId) + '</td><td class="mono">' + esc(String(r.trades)) + '</td><td class="mono">' +
        esc(r.winRate != null ? String(r.winRate) + '%' : 'n/a') + '</td><td class="mono">' +
        esc(r.totalPnl != null ? String(r.totalPnl) : 'n/a') + '</td><td class="mono">' + esc(String(r.score != null ? r.score : 'n/a')) + '</td></tr>';
    }).join('');
    var sug = pli.suggestions || {};
    var boost = Array.isArray(sug.strategiesToBoost) ? sug.strategiesToBoost.map(esc).join(', ') : '—';
    var redu = Array.isArray(sug.strategiesToReduce) ? sug.strategiesToReduce.map(esc).join(', ') : '—';
    var notes = Array.isArray(sug.notes) && sug.notes.length
      ? '<ul style="margin:0.35rem 0 0 1rem;padding:0;font-size:0.78rem;color:var(--muted);">' +
        sug.notes.map(function(n) { return '<li class="mono">' + esc(n) + '</li>'; }).join('') + '</ul>'
      : '<p class="muted" style="font-size:0.78rem;margin:0.35rem 0 0;">—</p>';
    document.getElementById('paperLearningInsightsBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid #8b6f47;padding:0.65rem 1rem;">' +
      '<h2 style="margin-bottom:0.35rem;">Learning insights (paper, suggestive only)</h2>' +
      '<p style="margin:0 0 0.5rem;"><span class="status-pair blocked"><span class="badge mono">NOT APPLIED</span></span>' +
      ' <span class="muted" style="font-size:0.78rem;">No auto changes to mutation / policy / governor · mode=' + esc((pli.safety && pli.safety.mode) || 'suggestive_only') + '</span></p>' +
      '<div class="kv" style="font-size:0.82rem;">' +
      '<div><div class="lbl">confidence</div><div class="val"><span class="status-pair ' + pliConfCls + '"><span class="badge mono">' + esc(pliConf) + '</span></span></div></div>' +
      '<div><div class="lbl">global trades / win% / totalPnl</div><div class="val mono">' + esc(String((pli.global && pli.global.trades) != null ? pli.global.trades : 0)) + ' / ' +
        esc(pli.global && pli.global.winRate != null ? String(pli.global.winRate) + '%' : 'n/a') + ' / ' +
        esc(pli.global && pli.global.totalPnl != null ? String(pli.global.totalPnl) : 'n/a') + '</div></div>' +
      '<div><div class="lbl">best / worst (ranked cohort)</div><div class="val mono">' + esc(pli.summaryBestStrategyId || '—') + ' / ' + esc(pli.summaryWorstStrategyId || '—') + '</div></div>' +
      '</div>' +
      '<p class="muted" style="font-size:0.75rem;margin:0.5rem 0 0.25rem;">Suggest · top ~20% boost / bottom ~20% reduce (min 5 trades/strategy, ≥3 eligible strategies)</p>' +
      '<p class="mono" style="font-size:0.78rem;margin:0;"><strong>boost</strong> ' + boost + '</p>' +
      '<p class="mono" style="font-size:0.78rem;margin:0.25rem 0 0;"><strong>reduce</strong> ' + redu + '</p>' +
      '<p class="lbl" style="margin-top:0.65rem;">Notes</p>' + notes +
      '<h3 style="font-size:0.78rem;color:var(--accent);margin:0.65rem 0 0.25rem;">Strategy ranking (eligible)</h3>' +
      '<table style="font-size:0.8rem;width:100%;"><thead><tr><th>strategyId</th><th>trades</th><th>win%</th><th>totalPnl</th><th>score</th></tr></thead><tbody>' +
      (rankRows || '<tr><td colspan="5" class="muted">—</td></tr>') + '</tbody></table>' +
      '<p class="muted" style="font-size:0.68rem;margin:0.45rem 0 0;">engine/governance/PAPER_LEARNING_INSIGHTS_SCHEMA.md · v ' + esc(pli.learningInsightsVersion || 'n/a') + '</p>' +
      '</section>';

    var ghx = payload.governanceHealth || {};
    var ghStatus = ghx.status || 'healthy';
    var ghPairCls = ghStatus === 'critical' ? 'blocked' : (ghStatus === 'warning' ? 'degraded' : 'ok');
    var ga = ghx.activeAlerts || [];
    var ghAlertsHtml = ga.length
      ? '<ul style="margin:0.35rem 0 0 1rem;padding:0;font-size:0.82rem;color:var(--muted);">' +
        ga.map(function(a) { return '<li class="mono">' + esc(a) + '</li>'; }).join('') + '</ul>'
      : '<p class="muted" style="margin:0.35rem 0 0;font-size:0.82rem;">No active alerts</p>';
    var ghComp = ghx.components || {};
    var ghCompRow = ['p5', 'policy', 'governor', 'p7'].map(function(k) {
      var c = ghComp[k] || {};
      var st = c.status || 'healthy';
      var pc = st === 'critical' ? 'blocked' : (st === 'warning' ? 'degraded' : 'ok');
      return '<div><div class="lbl">' + esc(k) + '</div><div class="val"><span class="status-pair ' + pc +
        '"><span class="badge mono">' + esc(st) + '</span></span>' +
        (c.lastAlertReason != null
          ? ' <span class="mono" style="font-size:0.72rem;color:var(--muted);">' + esc(c.lastAlertReason) + '</span>'
          : '') + '</div></div>';
    }).join('');
    document.getElementById('governanceHealthBanner').innerHTML =
      '<section class="header-last-run" style="border-left:4px solid var(--accent);">' +
      '<h2>Governance health (consolidated)</h2>' +
      '<div class="kv">' +
      '<div><div class="lbl">status</div><div class="val"><span class="status-pair ' + ghPairCls + '"><span class="badge mono">' + esc(ghStatus) + '</span></span></div></div>' +
      '<div><div class="lbl">priority lastAlertReason</div><div class="val mono">' + esc(ghx.lastAlertReason != null ? ghx.lastAlertReason : '—') + '</div></div>' +
      '<div><div class="lbl">healthy / alerting</div><div class="val mono">' + esc(String(ghx.healthyComponentCount != null ? ghx.healthyComponentCount : 'n/a')) + ' / ' + esc(String(ghx.alertComponentCount != null ? ghx.alertComponentCount : 'n/a')) + '</div></div>' +
      '</div>' +
      '<p class="lbl" style="margin-top:0.75rem;">Components</p><div class="kv">' + ghCompRow + '</div>' +
      '<p class="lbl" style="margin-top:0.75rem;">activeAlerts</p>' + ghAlertsHtml +
      '<p class="muted" style="font-size:0.72rem;margin:0.5rem 0 0;">Contract: engine/governance/GOVERNANCE_HEALTH_SCHEMA.md · schema ' + esc(ghx.governanceHealthSchemaVersion || 'n/a') + '</p>' +
      '</section>';

    var liveStatusHtml = '';
    if (liveState === 'idle') {
      liveStatusHtml =
        '<section class="header-last-run" style="border-left:4px solid #6c7a89;padding:0.65rem 1rem;">' +
        '<h2 style="margin-bottom:0.35rem;">No live execution data yet</h2>' +
        '<p style="margin:0 0 0.45rem;font-size:0.85rem;">No correlated fills or active positions were found for the current UTC day window.</p>' +
        '<ul>' +
        '<li>execution feed healthy but no fills in current window</li>' +
        '<li>no open positions</li>' +
        '<li>no pending orders</li>' +
        '<li>lab/evolution data still available below</li>' +
        '</ul>' +
        '<div class="kv" style="font-size:0.82rem;margin-top:0.45rem;">' +
        '<div><div class="lbl">periodPnlSource</div><div class="val mono">' + esc(live.periodPnlSource || 'none') + '</div></div>' +
        '<div><div class="lbl">periodStartUtc</div><div class="val mono" style="font-size:0.72rem;">' + esc(live.periodStartUtc || 'n/a') + '</div></div>' +
        '<div><div class="lbl">periodEndUtc</div><div class="val mono" style="font-size:0.72rem;">' + esc(live.periodEndUtc || 'n/a') + '</div></div>' +
        '</div>' +
        '</section>';
    } else if (liveState === 'stale') {
      liveStatusHtml =
        '<section class="header-last-run" style="border-left:4px solid var(--warn);padding:0.65rem 1rem;">' +
        '<h2 style="margin-bottom:0.35rem;">Live execution stale</h2>' +
        '<p style="margin:0 0 0.45rem;font-size:0.85rem;">Live execution state exists, but no new events within threshold.</p>' +
        '<div class="kv" style="font-size:0.82rem;margin-top:0.45rem;">' +
        '<div><div class="lbl">lastLiveEventTs</div><div class="val mono" style="font-size:0.72rem;">' + esc(lastLiveEventTs || 'n/a') + '</div></div>' +
        '<div><div class="lbl">staleAgeMinutes</div><div class="val mono">' + esc(staleAgeMinutes != null ? String(staleAgeMinutes) : 'n/a') + '</div></div>' +
        '<div><div class="lbl">thresholdMinutes</div><div class="val mono">' + esc(String(staleThresholdMinutes)) + '</div></div>' +
        '</div>' +
        '</section>';
    } else {
      liveStatusHtml =
        '<section class="header-last-run" style="border-left:4px solid var(--ok);padding:0.65rem 1rem;">' +
        '<h2 style="margin-bottom:0.35rem;">Live execution activity</h2>' +
        '<div class="kv" style="font-size:0.82rem;">' +
        '<div><div class="lbl">fills ledger</div><div class="val mono">' + esc(String(fillsLedgerCount)) + '</div></div>' +
        '<div><div class="lbl">open positions</div><div class="val mono">' + esc(String(openPositionsCount)) + '</div></div>' +
        '<div><div class="lbl">open trades</div><div class="val mono">' + esc(String(openTradesCount)) + '</div></div>' +
        '<div><div class="lbl">pending orders</div><div class="val mono">' + esc(String(pendingOrdersCount)) + '</div></div>' +
        '</div>' +
        '</section>';
    }
    document.getElementById('liveExecutionBanner').innerHTML = liveStatusHtml;

    var xauRows = Array.isArray(payload.xauDatasetDiagnostics) ? payload.xauDatasetDiagnostics : [];
    if (!xauRows.length) {
      document.getElementById('xauDataBanner').innerHTML =
        '<p class="muted mono" style="margin:0.1rem 0 0.2rem;">XAU data: n/a</p>';
    } else {
      var tfOrder = ['5m', '15m', '1h'];
      var byTf = {};
      for (var xr = 0; xr < xauRows.length; xr += 1) {
        var row = xauRows[xr] || {};
        byTf[String(row.timeframe || '').toLowerCase()] = row;
      }
      var parts = [];
      for (var xt = 0; xt < tfOrder.length; xt += 1) {
        var tfk = tfOrder[xt];
        var r = byTf[tfk];
        if (!r) continue;
        var verdict = String(r.verdict || 'unknown');
        var reason = r.primaryReason ? String(r.primaryReason) : '';
        var age = Number.isFinite(Number(r.ageMin)) ? (Math.round(Number(r.ageMin) * 10) / 10) : null;
        var cls = verdict === 'degraded_critical_dataset' ? 'degraded' : 'neutral';
        var txt = tfk + ' ' + verdict + (reason ? (' (' + reason + ')') : '') + (age != null ? (', ' + age + 'm') : '');
        parts.push('<span class="status-pair ' + cls + '"><span class="badge mono">' + esc(txt) + '</span></span>');
      }
      document.getElementById('xauDataBanner').innerHTML =
        '<p class="muted mono" style="margin:0.1rem 0 0.2rem;">XAU data: ' + (parts.length ? parts.join(' ') : 'n/a') + '</p>';
    }

    function reasonsList(title, o) {
      if (!o || !Array.isArray(o.reasons) || !o.reasons.length) return '';
      return '<p class="lbl" style="margin-top:0.75rem;">' + title + '</p><ul>' +
        o.reasons.map(function(r) { return '<li class="mono">' + esc(r) + '</li>'; }).join('') + '</ul>';
    }

    function skipBlock(label, o) {
      if (!o) return '';
      var ad = o.appliedDeltas;
      if (o.appliedFromTrendMemory === false && ad && ad.skipped) {
        return '<p class="muted"><strong>' + esc(label) + '</strong> skipped — reason: <span class="mono">' +
          esc(ad.reason || 'unknown') + '</span></p>';
      }
      return '';
    }

    var heroParts = [];
    if (tma) {
      heroParts.push('<p><span class="lbl">Apply enabled</span> <strong>' + esc(fmtBool(tma.envEnabled)) + '</strong></p>');
      heroParts.push('<p><span class="lbl">Mode</span> <strong class="mono">' + esc(tma.envMode || 'n/a') + '</strong> · mutations <strong>' +
        esc(fmtBool(tma.envMutationsEnabled)) + '</strong></p>');
    } else {
      heroParts.push('<p class="muted">No aggregated trendMemoryApply on mini report — showing governor / policy blocks only.</p>');
    }
    var govBlock = govTm || (tma && tma.governor);
    var polBlock = pol && pol.trendMemoryApply || (tma && tma.mutationPolicy);
    heroParts.push('<h2 style="margin-top:0.75rem;font-size:0.8rem;opacity:0.95;">Portfolio governor (P7.1)</h2>');
    if (govBlock) {
      heroParts.push('<p><strong>appliedFromTrendMemory</strong> = <span class="mono">' + esc(String(govBlock.appliedFromTrendMemory)) + '</span></p>');
      heroParts.push(skipBlock('Governor', govBlock));
      heroParts.push(reasonsList('Governor reasons', govBlock));
      if (govBlock.appliedDeltas && !govBlock.appliedDeltas.skipped) {
        heroParts.push('<pre style="max-height:200px;margin-top:0.5rem;">' + esc(JSON.stringify(govBlock.appliedDeltas, null, 2)) + '</pre>');
      } else if (govBlock.appliedDeltas && govBlock.appliedFromTrendMemory === false) {
        heroParts.push('<pre style="max-height:120px;margin-top:0.5rem;">' + esc(JSON.stringify(govBlock.appliedDeltas, null, 2)) + '</pre>');
      }
    } else {
      heroParts.push('<p class="muted">n/a</p>');
    }
    heroParts.push('<h2 style="margin-top:1rem;font-size:0.8rem;opacity:0.95;">Mutation policy (P7.1)</h2>');
    if (polBlock) {
      heroParts.push('<p><strong>appliedFromTrendMemory</strong> = <span class="mono">' + esc(String(polBlock.appliedFromTrendMemory)) + '</span></p>');
      heroParts.push(skipBlock('Policy', polBlock));
      heroParts.push(reasonsList('Policy reasons', polBlock));
      if (polBlock.appliedDeltas) {
        heroParts.push('<pre style="max-height:200px;margin-top:0.5rem;">' + esc(JSON.stringify(polBlock.appliedDeltas, null, 2)) + '</pre>');
      }
    } else {
      heroParts.push('<p class="muted">n/a</p>');
    }
    document.getElementById('heroTrendMemory').innerHTML =
      '<h2>Trend memory apply (P7.1)</h2>' + heroParts.join('');

    var src = payload.sources || {};
    var srcRows = Object.keys(src).map(function(k) {
      var p = src[k];
      var id = 'p-' + k.replace(/[^a-z0-9]/gi, '-');
      return '<div class="source-row"><span class="mono" style="min-width:11rem;font-size:0.8rem;color:var(--muted);">' +
        esc(k) + '</span><pre class="source-path" id="' + id + '" tabindex="0">' + esc(p) + '</pre>' +
        '<button type="button" class="btn-copy" data-copy-target="' + id + '">Copy path</button></div>';
    }).join('');
    document.getElementById('sourcesSection').innerHTML =
      '<h2>Sources</h2><p class="muted" style="font-size:0.8rem;margin:0 0 0.5rem;">Absolute paths to aggregated artefacts; click a path to focus, or use Copy path.</p>' +
      srcRows;

    document.body.addEventListener('click', function(ev) {
      var btn = ev.target && ev.target.closest && ev.target.closest('[data-copy-target]');
      if (!btn) return;
      var id = btn.getAttribute('data-copy-target');
      var el = document.getElementById(id);
      if (!el) return;
      var text = el.textContent || '';
      function done() {
        btn.classList.add('copied');
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function() { btn.classList.remove('copied'); btn.textContent = old; }, 1200);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function() {
          selAndCopy(el, done);
        });
      } else {
        selAndCopy(el, done);
      }
    });

    function selAndCopy(el, cb) {
      var r = document.createRange();
      r.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      try { document.execCommand('copy'); } catch (e) {}
      sel.removeAllRanges();
      if (cb) cb();
    }

    var hist = payload.runHistoryShort || [];
    var histRows = hist.map(function(r) {
      var v = r.verdict != null ? r.verdict : 'n/a';
      var ap = r.appliedFromTrendMemory;
      var apS = ap === true ? 'applied' : (ap === false ? 'skipped' : 'n/a');
      return '<tr><td class="mono">' + esc(r.experimentId) + '</td><td class="mono">' + esc(r.governanceStatus) + '</td>' +
        '<td class="mono">' + esc(v) + '</td><td class="mono">' + esc(r.targetExposure) + '</td><td class="mono">' + esc(apS) + '</td>' +
        '<td class="mono" style="font-size:0.7rem">' + esc(r.at || '') + '</td></tr>';
    }).join('');
    document.getElementById('runHistorySection').innerHTML =
      '<h2>Run history (short)</h2><p class="muted" style="font-size:0.8rem;margin:0 0 0.5rem;">From portfolio_governor_history.json; verdict from governance_mini_report_&lt;id&gt;.json when present.</p>' +
      '<table class="history-table"><thead><tr><th>experimentId</th><th>governanceStatus</th><th>verdict</th><th>targetExposure</th><th>TM apply</th><th>at</th></tr></thead><tbody>' +
      (histRows || '<tr><td colspan="6" class="muted">No history</td></tr>') + '</tbody></table>';

    function tmApplyRow(label, o) {
      if (!o) return '<p class="mono" style="color:var(--muted)">missing</p>';
      var on = o.appliedFromTrendMemory === true;
      return '<p><strong>' + esc(label) + '</strong> appliedFromTrendMemory=' + esc(String(on)) + '</p>' +
        '<pre>' + esc(JSON.stringify(o, null, 2)) + '</pre>';
    }

    var cards = document.getElementById('cards');
    var h = '';
    h += '<section><h2>Governance mini report</h2>' +
      (mini ? '<p>' + alignedBadges(mini.governanceStatus, mini.verdict) + '</p>' +
        '<table><tr><th>experimentId</th><td class="mono">' + esc(mini.experimentId || '') + '</td></tr>' +
        '<tr><th>cycle_valid</th><td>' + esc(fmtBool(mini.supervisor && mini.supervisor.cycle_valid)) + '</td></tr></table>' +
        '<h2 style="margin-top:0.75rem;font-size:0.8rem;">trendMemoryApply (full report)</h2>' +
        (mini.trendMemoryApply ? '<pre>' + esc(JSON.stringify(mini.trendMemoryApply, null, 2)) + '</pre>' : '<p class="muted">—</p>')
      : '<p class="muted">No governance_mini_report.json</p>') + '</section>';

    h += '<section><h2>Portfolio governor (P6)</h2>' +
      (gov ? '<p>' + alignedBadges(gov.governanceStatus, null) + ' <span class="muted">mode</span> <span class="mono">' + esc(gov.promotionMode || '') + '</span></p>' +
        '<table>' +
        '<tr><th>targetExposure</th><td>' + esc(gov.targetExposure) + '</td></tr>' +
        '<tr><th>maxNewAllocations</th><td>' + esc(gov.maxNewAllocations) + '</td></tr>' +
        '<tr><th>admission ×</th><td>' + esc(gov.admissionThresholdMultiplier) + '</td></tr>' +
        '<tr><th>holdCash</th><td>' + esc(gov.holdCash) + '</td></tr></table>' +
        '<h2 style="margin-top:0.75rem;font-size:0.8rem;">P7.1 trendMemoryApply (raw)</h2>' +
        tmApplyRow('Governor', gov.trendMemoryApply)
      : '<p class="muted">No portfolio_governor.json</p>') + '</section>';

    h += '<section><h2>Mutation policy (P5)</h2>' +
      (pol ? tmApplyRow('Policy', pol.trendMemoryApply) +
        '<pre style="max-height:160px">' + esc(JSON.stringify(pol.byMutationType, null, 2)) + '</pre>'
      : '<p class="muted">No mutation_policy.json</p>') + '</section>';

    var ph = payload.p5Health || {};
    h += '<section><h2>P5 cycle health (observability)</h2>' +
      '<div class="kv">' +
      '<div><div class="lbl">schema</div><div class="val mono">' + esc(ph.p5MetricsSchemaVersion != null ? ph.p5MetricsSchemaVersion : 'n/a') + '</div></div>' +
      '<div><div class="lbl">lastStatus</div><div class="val mono">' + esc(ph.lastStatus != null ? ph.lastStatus : 'n/a') + '</div></div>' +
      '<div><div class="lbl">lastAlertReason</div><div class="val mono">' + esc(ph.lastAlertReason != null ? ph.lastAlertReason : '—') + '</div></div>' +
      '<div><div class="lbl">cycleAlignment</div><div class="val mono">' + esc(ph.cycleAlignment != null ? ph.cycleAlignment : 'n/a') + '</div></div>' +
      '<div><div class="lbl">okRate / skipRate</div><div class="val mono">' + esc(ph.okRate != null ? ph.okRate : 'n/a') + ' / ' + esc(ph.skipRate != null ? ph.skipRate : 'n/a') + '</div></div>' +
      '<div><div class="lbl">mismatchCount</div><div class="val mono">' + esc(ph.mismatchCount != null ? ph.mismatchCount : 'n/a') + '</div></div>' +
      '<div><div class="lbl">lastObserved</div><div class="val mono" style="font-size:0.72rem">' + esc(ph.lastObserved || '') + '</div></div>' +
      '<div><div class="lbl">lastMismatchAt</div><div class="val mono" style="font-size:0.72rem">' + esc(ph.lastMismatchAt || '—') + '</div></div>' +
      '<div><div class="lbl">lastParseErrorAt</div><div class="val mono" style="font-size:0.72rem">' + esc(ph.lastParseErrorAt || '—') + '</div></div>' +
      '</div><p class="muted" style="font-size:0.78rem;margin:0.5rem 0 0;">From governance/p5_metrics.json (refreshed on dashboard build). Contract: engine/observability/P5_METRICS_SCHEMA.md</p></section>';

    var poh = payload.policyHealth || {};
    h += '<section><h2>Policy health (observability)</h2>' +
      '<div class="kv">' +
      '<div><div class="lbl">schema</div><div class="val mono">' + esc(poh.policyMetricsSchemaVersion != null ? poh.policyMetricsSchemaVersion : 'n/a') + '</div></div>' +
      '<div><div class="lbl">exploration / exploitation</div><div class="val mono">' + esc(poh.lastExplorationWeight != null ? poh.lastExplorationWeight : 'n/a') + ' / ' + esc(poh.lastExploitationWeight != null ? poh.lastExploitationWeight : 'n/a') + '</div></div>' +
      '<div><div class="lbl">diversity</div><div class="val mono">' + esc(poh.lastDiversity != null ? poh.lastDiversity : 'n/a') + '</div></div>' +
      '<div><div class="lbl">source</div><div class="val mono">' + esc(poh.source != null ? poh.source : 'n/a') + '</div></div>' +
      '<div><div class="lbl">driftDetected</div><div class="val mono">' + esc(String(!!poh.driftDetected)) + '</div></div>' +
      '<div><div class="lbl">lastAlertReason</div><div class="val mono">' + esc(poh.lastAlertReason != null ? poh.lastAlertReason : '—') + '</div></div>' +
      '</div><p class="muted" style="font-size:0.78rem;margin:0.5rem 0 0;">From governance/policy_metrics.json (refreshed on dashboard build).</p></section>';

    var gh = payload.governorHealth || {};
    h += '<section><h2>Governor health (observability)</h2>' +
      '<div class="kv">' +
      '<div><div class="lbl">schema</div><div class="val mono">' + esc(gh.governorMetricsSchemaVersion != null ? gh.governorMetricsSchemaVersion : 'n/a') + '</div></div>' +
      '<div><div class="lbl">lastDecision</div><div class="val mono">' + esc(gh.lastDecision != null ? gh.lastDecision : 'n/a') + '</div></div>' +
      '<div><div class="lbl">lastMode</div><div class="val mono">' + esc(gh.lastMode != null ? gh.lastMode : 'n/a') + '</div></div>' +
      '<div><div class="lbl">policySource</div><div class="val mono">' + esc(gh.policySource != null ? gh.policySource : 'n/a') + '</div></div>' +
      '<div><div class="lbl">decisionChangeDetected</div><div class="val mono">' + esc(String(!!gh.decisionChangeDetected)) + '</div></div>' +
      '<div><div class="lbl">lastReason</div><div class="val mono" style="font-size:0.72rem">' + esc(gh.lastReason != null ? gh.lastReason : '—') + '</div></div>' +
      '<div><div class="lbl">lastAlertReason</div><div class="val mono">' + esc(gh.lastAlertReason != null ? gh.lastAlertReason : '—') + '</div></div>' +
      '</div><p class="muted" style="font-size:0.78rem;margin:0.5rem 0 0;">From governance/governor_metrics.json (refreshed on dashboard build). Contract: engine/observability/GOVERNOR_METRICS_SCHEMA.md</p></section>';

    var p7h = payload.p7Health || {};
    h += '<section><h2>P7 trend memory health (observability)</h2>' +
      '<div class="kv">' +
      '<div><div class="lbl">schema</div><div class="val mono">' + esc(p7h.p7MetricsSchemaVersion != null ? p7h.p7MetricsSchemaVersion : 'n/a') + '</div></div>' +
      '<div><div class="lbl">lastStatus / source</div><div class="val mono">' + esc(p7h.lastStatus != null ? p7h.lastStatus : 'n/a') + ' / ' + esc(p7h.lastSource != null ? p7h.lastSource : 'n/a') + '</div></div>' +
      '<div><div class="lbl">window / considered / loaded</div><div class="val mono">' + esc(p7h.lastWindowSize != null ? p7h.lastWindowSize : 'n/a') + ' / ' + esc(p7h.lastReportsConsidered != null ? p7h.lastReportsConsidered : 'n/a') + ' / ' + esc(p7h.lastReportsLoaded != null ? p7h.lastReportsLoaded : 'n/a') + '</div></div>' +
      '<div><div class="lbl">lastApplyCount</div><div class="val mono">' + esc(p7h.lastApplyCount != null ? p7h.lastApplyCount : 'n/a') + '</div></div>' +
      '<div><div class="lbl">coverage / degraded / empty rate</div><div class="val mono">' + esc(p7h.coverageRate != null ? p7h.coverageRate : 'n/a') + ' / ' + esc(p7h.degradedRate != null ? p7h.degradedRate : 'n/a') + ' / ' + esc(p7h.emptyRate != null ? p7h.emptyRate : 'n/a') + '</div></div>' +
      '<div><div class="lbl">lastAlertReason</div><div class="val mono">' + esc(p7h.lastAlertReason != null ? p7h.lastAlertReason : '—') + '</div></div>' +
      '</div><p class="muted" style="font-size:0.78rem;margin:0.5rem 0 0;">From governance/p7_metrics.json (refreshed on dashboard build). Contract: engine/observability/P7_METRICS_SCHEMA.md</p></section>';

    h += '<section><h2>Trend memory (P7)</h2>' +
      (tm ? '<pre style="max-height:280px">' + esc(JSON.stringify(tm, null, 2)) + '</pre>'
      : '<p class="muted">No run_trend_memory.json</p>') + '</section>';

    cards.innerHTML = h;

    var expEl = document.getElementById('exp');
    var erows = (payload.experimentsRecent || []).map(function(e) {
      return '<tr><td class="mono">' + esc(e.experimentId || '') + '</td><td>' + esc(e.startedAt || '') + '</td><td class="mono" style="font-size:0.7rem">' +
        (e.artifactStages || []).map(esc).join(', ') + '</td></tr>';
    }).join('');
    expEl.innerHTML = '<table><thead><tr><th>experimentId</th><th>startedAt</th><th>artifacts</th></tr></thead><tbody>' +
      erows + '</tbody></table>';

    document.getElementById('raw').textContent = JSON.stringify(payload, null, 2);
  })();
  </script>
</body>
</html>`;

  const htmlPath = path.join(outDir, 'governance_dashboard.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  return { jsonPath, htmlPath, payload };
}

module.exports = { buildGovernanceDashboard, DASHBOARD_VERSION };

function envBoolOptIn(name) {
  const v = (process.env[name] || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

if (require.main === module) {
  try {
    const r = buildGovernanceDashboard();
    console.log('P8 Governance dashboard written.');
    console.log(' ', r.jsonPath);
    console.log(' ', r.htmlPath);
    if (envBoolOptIn('NEUROPILOT_GOVERNANCE_HISTORY_SNAPSHOT')) {
      const { snapshotGovernanceDashboardHistory } = require('./snapshotGovernanceDashboardHistory');
      const h = snapshotGovernanceDashboardHistory({ sourcePath: r.jsonPath });
      if (h.ok) {
        console.log(' ', '[governance_history]', h.dest);
        if (h.indexPath) {
          console.log(' ', '[governance_history] index', h.indexPath);
        }
      } else {
        console.error(' ', '[governance_history] skip:', h.reason, h.src);
      }
    }
  } catch (err) {
    console.error('buildGovernanceDashboard failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}
