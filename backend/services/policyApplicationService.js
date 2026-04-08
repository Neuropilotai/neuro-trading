'use strict';

/**
 * Policy application: RL scorecards + analytics → durable policy artifact (advisory).
 * Does not execute trades. Best-effort persistence.
 */

const fs = require('fs').promises;
const path = require('path');
const reinforcementLearningService = require('./reinforcementLearningService');
const analyticsOverviewService = require('./analyticsOverviewService');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getPolicyStatePath() {
  return path.join(getDataDir(), 'policy_state_v1.json');
}

const POLICY_VERSION = 1;

function computePolicyEnvFingerprint() {
  const keys = [
    'POLICY_PROMOTE_ALLOC_LO',
    'POLICY_PROMOTE_ALLOC_HI',
    'POLICY_THROTTLE_ALLOC_LO',
    'POLICY_DEMOTE_ALLOC_LO',
    'POLICY_DEMOTE_CONF_ELIGIBLE',
    'RL_PROMOTE_SCORE',
    'RL_KEEP_SCORE',
    'RL_THROTTLE_SCORE',
  ];
  return keys.map((k) => `${k}=${process.env[k] || ''}`).join(';');
}

function buildEntityChangeSummary(prevEntities, curEntities) {
  const prev = Array.isArray(prevEntities) ? prevEntities : [];
  const cur = Array.isArray(curEntities) ? curEntities : [];
  const map = new Map();
  for (const e of prev) {
    map.set(`${e.entityType}|${e.entityKey}`, e);
  }
  let decisionChanges = 0;
  let eligibilityFlips = 0;
  for (const e of cur) {
    const k = `${e.entityType}|${e.entityKey}`;
    const p = map.get(k);
    if (p) {
      if (p.decision !== e.decision) decisionChanges++;
      if (!!p.eligible !== !!e.eligible) eligibilityFlips++;
    }
  }
  return {
    previousEntityCount: prev.length,
    currentEntityCount: cur.length,
    decisionChanges,
    eligibilityFlips,
  };
}

