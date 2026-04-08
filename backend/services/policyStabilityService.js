'use strict';

/**
 * Run-to-run stability of policy + allocation (diagnostic). Pure + persisted snapshots.
 */

const fs = require('fs').promises;
const path = require('path');

const POLICY_STABILITY_VERSION = 1;

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getStabilityLatestPath() {
  return path.join(getDataDir(), 'policy_stability_latest.json');
}

function getStabilityHistoryPath() {
  return path.join(getDataDir(), 'policy_stability_history.jsonl');
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function decisionToBand(decision) {
  const d = String(decision || 'keep').toLowerCase();
  if (d === 'promote') return 'promoted';
  if (d === 'throttle') return 'throttled';
  if (d === 'demote') return 'demoted';
  if (d === 'suspend') return 'suspended';
  return 'neutral';
}

function entityMap(entities) {
  const m = new Map();
  for (const e of entities || []) {
    const k = `${e.entityType}|${e.entityKey}`;
    m.set(k, e);
  }
  return m;
}

function weightMapFromAlloc(allocationPlan, kind) {
  const rows =
    kind === 'symbol'
      ? allocationPlan?.symbolAllocations
      : allocationPlan?.strategyAllocations;
  const o = {};
  for (const r of rows || []) {
    const key = kind === 'symbol' ? r.symbol : r.strategy;
    if (key != null) o[String(key)] = Number(r.weight) || 0;
  }
  return o;
}

function turnoverL1(wPrev, wCur) {
  const keys = new Set([...Object.keys(wPrev || {}), ...Object.keys(wCur || {})]);
  let s = 0;
  for (const k of keys) {
    const a = Number(wPrev[k]) || 0;
    const b = Number(wCur[k]) || 0;
    s += Math.abs(b - a);
  }
  return round4(s / 2);
}

function rankChanges(wPrev, wCur, topN = 5) {
  const prevSorted = Object.entries(wPrev || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k], i) => [k, i]);
  const curSorted = Object.entries(wCur || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k], i) => [k, i]);
  const rankPrev = Object.fromEntries(prevSorted.map(([k], i) => [k, i]));
  const rankCur = Object.fromEntries(curSorted.map(([k], i) => [k, i]));
  const keys = new Set([...Object.keys(rankPrev), ...Object.keys(rankCur)]);
  const changes = [];
  for (const k of keys) {
    const dr = (rankCur[k] ?? 99) - (rankPrev[k] ?? 99);
    if (dr !== 0) changes.push({ key: k, rankDelta: dr });
  }
  changes.sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta));
  return changes.slice(0, topN);
}

/**
 * @param {object} currentPolicyState
 * @param {object} previousPolicyState
 * @param {object} currentAllocationPlan
 * @param {object} previousAllocationPlan
 * @param {object} [previousCorrelationOverlap]
 * @param {object} [currentCorrelationOverlap]
 */
