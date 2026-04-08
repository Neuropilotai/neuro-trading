'use strict';

/**
 * Shadow allocation: compare advisory plan vs paper execution (diagnostic only).
 * Never blocks trading; best-effort JSON persistence.
 */

const fs = require('fs').promises;
const path = require('path');

const SHADOW_ALLOC_VERSION = 1;

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getShadowLatestPath() {
  return path.join(getDataDir(), 'shadow_allocation_latest.json');
}

function getShadowHistoryPath() {
  return path.join(getDataDir(), 'shadow_allocation_history.jsonl');
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function parseShadowThresholds() {
  return {
    // Upper bounds on (ratio - 1) for overweight tiers above the aligned band.
    slight: parseFloat(process.env.SHADOW_ALLOC_SLIGHT_OVERWEIGHT_PCT || '0.15'),
    material: parseFloat(process.env.SHADOW_ALLOC_MATERIAL_OVERWEIGHT_PCT || '0.35'),
    severe: parseFloat(process.env.SHADOW_ALLOC_SEVERE_OVERWEIGHT_PCT || '0.70'),
    underweight: parseFloat(process.env.SHADOW_ALLOC_UNDERWEIGHT_PCT || '-0.15'),
    alignedLo: parseFloat(process.env.SHADOW_ALLOC_ALIGNED_LO || '0.85'),
    // Default ceiling 1.05 leaves room for slight/material bands above "aligned".
    alignedHi: parseFloat(process.env.SHADOW_ALLOC_ALIGNED_HI || '1.05'),
  };
}

/**
 * Conservative actual notional from trade decision + snapshot.
 */
function estimateActualNotional(tradeDecision, accountSnapshot) {
  const t = tradeDecision || {};
  if (Number.isFinite(Number(t.notional)) && Number(t.notional) > 0) {
    return Number(t.notional);
  }
  const costProceeds = Number(t.cost) || Number(t.proceeds);
  if (Number.isFinite(costProceeds) && costProceeds > 0) {
    return costProceeds;
  }
  if (Number.isFinite(Number(t.requestedValue)) && Number(t.requestedValue) > 0) {
    return Number(t.requestedValue);
  }
  const q = Number(t.quantity) || Number(t.filledQuantity);
  const px = Number(t.price) || Number(t.fillPrice);
  if (Number.isFinite(q) && Number.isFinite(px) && q > 0 && px > 0) {
    return q * px;
  }
  return null;
}

function findAllocationRow(rows, keyField, keyVal) {
  const k = String(keyVal || '').trim();
  if (!k || !Array.isArray(rows)) return null;
  return rows.find((r) => String(r[keyField] || '') === k) || null;
}

/**
 * Map strategy/symbol to plan slices. Combined = min(strategyCap, symbolCap) when both (conservative).
 */
function getRecommendedSliceForDecision(allocationPlan, strategyKey, symbolKey) {
  const plan = allocationPlan || {};
  const stratRows = plan.strategyAllocations || [];
  const symRows = plan.symbolAllocations || [];
  const deploy = Number(plan.portfolio?.recommendedDeployableCapital) || 0;

  const strategyNamed =
    strategyKey != null && String(strategyKey).trim() !== '';

  const sRow = strategyNamed ? findAllocationRow(stratRows, 'strategy', strategyKey) : null;
  const yRow = symbolKey != null ? findAllocationRow(symRows, 'symbol', String(symbolKey).toUpperCase()) : null;

  const wS = sRow ? Number(sRow.weight) : null;
  const wY = yRow ? Number(yRow.weight) : null;
  const recS = sRow ? Number(sRow.recommendedCapital) : null;
  const recY = yRow ? Number(yRow.recommendedCapital) : null;

  const reasons = [];
  // If the plan defines strategies and the trade names one, require a strategy row (no silent symbol-only fallback).
  if (strategyNamed && stratRows.length > 0 && !sRow) {
    reasons.push('strategy_key_not_in_allocation_plan');
    return {
      recommendedStrategyWeight: null,
      recommendedSymbolWeight: wY != null ? round4(wY) : null,
      recommendedDeployableCapital: deploy > 0 ? round4(deploy) : null,
      recommendedStrategyCapital: null,
      recommendedSymbolCapital: recY != null ? round4(recY) : null,
      combinedRecommendedNotional: null,
      reasons,
    };
  }

  let combinedRecommendedNotional = null;
  if (recS != null && recY != null) {
    combinedRecommendedNotional = Math.min(recS, recY);
    reasons.push('combined_uses_min_of_strategy_and_symbol_slice');
  } else if (recS != null) {
    combinedRecommendedNotional = recS;
    reasons.push('strategy_slice_only');
  } else if (recY != null) {
    combinedRecommendedNotional = recY;
    reasons.push('symbol_slice_only');
  } else {
    reasons.push('no_matching_slices');
  }

  return {
    recommendedStrategyWeight: wS,
    recommendedSymbolWeight: wY,
    recommendedDeployableCapital: deploy > 0 ? round4(deploy) : null,
    recommendedStrategyCapital: recS != null ? round4(recS) : null,
    recommendedSymbolCapital: recY != null ? round4(recY) : null,
    combinedRecommendedNotional:
      combinedRecommendedNotional != null ? round4(combinedRecommendedNotional) : null,
    reasons,
  };
}

function policyRowFor(policyState, entityType, entityKey) {
  const entities = policyState?.entities;
  if (!Array.isArray(entities)) return null;
  const ek = String(entityKey || '');
  return entities.find((e) => e.entityType === entityType && String(e.entityKey) === ek) || null;
}

/**
 * Core shadow decision object (inspectable).
 */
function buildShadowAllocationDecision(input) {
  const {
    tradeCandidate,
    tradeDecision,
    allocationPlan,
    policyState,
    accountSnapshot,
    metadata,
    correlationOverlapState,
  } = input || {};

  const td = tradeDecision || tradeCandidate || {};
  const strategy = td.strategy != null ? String(td.strategy) : null;
  const symbol = td.symbol != null ? String(td.symbol).toUpperCase().trim() : null;
  const side = td.side != null ? String(td.side).toUpperCase() : td.action != null ? String(td.action).toUpperCase() : null;

  const globalPolicy = policyState?.globalPolicy || {};
  const mode = String(globalPolicy.portfolioRiskMode || 'normal').toLowerCase();
  const degradedModes = new Set(['degraded', 'defensive', 'restricted']);

  const slice = getRecommendedSliceForDecision(allocationPlan, strategy, symbol);
  const stratPol = strategy ? policyRowFor(policyState, 'strategy', strategy) : null;
  const symPol = symbol ? policyRowFor(policyState, 'symbol', symbol) : null;

  let overlapScoreAtDecision = null;
  let crowdingScoreAtDecision = null;
  let crowdedClusterAtDecision = null;
  let duplicateEdgeAtDecision = false;
  let crowdingRiskLevelAtDecision = 'low';
  let crowdingAdjustedRecommendedCapital = null;
  const crowdingReasons = [];
  const ov = correlationOverlapState && typeof correlationOverlapState === 'object' ? correlationOverlapState : null;
  if (ov) {
    try {
      const cos = require('./correlationOverlapService');
      const idx = cos.buildEntityCrowdingIndex(ov);
      const ks = strategy ? `strategy|${strategy}` : null;
      const ky = symbol ? `symbol|${symbol}` : null;
      const os = ks ? idx.get(ks) : null;
      const oy = ky ? idx.get(ky) : null;
      overlapScoreAtDecision = round4(
        Math.max(os?.overlapScore || 0, oy?.overlapScore || 0)
      );
      crowdingScoreAtDecision = round4(
        Math.max(os?.crowdingScore || 0, oy?.crowdingScore || 0)
      );
      if ((os?.reasons || []).length) crowdingReasons.push(...(os.reasons || []).slice(0, 4));
      if ((oy?.reasons || []).length) crowdingReasons.push(...(oy.reasons || []).slice(0, 4));
      crowdedClusterAtDecision =
        (ov.crowdingDiagnostics?.topCrowdedClusters || []).find((c) =>
          (c.memberKeys || []).some(
            (mk) =>
              (ks && mk === ks) ||
              (ky && mk === ky) ||
              (ks && ky && mk.includes(strategy) && mk.includes(symbol))
          )
        )?.clusterKey || null;
      duplicateEdgeAtDecision =
        (Number(ov.overlapDiagnostics?.duplicateExpressionCount) || 0) >= 2;
      crowdingRiskLevelAtDecision = cos.crowdingRiskLevelFromScore(
        Math.max(overlapScoreAtDecision, crowdingScoreAtDecision)
      );
    } catch (e) {
      void e;
    }
  }
  const multCrowd =
    stratPol && stratPol.overlapPenaltyMultiplier != null
      ? Number(stratPol.overlapPenaltyMultiplier)
      : symPol && symPol.overlapPenaltyMultiplier != null
        ? Number(symPol.overlapPenaltyMultiplier)
        : 1;

  const policyEligible =
    stratPol && symPol
      ? stratPol.eligible !== false && symPol.eligible !== false
      : stratPol
        ? stratPol.eligible !== false
        : symPol
          ? symPol.eligible !== false
          : true;

  const policyRiskLevel = stratPol?.policyRiskLevel || symPol?.policyRiskLevel || null;

  const estimatedActual = estimateActualNotional(td, accountSnapshot);
  const rec = slice.combinedRecommendedNotional;

  const reasons = [...slice.reasons];
  let advisoryStatus = 'insufficient_data';
  let withinRecommendedBand = false;
  let deltaNotional = null;
  let deltaPct = null;

  if (estimatedActual == null || !Number.isFinite(estimatedActual)) {
    advisoryStatus = 'insufficient_data';
    reasons.push('actual_notional_unknown');
  } else if (!policyEligible) {
    advisoryStatus = 'ineligible_policy';
    reasons.push('strategy_or_symbol_ineligible');
  } else if (rec == null || rec <= 0) {
    advisoryStatus = 'no_allocation_match';
    reasons.push('no_positive_recommended_slice');
  } else {
    const T = parseShadowThresholds();
    const ratio = estimatedActual / (rec + 1e-9);
    deltaNotional = round4(estimatedActual - rec);
    deltaPct = round4((estimatedActual - rec) / (rec + 1e-9));
    withinRecommendedBand = ratio >= T.alignedLo && ratio <= T.alignedHi;

    const overPct = ratio - 1;
    if (degradedModes.has(mode)) {
      advisoryStatus = 'degraded_global_mode';
      reasons.push(`portfolio_mode=${mode}`);
    } else if (ratio < 1 + T.underweight) {
      advisoryStatus = 'underweight';
    } else if (ratio >= T.alignedLo && ratio <= T.alignedHi) {
      advisoryStatus = 'aligned';
    } else if (overPct > 0 && ratio > T.alignedHi && overPct <= T.slight) {
      advisoryStatus = 'slight_overweight';
    } else if (overPct > T.slight && overPct <= T.material) {
      advisoryStatus = 'material_overweight';
    } else if (overPct > T.material && overPct <= T.severe) {
      advisoryStatus = 'material_overweight';
    } else if (overPct > T.severe) {
      advisoryStatus = 'severe_overweight';
    } else {
      advisoryStatus = 'underweight';
    }

    const totalCrowd = Number(ov?.crowdingDiagnostics?.totalCrowdingScore) || 0;
    if (
      advisoryStatus === 'aligned' &&
      totalCrowd >= parseFloat(process.env.CROWDING_WARN_THRESHOLD || '0.35') &&
      (overlapScoreAtDecision || 0) >= 0.25
    ) {
      advisoryStatus = 'crowded_but_within_bounds';
      reasons.push('portfolio_crowding_elevated');
    }
    if (
      duplicateEdgeAtDecision &&
      strategy &&
      symbol &&
      (advisoryStatus === 'aligned' || advisoryStatus === 'crowded_but_within_bounds')
    ) {
      advisoryStatus = 'duplicate_edge_expression';
      reasons.push('duplicate_edge_cluster');
    }
    if (
      (crowdingRiskLevelAtDecision === 'high' || crowdingRiskLevelAtDecision === 'severe') &&
      advisoryStatus === 'slight_overweight'
    ) {
      advisoryStatus = 'crowded_overweight';
      reasons.push('crowding_amplifies_overweight');
    }
    if (
      (ov?.crowdingDiagnostics?.falseDiversificationScore || 0) > 0.5 &&
      (advisoryStatus === 'aligned' || advisoryStatus === 'crowded_but_within_bounds')
    ) {
      advisoryStatus = 'false_diversification_detected';
      reasons.push('false_diversification');
    }
  }

  if (rec != null && rec > 0 && Number.isFinite(multCrowd)) {
    crowdingAdjustedRecommendedCapital = round4(rec * multCrowd);
  }

  return {
    strategy,
    symbol,
    side,
    requestedQuantity: Number(td.quantity) || Number(td.filledQuantity) || null,
    requestedNotional: estimatedActual,
    estimatedActualNotional: estimatedActual,
    recommendedStrategyWeight: slice.recommendedStrategyWeight,
    recommendedSymbolWeight: slice.recommendedSymbolWeight,
    recommendedDeployableCapital: slice.recommendedDeployableCapital,
    recommendedStrategyCapital: slice.recommendedStrategyCapital,
    recommendedSymbolCapital: slice.recommendedSymbolCapital,
    recommendedNotionalTarget: slice.combinedRecommendedNotional,
    shadowDeltaNotional: deltaNotional,
    shadowDeltaPct: deltaPct,
    shadowSizeRatio:
      estimatedActual != null && rec != null && rec > 0
        ? round4(estimatedActual / rec)
        : null,
    withinRecommendedBand,
    advisoryStatus,
    policyEligible,
    policyRiskLevel,
    portfolioRiskMode: mode,
    reasons,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    overlapScoreAtDecision,
    crowdingScoreAtDecision,
    crowdedClusterAtDecision,
    duplicateEdgeAtDecision,
    crowdingRiskLevelAtDecision,
    crowdingAdjustedRecommendedCapital,
    crowdingReasons: [...new Set(crowdingReasons)].slice(0, 12),
  };
}

/**
 * Full persisted record shape.
 */
function buildShadowAllocationRecord(input) {
  const generatedAt = new Date().toISOString();
  const d = buildShadowAllocationDecision(input);
  const tradeRef =
    input?.tradeRef ||
    input?.tradeDecision?.tradeId ||
    input?.metadata?.tradeId ||
    null;

  return {
    shadowAllocationVersion: SHADOW_ALLOC_VERSION,
    generatedAt,
    tradeRef,
    strategy: d.strategy,
    symbol: d.symbol,
    requestedNotional: d.estimatedActualNotional,
    estimatedActualNotional: d.estimatedActualNotional,
    recommendedStrategyWeight: d.recommendedStrategyWeight,
    recommendedSymbolWeight: d.recommendedSymbolWeight,
    recommendedDeployableCapital: d.recommendedDeployableCapital,
    recommendedStrategyCapital: d.recommendedStrategyCapital,
    recommendedSymbolCapital: d.recommendedSymbolCapital,
    policyEligible: d.policyEligible,
    policyRiskLevel: d.policyRiskLevel,
    portfolioRiskMode: d.portfolioRiskMode,
    advisoryStatus: d.advisoryStatus,
    deltaNotional: d.shadowDeltaNotional,
    deltaPct: d.shadowDeltaPct,
    withinRecommendedBand: d.withinRecommendedBand,
    reasons: d.reasons,
    metadata: d.metadata,
    overlapScoreAtDecision: d.overlapScoreAtDecision,
    crowdingScoreAtDecision: d.crowdingScoreAtDecision,
    crowdedClusterAtDecision: d.crowdedClusterAtDecision,
    duplicateEdgeAtDecision: d.duplicateEdgeAtDecision,
    crowdingRiskLevelAtDecision: d.crowdingRiskLevelAtDecision,
    crowdingAdjustedRecommendedCapital: d.crowdingAdjustedRecommendedCapital,
    crowdingReasons: d.crowdingReasons,
  };
}

async function loadLatestShadowAllocationRecord() {
  try {
    const raw = await fs.readFile(getShadowLatestPath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return null;
  }
}

async function saveLatestShadowAllocationRecord(record) {
  const file = getShadowLatestPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[shadow-allocation] save latest failed: ${e.message}`);
    return false;
  }
}

async function appendShadowAllocationHistory(record) {
  const file = getShadowHistoryPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn(`[shadow-allocation] append history failed: ${e.message}`);
    return false;
  }
}

function median(arr) {
  const a = (arr || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function buildShadowAllocationSummary(records) {
  const rows = Array.isArray(records) ? records : [];
  const byStrategy = {};
  const bySymbol = {};
  const byAdvisoryStatus = {};

  let alignedCount = 0;
  let overweightCount = 0;
  let severeOverweightCount = 0;
  let underweightCount = 0;
  let ineligibleCount = 0;
  const deltaPcts = [];
  const absDeltaPcts = [];

  for (const r of rows) {
    const st = r.advisoryStatus;
    byAdvisoryStatus[st] = (byAdvisoryStatus[st] || 0) + 1;
    if (st === 'aligned') alignedCount++;
    if (st === 'severe_overweight' || st === 'material_overweight' || st === 'slight_overweight') {
      overweightCount++;
    }
    if (st === 'severe_overweight') severeOverweightCount++;
    if (st === 'underweight') underweightCount++;
    if (st === 'ineligible_policy') ineligibleCount++;

    const dp = Number(r.deltaPct);
    if (Number.isFinite(dp)) {
      deltaPcts.push(dp);
      absDeltaPcts.push(Math.abs(dp));
    }

    const s = r.strategy || 'null';
    const y = r.symbol || 'null';
    if (!byStrategy[s]) byStrategy[s] = { count: 0, sumDeltaPct: 0 };
    byStrategy[s].count++;
    if (Number.isFinite(dp)) byStrategy[s].sumDeltaPct += dp;

    if (!bySymbol[y]) bySymbol[y] = { count: 0, sumDeltaPct: 0 };
    bySymbol[y].count++;
    if (Number.isFinite(dp)) bySymbol[y].sumDeltaPct += dp;
  }

  const worstOverweights = [...rows]
    .filter((r) => Number(r.deltaPct) > 0)
    .sort((a, b) => Number(b.deltaPct) - Number(a.deltaPct))
    .slice(0, 10)
    .map((r) => ({
      strategy: r.strategy,
      symbol: r.symbol,
      deltaPct: r.deltaPct,
      advisoryStatus: r.advisoryStatus,
    }));

  const worstUnderweights = [...rows]
    .filter((r) => Number(r.deltaPct) < 0)
    .sort((a, b) => Number(a.deltaPct) - Number(b.deltaPct))
    .slice(0, 10)
    .map((r) => ({
      strategy: r.strategy,
      symbol: r.symbol,
      deltaPct: r.deltaPct,
      advisoryStatus: r.advisoryStatus,
    }));

  const mDelta = deltaPcts.length ? round4(deltaPcts.reduce((a, b) => a + b, 0) / deltaPcts.length) : null;
  const mAbs = absDeltaPcts.length ? round4(absDeltaPcts.reduce((a, b) => a + b, 0) / absDeltaPcts.length) : null;

  return {
    generatedAt: new Date().toISOString(),
    totalComparisons: rows.length,
    alignedCount,
    overweightCount,
    severeOverweightCount,
    underweightCount,
    ineligibleCount,
    avgDeltaPct: mDelta,
    medianDeltaPct: median(deltaPcts) != null ? round4(median(deltaPcts)) : null,
    avgAbsDeltaPct: mAbs,
    worstOverweights,
    worstUnderweights,
    byStrategy,
    bySymbol,
    byAdvisoryStatus,
  };
}

async function readShadowAllocationHistory(limit = 100) {
  const maxRead = parseInt(process.env.SHADOW_ALLOC_HISTORY_MAX_READ || '5000', 10);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), maxRead);
  try {
    const text = await fs.readFile(getShadowHistoryPath(), 'utf8');
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

/**
 * Post-trade hook: build plan (no allocation file churn), persist shadow only.
 */
async function logShadowAfterPaperExecution(ctx) {
  if (String(process.env.ENABLE_SHADOW_ALLOCATION || 'true').toLowerCase() === 'false') {
    return null;
  }
  const orderIntent = ctx?.orderIntent || {};
  const executionResult = ctx?.executionResult || {};
  const action = String(ctx?.action || orderIntent.action || '').toUpperCase();

  const capitalAllocationService = require('./capitalAllocationService');
  const policyApplicationService = require('./policyApplicationService');

  const policyState = await policyApplicationService.loadPolicyState();
  const allocationPlan = await capitalAllocationService.buildCapitalAllocationPlan({
    policyState,
    skipAllocationPersistence: true,
  });

  let correlationOverlapState = {};
  try {
    correlationOverlapState = await require('./correlationOverlapService').loadLatestCorrelationOverlapState();
  } catch (e) {
    correlationOverlapState = {};
  }

  let accountSnapshot = null;
  try {
    const paper = require('./paperTradingService');
    accountSnapshot = paper.getAccountSummary();
  } catch (e) {
    accountSnapshot = null;
  }

  const tradeDecision = {
    strategy: orderIntent.strategy != null ? orderIntent.strategy : null,
    symbol: orderIntent.symbol,
    action,
    side: action === 'BUY' ? 'LONG' : action === 'SELL' || action === 'CLOSE' ? 'LONG' : null,
    quantity: orderIntent.quantity,
    price: orderIntent.price,
    filledQuantity: executionResult.filledQuantity,
    fillPrice: executionResult.fillPrice,
    cost: executionResult.cost,
    proceeds: executionResult.proceeds,
    notional:
      executionResult.cost != null && executionResult.cost > 0
        ? executionResult.cost
        : executionResult.proceeds,
    tradeId: ctx?.tradeId,
  };

  const record = buildShadowAllocationRecord({
    tradeDecision,
    allocationPlan,
    policyState,
    correlationOverlapState,
    accountSnapshot,
    metadata: {
      source: 'paperTradingService',
      action,
      tradeId: ctx?.tradeId,
    },
    tradeRef: ctx?.tradeId,
  });

  await saveLatestShadowAllocationRecord(record);
  await appendShadowAllocationHistory(record);
  return record;
}

module.exports = {
  SHADOW_ALLOC_VERSION,
  estimateActualNotional,
  getRecommendedSliceForDecision,
  buildShadowAllocationDecision,
  buildShadowAllocationRecord,
  loadLatestShadowAllocationRecord,
  saveLatestShadowAllocationRecord,
  appendShadowAllocationHistory,
  buildShadowAllocationSummary,
  readShadowAllocationHistory,
  logShadowAfterPaperExecution,
};
