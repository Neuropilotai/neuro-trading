'use strict';

/**
 * SMART ALLOWLIST V2 — scored, ranked, budget-aware candidate selection for
 * NEUROPILOT_PAPER_PROMOTED_REPLAY_SMART_ONLY=1.
 *
 * Optional: NP_SMART_REPLAY_POLICY_INTEGRATION_ENABLE=1 merges replay_boost_policy.json
 * as a bounded modulator on top of the native smart score (not an authority).
 * Optional: NP_AUTO_THROTTLE_ENABLE=1 merges governance/auto_throttle_policy.json
 * (PROTECT / NEUTRAL / THROTTLE / FROZEN) into the final replay score and per-setup bar caps.
 * Optional: NP_CAPITAL_ALLOCATION_ENABLE=1 merges governance/capital_allocation_policy.json
 * (CORE / ACTIVE / REDUCED / SUSPENDED) into the fused score, global replay factor, and per-setup bar caps (min with auto-throttle).
 *
 * Does not touch simulator, strict mapping generation, or paper_trades.jsonl format.
 * Deterministic; no randomness.
 */

const fs = require('fs');
const path = require('path');

const replayBoostPolicyCore = require('./replayBoostPolicyCore');
const autoThrottlePolicyCore = require('./autoThrottlePolicyCore');
const capitalAllocationPolicyCore = require('./capitalAllocationPolicyCore');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function resolveOpsSnapshotDir() {
  const e = process.env.NEUROPILOT_OPS_SNAPSHOT_DIR;
  if (e && String(e).trim()) return path.resolve(String(e).trim());
  return path.join(REPO_ROOT, 'ops-snapshot');
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function envNumDefault(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}

function getReplaySetupKey(signal) {
  if (!signal || typeof signal !== 'object') return '';
  return String(signal.setupId || signal.strategyId || '').trim();
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

function collectPromotedManifestSetupKeys(signals) {
  const set = new Set();
  for (const s of signals || []) {
    if (!s || s.signalSource !== 'promoted_manifest') continue;
    const k = getReplaySetupKey(s);
    if (k) set.add(k);
  }
  return set;
}

function signalAlignHintsBySetup(signals) {
  const m = new Map();
  for (const s of signals || []) {
    if (!s || s.signalSource !== 'promoted_manifest') continue;
    const k = getReplaySetupKey(s);
    if (!k) continue;
    const prev = m.get(k) || { aligned: false };
    if (s.entryAtBarClose === true) prev.aligned = true;
    m.set(k, prev);
  }
  return m;
}

function strictTier1Keys(strictDoc) {
  const s = new Set();
  const t1 = strictDoc && Array.isArray(strictDoc.promoted_not_seen_in_paper_last_7d)
    ? strictDoc.promoted_not_seen_in_paper_last_7d
    : [];
  for (const row of t1) {
    const k = row && row.setupKey != null ? String(row.setupKey).trim() : '';
    if (k) s.add(k);
  }
  return s;
}

function strictRecentOverlapKeys(strictDoc) {
  const s = new Set();
  const rows = strictDoc && Array.isArray(strictDoc.promoted_and_paper_recent)
    ? strictDoc.promoted_and_paper_recent
    : [];
  for (const row of rows) {
    const k = row && row.setupKey != null ? String(row.setupKey).trim() : '';
    if (k) s.add(k);
  }
  return s;
}

function loadHealthAndCircuit(opsDir) {
  const health = readJsonSafe(path.join(opsDir, 'neuropilot_health.json')) || {};
  const cb = readJsonSafe(path.join(opsDir, 'circuit_breaker_status.json')) || {};
  return {
    health,
    circuitBreaker: cb,
    healthOverall: health.overallStatus != null ? String(health.overallStatus) : null,
    circuitState: cb.state != null ? String(cb.state) : null,
  };
}

function loadSmartReplayPolicyTierEnv() {
  const sg = process.env.NP_SMART_REPLAY_POLICY_STRICT_GUARD_ENABLE;
  const df = process.env.NP_SMART_REPLAY_POLICY_DROP_FROZEN_STRICT;
  return {
    boostedBonus: envNumDefault('NP_SMART_REPLAY_POLICY_BOOSTED_BONUS', 18),
    neutralBonus: envNumDefault('NP_SMART_REPLAY_POLICY_NEUTRAL_BONUS', 3),
    throttledPenalty: envNumDefault('NP_SMART_REPLAY_POLICY_THROTTLED_PENALTY', 15),
    frozenPenalty: envNumDefault('NP_SMART_REPLAY_POLICY_FROZEN_PENALTY', 45),
    confidenceWeight: envNumDefault('NP_SMART_REPLAY_POLICY_CONFIDENCE_WEIGHT', 10),
    strictGuard:
      sg == null || sg === ''
        ? true
        : !['0', 'false', 'no', 'off'].includes(String(sg).trim().toLowerCase()),
    dropFrozenStrict:
      df == null || df === ''
        ? true
        : !['0', 'false', 'no', 'off'].includes(String(df).trim().toLowerCase()),
    strictGuardFloor: envNumDefault('NP_SMART_REPLAY_POLICY_STRICT_GUARD_FLOOR', 45),
  };
}

function normalizePriorityTier(t) {
  const s = String(t || 'neutral').trim().toLowerCase();
  if (['boosted', 'neutral', 'throttled', 'frozen'].includes(s)) return s;
  return 'neutral';
}

/**
 * Policy-derived adjustment (bounded). Does not replace smart base score.
 */
function computePolicyReplayAdjustment(policyRow, tierEnv, ctx) {
  const codes = [];
  if (!policyRow) return { adj: 0, codes, policyTier: null, weightMul: 1 };

  const tier = normalizePriorityTier(policyRow.priorityTier);
  const conf = clamp(Number(policyRow.confidence) || 0, 0, 1);
  const w = Number(policyRow.replayBudgetWeight);
  const weightMul = Number.isFinite(w) ? clamp(w, 0.85, 1.1) : 1;

  let adj = 0;
  if (tier === 'boosted') {
    adj = tierEnv.boostedBonus + clamp(conf * tierEnv.confidenceWeight, 0, 10);
    codes.push('boosted_bonus');
    if (
      tierEnv.strictGuard &&
      Number.isFinite(ctx.strictScore) &&
      ctx.strictScore < tierEnv.strictGuardFloor
    ) {
      const cap = tierEnv.neutralBonus + 2;
      if (adj > cap) {
        adj = cap;
        codes.push('strict_guard_cap_boosted');
      }
    }
  } else if (tier === 'neutral') {
    adj = tierEnv.neutralBonus;
    codes.push('neutral_small');
  } else if (tier === 'throttled') {
    adj = -Math.abs(tierEnv.throttledPenalty);
    codes.push('throttled_penalty');
  } else if (tier === 'frozen') {
    adj = -Math.abs(tierEnv.frozenPenalty);
    codes.push('frozen_penalty');
  }

  adj *= weightMul;

  const pm = String(ctx.policyMode || 'normal').toLowerCase();
  if (pm === 'circuit_breaker' || pm === 'degraded') {
    if (adj > 0) adj *= 0.5;
    else adj *= 1.1;
    codes.push('policy_mode_dampen_positive_or_amplify_negative');
  }

  if (ctx.duplicateRiskHigh) {
    adj -= 5;
    codes.push('dup_pressure_extra');
  }
  if (ctx.wasRecentlyReplayed && ctx.baseScore < 55) {
    adj -= 3;
    codes.push('replay_recent_low_base');
  }

  return {
    adj: Math.round(adj * 100) / 100,
    codes,
    policyTier: tier,
    weightMul,
  };
}

function computeSystemReplayAdjustment(healthOverall, circuitState) {
  let adj = 0;
  const ho = String(healthOverall || 'OK').toUpperCase();
  if (['CRITICAL', 'DOWN'].includes(ho)) adj -= 10;
  else if (['DEGRADED', 'STALLED', 'WATCH'].includes(ho)) adj -= 5;
  if (String(circuitState || 'CLOSED').toUpperCase() === 'OPEN') adj -= 6;
  return adj;
}

function klassFromFinalScore(score) {
  let klass = 'LOW';
  if (score >= 70) klass = 'HIGH';
  else if (score >= 50) klass = 'MEDIUM';
  return klass;
}

/**
 * @param {object} ctx
 * @returns {{ score: number, klass: 'HIGH'|'MEDIUM'|'LOW' }}
 */
function computeSmartReplayScore(ctx) {
  const row = ctx.valRow;
  const strictScore = row && Number(row.score);
  const learningScore = row && Number(row.learningScore);
  let gap = 0;
  if (row && row.gap != null && Number.isFinite(Number(row.gap))) gap = Number(row.gap);
  else if (row && row.strictVsLearningGap != null && Number.isFinite(Number(row.strictVsLearningGap))) {
    gap = Number(row.strictVsLearningGap);
  }

  let score = 0;
  if (Number.isFinite(strictScore)) score += clamp(strictScore * 0.4, 0, 40);
  if (Number.isFinite(learningScore)) score += clamp(learningScore * 0.3, 0, 30);
  score += clamp(gap * 0.2, -15, 15);

  const tier = row && String(row.tier || '').trim();
  if (tier === 'promote_candidate') {
    score += 20;
  } else if (
    tier &&
    tier !== 'reject' &&
    row &&
    String(row.learningTier || '') === 'strong_potential'
  ) {
    score += 10;
  }

  if (ctx.inRecentOverlap) score += 5;
  if (ctx.recentAlignHint) score += 10;

  if (ctx.wasRecentlyReplayed) score -= 15;
  if (ctx.duplicateRiskHigh) score -= 20;

  score -= clamp((ctx.usageCountLastRuns || 0) * 5, 0, 25);

  score = clamp(score, 0, 100);

  let klass = 'LOW';
  if (score >= 70) klass = 'HIGH';
  else if (score >= 50) klass = 'MEDIUM';

  return { score, klass };
}

function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.setupKey.localeCompare(b.setupKey);
}

/**
 * @param {{ setupKey: string, score: number, klass: string }[]} scoredRows
 * @param {number} maxSetups
 */
function selectSmartReplayCandidates(scoredRows, maxSetups) {
  const cap = Math.max(1, Math.floor(Number(maxSetups) || 5));
  const high = scoredRows.filter((r) => r.klass === 'HIGH').sort(compareCandidates);
  const med = scoredRows.filter((r) => r.klass === 'MEDIUM').sort(compareCandidates);
  const low = scoredRows.filter((r) => r.klass === 'LOW').sort(compareCandidates);

  const selected = [];
  for (const r of high) {
    if (selected.length >= cap) break;
    selected.push({ ...r, pickReason: 'HIGH_PRIORITY' });
  }
  for (const r of med) {
    if (selected.length >= cap) break;
    selected.push({ ...r, pickReason: 'MEDIUM_FILL' });
  }
  for (const r of low) {
    if (selected.length >= cap) break;
    selected.push({ ...r, pickReason: 'LOW_FILL' });
  }

  const selectedKeys = new Set(selected.map((r) => r.setupKey));
  const dropped = scoredRows
    .filter((r) => !selectedKeys.has(r.setupKey))
    .map((r) => ({
      setupKey: r.setupKey,
      score: r.score,
      klass: r.klass,
      reason: 'below_selection_cut',
    }));

  const n = scoredRows.length;
  const avgScore = n > 0 ? scoredRows.reduce((a, r) => a + r.score, 0) / n : 0;
  const stats = {
    candidates: n,
    selected: selected.length,
    dropped: dropped.length,
    avgScore: Math.round(avgScore * 100) / 100,
    high: scoredRows.filter((r) => r.klass === 'HIGH').length,
    medium: scoredRows.filter((r) => r.klass === 'MEDIUM').length,
    low: scoredRows.filter((r) => r.klass === 'LOW').length,
  };

  return { selected, dropped, stats };
}

function compareCandidatesFusion(a, b) {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
  const bs = Number.isFinite(b.strictScore) ? b.strictScore : -1;
  const as = Number.isFinite(a.strictScore) ? a.strictScore : -1;
  if (bs !== as) return bs - as;
  return a.setupKey.localeCompare(b.setupKey);
}

function resolveSelectionModeLabel(policyIntegrated, autoThrottleIntegrated, capitalIntegrated) {
  const c = Boolean(capitalIntegrated);
  const p = Boolean(policyIntegrated);
  const a = Boolean(autoThrottleIntegrated);
  if (p && a && c) return 'smart_plus_policy_auto_capital';
  if (p && c) return 'smart_plus_policy_capital';
  if (a && c) return 'smart_plus_auto_capital';
  if (c) return 'smart_plus_capital';
  if (p && a) return 'smart_plus_policy_auto';
  if (p) return 'smart_plus_policy';
  if (a) return 'smart_plus_auto';
  return 'smart_only';
}

/**
 * Sort by finalReplayScore, strict score, setupKey; take top cap.
 */
function selectSmartReplayCandidatesFusion(enrichedRows, maxSetups) {
  const cap = Math.max(1, Math.floor(Number(maxSetups) || 5));
  const sorted = enrichedRows.slice().sort(compareCandidatesFusion);
  const selected = sorted.slice(0, cap).map((r) => ({
    setupKey: r.setupKey,
    score: r.finalScore,
    klass: r.klass,
    pickReason: 'FUSION_RANK',
    baseScore: r.baseScore,
    policyAdj: r.policyAdj,
    autoThrottleAdj: r.autoThrottleAdj != null ? r.autoThrottleAdj : 0,
    capitalAllocationAdj: r.capitalAllocationAdj != null ? r.capitalAllocationAdj : 0,
    systemAdj: r.systemAdj,
    finalScore: r.finalScore,
    policyTier: r.policyTier,
    autoDecision: r.autoDecision != null ? r.autoDecision : null,
    capitalBucket: r.capitalBucket != null ? r.capitalBucket : null,
    strictScore: r.strictScore,
  }));

  const selectedKeys = new Set(selected.map((r) => r.setupKey));
  const dropped = sorted
    .filter((r) => !selectedKeys.has(r.setupKey))
    .map((r) => ({
      setupKey: r.setupKey,
      score: r.finalScore,
      klass: r.klass,
      reason: 'below_fusion_rank',
      baseScore: r.baseScore,
      policyAdj: r.policyAdj,
      autoThrottleAdj: r.autoThrottleAdj != null ? r.autoThrottleAdj : 0,
      capitalAllocationAdj: r.capitalAllocationAdj != null ? r.capitalAllocationAdj : 0,
      systemAdj: r.systemAdj,
      policyTier: r.policyTier,
      autoDecision: r.autoDecision != null ? r.autoDecision : null,
      capitalBucket: r.capitalBucket != null ? r.capitalBucket : null,
    }));

  const n = enrichedRows.length;
  const avgBase =
    n > 0 ? enrichedRows.reduce((a, r) => a + r.baseScore, 0) / n : 0;
  const avgFinal = n > 0 ? enrichedRows.reduce((a, r) => a + r.finalScore, 0) / n : 0;
  const stats = {
    candidates: n,
    selected: selected.length,
    dropped: dropped.length,
    avgScore: Math.round(avgFinal * 100) / 100,
    avgBaseScore: Math.round(avgBase * 100) / 100,
    avgFinalScore: Math.round(avgFinal * 100) / 100,
    high: enrichedRows.filter((r) => r.klass === 'HIGH').length,
    medium: enrichedRows.filter((r) => r.klass === 'MEDIUM').length,
    low: enrichedRows.filter((r) => r.klass === 'LOW').length,
  };

  return { selected, dropped, stats };
}

function tallyHistogram(codesList) {
  const h = {};
  for (const codes of codesList) {
    for (const c of codes || []) {
      h[c] = (h[c] || 0) + 1;
    }
  }
  return h;
}

/**
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {object[]} opts.signals
 * @param {number} opts.maxSetupsPerRun
 * @param {number} [opts.maxBarsPerSetup]
 * @param {number} [opts.promotedReplayMaxPerRun]
 * @param {boolean} opts.requireNotSeen7d
 * @param {object|null} opts.strictDoc — optional preloaded strict mapping
 * @param {object|null} [opts.policyDoc] — replay_boost_policy.json (validated)
 * @param {boolean} [opts.policyIntegrationEnabled]
 * @param {object|null} [opts.autoThrottleDoc]
 * @param {boolean} [opts.autoThrottleIntegrationEnabled]
 * @param {boolean} [opts.capitalAllocationIntegrationEnabled]
 * @returns {object|null} null if nothing to do
 */
function buildSmartReplaySelectionV2(opts) {
  const dataRoot = opts.dataRoot;
  const signals = opts.signals || [];
  const maxSetupsPerRun = opts.maxSetupsPerRun;
  const maxBarsPerSetup = Math.max(0, Math.floor(Number(opts.maxBarsPerSetup) || 3));
  const promotedReplayMaxPerRun = Math.max(1, Math.floor(Number(opts.promotedReplayMaxPerRun) || 20));
  const requireNotSeen7d = Boolean(opts.requireNotSeen7d);
  const policyIntegrationRequested = Boolean(opts.policyIntegrationEnabled);
  let policyDoc = opts.policyDoc || null;
  if (policyIntegrationRequested && !policyDoc) {
    const p = path.join(dataRoot, 'governance', 'replay_boost_policy.json');
    policyDoc = replayBoostPolicyCore.loadReplayBoostPolicy(p);
  }

  const policyAllocations = policyDoc ? replayBoostPolicyCore.getPolicyAllocationsArray(policyDoc) : [];
  const policyIntegrated =
    policyIntegrationRequested &&
    Boolean(policyDoc && Array.isArray(policyAllocations) && policyAllocations.length > 0);

  const autoThrottleRequested = Boolean(opts.autoThrottleIntegrationEnabled);
  let autoThrottleDoc = opts.autoThrottleDoc || null;
  if (autoThrottleRequested && !autoThrottleDoc) {
    const ap = path.join(dataRoot, 'governance', 'auto_throttle_policy.json');
    autoThrottleDoc = autoThrottlePolicyCore.loadAutoThrottlePolicy(ap);
  }
  const autoAllocations =
    autoThrottleDoc && Array.isArray(autoThrottleDoc.allocations) ? autoThrottleDoc.allocations : [];
  const autoThrottleIntegrated =
    autoThrottleRequested &&
    Boolean(autoThrottleDoc && autoAllocations.length > 0);

  const capitalAllocationRequested = Boolean(opts.capitalAllocationIntegrationEnabled);
  let capitalDoc = opts.capitalAllocationDoc || null;
  if (capitalAllocationRequested && !capitalDoc) {
    const cp = path.join(dataRoot, 'governance', 'capital_allocation_policy.json');
    capitalDoc = capitalAllocationPolicyCore.loadCapitalAllocationPolicy(cp);
  }
  const capitalAllocations =
    capitalDoc && Array.isArray(capitalDoc.allocations) ? capitalDoc.allocations : [];
  const capitalIntegrated =
    capitalAllocationRequested &&
    Boolean(capitalDoc && capitalAllocations.length > 0);

  const useFusion = policyIntegrated || autoThrottleIntegrated || capitalIntegrated;

  const policyMode = policyIntegrated ? String(policyDoc.policyMode || 'normal') : null;
  const autoThrottlePolicyMode =
    autoThrottleIntegrated ? String(autoThrottleDoc.policyMode || 'normal') : null;
  const capitalAllocationPolicyMode =
    capitalIntegrated ? String(capitalDoc.policyMode || 'normal') : null;
  const capitalOpts = capitalAllocationPolicyCore.parseCapitalAllocationEnv();
  const tierEnv = loadSmartReplayPolicyTierEnv();
  const opsDir = resolveOpsSnapshotDir();
  const { healthOverall, circuitState } = loadHealthAndCircuit(opsDir);

  const systemAdjGlobal = computeSystemReplayAdjustment(healthOverall, circuitState);

  let mergedGlobalCaps = null;
  let globalControlsApplied = null;
  if (policyIntegrated) {
    mergedGlobalCaps = replayBoostPolicyCore.mergeReplaySelectionGlobalCaps({
      envMaxPerRun: promotedReplayMaxPerRun,
      envMaxSetups: maxSetupsPerRun,
      envMaxBars: maxBarsPerSetup,
      policyGlobalControls: policyDoc.globalControls || {},
      policyMode,
      healthOverall,
      circuitBreakerState: circuitState,
    });
    globalControlsApplied = {
      ...mergedGlobalCaps,
      source: 'min_env_and_policy_recommended_then_health_cb_hardening',
      policyAllowAggressive:
        policyDoc.globalControls && policyDoc.globalControls.allowAggressiveReplay,
    };
  }

  const universe = collectPromotedManifestSetupKeys(signals);
  const govDir = path.join(dataRoot, 'governance');
  const strictPath = path.join(govDir, 'paper_trades_strict_mapping_report.json');
  const strictDoc = opts.strictDoc || readJsonSafe(strictPath) || {};
  const tier1Keys = strictTier1Keys(strictDoc);

  const logLines = [];

  const emptyStats = {
    candidates: 0,
    selected: 0,
    dropped: 0,
    avgScore: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  if (universe.size === 0) {
    const obs = buildObservability({
      smartReplayV2Enabled: true,
      policyIntegrated: false,
      policyModeRequested: policyIntegrationRequested,
      policyMode,
      stats: emptyStats,
      mergedGlobalCaps,
      globalControlsApplied,
      tierEnv,
      healthOverall,
      circuitState,
      frozenExcluded: 0,
      frozenDropped: 0,
      throttledDropped: 0,
      boostedSelected: 0,
      neutralSelected: 0,
      topSelected: [],
      histogram: {},
      selectionMode: 'no_candidates',
      systemAdjGlobal,
      autoThrottleRequested: false,
      autoThrottleIntegrated: false,
      autoThrottlePolicyMode: null,
      autoThrottlePolicyGeneratedAt: null,
      autoThrottleProtectSeen: 0,
      autoThrottleThrottleSeen: 0,
      autoThrottleFrozenSeen: 0,
      autoThrottleFrozenDropped: 0,
      autoThrottleReducedBudgetCount: 0,
      autoHistogram: {},
      capitalAllocationRequested: Boolean(opts.capitalAllocationIntegrationEnabled),
      capitalIntegrated: false,
      capitalAllocationPolicyMode: null,
      capitalAllocationPolicyGeneratedAt: null,
      capitalAllocationCoreSeen: 0,
      capitalAllocationActiveSeen: 0,
      capitalAllocationReducedSeen: 0,
      capitalAllocationSuspendedSeen: 0,
      capitalAllocationReducedBudgetCount: 0,
      capitalAllocationSuspendedDropped: 0,
      capitalAllocationGlobalControlsApplied: null,
      capitalAllocationConcentrationRisk: null,
      capitalHistogram: {},
    });
    return {
      selectedSetupKeys: new Set(),
      selectedReasonBySetupKey: new Map(),
      scoreBySetup: new Map(),
      classBySetup: new Map(),
      tier1Keys,
      stats: emptyStats,
      dropped: [],
      selectedDetail: [],
      mergedGlobalCaps,
      smartReplayObservability: obs,
      selectionLogLines: logLines,
      replayBarsCapBySetup: new Map(),
      capitalAllocationGlobalReplayFactor: null,
    };
  }

  let keys = Array.from(universe);
  if (requireNotSeen7d) {
    keys = keys.filter((k) => tier1Keys.has(k));
  }

  const validationDoc = readJsonSafe(path.join(opsDir, 'strategy_validation.json'));
  const valMap = validationRowByStrategyId(validationDoc);

  const lastRunPath = path.join(govDir, 'paper_exec_v1_last_run.json');
  const lastRun = readJsonSafe(lastRunPath) || {};
  const barsBy =
    lastRun.promotedReplayBarsBySetup && typeof lastRun.promotedReplayBarsBySetup === 'object'
      ? lastRun.promotedReplayBarsBySetup
      : {};
  const globalDup = Number(lastRun.duplicateSkippedPersistent) || 0;

  const alignHints = signalAlignHintsBySetup(signals);
  const recentKeys = strictRecentOverlapKeys(strictDoc);
  const policyMap = policyIntegrated ? replayBoostPolicyCore.buildPolicyRowBySetupMap(policyDoc) : new Map();
  const autoMap = autoThrottleIntegrated
    ? autoThrottlePolicyCore.buildAutoThrottleRowBySetupMap(autoThrottleDoc)
    : new Map();
  const autoOpts = autoThrottlePolicyCore.parseAutoThrottleEnv();
  const capitalMap = capitalIntegrated
    ? capitalAllocationPolicyCore.buildCapitalAllocationRowBySetupMap(capitalDoc)
    : new Map();

  let frozenExcluded = 0;
  const policyCodeLists = [];

  let autoThrottleProtectSeen = 0;
  let autoThrottleThrottleSeen = 0;
  let autoThrottleFrozenSeen = 0;
  let autoFrozenExcluded = 0;
  const autoThrottleBarsBySetup = new Map();
  const capitalAllocationBarsBySetup = new Map();
  const autoCodeLists = [];
  const capitalCodeLists = [];

  let capitalAllocationCoreSeen = 0;
  let capitalAllocationActiveSeen = 0;
  let capitalAllocationReducedSeen = 0;
  let capitalAllocationSuspendedSeen = 0;
  let capitalAllocationReducedBudgetCount = 0;
  let capitalStrictSuspendExcluded = 0;

  for (const k of keys) {
    const crow = capitalMap.get(k);
    if (crow) {
      const b = String(crow.bucket || '').toUpperCase();
      if (b === 'CORE') capitalAllocationCoreSeen += 1;
      else if (b === 'ACTIVE') capitalAllocationActiveSeen += 1;
      else if (b === 'REDUCED') capitalAllocationReducedSeen += 1;
      else if (b === 'SUSPENDED') capitalAllocationSuspendedSeen += 1;
    }
  }

  for (const k of keys) {
    const row = autoMap.get(k);
    if (!row) continue;
    const d = String(row.decision || '').toUpperCase();
    if (d === 'PROTECT') autoThrottleProtectSeen += 1;
    else if (d === 'THROTTLE') autoThrottleThrottleSeen += 1;
    else if (d === 'FROZEN') autoThrottleFrozenSeen += 1;
  }

  const modeLabel = resolveSelectionModeLabel(
    policyIntegrated,
    autoThrottleIntegrated,
    capitalIntegrated
  );
  if (policyIntegrated) {
    logLines.push(
      `smart_replay mode=${modeLabel} candidates_universe=${keys.length} replay_policy_mode=${policyMode || 'unknown'} replay_policy_integrated=true`
    );
  } else if (policyIntegrationRequested && !policyDoc) {
    logLines.push(
      'smart_replay replay_policy_integrated=false reason=policy_missing_or_invalid'
    );
  } else if (policyIntegrationRequested && policyDoc && policyAllocations.length === 0) {
    logLines.push(
      'smart_replay replay_policy_integrated=false reason=policy_allocations_empty'
    );
  }
  if (autoThrottleIntegrated) {
    logLines.push(
      `[paper_exec_v1] auto_throttle mode=${autoThrottlePolicyMode || 'unknown'} protect=${autoThrottleProtectSeen} throttle=${autoThrottleThrottleSeen} frozen=${autoThrottleFrozenSeen} integrated=true`
    );
  } else if (autoThrottleRequested && !autoThrottleDoc) {
    logLines.push('[paper_exec_v1] auto_throttle integrated=false reason=policy_missing_or_invalid');
  } else if (autoThrottleRequested && autoAllocations.length === 0) {
    logLines.push('[paper_exec_v1] auto_throttle integrated=false reason=allocations_empty');
  }
  if (capitalIntegrated) {
    logLines.push(
      `[paper_exec_v1] capital_allocation mode=${capitalAllocationPolicyMode || 'unknown'} core=${capitalAllocationCoreSeen} active=${capitalAllocationActiveSeen} reduced=${capitalAllocationReducedSeen} suspended=${capitalAllocationSuspendedSeen} integrated=true`
    );
    if (capitalDoc.concentrationRisk) {
      const cr = capitalDoc.concentrationRisk;
      logLines.push(
        `[paper_exec_v1] capital_allocation concentration family=${cr.topFamily || 'n/a'} market=${cr.topMarket || 'n/a'} action=conservative_caps`
      );
    }
  } else if (capitalAllocationRequested && !capitalDoc) {
    logLines.push('[paper_exec_v1] capital_allocation integrated=false reason=policy_missing_or_invalid');
  } else if (capitalAllocationRequested && capitalAllocations.length === 0) {
    logLines.push('[paper_exec_v1] capital_allocation integrated=false reason=allocations_empty');
  }

  if (!policyIntegrated && !autoThrottleIntegrated && !capitalIntegrated) {
    logLines.push('smart_replay mode=smart_only replay_policy_integrated=false');
  }

  const enrichedRows = [];
  const scoredRowsLegacy = [];

  for (const setupKey of keys.sort((a, b) => a.localeCompare(b))) {
    const valRow = valMap.get(setupKey) || null;
    const strictS = valRow && Number(valRow.score);
    const usageCountLastRuns = Number(barsBy[setupKey]) || 0;
    const wasRecentlyReplayed = usageCountLastRuns > 0;
    const duplicateRiskHigh = globalDup > 500 && Number.isFinite(strictS) && strictS < 55;

    const hint = alignHints.get(setupKey);
    const recentAlignHint = Boolean(hint && hint.aligned === true);

    const baseCtx = {
      valRow,
      inRecentOverlap: recentKeys.has(setupKey),
      recentAlignHint,
      wasRecentlyReplayed,
      duplicateRiskHigh,
      usageCountLastRuns,
    };

    const { score: baseScore, klass: baseKlass } = computeSmartReplayScore(baseCtx);

    let policyAdj = 0;
    let policyTier = null;
    if (policyIntegrated) {
      const policyRow = policyMap.get(setupKey) || null;
      const pt = policyRow ? normalizePriorityTier(policyRow.priorityTier) : null;
      if (tierEnv.dropFrozenStrict && pt === 'frozen') {
        frozenExcluded += 1;
        logLines.push(
          `smart_replay dropped strategyId=${setupKey} tier=frozen base=${baseScore} final=n/a reason=drop_frozen_strict`
        );
        continue;
      }

      const pr = computePolicyReplayAdjustment(policyRow, tierEnv, {
        strictScore: strictS,
        policyMode,
        duplicateRiskHigh,
        wasRecentlyReplayed,
        baseScore,
      });
      policyAdj = pr.adj;
      policyTier = pr.policyTier || (policyRow ? normalizePriorityTier(policyRow.priorityTier) : null);
      policyCodeLists.push(pr.codes);
    }

    let autoThrottleAdj = 0;
    let autoDecision = null;
    if (autoThrottleIntegrated) {
      const arow = autoMap.get(setupKey) || null;
      const ar = autoThrottlePolicyCore.computeAutoThrottleAdjustment(arow, autoOpts);
      autoThrottleAdj = ar.adj;
      autoDecision = ar.decision;
      autoCodeLists.push(ar.codes);
      if (arow && arow.recommendedMaxBarsPerSetup != null) {
        autoThrottleBarsBySetup.set(
          setupKey,
          Math.max(0, Math.floor(Number(arow.recommendedMaxBarsPerSetup)))
        );
      }
      if (autoOpts.strictFreeze && ar.decision === 'FROZEN') {
        autoFrozenExcluded += 1;
        logLines.push(
          `[paper_exec_v1] auto_throttle dropped strategyId=${setupKey} decision=FROZEN reason=strict_freeze_active base=${baseScore}`
        );
        continue;
      }
    }

    let capitalAllocationAdj = 0;
    let capitalBucket = null;
    if (capitalIntegrated) {
      const crow = capitalMap.get(setupKey) || null;
      const ca = capitalAllocationPolicyCore.computeCapitalAllocationAdjustment(
        crow,
        { setupKey, valRow },
        capitalOpts
      );
      capitalAllocationAdj = ca.adj;
      capitalBucket = ca.bucket;
      capitalCodeLists.push(ca.codes);
      if (crow && crow.recommendedMaxBarsPerSetup != null) {
        const cb = Math.max(0, Math.floor(Number(crow.recommendedMaxBarsPerSetup)));
        capitalAllocationBarsBySetup.set(setupKey, cb);
        if (cb < maxBarsPerSetup) capitalAllocationReducedBudgetCount += 1;
      }
      if (capitalOpts.strictSuspend && ca.bucket === 'SUSPENDED') {
        capitalStrictSuspendExcluded += 1;
        logLines.push(
          `[paper_exec_v1] capital_allocation dropped strategyId=${setupKey} bucket=SUSPENDED reason=strict_suspend_active`
        );
        continue;
      }
    }

    const systemAdj = systemAdjGlobal;

    if (useFusion) {
      const finalScore = clamp(
        baseScore + policyAdj + autoThrottleAdj + capitalAllocationAdj + systemAdj,
        0,
        100
      );
      const klass = klassFromFinalScore(finalScore);
      enrichedRows.push({
        setupKey,
        baseScore,
        baseKlass,
        policyAdj,
        autoThrottleAdj,
        capitalAllocationAdj,
        systemAdj,
        finalScore,
        klass,
        strictScore: Number.isFinite(strictS) ? strictS : null,
        policyTier,
        policyRowPresent: policyIntegrated && Boolean(policyMap.get(setupKey)),
        autoDecision,
        capitalBucket,
      });
    } else {
      scoredRowsLegacy.push({ setupKey, score: baseScore, klass: baseKlass });
    }
  }

  let selected;
  let dropped;
  let stats;

  let capitalSuspendedFusionDropped = 0;

  if (useFusion) {
    let fusionMaxSetups = maxSetupsPerRun;
    if (capitalIntegrated && capitalDoc.globalControls) {
      const share = Number(capitalDoc.globalControls.recommendedMaxSetupShare);
      if (Number.isFinite(share) && share > 0 && share <= 1) {
        fusionMaxSetups = Math.min(
          maxSetupsPerRun,
          Math.max(1, Math.floor(keys.length * share))
        );
      }
    }
    const sel = selectSmartReplayCandidatesFusion(enrichedRows, fusionMaxSetups);
    selected = sel.selected;
    dropped = sel.dropped;
    stats = sel.stats;

    for (const r of dropped) {
      if (String(r.capitalBucket || '').toUpperCase() === 'SUSPENDED') {
        capitalSuspendedFusionDropped += 1;
      }
    }

    for (const r of selected) {
      logLines.push(
        `smart_replay selected strategyId=${r.setupKey} tier=${r.policyTier || 'n/a'} auto=${r.autoDecision || 'n/a'} capital=${r.capitalBucket || 'n/a'} base=${r.baseScore} adj_policy=${r.policyAdj} adj_auto=${r.autoThrottleAdj} adj_capital=${r.capitalAllocationAdj != null ? r.capitalAllocationAdj : 0} adj_sys=${r.systemAdj} final=${r.finalScore}`
      );
    }
    for (const r of dropped.slice(0, 30)) {
      logLines.push(
        `smart_replay dropped strategyId=${r.setupKey} tier=${r.policyTier || 'n/a'} auto=${r.autoDecision || 'n/a'} base=${r.baseScore} final=${r.score} reason=${r.reason}`
      );
    }
  } else {
    const sel = selectSmartReplayCandidates(scoredRowsLegacy, maxSetupsPerRun);
    selected = sel.selected;
    dropped = sel.dropped;
    stats = sel.stats;
  }

  let autoThrottleReducedBudgetCount = 0;
  for (const [, b] of autoThrottleBarsBySetup) {
    if (b < maxBarsPerSetup) autoThrottleReducedBudgetCount += 1;
  }

  const replayBarsCapBySetup = new Map();
  for (const sk of keys.sort((a, b) => a.localeCompare(b))) {
    let c = maxBarsPerSetup;
    if (autoThrottleBarsBySetup.has(sk)) c = Math.min(c, autoThrottleBarsBySetup.get(sk));
    if (capitalAllocationBarsBySetup.has(sk)) c = Math.min(c, capitalAllocationBarsBySetup.get(sk));
    if (c < maxBarsPerSetup) replayBarsCapBySetup.set(sk, c);
  }

  if (capitalIntegrated) {
    let capitalReducedLogN = 0;
    for (const sk of keys.sort((a, b) => a.localeCompare(b))) {
      if (!capitalAllocationBarsBySetup.has(sk)) continue;
      const merged = replayBarsCapBySetup.has(sk) ? replayBarsCapBySetup.get(sk) : maxBarsPerSetup;
      if (merged < maxBarsPerSetup && capitalReducedLogN < 15) {
        logLines.push(
          `[paper_exec_v1] capital_allocation reduced_budget strategyId=${sk} bars=${merged}`
        );
        capitalReducedLogN += 1;
      }
    }
  }

  const capitalAllocationSuspendedDropped =
    capitalStrictSuspendExcluded + capitalSuspendedFusionDropped;

  const selectedSetupKeys = new Set(selected.map((r) => r.setupKey));
  const selectedReasonBySetupKey = new Map();
  const scoreBySetup = new Map();
  const classBySetup = new Map();

  for (const r of useFusion ? enrichedRows : scoredRowsLegacy) {
    const sk = r.setupKey;
    const fs = useFusion ? r.finalScore : r.score;
    scoreBySetup.set(sk, fs);
    classBySetup.set(sk, useFusion ? klassFromFinalScore(fs) : r.klass);
  }
  for (const r of selected) {
    const tag = useFusion ? `smart_v2_fusion_${r.klass}_${r.pickReason}` : `smart_v2_${r.klass}_${r.pickReason}`;
    selectedReasonBySetupKey.set(r.setupKey, tag);
  }

  const boostedSelected = policyIntegrated
    ? selected.filter((r) => r.policyTier === 'boosted').length
    : 0;
  const neutralSelected = policyIntegrated
    ? selected.filter((r) => r.policyTier === 'neutral' || r.policyTier == null).length
    : 0;

  const droppedRows = useFusion ? dropped : [];
  const frozenDropped =
    policyIntegrated
      ? frozenExcluded + droppedRows.filter((r) => r.policyTier === 'frozen').length
      : 0;
  const throttledDropped = policyIntegrated
    ? droppedRows.filter((r) => r.policyTier === 'throttled').length
    : 0;

  const autoThrottleFrozenDropped =
    autoFrozenExcluded + droppedRows.filter((r) => String(r.autoDecision || '').toUpperCase() === 'FROZEN').length;

  const histogram = policyIntegrated ? tallyHistogram(policyCodeLists) : {};
  const autoHistogram = autoThrottleIntegrated ? tallyHistogram(autoCodeLists) : {};
  const capitalHistogram = capitalIntegrated ? tallyHistogram(capitalCodeLists) : {};

  const topSelected = selected.slice(0, 15).map((r) => ({
    setupKey: r.setupKey,
    baseScore: r.baseScore != null ? r.baseScore : r.score,
    policyAdj: r.policyAdj != null ? r.policyAdj : 0,
    autoThrottleAdj: r.autoThrottleAdj != null ? r.autoThrottleAdj : 0,
    capitalAllocationAdj: r.capitalAllocationAdj != null ? r.capitalAllocationAdj : 0,
    systemAdj: r.systemAdj != null ? r.systemAdj : 0,
    finalScore: r.finalScore != null ? r.finalScore : r.score,
    policyTier: r.policyTier || null,
    autoDecision: r.autoDecision != null ? r.autoDecision : null,
    capitalBucket: r.capitalBucket != null ? r.capitalBucket : null,
    strictScore: r.strictScore != null ? r.strictScore : null,
  }));

  const selectionMode = modeLabel;

  const obs = buildObservability({
    smartReplayV2Enabled: true,
    policyIntegrated,
    policyModeRequested: policyIntegrationRequested,
    policyMode,
    stats,
    mergedGlobalCaps,
    globalControlsApplied,
    tierEnv,
    healthOverall,
    circuitState,
    frozenExcluded,
    frozenDropped,
    throttledDropped,
    boostedSelected,
    neutralSelected,
    topSelected,
    histogram,
    selectionMode,
    systemAdjGlobal,
    autoThrottleRequested,
    autoThrottleIntegrated,
    autoThrottlePolicyMode,
    autoThrottlePolicyGeneratedAt: autoThrottleIntegrated ? autoThrottleDoc.generatedAt || null : null,
    autoThrottleProtectSeen,
    autoThrottleThrottleSeen,
    autoThrottleFrozenSeen,
    autoThrottleFrozenDropped,
    autoThrottleReducedBudgetCount,
    autoHistogram,
    capitalAllocationRequested,
    capitalIntegrated,
    capitalAllocationPolicyMode,
    capitalAllocationPolicyGeneratedAt: capitalIntegrated ? capitalDoc.generatedAt || null : null,
    capitalAllocationCoreSeen,
    capitalAllocationActiveSeen,
    capitalAllocationReducedSeen,
    capitalAllocationSuspendedSeen,
    capitalAllocationReducedBudgetCount,
    capitalAllocationSuspendedDropped,
    capitalAllocationGlobalControlsApplied: capitalIntegrated ? capitalDoc.globalControls || null : null,
    capitalAllocationConcentrationRisk: capitalIntegrated ? capitalDoc.concentrationRisk || null : null,
    capitalHistogram,
  });

  logLines.unshift(
    `smart_replay mode=${selectionMode} candidates=${stats.candidates} selected=${stats.selected} dropped=${stats.dropped} avg_base=${stats.avgBaseScore != null ? stats.avgBaseScore : stats.avgScore} avg_final=${stats.avgFinalScore != null ? stats.avgFinalScore : stats.avgScore}`
  );

  const autoThrottleObservability = {
    autoThrottleEnabled: autoThrottleRequested,
    autoThrottlePolicyIntegrated: autoThrottleIntegrated,
    autoThrottlePolicyMode: autoThrottlePolicyMode,
    autoThrottlePolicyGeneratedAt: autoThrottleIntegrated ? autoThrottleDoc.generatedAt || null : null,
    autoThrottleProtectSeen,
    autoThrottleThrottleSeen,
    autoThrottleFrozenSeen,
    autoThrottleFrozenDropped,
    autoThrottleReducedBudgetCount,
    autoThrottleHistogram: autoHistogram,
  };

  writeAutoThrottleSelectionSnapshot({
    generatedAt: new Date().toISOString(),
    selectionMode,
    autoThrottleObservability,
    selected: topSelected,
    droppedSample: dropped.slice(0, 60),
  });

  let capitalAllocationGlobalReplayFactor = null;
  if (capitalIntegrated && capitalDoc.globalControls) {
    const gf = Number(capitalDoc.globalControls.recommendedGlobalReplayFactor);
    if (Number.isFinite(gf)) capitalAllocationGlobalReplayFactor = clamp(gf, 0.45, 1.12);
  }

  writeCapitalAllocationSelectionSnapshot({
    generatedAt: new Date().toISOString(),
    selectionMode,
    capitalIntegrated,
    capitalAllocationPolicyMode,
    capitalAllocationGlobalReplayFactor,
    concentrationRisk: capitalIntegrated ? capitalDoc.concentrationRisk || null : null,
    selected: topSelected,
    droppedSample: dropped.slice(0, 60),
  });

  return {
    selectedSetupKeys,
    selectedReasonBySetupKey,
    scoreBySetup,
    classBySetup,
    tier1Keys,
    stats,
    dropped,
    selectedDetail: selected,
    mergedGlobalCaps,
    smartReplayObservability: obs,
    selectionLogLines: logLines,
    enrichedRows: useFusion ? enrichedRows : null,
    replayBarsCapBySetup,
    autoThrottleBarsBySetup,
    capitalAllocationGlobalReplayFactor,
  };
}

function writeAutoThrottleSelectionSnapshot(payload) {
  const opsDir = resolveOpsSnapshotDir();
  try {
    fs.mkdirSync(opsDir, { recursive: true });
    fs.writeFileSync(
      path.join(opsDir, 'auto_throttle_selection.json'),
      JSON.stringify({ schemaVersion: 1, ...payload }, null, 2),
      'utf8'
    );
  } catch {
    /* optional */
  }
}

function writeCapitalAllocationSelectionSnapshot(payload) {
  const opsDir = resolveOpsSnapshotDir();
  try {
    fs.mkdirSync(opsDir, { recursive: true });
    fs.writeFileSync(
      path.join(opsDir, 'capital_allocation_selection.json'),
      JSON.stringify({ schemaVersion: 1, ...payload }, null, 2),
      'utf8'
    );
  } catch {
    /* optional */
  }
}

function buildObservability(o) {
  const modeLabelReplay = !o.policyIntegrated
    ? o.policyModeRequested && !o.policyMode
      ? 'smart_only_policy_requested_invalid'
      : 'smart_only'
    : 'smart_plus_policy';
  const smartReplayPolicyModeOut =
    o.selectionMode != null && String(o.selectionMode).trim() !== ''
      ? o.selectionMode
      : modeLabelReplay;

  return {
    smartReplayV2Enabled: o.smartReplayV2Enabled,
    smartReplayPolicyIntegrated: o.policyIntegrated,
    smartReplayPolicyMode: smartReplayPolicyModeOut,
    smartReplayEnginePolicyMode: o.policyMode,
    smartReplayCandidatesSeen: o.stats.candidates,
    smartReplayCandidatesSelected: o.stats.selected,
    smartReplayBoostedSelected: o.boostedSelected,
    smartReplayNeutralSelected: o.neutralSelected,
    smartReplayThrottledDropped: o.throttledDropped,
    smartReplayFrozenDropped: o.frozenDropped,
    smartReplayAvgBaseScore: o.stats.avgBaseScore != null ? o.stats.avgBaseScore : o.stats.avgScore,
    smartReplayAvgFinalScore: o.stats.avgFinalScore != null ? o.stats.avgFinalScore : o.stats.avgScore,
    smartReplayGlobalControlsApplied: o.globalControlsApplied,
    smartReplayTopSelected: o.topSelected,
    smartReplayPolicyInfluenceHistogram: o.histogram,
    smartReplaySelectionMode: o.selectionMode,
    smartReplaySystemAdjGlobal: o.systemAdjGlobal,
    smartReplayFrozenExcludedStrict: o.frozenExcluded,
    smartReplayHealthOverall: o.healthOverall,
    smartReplayCircuitState: o.circuitState,
    autoThrottleEnabled: Boolean(o.autoThrottleRequested),
    autoThrottlePolicyIntegrated: Boolean(o.autoThrottleIntegrated),
    autoThrottlePolicyMode: o.autoThrottlePolicyMode != null ? o.autoThrottlePolicyMode : null,
    autoThrottlePolicyGeneratedAt: o.autoThrottlePolicyGeneratedAt != null ? o.autoThrottlePolicyGeneratedAt : null,
    autoThrottleProtectSeen: o.autoThrottleProtectSeen != null ? o.autoThrottleProtectSeen : null,
    autoThrottleThrottleSeen: o.autoThrottleThrottleSeen != null ? o.autoThrottleThrottleSeen : null,
    autoThrottleFrozenSeen: o.autoThrottleFrozenSeen != null ? o.autoThrottleFrozenSeen : null,
    autoThrottleFrozenDropped: o.autoThrottleFrozenDropped != null ? o.autoThrottleFrozenDropped : null,
    autoThrottleReducedBudgetCount: o.autoThrottleReducedBudgetCount != null ? o.autoThrottleReducedBudgetCount : null,
    smartReplayAutoThrottleHistogram: o.autoHistogram && Object.keys(o.autoHistogram).length ? o.autoHistogram : null,
    capitalAllocationEnabled: Boolean(o.capitalAllocationRequested),
    capitalAllocationPolicyIntegrated: Boolean(o.capitalIntegrated),
    capitalAllocationPolicyGeneratedAt:
      o.capitalAllocationPolicyGeneratedAt != null ? o.capitalAllocationPolicyGeneratedAt : null,
    capitalAllocationPolicyMode: o.capitalAllocationPolicyMode != null ? o.capitalAllocationPolicyMode : null,
    capitalAllocationCoreSeen: o.capitalAllocationCoreSeen != null ? o.capitalAllocationCoreSeen : null,
    capitalAllocationActiveSeen: o.capitalAllocationActiveSeen != null ? o.capitalAllocationActiveSeen : null,
    capitalAllocationReducedSeen: o.capitalAllocationReducedSeen != null ? o.capitalAllocationReducedSeen : null,
    capitalAllocationSuspendedSeen:
      o.capitalAllocationSuspendedSeen != null ? o.capitalAllocationSuspendedSeen : null,
    capitalAllocationReducedBudgetCount:
      o.capitalAllocationReducedBudgetCount != null ? o.capitalAllocationReducedBudgetCount : null,
    capitalAllocationSuspendedDropped:
      o.capitalAllocationSuspendedDropped != null ? o.capitalAllocationSuspendedDropped : null,
    capitalAllocationGlobalControlsApplied:
      o.capitalAllocationGlobalControlsApplied != null ? o.capitalAllocationGlobalControlsApplied : null,
    capitalAllocationConcentrationRisk:
      o.capitalAllocationConcentrationRisk != null ? o.capitalAllocationConcentrationRisk : null,
    smartReplayCapitalAllocationHistogram:
      o.capitalHistogram && Object.keys(o.capitalHistogram).length ? o.capitalHistogram : null,
  };
}

/**
 * Write observability artefact under ops-snapshot and governance (compact).
 */
function writeSmartReplaySelectionSnapshot(selection, extra) {
  if (!selection) return;
  const opsDir = resolveOpsSnapshotDir();
  const obs = selection.smartReplayObservability || {};
  const payload = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode: obs.smartReplayPolicyMode || 'unknown',
    selectionMode: obs.smartReplaySelectionMode,
    controls: obs.smartReplayGlobalControlsApplied || null,
    selected: (selection.selectedDetail || []).map((r) => ({
      setupKey: r.setupKey,
      baseScore: r.baseScore != null ? r.baseScore : r.score,
      policyAdj: r.policyAdj,
      autoThrottleAdj: r.autoThrottleAdj,
      capitalAllocationAdj: r.capitalAllocationAdj,
      systemAdj: r.systemAdj,
      finalScore: r.finalScore != null ? r.finalScore : r.score,
      klass: r.klass,
      policyTier: r.policyTier,
      autoDecision: r.autoDecision,
      capitalBucket: r.capitalBucket,
      pickReason: r.pickReason,
    })),
    droppedSample: (selection.dropped || []).slice(0, 80),
    stats: selection.stats,
    observability: {
      histogram: obs.smartReplayPolicyInfluenceHistogram,
      topSelected: obs.smartReplayTopSelected,
    },
    ...extra,
  };
  try {
    fs.mkdirSync(opsDir, { recursive: true });
    fs.writeFileSync(path.join(opsDir, 'smart_replay_selection.json'), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* optional */
  }
  const dr = extra && extra.dataRoot ? String(extra.dataRoot) : '';
  if (dr) {
    try {
      const gdir = path.join(dr, 'governance');
      fs.mkdirSync(gdir, { recursive: true });
      const compact = {
        schemaVersion: 2,
        generatedAt: payload.generatedAt,
        mode: payload.mode,
        stats: payload.stats,
        selectedKeys: (selection.selectedDetail || []).map((r) => r.setupKey),
        histogram: obs.smartReplayPolicyInfluenceHistogram,
      };
      fs.writeFileSync(
        path.join(gdir, 'smart_replay_selection.json'),
        JSON.stringify(compact, null, 2),
        'utf8'
      );
    } catch {
      /* optional */
    }
  }
}

function smartAllowlistV2Enabled() {
  const v = String(process.env.NP_SMART_ALLOWLIST_V2 || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function smartReplayPolicyIntegrationEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NP_SMART_REPLAY_POLICY_INTEGRATION_ENABLE || '0').trim().toLowerCase()
  );
}

function autoThrottlePolicyIntegrationEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NP_AUTO_THROTTLE_ENABLE || '0').trim().toLowerCase()
  );
}

function capitalAllocationPolicyIntegrationEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NP_CAPITAL_ALLOCATION_ENABLE || '0').trim().toLowerCase()
  );
}

module.exports = {
  smartAllowlistV2Enabled,
  smartReplayPolicyIntegrationEnabled,
  autoThrottlePolicyIntegrationEnabled,
  capitalAllocationPolicyIntegrationEnabled,
  buildSmartReplaySelectionV2,
  writeSmartReplaySelectionSnapshot,
  computeSmartReplayScore,
  selectSmartReplayCandidates,
  getReplaySetupKey,
};