function buildPolicyStabilityDiagnostics(
  currentPolicyState,
  previousPolicyState,
  currentAllocationPlan,
  previousAllocationPlan,
  previousCorrelationOverlap,
  currentCorrelationOverlap
) {
  const generatedAt = new Date().toISOString();
  const curP = currentPolicyState && typeof currentPolicyState === 'object' ? currentPolicyState : {};
  const prevP = previousPolicyState && typeof previousPolicyState === 'object' ? previousPolicyState : {};
  const curA = currentAllocationPlan && typeof currentAllocationPlan === 'object' ? currentAllocationPlan : {};
  const prevA = previousAllocationPlan && typeof previousAllocationPlan === 'object' ? previousAllocationPlan : {};

  const lookbackAvailable = !!(prevP.generatedAt != null && String(prevP.generatedAt).length > 0);

  const curEnt = Array.isArray(curP.entities) ? curP.entities : [];
  const prevEnt = Array.isArray(prevP.entities) ? prevP.entities : [];
  const mapC = entityMap(curEnt);
  const mapP = entityMap(prevEnt);

  let comparableEntityCount = 0;
  let bandChanges = 0;
  let promoteToThrottleCount = 0;
  let throttleToPromoteCount = 0;
  let activeToSuspendedCount = 0;
  let suspendedToActiveCount = 0;
  let eligibilityFlipCount = 0;
  const confidenceChanges = [];
  const topEntityFlips = [];

  for (const [k, eCur] of mapC) {
    const ePrev = mapP.get(k);
    if (!ePrev) continue;
    comparableEntityCount++;
    const bCur = decisionToBand(eCur.decision);
    const bPrev = decisionToBand(ePrev.decision);
    if (bCur !== bPrev) {
      bandChanges++;
      topEntityFlips.push({
        entityKey: k,
        fromBand: bPrev,
        toBand: bCur,
      });
    }
    if (bPrev === 'promoted' && bCur === 'throttled') promoteToThrottleCount++;
    if (bPrev === 'throttled' && bCur === 'promoted') throttleToPromoteCount++;
    if (bPrev !== 'suspended' && bCur === 'suspended') activeToSuspendedCount++;
    if (bPrev === 'suspended' && bCur !== 'suspended') suspendedToActiveCount++;
    if (!!ePrev.eligible !== !!eCur.eligible) eligibilityFlipCount++;

    const dConf = (Number(eCur.confidence) || 0) - (Number(ePrev.confidence) || 0);
    confidenceChanges.push(dConf);
  }

  const entityBandChangeRate =
    comparableEntityCount > 0 ? round4(bandChanges / comparableEntityCount) : null;

  let avgConfidenceChange = null;
  let avgAbsConfidenceChange = null;
  if (confidenceChanges.length) {
    avgConfidenceChange = round4(
      confidenceChanges.reduce((a, b) => a + b, 0) / confidenceChanges.length
    );
    avgAbsConfidenceChange = round4(
      confidenceChanges.reduce((a, b) => a + Math.abs(b), 0) / confidenceChanges.length
    );
  }

  topEntityFlips.sort((a, b) => {
    const rank = { suspended: 4, demoted: 3, throttled: 2, promoted: 1, neutral: 0 };
    return (rank[b.fromBand] || 0) - (rank[a.fromBand] || 0);
  });

  const gCur = curP.globalPolicy || {};
  const gPrev = prevP.globalPolicy || {};
  const portfolioRiskModeChanged =
    String(gCur.portfolioRiskMode || '') !== String(gPrev.portfolioRiskMode || '');
  const deployablePctCur = Number(curA.diagnostics?.deployablePct);
  const deployablePctPrev = Number(prevA.diagnostics?.deployablePct);
  const deployableCapitalPctChange =
    Number.isFinite(deployablePctCur) && Number.isFinite(deployablePctPrev)
      ? round4(deployablePctCur - deployablePctPrev)
      : null;

  const newEntryThrottleChange =
    Number.isFinite(Number(gCur.newEntryThrottle)) &&
    Number.isFinite(Number(gPrev.newEntryThrottle))
      ? round4(Number(gCur.newEntryThrottle) - Number(gPrev.newEntryThrottle))
      : null;

  const degradedModeChanged = !!gCur.degradedMode !== !!gPrev.degradedMode;
  const recommendedActionChanged =
    String(gCur.recommendedAction || '') !== String(gPrev.recommendedAction || '');

  const policyHealthScoreChange =
    Number.isFinite(Number(curP.policyHealthScore)) &&
    Number.isFinite(Number(prevP.policyHealthScore))
      ? round4(Number(curP.policyHealthScore) - Number(prevP.policyHealthScore))
      : null;

  const instabilityFlags = [];
  if (!lookbackAvailable) instabilityFlags.push('insufficient_history');
  if (entityBandChangeRate != null && entityBandChangeRate > 0.35) {
    instabilityFlags.push('excessive_policy_flip');
  }
  if (promoteToThrottleCount + throttleToPromoteCount >= 3) {
    instabilityFlags.push('policy_band_churn');
  }
  if (portfolioRiskModeChanged || degradedModeChanged) {
    instabilityFlags.push('degraded_mode_toggle');
  }
  if (policyHealthScoreChange != null && policyHealthScoreChange < -15) {
    instabilityFlags.push('confidence_drop');
  }

  const wSPrev = weightMapFromAlloc(prevA, 'strategy');
  const wSCur = weightMapFromAlloc(curA, 'strategy');
  const wYPrev = weightMapFromAlloc(prevA, 'symbol');
  const wYCur = weightMapFromAlloc(curA, 'symbol');

  const strategyWeightTurnover = turnoverL1(wSPrev, wSCur);
  const symbolWeightTurnover = turnoverL1(wYPrev, wYCur);

  if (strategyWeightTurnover > 0.35 || symbolWeightTurnover > 0.35) {
    instabilityFlags.push('allocation_turnover_high');
  }

  const concCur = Number(curA.diagnostics?.postCapConcentrationScore ?? curA.allocationConcentrationScore);
  const concPrev = Number(prevA.diagnostics?.postCapConcentrationScore ?? prevA.allocationConcentrationScore);
  const concentrationScoreChange =
    Number.isFinite(concCur) && Number.isFinite(concPrev) ? round4(concCur - concPrev) : null;

  if (concentrationScoreChange != null && concentrationScoreChange > 12) {
    instabilityFlags.push('concentration_jump');
  }

  const reserveCur =
    Number(curA.portfolio?.cashReserve) /
    (Number(curA.portfolio?.baseCapital) + 1e-9);
  const reservePrev =
    Number(prevA.portfolio?.cashReserve) /
    (Number(prevA.portfolio?.baseCapital) + 1e-9);
  const reservePctChange =
    Number.isFinite(reserveCur) && Number.isFinite(reservePrev)
      ? round4(reserveCur - reservePrev)
      : null;

  const topStrategyRankChanges = rankChanges(wSPrev, wSCur);
  const topSymbolRankChanges = rankChanges(wYPrev, wYCur);

  if (topStrategyRankChanges.length >= 3 && strategyWeightTurnover > 0.25) {
    instabilityFlags.push('unstable_top_ranks');
  }

  let policyStabilityScore = 85;
  policyStabilityScore -= (entityBandChangeRate || 0) * 80;
  policyStabilityScore -= (promoteToThrottleCount + throttleToPromoteCount) * 6;
  policyStabilityScore -= (activeToSuspendedCount + suspendedToActiveCount) * 8;
  if (portfolioRiskModeChanged) policyStabilityScore -= 12;
  if (degradedModeChanged) policyStabilityScore -= 10;
  if (avgAbsConfidenceChange != null) policyStabilityScore -= avgAbsConfidenceChange * 40;
  policyStabilityScore = Math.round(clamp(policyStabilityScore, 0, 100));

  let allocationStabilityScore = 85;
  allocationStabilityScore -= strategyWeightTurnover * 90;
  allocationStabilityScore -= symbolWeightTurnover * 70;
  if (concentrationScoreChange != null) {
    allocationStabilityScore -= Math.abs(concentrationScoreChange) * 1.5;
  }
  allocationStabilityScore = Math.round(clamp(allocationStabilityScore, 0, 100));

  let overallStabilityScore = Math.round(
    clamp(policyStabilityScore * 0.55 + allocationStabilityScore * 0.45, 0, 100)
  );
  if (!lookbackAvailable) overallStabilityScore = null;

  const prevO =
    previousCorrelationOverlap && typeof previousCorrelationOverlap === 'object'
      ? previousCorrelationOverlap
      : {};
  const curO =
    currentCorrelationOverlap && typeof currentCorrelationOverlap === 'object'
      ? currentCorrelationOverlap
      : {};
  const prevCrowd = Number(prevO.crowdingDiagnostics?.totalCrowdingScore);
  const curCrowd = Number(curO.crowdingDiagnostics?.totalCrowdingScore);
  const crowdingScoreChange =
    Number.isFinite(prevCrowd) && Number.isFinite(curCrowd)
      ? round4(curCrowd - prevCrowd)
      : null;
  const symbolCrowdingChange =
    Number.isFinite(Number(prevO.crowdingDiagnostics?.symbolCrowdingScore)) &&
    Number.isFinite(Number(curO.crowdingDiagnostics?.symbolCrowdingScore))
      ? round4(
          Number(curO.crowdingDiagnostics.symbolCrowdingScore) -
            Number(prevO.crowdingDiagnostics.symbolCrowdingScore)
        )
      : null;
  const strategyCrowdingChange =
    Number.isFinite(Number(prevO.crowdingDiagnostics?.strategyCrowdingScore)) &&
    Number.isFinite(Number(curO.crowdingDiagnostics?.strategyCrowdingScore))
      ? round4(
          Number(curO.crowdingDiagnostics.strategyCrowdingScore) -
            Number(prevO.crowdingDiagnostics.strategyCrowdingScore)
        )
      : null;
  const falseDivPrev = Number(prevO.crowdingDiagnostics?.falseDiversificationScore);
  const falseDivCur = Number(curO.crowdingDiagnostics?.falseDiversificationScore);
  const falseDiversificationChange =
    Number.isFinite(falseDivPrev) && Number.isFinite(falseDivCur)
      ? round4(falseDivCur - falseDivPrev)
      : null;

  let overlapMatrixInstability = null;
  const prevPairs = prevO.matrices?.pairwiseTop || [];
  const curPairs = curO.matrices?.pairwiseTop || [];
  if (prevPairs.length && curPairs.length) {
    const mapP = new Map(prevPairs.map((p) => [`${p.pairKeyA}||${p.pairKeyB}`, p.overlapScore]));
    let deltaSum = 0;
    let n = 0;
    for (const p of curPairs.slice(0, 20)) {
      const k = `${p.pairKeyA}||${p.pairKeyB}`;
      if (mapP.has(k)) {
        deltaSum += Math.abs(p.overlapScore - mapP.get(k));
        n++;
      }
    }
    overlapMatrixInstability = n > 0 ? round4(deltaSum / n) : null;
  }

  const overlapStabilityFlags = [];
  if (crowdingScoreChange != null && crowdingScoreChange > 0.12) {
    overlapStabilityFlags.push('crowding_jump');
  }
  if (falseDiversificationChange != null && falseDiversificationChange > 0.1) {
    overlapStabilityFlags.push('false_diversification_increase');
  }
  if (overlapMatrixInstability != null && overlapMatrixInstability > 0.18) {
    overlapStabilityFlags.push('overlap_instability_high');
  }
  if (
    prevO.overlapDiagnostics?.duplicateExpressionCount != null &&
    curO.overlapDiagnostics?.duplicateExpressionCount != null
  ) {
    const d =
      curO.overlapDiagnostics.duplicateExpressionCount -
      prevO.overlapDiagnostics.duplicateExpressionCount;
    if (d >= 2) overlapStabilityFlags.push('duplicate_edge_cluster_shift');
  }

  for (const f of overlapStabilityFlags) {
    if (!instabilityFlags.includes(f)) instabilityFlags.push(f);
  }

  if (overlapStabilityFlags.length && overallStabilityScore != null) {
    overallStabilityScore = Math.round(
      clamp(overallStabilityScore - overlapStabilityFlags.length * 6, 0, 100)
    );
  }

  return {
    policyStabilityVersion: POLICY_STABILITY_VERSION,
    generatedAt,
    lookbackAvailable,
    policy: {
      entityCountCurrent: curEnt.length,
      entityCountPrevious: prevEnt.length,
      comparableEntityCount,
      entityBandChangeRate,
      promoteToThrottleCount,
      throttleToPromoteCount,
      activeToSuspendedCount,
      suspendedToActiveCount,
      eligibilityFlipCount,
      avgConfidenceChange,
      avgAbsConfidenceChange,
      topEntityFlips: topEntityFlips.slice(0, 15),
    },
    allocation: {
      strategyWeightTurnover,
      symbolWeightTurnover,
      topStrategyRankChanges,
      topSymbolRankChanges,
      concentrationScoreChange,
      reservePctChange,
      deployableCapitalPctChange,
      weightDriftSummary: {
        strategyKeysCompared: Object.keys({ ...wSPrev, ...wSCur }).length,
        symbolKeysCompared: Object.keys({ ...wYPrev, ...wYCur }).length,
      },
    },
    global: {
      portfolioRiskModeChanged,
      deployableCapitalPctChange,
      newEntryThrottleChange,
      degradedModeChanged,
      recommendedActionChanged,
      policyHealthScoreChange,
      instabilityFlags,
    },
    overlap: {
      crowdingScoreChange,
      symbolCrowdingChange,
      strategyCrowdingChange,
      falseDiversificationChange,
      topCrowdedClusterChanges: [],
      overlapMatrixInstability,
      crowdedEntityFlipCount: null,
      overlapStabilityFlags,
    },
    summary: {
      policyStabilityScore,
      allocationStabilityScore,
      overallStabilityScore,
      instabilityFlags,
    },
  };
}

async function loadLatestStabilityDiagnostics() {
  try {
    const raw = await fs.readFile(getStabilityLatestPath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return null;
  }
}

async function saveLatestStabilityDiagnostics(diagnostics) {
  const file = getStabilityLatestPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(diagnostics, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[policy-stability] save latest failed: ${e.message}`);
    return false;
  }
}

async function appendStabilityHistory(diagnostics) {
  const file = getStabilityHistoryPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(diagnostics)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn(`[policy-stability] append history failed: ${e.message}`);
    return false;
  }
}

async function readStabilityHistory(limit = 50) {
  const maxRead = parseInt(process.env.POLICY_STABILITY_HISTORY_MAX_READ || '2000', 10);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), maxRead);
  try {
    const text = await fs.readFile(getStabilityHistoryPath(), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < lim; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch (e) {
        /* skip */
      }
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    return [];
  }
}

module.exports = {
  POLICY_STABILITY_VERSION,
  buildPolicyStabilityDiagnostics,
  loadLatestStabilityDiagnostics,
  saveLatestStabilityDiagnostics,
  appendStabilityHistory,
  readStabilityHistory,
  decisionToBand,
};