function wrapPolicyMetadata(previousPolicyState, baseApplyResult) {
  return {
    policyVersion: POLICY_VERSION,
    previousGeneratedAt: previousPolicyState.generatedAt || null,
    sourceLearningGeneratedAt: baseApplyResult.summary?.learningGeneratedAt || null,
    analyticsGeneratedAt: baseApplyResult.summary?.analyticsGeneratedAt || null,
    envFingerprint: computePolicyEnvFingerprint(),
    entityChangeSummary: buildEntityChangeSummary(
      previousPolicyState.entities,
      baseApplyResult.entities
    ),
  };
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function parseEffectRanges() {
  return {
    promoteAlloc: [
      parseFloat(process.env.POLICY_PROMOTE_ALLOC_LO || '1.25'),
      parseFloat(process.env.POLICY_PROMOTE_ALLOC_HI || '1.5'),
    ],
    promoteExp: [
      parseFloat(process.env.POLICY_PROMOTE_EXP_LO || '1.1'),
      parseFloat(process.env.POLICY_PROMOTE_EXP_HI || '1.25'),
    ],
    throttleAlloc: [
      parseFloat(process.env.POLICY_THROTTLE_ALLOC_LO || '0.5'),
      parseFloat(process.env.POLICY_THROTTLE_ALLOC_HI || '0.8'),
    ],
    demoteAlloc: [
      parseFloat(process.env.POLICY_DEMOTE_ALLOC_LO || '0.25'),
      parseFloat(process.env.POLICY_DEMOTE_ALLOC_HI || '0.5'),
    ],
    demoteConfEligible: parseFloat(process.env.POLICY_DEMOTE_CONF_ELIGIBLE || '0.35'),
    lowConfDampen: process.env.POLICY_LOW_CONF_DAMPEN !== 'false',
  };
}

/**
 * Parse RL bucketKey into supported entity types only.
 * @returns {{ entityType: string, entityKey: string } | null}
 */
function parseEntityFromBucketKey(bucketKey) {
  const k = String(bucketKey || '');
  const parts = k.split('|');
  const head = parts[0];
  if (head === 'strategy' && parts.length === 2) {
    return { entityType: 'strategy', entityKey: parts[1] };
  }
  if (head === 'symbol' && parts.length === 2) {
    return { entityType: 'symbol', entityKey: parts[1].toUpperCase() };
  }
  if (head === 'regime' && parts.length === 2) {
    return { entityType: 'regime', entityKey: parts[1] };
  }
  if (head === 'hourUTC' && parts.length === 2) {
    return { entityType: 'hourUTC', entityKey: parts[1] };
  }
  if (head === 'strategy+regime' && parts.length === 3) {
    return { entityType: 'strategy+regime', entityKey: `${parts[1]}|${parts[2]}` };
  }
  if (head === 'symbol+hourUTC' && parts.length === 3) {
    return {
      entityType: 'symbol+hourUTC',
      entityKey: `${parts[1].toUpperCase()}|${parts[2]}`,
    };
  }
  return null;
}

function lerpRange(lo, hi, t) {
  return lo + (hi - lo) * clamp(t, 0, 1);
}

/**
 * Core multipliers from RL decision + score/confidence (deterministic).
 */
function policyEffectForDecision(decision, score, confidence) {
  const R = parseEffectRanges();
  const t = clamp(Number(confidence) || 0, 0, 1);
  const s = Number(score) || 0;

  switch (decision) {
    case 'promote': {
      const alloc = lerpRange(R.promoteAlloc[0], R.promoteAlloc[1], t);
      const exp = lerpRange(R.promoteExp[0], R.promoteExp[1], t);
      return {
        allocationMultiplier: round4(alloc + (s > 0.5 ? 0.05 : 0)),
        maxExposureMultiplier: round4(exp),
        throttleFactor: 1,
        eligible: true,
      };
    }
    case 'keep':
      return {
        allocationMultiplier: 1,
        maxExposureMultiplier: 1,
        throttleFactor: 1,
        eligible: true,
      };
    case 'throttle': {
      const a = lerpRange(R.throttleAlloc[0], R.throttleAlloc[1], t);
      const damp = clamp(1 - (s < 0 ? -s * 0.15 : 0), 0.35, 1);
      const v = round4(a * damp);
      return {
        allocationMultiplier: v,
        maxExposureMultiplier: v,
        throttleFactor: v,
        eligible: true,
      };
    }
    case 'demote': {
      const a = lerpRange(R.demoteAlloc[0], R.demoteAlloc[1], t);
      const v = round4(a * clamp(1 + s * 0.1, 0.5, 1));
      return {
        allocationMultiplier: v,
        maxExposureMultiplier: v,
        throttleFactor: v,
        eligible: t >= R.demoteConfEligible,
      };
    }
    case 'suspend':
      return {
        allocationMultiplier: 0,
        maxExposureMultiplier: 0,
        throttleFactor: 0,
        eligible: false,
      };
    default:
      return {
        allocationMultiplier: 1,
        maxExposureMultiplier: 1,
        throttleFactor: 1,
        eligible: true,
      };
  }
}

function policyRiskLevelFromDecision(decision) {
  if (decision === 'suspend' || decision === 'demote') return 'high';
  if (decision === 'throttle') return 'medium';
  if (decision === 'promote') return 'low';
  return 'medium';
}

/**
 * @param {object} input
 * @param {string} input.entityType
 * @param {string} input.entityKey
 * @param {object} input.scoreCard - { bucketKey, score, confidence, decision, components }
 * @param {object} [input.bucketStats]
 * @param {string[]} [input.globalDegradationFlags]
 */
function deriveEntityPolicy(input) {
  const generatedAt = new Date().toISOString();
  const scoreCard = input.scoreCard || {};
  const decision = String(scoreCard.decision || 'keep');
  const score = Number(scoreCard.score) || 0;
  const confidence = Number(scoreCard.confidence) || 0;
  const bucketStats = input.bucketStats || {};
  const n = Number(bucketStats.tradeCount) || 0;

  let dataQualityFlag = 'insufficient';
  if (n >= 12) dataQualityFlag = 'ok';
  else if (n >= 5) dataQualityFlag = 'thin';

  const eff = policyEffectForDecision(decision, score, confidence);
  let allocationMultiplier = eff.allocationMultiplier;
  let maxExposureMultiplier = eff.maxExposureMultiplier;
  let throttleFactor = eff.throttleFactor;
  let eligible = eff.eligible;
  let degradationReason = null;

  const R = parseEffectRanges();
  if (R.lowConfDampen && decision !== 'suspend') {
    const confScale = 0.5 + 0.5 * clamp(confidence, 0, 1);
    if (decision !== 'keep') {
      allocationMultiplier = round4(1 + (allocationMultiplier - 1) * confScale);
      maxExposureMultiplier = round4(1 + (maxExposureMultiplier - 1) * confScale);
      throttleFactor = round4(1 + (throttleFactor - 1) * confScale);
    } else if (confidence < 0.4) {
      allocationMultiplier = round4(0.85 + 0.15 * confScale);
      maxExposureMultiplier = round4(0.9 + 0.1 * confScale);
    }
  }

  if (decision === 'demote' && confidence < R.demoteConfEligible) {
    eligible = false;
    degradationReason = 'LOW_CONFIDENCE_DEMOTE';
  }

  if (decision === 'suspend') {
    allocationMultiplier = 0;
    maxExposureMultiplier = 0;
    throttleFactor = 0;
    eligible = false;
    degradationReason = degradationReason || 'RL_SUSPEND';
  }

  const flags = input.globalDegradationFlags || [];
  if (flags.includes('CONCENTRATED_BOOK') && input.entityType === 'symbol') {
    maxExposureMultiplier = round4(maxExposureMultiplier * 0.85);
    throttleFactor = round4(throttleFactor * 0.9);
  }

  const reasons = scoreCard.components && typeof scoreCard.components === 'object'
    ? { ...scoreCard.components }
    : {};

  return {
    entityType: input.entityType,
    entityKey: input.entityKey,
    decision,
    confidence: round4(confidence),
    score: round4(score),
    policyRiskLevel: policyRiskLevelFromDecision(decision),
    effectiveSampleSize: n,
    dataQualityFlag,
    degradationReason,
    throttleFactor,
    allocationMultiplier,
    maxExposureMultiplier,
    eligible,
    reasons,
    generatedAt,
  };
}

/**
 * Top-level portfolio policy from aggregates + analytics.
 */
function deriveGlobalPolicy(summary) {
  const generatedAt = new Date().toISOString();
  const {
    suspendedCount = 0,
    throttledCount = 0,
    demotedCount = 0,
    entityCount = 0,
    avgConfidence = 1,
    drawdownProxy = 0,
    concentration = 0,
    degradationFlags = [],
    recentExpectancyNegative = false,
    unstableRegimeCount = 0,
  } = summary || {};

  let portfolioRiskMode = 'normal';
  let maxGrossExposureMultiplier = 1;
  let newEntryThrottle = 1;
  let degradedMode = false;
  const flags = [...degradationFlags];

  if (suspendedCount >= 3 || (entityCount > 0 && suspendedCount / entityCount > 0.25)) {
    portfolioRiskMode = 'defensive';
    maxGrossExposureMultiplier = 0.15;
    newEntryThrottle = 0.1;
    degradedMode = true;
  } else if (
    suspendedCount >= 1 ||
    drawdownProxy > 0.45 ||
    (concentration > 0.65 && throttledCount >= 2)
  ) {
    portfolioRiskMode = 'degraded';
    maxGrossExposureMultiplier = 0.35;
    newEntryThrottle = 0.35;
    degradedMode = true;
  } else if (
    throttledCount + demotedCount >= 5 ||
    avgConfidence < 0.42 ||
    recentExpectancyNegative ||
    unstableRegimeCount >= 2
  ) {
    portfolioRiskMode = 'restricted';
    maxGrossExposureMultiplier = 0.55;
    newEntryThrottle = 0.55;
    degradedMode = true;
  } else if (
    throttledCount >= 2 ||
    concentration > 0.55 ||
    drawdownProxy > 0.25 ||
    flags.length > 0
  ) {
    portfolioRiskMode = 'cautious';
    maxGrossExposureMultiplier = 0.78;
    newEntryThrottle = 0.78;
  }

  let recommendedAction = 'normal';
  if (portfolioRiskMode === 'defensive') recommendedAction = 'preserve_capital';
  else if (portfolioRiskMode === 'degraded') recommendedAction = 'reduce_exposure';
  else if (portfolioRiskMode === 'restricted') recommendedAction = 'throttle_new_entries';
  else if (portfolioRiskMode === 'cautious') recommendedAction = 'tighten_risk';

  return {
    generatedAt,
    globalPolicy: {
      portfolioRiskMode,
      maxGrossExposureMultiplier: round4(maxGrossExposureMultiplier),
      newEntryThrottle: round4(newEntryThrottle),
      degradedMode,
      degradationFlags: flags,
      recommendedAction,
    },
  };
}

function computePolicyHealthScore(entities, globalBlock) {
  let h = 100;
  const by = { promote: 0, keep: 0, throttle: 0, demote: 0, suspend: 0 };
  for (const e of entities || []) {
    if (by[e.decision] != null) by[e.decision]++;
  }
  h -= by.suspend * 12;
  h -= by.demote * 6;
  h -= by.throttle * 3;
  h -= (globalBlock.globalPolicy?.degradationFlags?.length || 0) * 8;
  if (globalBlock.globalPolicy?.degradedMode) h -= 15;
  return Math.round(clamp(h, 0, 100));
}

/**
 * Merge RL learning state + analytics overview into policy state object (not yet saved).
 */
function applyPolicies(learningState, analyticsOverview, options = {}) {
  void options;
  const generatedAt = new Date().toISOString();
  const scoreCards = Array.isArray(learningState?.scoreCards)
    ? learningState.scoreCards
    : [];
  const buckets = learningState?.buckets && typeof learningState.buckets === 'object'
    ? learningState.buckets
    : {};

  const overview = analyticsOverview || {};
  const risk = overview.riskDiagnostics || {};
  const globalDegFlags = [
    ...(Array.isArray(overview.degradationFlags) ? overview.degradationFlags : []),
    ...(Array.isArray(risk.degradationFlags) ? risk.degradationFlags : []),
  ];
  const uniqueFlags = [...new Set(globalDegFlags)];

  const entities = [];
  for (const sc of scoreCards) {
    const parsed = parseEntityFromBucketKey(sc.bucketKey);
    if (!parsed) continue;
    const bucketStats = buckets[sc.bucketKey] || {};
    entities.push(
      deriveEntityPolicy({
        entityType: parsed.entityType,
        entityKey: parsed.entityKey,
        scoreCard: sc,
        bucketStats,
        globalDegradationFlags: uniqueFlags,
      })
    );
  }

  let confSum = 0;
  let suspendedCount = 0;
  let throttledCount = 0;
  let demotedCount = 0;
  for (const e of entities) {
    confSum += Number(e.confidence) || 0;
    if (e.decision === 'suspend') suspendedCount++;
    if (e.decision === 'throttle') throttledCount++;
    if (e.decision === 'demote') demotedCount++;
  }
  const avgConfidence = entities.length ? confSum / entities.length : 1;

  const portfolio = overview.portfolio || {};
  const bookEq = Number(portfolio.bookEquity) || 0;
  const gross = Number(portfolio.grossExposure) || 0;
  const concentration = bookEq > 0 ? gross / bookEq : 0;

  const stratAttr = overview.strategyAttribution || [];
  let recentExpectancyNegative = false;
  if (stratAttr.length) {
    const neg = stratAttr.filter((r) => Number(r.expectancy) < 0);
    recentExpectancyNegative = neg.length > stratAttr.length * 0.5;
  }

  const unstableRegimeCount = (risk.unstableRegimes || []).length;

  const globalBlock = deriveGlobalPolicy({
    suspendedCount,
    throttledCount,
    demotedCount,
    entityCount: entities.length,
    avgConfidence,
    drawdownProxy: Number(risk.drawdownProxy) || 0,
    concentration,
    degradationFlags: uniqueFlags,
    recentExpectancyNegative,
    unstableRegimeCount,
  });

  const sorted = [...entities];
  const topPromoted = sorted
    .filter((e) => e.decision === 'promote')
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  const topThrottled = sorted
    .filter((e) => e.decision === 'throttle')
    .sort((a, b) => a.score - b.score)
    .slice(0, 15);
  const topSuspended = sorted
    .filter((e) => e.decision === 'suspend')
    .sort((a, b) => a.score - b.score)
    .slice(0, 15);

  const summary = {
    entityCount: entities.length,
    byDecision: {
      promote: entities.filter((e) => e.decision === 'promote').length,
      keep: entities.filter((e) => e.decision === 'keep').length,
      throttle: entities.filter((e) => e.decision === 'throttle').length,
      demote: entities.filter((e) => e.decision === 'demote').length,
      suspend: entities.filter((e) => e.decision === 'suspend').length,
    },
    learningGeneratedAt: learningState?.generatedAt || null,
    analyticsGeneratedAt: overview.generatedAt || null,
  };

  const policyHealthScore = computePolicyHealthScore(entities, globalBlock);

  return {
    generatedAt,
    entities,
    globalPolicy: globalBlock.globalPolicy,
    diagnostics: {
      rlBucketCount: Object.keys(buckets).length,
      scoreCardCount: scoreCards.length,
      parsedEntityCount: entities.length,
      concentration: round4(concentration),
    },
    summary,
    topPromoted,
    topThrottled,
    topSuspended,
    degradationFlags: uniqueFlags,
    policyHealthScore,
  };
}

async function loadPolicyState() {
  const file = getPolicyStatePath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.warn(`[policy] loadPolicyState: ${e.message}`);
    return {};
  }
}

