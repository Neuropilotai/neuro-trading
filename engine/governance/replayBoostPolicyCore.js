#!/usr/bin/env node
'use strict';

/**
 * Replay boost policy (desk-quant): canonical JSON + execution helpers.
 * Conservative, bounded, transparent. Does not replace replayBoostPolicy.js baseline scorer;
 * layers health / supervisor / circuit breaker and tier mapping (boosted..frozen).
 */

const fs = require('fs');
const path = require('path');
const replayBoostPolicy = require('./replayBoostPolicy');

const POLICY_SCHEMA_VERSION = 1;

function envBool(name, defaultTrue = true) {
  const v = String(process.env[name] == null ? (defaultTrue ? '1' : '0') : process.env[name]).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return defaultTrue;
}

function envNum(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}

/** @returns {import('./replayBoostPolicy').parseReplayBoostEnv extends object} */
function parseReplayBoostPolicyEnv() {
  return {
    policyEnable: envBool('NP_REPLAY_BOOST_POLICY_ENABLE', true),
    intervalSec: Math.max(30, Math.floor(envNum('NP_REPLAY_BOOST_POLICY_INTERVAL_SEC', 120))),
    maxGlobalPerRun: Math.max(1, Math.floor(envNum('NP_REPLAY_BOOST_POLICY_MAX_GLOBAL_PER_RUN', 24))),
    maxSetupsPerRun: Math.max(1, Math.floor(envNum('NP_REPLAY_BOOST_POLICY_MAX_SETUPS_PER_RUN', 8))),
    maxBarsPerSetup: Math.max(1, Math.floor(envNum('NP_REPLAY_BOOST_POLICY_MAX_BARS_PER_SETUP', 5))),
    allowAggressive: ['1', 'true', 'yes', 'on'].includes(
      String(process.env.NP_REPLAY_BOOST_POLICY_ALLOW_AGGRESSIVE || '0').trim().toLowerCase()
    ),
    wStrict: Math.max(0, envNum('NP_REPLAY_BOOST_POLICY_STRICT_WEIGHT', 1.0)),
    wLearning: Math.max(0, envNum('NP_REPLAY_BOOST_POLICY_LEARNING_WEIGHT', 0.35)),
    wExp: Math.max(0, envNum('NP_REPLAY_BOOST_POLICY_EXPECTANCY_WEIGHT', 0.8)),
    wPf: Math.max(0, envNum('NP_REPLAY_BOOST_POLICY_PF_WEIGHT', 0.8)),
    wDup: Math.max(0, envNum('NP_REPLAY_BOOST_POLICY_DUPLICATE_PENALTY_WEIGHT', 1.2)),
    wStall: Math.max(0, envNum('NP_REPLAY_BOOST_POLICY_STALLED_PENALTY_WEIGHT', 1.0)),
  };
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function parseConvergenceTail(content, maxLines) {
  return replayBoostPolicy.parseConvergenceTail(content, maxLines);
}

/**
 * Load all artefacts needed to build policy (paths are explicit).
 * @param {{ dataRoot: string, repoRoot: string, opsDir: string }} roots
 */
function loadInputsForPolicyBuild(roots) {
  const { dataRoot, repoRoot, opsDir } = roots;
  const gov = path.join(dataRoot, 'governance');
  const disc = path.join(dataRoot, 'discovery');
  const convPath = path.join(gov, 'promoted_convergence_trend.jsonl');
  let convergenceTail = [];
  try {
    if (fs.existsSync(convPath)) {
      convergenceTail = parseConvergenceTail(fs.readFileSync(convPath, 'utf8'), 10);
    }
  } catch {
    /* optional */
  }

  const read = (p) => readJsonSafe(p);

  return {
    dataRoot,
    repoRoot,
    opsDir,
    strategyValidation: read(path.join(opsDir, 'strategy_validation.json')),
    strictMappingReport: read(path.join(gov, 'paper_trades_strict_mapping_report.json')),
    setupAnalysis: read(path.join(gov, 'paper_trades_by_setup_analysis.json')),
    lastRun: read(path.join(gov, 'paper_exec_v1_last_run.json')),
    promotedManifest: read(path.join(disc, 'promoted_manifest.json')),
    latestSnapshot: read(path.join(opsDir, 'latest.json')),
    governanceDashboard: read(path.join(opsDir, 'governance_dashboard.json')),
    hybridPromotion: read(path.join(opsDir, 'hybrid_promotion_insights.json')),
    health: read(path.join(opsDir, 'neuropilot_health.json')),
    incident: read(path.join(opsDir, 'incident_status.json')),
    circuitBreaker: read(path.join(opsDir, 'circuit_breaker_status.json')),
    supervisor: read(path.join(opsDir, 'supervisor_status.json')),
    datasetsFreshness:
      read(path.join(gov, 'datasets_freshness.json')) || read(path.join(opsDir, 'datasets_freshness.json')),
    convergenceTail,
  };
}

function countDatasetStress(doc) {
  const rows = doc && Array.isArray(doc.datasets) ? doc.datasets : [];
  let degraded = 0;
  let critical = 0;
  let lagging = 0;
  for (const row of rows) {
    const s = row && row.status != null ? String(row.status).toLowerCase() : '';
    if (s === 'degraded') degraded += 1;
    else if (s === 'critical') critical += 1;
    else if (s === 'lagging') lagging += 1;
  }
  return { degraded, critical, lagging, total: rows.length };
}

/**
 * @param {object} inputs from loadInputsForPolicyBuild
 * @param {ReturnType<typeof parseReplayBoostPolicyEnv>} envOpts
 */
function resolvePolicyMode(inputs, envOpts) {
  const health = inputs.health || {};
  const cb = inputs.circuitBreaker || {};
  const inc = inputs.incident || {};
  const ds = countDatasetStress(inputs.datasetsFreshness || {});

  const cbState = String(cb.state || 'CLOSED').toUpperCase();
  const overall = String(health.overallStatus || 'UNKNOWN').toUpperCase();
  const incidentMode = String(health.incidentMode || inc.incidentMode || 'normal').toLowerCase();

  if (cbState === 'OPEN' || incidentMode === 'circuit_breaker') return 'circuit_breaker';
  if (overall === 'CRITICAL' || ds.critical >= 2) return 'degraded';
  if (['DEGRADED', 'STALLED', 'WATCH'].includes(overall) || ds.degraded >= 8) return 'conservative';
  return 'normal';
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function validationRowByStrategyId(validationDoc) {
  const map = new Map();
  const rows = validationDoc && Array.isArray(validationDoc.rows) ? validationDoc.rows : [];
  for (const row of rows) {
    const sid = row && row.strategyId != null ? String(row.strategyId).trim() : '';
    if (sid) map.set(sid, row);
  }
  return map;
}

/**
 * Secondary score components — learning is bonus-only (capped).
 * @param {object|null} valRow strategy_validation row
 * @param {typeof parseReplayBoostPolicyEnv()} w
 */
function scoreReplayCandidate(setupId, valRow, baselineScore, inputs, w) {
  const strict = valRow && Number(valRow.score);
  const learning = valRow && Number(valRow.learningScore);
  const ex = valRow && Number(valRow.expectancy);
  const pf = valRow && Number(valRow.profitFactor);
  const trades = valRow && Number(valRow.trades);

  let bonus = 0;
  const reasons = [];

  if (Number.isFinite(strict)) {
    const contrib = clamp((strict / 100) * 12 * w.wStrict, 0, 12);
    bonus += contrib;
    if (strict >= 60) reasons.push({ code: 'strict_tier_ok', message: 'Validation strict score healthy', value: strict });
  }
  if (Number.isFinite(learning) && learning > 0) {
    const contrib = clamp((learning / 100) * 6 * w.wLearning, 0, 4);
    bonus += contrib;
    if (learning >= 55) reasons.push({ code: 'learning_bonus_capped', message: 'Learning bonus (capped)', value: learning });
  }
  if (Number.isFinite(ex) && ex > 0) {
    bonus += clamp(ex * 3 * w.wExp, 0, 8);
    reasons.push({ code: 'expectancy_positive', message: 'Expectancy > 0', value: ex });
  }
  if (Number.isFinite(pf) && pf > 1) {
    bonus += clamp((pf - 1) * 5 * w.wPf, 0, 8);
    reasons.push({ code: 'pf_above_one', message: 'Profit factor > 1', value: pf });
  }
  if (Number.isFinite(trades) && trades >= 15) {
    if (Number.isFinite(ex) && ex < 0) {
      bonus -= 15;
      reasons.push({ code: 'negative_expectancy_sample_sufficient', message: 'Negative expectancy with enough trades', value: ex });
    }
    if (Number.isFinite(pf) && pf < 0.9) {
      bonus -= 12;
      reasons.push({ code: 'low_pf_sample_sufficient', message: 'PF weak with enough trades', value: pf });
    }
  }

  const lr = inputs.lastRun || {};
  const dup = Number(lr.duplicateSkippedPersistent);
  const eff = Number(lr.effectiveAppended);
  if (Number.isFinite(dup) && dup > 35 && (!Number.isFinite(eff) || eff === 0)) {
    bonus -= clamp(Math.log1p(dup) * 4 * w.wDup, 0, 18);
    reasons.push({ code: 'duplicate_pressure_global', message: 'High duplicate skips with low append', value: dup });
  }

  const stall = replayBoostPolicy.globalPipelineStallMalus(inputs.convergenceTail || []);
  if (stall.malus) {
    bonus -= stall.malus * w.wStall;
    for (const r of stall.reasons) reasons.push({ code: String(r), message: 'Convergence / pipeline stall signal', value: stall.malus });
  }

  const adjusted = clamp(baselineScore + bonus, 0, 100);
  return { adjustedScore: adjusted, reasons };
}

/**
 * Tier bands use the raw composite score. IMPORTANT: `conservative` policyMode must NOT
 * clamp score below the boosted threshold (70), or boostedCount stays 0 forever while
 * globalControls still reduce caps — that was the previous bug.
 */
function mapScoreToTier(score, policyMode, baselineTier) {
  let s = score;
  if (policyMode === 'circuit_breaker') s = Math.min(s, 38);
  else if (policyMode === 'degraded') s = Math.min(s, 48);
  /* conservative: no score clamp — caution is expressed via globalControls + lower weights */

  let tier = 'neutral';
  if (s >= 70) tier = 'boosted';
  else if (s >= 45) tier = 'neutral';
  else if (s >= 22) tier = 'throttled';
  else tier = 'frozen';

  if (baselineTier === 'D' && s < 30) tier = 'frozen';
  if (policyMode === 'circuit_breaker' && tier === 'boosted') tier = 'neutral';

  return { tier, adjustedScore: s };
}

function manifestIdSet(manifestDoc) {
  const s = new Set();
  const items = manifestDoc && Array.isArray(manifestDoc.items) ? manifestDoc.items : [];
  for (const it of items) {
    const id = it && it.setupId != null ? String(it.setupId).trim() : '';
    if (id) s.add(id);
  }
  return s;
}

/**
 * Extra score for setups on strict `promoted_and_paper_recent` (near-promote / overlap band).
 */
function strictOverlapReplayBonus(strictDoc, setupId, manifestIds) {
  const reasons = [];
  let bonus = 0;
  const rows =
    strictDoc && Array.isArray(strictDoc.promoted_and_paper_recent)
      ? strictDoc.promoted_and_paper_recent
      : [];
  const hit = rows.find((r) => r && String(r.setupKey || '').trim() === setupId);
  if (!hit) {
    return { bonus: 0, reasons, inOverlap: false };
  }
  const tr = Number(hit.tradesRecent);
  const pnl = Number(hit.pnlRecent);
  const inManifest = manifestIds && manifestIds.has(setupId);
  if (inManifest) {
    bonus += 10;
    reasons.push({
      code: 'manifest_and_strict_overlap',
      message: 'In promoted manifest and strict promoted+paper recent',
      value: { tradesRecent: tr, pnlRecent: pnl },
    });
  } else {
    bonus += 4;
    reasons.push({
      code: 'strict_overlap_band',
      message: 'Listed in strict promoted_and_paper_recent',
      value: { tradesRecent: tr, pnlRecent: pnl },
    });
  }
  if (Number.isFinite(tr) && tr >= 1 && tr <= 5) {
    bonus += 5;
    reasons.push({
      code: 'replay_headroom_recent_trades',
      message: 'Moderate recent trade count — bounded replay headroom',
      value: tr,
    });
  }
  return { bonus: clamp(bonus, 0, 22), reasons, inOverlap: true };
}

function tierToExecutionABCD(priorityTier) {
  switch (priorityTier) {
    case 'boosted':
      return 'A';
    case 'neutral':
      return 'B';
    case 'throttled':
      return 'C';
    case 'frozen':
    default:
      return 'D';
  }
}

function resolveReplayBudgetControls(policyMode, inputs, envOpts) {
  const health = inputs.health || {};
  const overall = String(health.overallStatus || 'HEALTHY').toUpperCase();
  let maxPer = envOpts.maxGlobalPerRun;
  let maxSetups = envOpts.maxSetupsPerRun;
  let maxBars = envOpts.maxBarsPerSetup;
  let allowAggressive = envOpts.allowAggressive;

  if (policyMode === 'circuit_breaker') {
    maxPer = Math.min(maxPer, 4);
    maxSetups = Math.min(maxSetups, 2);
    maxBars = Math.min(maxBars, 2);
    allowAggressive = false;
  } else if (policyMode === 'degraded' || overall === 'CRITICAL') {
    maxPer = Math.min(maxPer, 8);
    maxSetups = Math.min(maxSetups, 4);
    maxBars = Math.min(maxBars, 3);
    allowAggressive = false;
  } else if (policyMode === 'conservative') {
    maxPer = Math.min(maxPer, 12);
    maxSetups = Math.min(maxSetups, 6);
    maxBars = Math.min(maxBars, 4);
    allowAggressive = false;
  }

  return {
    recommendedMaxPerRun: Math.max(1, Math.floor(maxPer)),
    recommendedMaxSetupsPerRun: Math.max(1, Math.floor(maxSetups)),
    recommendedMaxBarsPerSetup: Math.max(1, Math.floor(maxBars)),
    allowAggressiveReplay: allowAggressive,
  };
}

/**
 * Build full policy document (for replay_boost_policy.json).
 * @param {{ dataRoot: string, repoRoot: string, opsDir: string }} roots
 * @param {Partial<ReturnType<typeof parseReplayBoostPolicyEnv>>} [envOverride]
 */
function computeReplayBoostPolicy(roots, envOverride) {
  const inputs = loadInputsForPolicyBuild(roots);
  const envOpts = { ...parseReplayBoostPolicyEnv(), ...envOverride };
  const policyMode = resolvePolicyMode(inputs, envOpts);

  const baselineInputs = {
    strategyValidation: inputs.strategyValidation,
    strictMappingReport: inputs.strictMappingReport,
    setupAnalysis: inputs.setupAnalysis,
    lastRun: inputs.lastRun,
    promotedManifest: inputs.promotedManifest,
    latestSnapshot: inputs.latestSnapshot,
    governanceDashboard: inputs.governanceDashboard,
    convergenceTail: inputs.convergenceTail,
  };

  const rbOpts = {
    ...replayBoostPolicy.parseReplayBoostEnv(),
    baseMaxBarsFromEnv: envOpts.maxBarsPerSetup,
  };

  const computed = replayBoostPolicy.computeReplayBoostPriority(baselineInputs, rbOpts);
  const valMap = validationRowByStrategyId(inputs.strategyValidation);
  const manifestIds = manifestIdSet(inputs.promotedManifest);

  const globalControls = resolveReplayBudgetControls(policyMode, inputs, envOpts);
  const allocations = [];
  const w = envOpts;

  let boostedCount = 0;
  let neutralCount = 0;
  let throttledCount = 0;
  let frozenCount = 0;

  for (const row of computed.setups) {
    const valRow = valMap.get(row.setupId) || null;
    const scored = scoreReplayCandidate(row.setupId, valRow, row.replayPriorityScore, inputs, w);
    const ov = strictOverlapReplayBonus(inputs.strictMappingReport, row.setupId, manifestIds);
    const combined = clamp(scored.adjustedScore + ov.bonus, 0, 100);
    const { tier, adjustedScore } = mapScoreToTier(combined, policyMode, row.replayPriorityTier);

    if (tier === 'boosted') boostedCount += 1;
    else if (tier === 'neutral') neutralCount += 1;
    else if (tier === 'throttled') throttledCount += 1;
    else frozenCount += 1;

    let weight =
      tier === 'boosted' ? 0.95 : tier === 'neutral' ? 0.65 : tier === 'throttled' ? 0.35 : 0.05;
    if (policyMode === 'conservative' && tier === 'boosted') {
      weight = Math.min(weight, 0.78);
    }
    const maxBars =
      tier === 'frozen'
        ? 0
        : Math.max(
            1,
            Math.min(
              globalControls.recommendedMaxBarsPerSetup,
              Math.round(globalControls.recommendedMaxBarsPerSetup * weight)
            )
          );

    const metricsSnapshot = {
      strictScore: valRow && Number(valRow.score),
      learningScore: valRow && Number(valRow.learningScore),
      gap: valRow && valRow.gapScore != null ? Number(valRow.gapScore) : null,
      trades: valRow && Number(valRow.trades),
      profitFactor: valRow && Number(valRow.profitFactor),
      expectancy: valRow && Number(valRow.expectancy),
      promotedRecent: row.reasons.some((x) => String(x).includes('paper_recent')),
      notSeen7d: row.reasons.some((x) => String(x).includes('not_seen')),
      effectiveRecentOverlap: ov.inOverlap === true,
    };

    const reasonsOut = [
      ...scored.reasons.slice(0, 6),
      ...ov.reasons.slice(0, 4),
      ...row.reasons.slice(0, 5).map((r) => ({
        code: 'baseline_signal',
        message: String(r),
        value: null,
      })),
      { code: 'baseline_tier', message: 'Baseline replay boost tier', value: row.replayPriorityTier },
      { code: 'policy_mode', message: 'Active policy mode', value: policyMode },
    ];

    allocations.push({
      setupId: row.setupId,
      priorityTier: tier,
      replayBudgetWeight: weight,
      maxReplayBarsPerRun: maxBars,
      maxReplaySetupsShare: null,
      confidence: clamp(adjustedScore / 100, 0, 1),
      reasons: reasonsOut,
      metricsSnapshot,
      _executionTier: tierToExecutionABCD(tier),
      _baselineScore: row.replayPriorityScore,
    });
  }

  allocations.sort((a, b) => a.setupId.localeCompare(b.setupId));

  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    dataRoot: inputs.dataRoot,
    policyMode,
    inputs: {
      healthOverallStatus: (inputs.health && inputs.health.overallStatus) || null,
      incidentMode: (inputs.health && inputs.health.incidentMode) || null,
      circuitBreakerState: (inputs.circuitBreaker && inputs.circuitBreaker.state) || null,
      operatorLoopStatusLatest: (inputs.health && inputs.health.operatorLoopStatusLatest) || null,
      effectiveAppendedLatest: inputs.lastRun && inputs.lastRun.effectiveAppended,
      duplicateSkippedPersistentLatest: inputs.lastRun && inputs.lastRun.duplicateSkippedPersistent,
    },
    summary: {
      candidateCount: allocations.length,
      boostedCount,
      neutralCount,
      throttledCount,
      frozenCount,
    },
    allocations: allocations.map((a) => {
      const { _executionTier, _baselineScore, ...rest } = a;
      return rest;
    }),
    allocationsInternal: allocations,
    globalControls,
  };
}

/**
 * Strip internal keys for JSON write.
 */
function policyDocumentForWrite(doc) {
  const { allocationsInternal, ...rest } = doc;
  return rest;
}

/**
 * @param {string} policyPath absolute path to replay_boost_policy.json
 * @returns {object|null}
 */
function loadReplayBoostPolicy(policyPath) {
  const doc = readJsonSafe(policyPath);
  if (!doc || doc.schemaVersion !== POLICY_SCHEMA_VERSION) return null;
  if (!Array.isArray(doc.allocations)) return null;
  return doc;
}

/**
 * Build execution map compatible with replayBoostPolicy.orderSignalsForReplayBoostStable.
 * @param {object} policyDoc from loadReplayBoostPolicy
 * @param {{ baseMaxBarsFromEnv: number }} opts
 * @returns {{
 *   setupMap: Map<string, object>,
 *   getMaxBarsForSetup: (setupId: string) => number,
 *   effectiveMaxPerRun: number,
 *   effectiveMaxSetups: number,
 *   globalControls: object,
 *   policyMode: string
 * }}
 */
function executionRowsFromPolicy(policyDoc, opts) {
  const baseMax = Math.max(0, Math.floor(Number(opts.baseMaxBarsFromEnv) || 0));
  const gc = policyDoc.globalControls || {};
  const polMaxRun = Math.max(1, Number(gc.recommendedMaxPerRun) || 20);
  const polMaxSetups = Math.max(1, Number(gc.recommendedMaxSetupsPerRun) || 5);
  const envRun = Number(opts.promotedReplayMaxPerRunEnv);
  const envSetups = Number(opts.maxSetupsPerRunEnv);
  const effectiveMaxPerRun =
    Number.isFinite(envRun) && envRun > 0 ? Math.min(envRun, polMaxRun) : polMaxRun;
  const effectiveMaxSetups =
    Number.isFinite(envSetups) && envSetups > 0 ? Math.min(envSetups, polMaxSetups) : polMaxSetups;
  const setupMap = new Map();

  const internal = policyDoc.allocationsInternal || policyDoc.allocations;

  for (const a of internal) {
    const exTier = a._executionTier || tierToExecutionABCD(a.priorityTier);
    const maxBars = a.priorityTier === 'frozen' ? 0 : Math.max(0, Math.floor(Number(a.maxReplayBarsPerRun) || 0));
    const scoreForOrder =
      a.priorityTier === 'boosted'
        ? 90
        : a.priorityTier === 'neutral'
          ? 60
          : a.priorityTier === 'throttled'
            ? 35
            : 5;

    setupMap.set(a.setupId, {
      setupId: a.setupId,
      replayPriorityScore: scoreForOrder,
      replayPriorityTier: exTier,
      reasons: (a.reasons || []).map((r) => (typeof r === 'string' ? r : r.code || 'reason')),
      budgetAssigned: maxBars > 0 ? Math.min(maxBars, baseMax || maxBars) : 0,
      priorityTier: a.priorityTier,
      replayBudgetWeight: a.replayBudgetWeight,
    });
  }

  return {
    setupMap,
    getMaxBarsForSetup: (setupId) => {
      const row = setupMap.get(setupId);
      if (!row) return baseMax;
      return Math.max(0, Math.floor(Number(row.budgetAssigned) || 0));
    },
    effectiveMaxPerRun,
    effectiveMaxSetups,
    globalControls: gc,
    policyMode: policyDoc.policyMode || 'normal',
  };
}

/**
 * Allocations as built (internal) or as written to JSON (public allocations only).
 * @param {object|null} policyDoc
 * @returns {object[]}
 */
function getPolicyAllocationsArray(policyDoc) {
  if (!policyDoc) return [];
  if (Array.isArray(policyDoc.allocationsInternal)) return policyDoc.allocationsInternal;
  return Array.isArray(policyDoc.allocations) ? policyDoc.allocations : [];
}

/**
 * setupId -> allocation row (for smart replay policy integration).
 * @param {object|null} policyDoc
 * @returns {Map<string, object>}
 */
function buildPolicyRowBySetupMap(policyDoc) {
  const m = new Map();
  for (const a of getPolicyAllocationsArray(policyDoc)) {
    const id = a && a.setupId != null ? String(a.setupId).trim() : '';
    if (id) m.set(id, a);
  }
  return m;
}

/**
 * Conservative caps for replay selection: min(operator env, policy recommended), then harden
 * under circuit breaker / degraded health / non-aggressive policy. Does not replace env caps —
 * never exceeds what the operator set.
 * @param {{
 *   envMaxPerRun: number,
 *   envMaxSetups: number,
 *   envMaxBars: number,
 *   policyGlobalControls?: object|null,
 *   policyMode?: string|null,
 *   healthOverall?: string|null,
 *   circuitBreakerState?: string|null,
 * }} opts
 */
function mergeReplaySelectionGlobalCaps(opts) {
  const {
    envMaxPerRun,
    envMaxSetups,
    envMaxBars,
    policyGlobalControls,
    policyMode,
    healthOverall,
    circuitBreakerState,
  } = opts || {};

  let maxPerRun = Math.max(1, Math.floor(Number(envMaxPerRun) || 20));
  let maxSetups = Math.max(1, Math.floor(Number(envMaxSetups) || 5));
  let maxBars = Math.max(0, Math.floor(Number(envMaxBars) || 3));

  const gc = policyGlobalControls || {};
  const polRun = Number(gc.recommendedMaxPerRun);
  const polSetups = Number(gc.recommendedMaxSetupsPerRun);
  const polBars = Number(gc.recommendedMaxBarsPerSetup);

  if (Number.isFinite(polRun) && polRun > 0) maxPerRun = Math.min(maxPerRun, Math.floor(polRun));
  if (Number.isFinite(polSetups) && polSetups > 0) maxSetups = Math.min(maxSetups, Math.floor(polSetups));
  if (Number.isFinite(polBars) && polBars >= 0) maxBars = Math.min(maxBars, Math.floor(polBars));

  const mode = String(policyMode || 'normal').toLowerCase();
  const cb = String(circuitBreakerState || 'CLOSED').toUpperCase();
  if (mode === 'circuit_breaker' || cb === 'OPEN') {
    maxPerRun = Math.min(maxPerRun, 6);
    maxSetups = Math.min(maxSetups, 2);
    maxBars = Math.min(maxBars, 2);
  } else if (mode === 'degraded') {
    maxPerRun = Math.min(maxPerRun, 14);
    maxSetups = Math.min(maxSetups, 4);
  } else if (mode === 'conservative') {
    maxPerRun = Math.min(maxPerRun, 16);
    maxSetups = Math.min(maxSetups, 4);
  }

  const ho = String(healthOverall || 'OK').toUpperCase();
  if (['CRITICAL', 'DOWN'].includes(ho)) {
    maxPerRun = Math.min(maxPerRun, 8);
    maxSetups = Math.min(maxSetups, 2);
    maxBars = Math.min(maxBars, 2);
  } else if (['DEGRADED', 'STALLED', 'WATCH'].includes(ho)) {
    maxPerRun = Math.min(maxPerRun, 12);
    maxSetups = Math.min(maxSetups, 3);
  }

  if (gc.allowAggressiveReplay === false) {
    maxPerRun = Math.min(maxPerRun, 16);
    maxSetups = Math.min(maxSetups, 4);
    maxBars = Math.min(maxBars, 4);
  }

  return {
    recommendedMaxPerRun: Math.max(1, maxPerRun),
    recommendedMaxSetupsPerRun: Math.max(1, maxSetups),
    recommendedMaxBarsPerSetup: Math.max(0, maxBars),
  };
}

module.exports = {
  POLICY_SCHEMA_VERSION,
  parseReplayBoostPolicyEnv,
  loadInputsForPolicyBuild,
  loadReplayBoostPolicy,
  computeReplayBoostPolicy,
  scoreReplayCandidate,
  resolveReplayBudgetControls,
  resolvePolicyMode,
  executionRowsFromPolicy,
  policyDocumentForWrite,
  tierToExecutionABCD,
  mapScoreToTier,
  strictOverlapReplayBonus,
  getPolicyAllocationsArray,
  buildPolicyRowBySetupMap,
  mergeReplaySelectionGlobalCaps,
};