async function savePolicyState(state) {
  const file = getPolicyStatePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[policy] savePolicyState: ${e.message}`);
    return false;
  }
}

async function buildPolicyState(options = {}) {
  let learningState = options.learningState;
  if (!learningState) {
    learningState = await reinforcementLearningService.loadLearningState();
  }
  let overview = options.analyticsOverview;
  if (!overview) {
    try {
      overview = await analyticsOverviewService.getAnalyticsOverview({
        from: options.from,
        to: options.to,
        symbol: options.symbol,
        strategy: options.strategy,
        limit: options.limit,
        outlierLimit: options.outlierLimit,
      });
    } catch (e) {
      overview = {
        generatedAt: new Date().toISOString(),
        portfolio: {},
        riskDiagnostics: { degradationFlags: [], drawdownProxy: 0 },
        degradationFlags: [],
        strategyAttribution: [],
        executionQuality: { tradeCount: 0 },
      };
    }
  }
  return applyPolicies(learningState, overview, options);
}

async function getPolicyOverview() {
  const state = await loadPolicyState();
  return {
    ok: true,
    generatedAt: state.generatedAt || null,
    policyVersion: state.policyVersion ?? null,
    previousGeneratedAt: state.previousGeneratedAt || null,
    sourceLearningGeneratedAt: state.sourceLearningGeneratedAt || null,
    analyticsGeneratedAt: state.analyticsGeneratedAt || null,
    envFingerprint: state.envFingerprint || null,
    entityChangeSummary: state.entityChangeSummary || null,
    policyStabilityScore: state.policyStabilityScore ?? null,
    stabilityFlags: state.stabilityFlags || [],
    globalPolicy: state.globalPolicy || null,
    summary: state.summary || {},
    topPromoted: state.topPromoted || [],
    topThrottled: state.topThrottled || [],
    topSuspended: state.topSuspended || [],
    degradationFlags: state.degradationFlags || [],
    policyHealthScore: state.policyHealthScore ?? null,
    diagnostics: state.diagnostics || {},
  };
}

async function getPolicyEntities() {
  const state = await loadPolicyState();
  return {
    ok: true,
    generatedAt: state.generatedAt || null,
    entities: Array.isArray(state.entities) ? state.entities : [],
    count: Array.isArray(state.entities) ? state.entities.length : 0,
  };
}

async function getPolicyEntity(entityType, entityKey) {
  const state = await loadPolicyState();
  const entities = Array.isArray(state.entities) ? state.entities : [];
  const et = String(entityType || '');
  const ek = String(entityKey || '');
  const found =
    entities.find((e) => e.entityType === et && String(e.entityKey) === ek) || null;
  return {
    ok: true,
    generatedAt: state.generatedAt || null,
    entity: found,
  };
}

async function runPolicyCycle(options = {}) {
  const previousPolicyState = await loadPolicyState();
  let previousAllocationPlan = {};
  try {
    previousAllocationPlan = await require('./capitalAllocationService').loadLatestAllocationPlan();
  } catch (e) {
    previousAllocationPlan = {};
  }

  const base = await buildPolicyState(options);
  const meta = wrapPolicyMetadata(previousPolicyState, base);
  let enriched = { ...base, ...meta };

  let newAllocationPlan = {};
  try {
    const cap = require('./capitalAllocationService');
    newAllocationPlan = await cap.buildCapitalAllocationPlan({
      policyState: enriched,
      skipAllocationPersistence: true,
      ...options,
    });
    await cap.persistAllocationPlan(newAllocationPlan, {
      cacheHit: false,
      forceHistoryAppend: options.forceAllocationHistoryAppend === true,
    });
  } catch (e) {
    console.warn(`[policy] allocation persist in runPolicyCycle: ${e.message}`);
  }

  try {
    const stab = require('./policyStabilityService');
    const diag = stab.buildPolicyStabilityDiagnostics(
      enriched,
      previousPolicyState,
      newAllocationPlan,
      previousAllocationPlan
    );
    enriched.policyStabilityScore = diag.summary?.overallStabilityScore ?? null;
    enriched.stabilityFlags = diag.summary?.instabilityFlags || [];
    await stab.saveLatestStabilityDiagnostics(diag);
    await stab.appendStabilityHistory(diag);
  } catch (e) {
    console.warn(`[policy] stability in runPolicyCycle: ${e.message}`);
  }

  await savePolicyState(enriched);
  return enriched;
}

module.exports = {
  POLICY_VERSION,
  getPolicyStatePath,
  loadPolicyState,
  savePolicyState,
  buildPolicyState,
  applyPolicies,
  deriveEntityPolicy,
  deriveGlobalPolicy,
  parseEntityFromBucketKey,
  computePolicyEnvFingerprint,
  buildEntityChangeSummary,
  getPolicyOverview,
  getPolicyEntities,
  getPolicyEntity,
  runPolicyCycle,
};
