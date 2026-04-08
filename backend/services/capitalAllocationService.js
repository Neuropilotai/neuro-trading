'use strict';

/**
 * Deterministic capital allocation from policy + analytics (advisory).
 * Persists latest + append-only history under DATA_DIR.
 */

const fs = require('fs').promises;
const path = require('path');
const analyticsOverviewService = require('./analyticsOverviewService');
const policyApplicationService = require('./policyApplicationService');

const ALLOCATION_VERSION = 1;

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getAllocationLatestPath() {
  return path.join(getDataDir(), 'allocation_plan_latest.json');
}

function getAllocationHistoryPath() {
  return path.join(getDataDir(), 'allocation_plan_history.jsonl');
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function deployablePctForMode(portfolioRiskMode) {
  const m = String(portfolioRiskMode || 'normal').toLowerCase();
  const map = {
    normal: parseFloat(process.env.POLICY_BASE_DEPLOYABLE_CAPITAL_PCT || '0.7'),
    cautious: parseFloat(process.env.POLICY_CAUTIOUS_DEPLOYABLE_PCT || '0.55'),
    restricted: parseFloat(process.env.POLICY_RESTRICTED_DEPLOYABLE_CAPITAL_PCT || '0.25'),
    degraded: parseFloat(process.env.POLICY_DEGRADED_DEPLOYABLE_CAPITAL_PCT || '0.4'),
    defensive: parseFloat(process.env.POLICY_DEFENSIVE_DEPLOYABLE_CAPITAL_PCT || '0.15'),
  };
  return map[m] != null && Number.isFinite(map[m]) ? map[m] : map.normal;
}

function computeAllocationConfigFingerprint() {
  const keys = [
    'POLICY_MAX_STRATEGY_WEIGHT',
    'POLICY_MAX_SYMBOL_WEIGHT',
    'POLICY_MIN_CASH_RESERVE_PCT',
    'POLICY_BASE_DEPLOYABLE_CAPITAL_PCT',
    'POLICY_CAUTIOUS_DEPLOYABLE_PCT',
    'POLICY_RESTRICTED_DEPLOYABLE_CAPITAL_PCT',
    'POLICY_DEGRADED_DEPLOYABLE_CAPITAL_PCT',
    'POLICY_DEFENSIVE_DEPLOYABLE_CAPITAL_PCT',
  ];
  return keys.map((k) => `${k}=${process.env[k] || ''}`).join(';');
}

function computeEntityBaseWeights(entities) {
  const w = {};
  for (const e of entities || []) {
    if (!e || !e.eligible) continue;
    const key = String(e.entityKey);
    const score01 = clamp((Number(e.score) + 1) / 2, 0, 1);
    const conf = clamp(Number(e.confidence) || 0, 0, 1);
    const mult = Math.max(0, Number(e.allocationMultiplier) || 0);
    let raw = score01 * conf * mult;
    if (raw <= 1e-9) raw = 0.02 * conf * mult;
    w[key] = (w[key] || 0) + raw;
  }
  return w;
}

function normalizeWeights(weights) {
  const obj = weights && typeof weights === 'object' ? { ...weights } : {};
  const keys = Object.keys(obj);
  let sum = 0;
  for (const k of keys) sum += Math.max(0, Number(obj[k]) || 0);
  const out = {};
  if (sum <= 1e-12) {
    if (!keys.length) return {};
    const u = 1 / keys.length;
    for (const k of keys) out[k] = round4(u);
    return out;
  }
  for (const k of keys) out[k] = round4(Math.max(0, Number(obj[k]) || 0) / sum);
  return out;
}

function applyCapToNormalizedWeights(w, cap) {
  const keys = Object.keys(w);
  if (!keys.length || !Number.isFinite(cap) || cap <= 0) return { ...w };
  let cur = {};
  let sum0 = 0;
  for (const k of keys) {
    cur[k] = Math.max(0, Number(w[k]) || 0);
    sum0 += cur[k];
  }
  if (sum0 <= 1e-12) return normalizeWeights(cur);
  for (const k of keys) cur[k] /= sum0;

  const n = keys.length;
  if (cap * n < 1 - 1e-9) {
    const u = Math.min(1 / n, cap);
    const out = {};
    for (const k of keys) out[k] = u;
    return normalizeWeights(out);
  }

  for (let iter = 0; iter < 128; iter++) {
    const atCap = [];
    const below = [];
    let sum = keys.reduce((s, k) => s + (Number(cur[k]) || 0), 0);
    if (sum <= 1e-12) break;
    for (const k of keys) {
      const v = (Number(cur[k]) || 0) / sum;
      if (v > cap + 1e-10) atCap.push(k);
      else below.push(k);
    }
    if (!atCap.length) break;
    const massCap = atCap.length * cap;
    let rem = 1 - massCap;
    if (rem < 1e-12) {
      for (const k of keys) cur[k] = atCap.includes(k) ? cap : 0;
      break;
    }
    if (!below.length) break;
    let sumBelow = below.reduce((s, k) => s + (Number(cur[k]) || 0), 0);
    for (const k of atCap) cur[k] = cap;
    if (sumBelow <= 1e-12) {
      const share = rem / below.length;
      for (const k of below) cur[k] = share;
    } else {
      for (const k of below) {
        cur[k] = rem * ((Number(cur[k]) || 0) / sumBelow);
      }
    }
    sum = keys.reduce((s, k) => s + (Number(cur[k]) || 0), 0);
    for (const k of keys) cur[k] = (Number(cur[k]) || 0) / (sum || 1);
    let ok = true;
    for (const k of keys) {
      if ((Number(cur[k]) || 0) > cap + 1e-7) ok = false;
    }
    if (ok) break;
  }
  return normalizeWeights(cur);
}

function applyRiskCaps(weights, caps) {
  const maxStrategy = caps.maxStrategy != null ? caps.maxStrategy : 0.4;
  const maxSymbol = caps.maxSymbol != null ? caps.maxSymbol : 0.5;
  const outS = normalizeWeights(weights.strategies || {});
  const outY = normalizeWeights(weights.symbols || {});
  return {
    strategies: applyCapToNormalizedWeights(outS, maxStrategy),
    symbols: applyCapToNormalizedWeights(outY, maxSymbol),
  };
}

function entityMetaMap(entities) {
  const m = {};
  for (const e of entities || []) {
    m[String(e.entityKey)] = e;
  }
  return m;
}

function buildStrategyAllocations(normWeights, stratEntities, deployableCapital) {
  const meta = entityMetaMap(stratEntities);
  const keys = Object.keys(normWeights);
  const rows = keys.map((strategy) => {
    const w = Number(normWeights[strategy]) || 0;
    const me = meta[strategy] || {};
    return {
      strategy,
      weight: round4(w),
      recommendedCapital: round4(deployableCapital * w),
      allocationMultiplier: me.allocationMultiplier != null ? round4(me.allocationMultiplier) : 1,
      decision: me.decision || 'keep',
      confidence: me.confidence != null ? round4(me.confidence) : 0,
      eligible: me.eligible !== false,
    };
  });
  rows.sort((a, b) => b.weight - a.weight);
  return rows;
}

function buildSymbolAllocations(normWeights, symEntities, deployableCapital) {
  const meta = entityMetaMap(symEntities);
  const keys = Object.keys(normWeights);
  const rows = keys.map((symbol) => {
    const w = Number(normWeights[symbol]) || 0;
    const me = meta[symbol] || {};
    const maxExpMult = Number(me.maxExposureMultiplier) != null ? Number(me.maxExposureMultiplier) : 1;
    return {
      symbol,
      weight: round4(w),
      recommendedCapital: round4(deployableCapital * w),
      maxExposure: round4(deployableCapital * w * maxExpMult),
      decision: me.decision || 'keep',
      confidence: me.confidence != null ? round4(me.confidence) : 0,
      eligible: me.eligible !== false,
    };
  });
  rows.sort((a, b) => b.weight - a.weight);
  return rows;
}

function buildPortfolioAllocationSummary(baseCapital, deployable, cashReserve, mode, globalPolicy) {
  return {
    baseCapital: round4(baseCapital),
    recommendedDeployableCapital: round4(deployable),
    cashReserve: round4(cashReserve),
    grossExposureCap: round4(deployable),
    portfolioRiskMode: mode,
    maxGrossExposureMultiplier:
      globalPolicy.maxGrossExposureMultiplier != null
        ? round4(globalPolicy.maxGrossExposureMultiplier)
        : 1,
    newEntryThrottle:
      globalPolicy.newEntryThrottle != null ? round4(globalPolicy.newEntryThrottle) : 1,
  };
}

function herfindahl(weights) {
  const vals = Object.values(weights || {}).map((x) => Number(x) || 0);
  let s = 0;
  for (const v of vals) s += v * v;
  return s;
}

function allocationConcentrationScore(weights) {
  return round4(herfindahl(weights) * 100);
}

function cappedWeightLossL1(uncapped, capped) {
  const keys = new Set([...Object.keys(uncapped || {}), ...Object.keys(capped || {})]);
  let loss = 0;
  for (const k of keys) {
    const u = Number(uncapped[k]) || 0;
    const c = Number(capped[k]) || 0;
    loss += Math.max(0, u - c);
  }
  return round4(loss);
}

function topOverweightRisks(strategyAllocations, maxW) {
  const out = [];
  for (const r of strategyAllocations || []) {
    if (r.weight > maxW * 0.95) out.push({ type: 'strategy', key: r.strategy, weight: r.weight });
  }
  return out;
}

function capitalEfficiencyScore(strategyAllocations, executionQuality) {
  const eff = executionQuality?.averageEfficiencyRatio;
  const deployRatio =
    strategyAllocations?.length > 0
      ? strategyAllocations.reduce((s, r) => s + r.weight, 0)
      : 0;
  let score = 50 + deployRatio * 30;
  if (eff != null && Number.isFinite(eff)) score += eff * 20;
  return Math.round(clamp(score, 0, 100));
}

function computeBindingReadinessScore(plan, policyState) {
  let s = 72;
  const mode = String(plan.portfolio?.portfolioRiskMode || 'normal').toLowerCase();
  if (mode === 'degraded' || mode === 'defensive') s -= 25;
  if (mode === 'restricted' || mode === 'cautious') s -= 12;
  const conc =
    Number(plan.diagnostics?.postCapConcentrationScore) ||
    Number(plan.allocationConcentrationScore) ||
    0;
  if (conc > 45) s -= 15;
  else if (conc > 35) s -= 8;
  const cwl = Number(plan.diagnostics?.cappedWeightLoss) || 0;
  if (cwl > 0.25) s -= 12;
  else if (cwl > 0.12) s -= 6;
  const rows = plan.strategyAllocations || [];
  const n = rows.length || 1;
  const lowConf = rows.filter((r) => (Number(r.confidence) || 0) < 0.45).length;
  if (lowConf / n > 0.5) s -= 10;
  const ph = Number(policyState?.policyHealthScore);
  if (Number.isFinite(ph)) s += (ph - 70) * 0.35;
  return Math.round(clamp(s, 0, 100));
}

function enrichPlan(plan, policyState, meta = {}) {
  const warnings = [];
  const deploy = Number(plan.portfolio?.recommendedDeployableCapital) || 0;
  const sumStrat = (plan.strategyAllocations || []).reduce(
    (a, r) => a + (Number(r.recommendedCapital) || 0),
    0
  );
  let unusedPct = null;
  if (deploy > 1e-6) {
    unusedPct = round4(Math.max(0, deploy - sumStrat) / deploy);
    if (unusedPct > 0.2) warnings.push('HIGH_UNUSED_DEPLOYABLE_VS_STRATEGY_SLICES');
  }
  if (!(plan.strategyAllocations || []).length) warnings.push('NO_STRATEGY_ALLOCATION_ROWS');
  if (!(plan.symbolAllocations || []).length) warnings.push('NO_SYMBOL_ALLOCATION_ROWS');

  const bindingReadinessScore = computeBindingReadinessScore(plan, policyState);

  return {
    ...plan,
    allocationVersion: ALLOCATION_VERSION,
    cacheHit: !!meta.cacheHit,
    reproducibility: {
      generatedAt: plan.generatedAt,
      policyGeneratedAt: policyState?.generatedAt || null,
      policyVersion: policyState?.policyVersion ?? null,
      sourceLearningGeneratedAt: policyState?.sourceLearningGeneratedAt || null,
      analyticsGeneratedAt: policyState?.analyticsGeneratedAt || null,
      configFingerprint: computeAllocationConfigFingerprint(),
      persistenceMode: meta.persistenceMode || 'standard',
      cacheHit: !!meta.cacheHit,
    },
    diagnostics: {
      ...plan.diagnostics,
      unusedDeployableCapitalPct: unusedPct,
      allocationWarnings: warnings,
    },
    topOverweightRisks: plan.topOverweightRisks || [],
    capitalEfficiencyScore: plan.capitalEfficiencyScore,
    bindingReadinessScore,
  };
}

let _lastPlan = null;
let _lastPersistedSignature = null;

async function loadLatestPolicyState() {
  return policyApplicationService.loadPolicyState();
}

async function loadLatestAllocationPlan() {
  try {
    const raw = await fs.readFile(getAllocationLatestPath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.warn(`[allocation] loadLatestAllocationPlan: ${e.message}`);
    return {};
  }
}

async function saveLatestAllocationPlan(plan) {
  const file = getAllocationLatestPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(plan, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[allocation] saveLatestAllocationPlan: ${e.message}`);
    return false;
  }
}

async function appendAllocationPlanHistory(plan) {
  const file = getAllocationHistoryPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(plan)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn(`[allocation] appendAllocationPlanHistory: ${e.message}`);
    return false;
  }
}

function planPersistenceSignature(plan) {
  const g = plan.generatedAt || '';
  const s0 = plan.strategyAllocations?.[0];
  const h = s0 ? `${s0.strategy}:${s0.weight}` : '';
  return `${g}|${h}|${plan.allocationVersion || ''}`;
}

/**
 * Persist latest + optional history (skip duplicate signature unless forceHistoryAppend).
 */
async function persistAllocationPlan(plan, options = {}) {
  const { cacheHit, forceHistoryAppend } = options;
  if (cacheHit) return { saved: false, reason: 'cache_hit' };
  await saveLatestAllocationPlan(plan);
  const sig = planPersistenceSignature(plan);
  const dup = !forceHistoryAppend && sig === _lastPersistedSignature;
  if (!dup || forceHistoryAppend) {
    await appendAllocationPlanHistory(plan);
    _lastPersistedSignature = sig;
  }
  return { saved: true, historyAppended: !dup || !!forceHistoryAppend };
}

async function readAllocationHistory(limit = 50) {
  const maxRead = parseInt(process.env.ALLOCATION_HISTORY_MAX_READ || '2000', 10);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), maxRead);
  try {
    const text = await fs.readFile(getAllocationHistoryPath(), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < lim; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch (e) {
        /* skip corrupt */
      }
    }
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    return [];
  }
}

async function buildCapitalAllocationPlan(options = {}) {
  const generatedAt = new Date().toISOString();
  const policyState =
    options.policyState || (await policyApplicationService.loadPolicyState());
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
      overview = { portfolio: {}, executionQuality: {} };
    }
  }

  const globalPolicy = policyState.globalPolicy || {
    portfolioRiskMode: 'normal',
    maxGrossExposureMultiplier: 1,
    newEntryThrottle: 1,
    degradedMode: false,
    degradationFlags: [],
    recommendedAction: 'normal',
  };

  const mode = globalPolicy.portfolioRiskMode || 'normal';
  const deployablePct = deployablePctForMode(mode);

  const pf = overview.portfolio || {};
  let baseCapital =
    Number(pf.equity) ||
    Number(pf.bookEquity) ||
    Number(pf.cash) ||
    parseFloat(process.env.ACCOUNT_BALANCE || '500');
  if (!Number.isFinite(baseCapital) || baseCapital <= 0) {
    baseCapital = parseFloat(process.env.ACCOUNT_BALANCE || '500');
  }

  const maxStrat = parseFloat(process.env.POLICY_MAX_STRATEGY_WEIGHT || '0.4');
  let maxSym = parseFloat(process.env.POLICY_MAX_SYMBOL_WEIGHT || '0.5');
  if (mode === 'cautious') {
    const c = parseFloat(process.env.POLICY_CAUTIOUS_MAX_SYMBOL_WEIGHT || '');
    maxSym = Number.isFinite(c) ? c : round4(maxSym * 0.9);
  }

  const minCashPct = parseFloat(process.env.POLICY_MIN_CASH_RESERVE_PCT || '0.3');

  const grossMult = clamp(Number(globalPolicy.maxGrossExposureMultiplier) || 1, 0, 2);
  const entryThr = clamp(Number(globalPolicy.newEntryThrottle) || 1, 0, 2);

  let recommendedDeployable = baseCapital * deployablePct * grossMult * entryThr;
  const minCash = baseCapital * minCashPct;
  let cashReserve = Math.max(minCash, baseCapital - recommendedDeployable);
  if (cashReserve + recommendedDeployable > baseCapital + 1e-6) {
    recommendedDeployable = Math.max(0, baseCapital - cashReserve);
  }

  const entities = Array.isArray(policyState.entities) ? policyState.entities : [];
  const stratEntities = entities.filter((e) => e.entityType === 'strategy');
  const symEntities = entities.filter((e) => e.entityType === 'symbol');

  const eligibleStrat = stratEntities.filter((e) => e.eligible);
  const eligibleSym = symEntities.filter((e) => e.eligible);

  const rawS = computeEntityBaseWeights(eligibleStrat);
  const rawY = computeEntityBaseWeights(eligibleSym);

  const uncappedS = normalizeWeights(rawS);
  const uncappedY = normalizeWeights(rawY);

  const capped = applyRiskCaps(
    { strategies: uncappedS, symbols: uncappedY },
    { maxStrategy: maxStrat, maxSymbol: maxSym }
  );
  const normS = capped.strategies;
  const normY = capped.symbols;

  const strategyAllocations = buildStrategyAllocations(
    normS,
    stratEntities,
    recommendedDeployable
  );
  const symbolAllocations = buildSymbolAllocations(normY, symEntities, recommendedDeployable);

  const portfolio = buildPortfolioAllocationSummary(
    baseCapital,
    recommendedDeployable,
    cashReserve,
    mode,
    globalPolicy
  );

  const uncappedConc = allocationConcentrationScore(uncappedS);
  const postCapConc = allocationConcentrationScore(normS);
  const cwl = cappedWeightLossL1(uncappedS, normS);
  const overW = topOverweightRisks(strategyAllocations, maxStrat);
  const capEff = capitalEfficiencyScore(strategyAllocations, overview.executionQuality);

  const plan = {
    generatedAt,
    portfolio,
    strategyAllocations,
    symbolAllocations,
    diagnostics: {
      normalizationMethod: 'score_confidence_allocation_weighted',
      riskCapsApplied: true,
      degradationFlags: globalPolicy.degradationFlags || [],
      deployablePct: round4(deployablePct),
      maxStrategyWeight: maxStrat,
      maxSymbolWeight: maxSym,
      minCashReservePct: minCashPct,
      uncappedConcentrationScore: uncappedConc,
      postCapConcentrationScore: postCapConc,
      cappedWeightLoss: cwl,
    },
    allocationConcentrationScore: postCapConc,
    topOverweightRisks: overW,
    capitalEfficiencyScore: capEff,
  };

  const enriched = enrichPlan(plan, policyState, {
    cacheHit: false,
    persistenceMode: options.skipAllocationPersistence ? 'shadow_no_persist' : 'standard',
  });

  _lastPlan = enriched;
  return enriched;
}

async function getCapitalAllocationPlan(options = {}) {
  const skipAllocPersist =
    options.skipAllocationPersistence === true ||
    options.skipPersistence === true ||
    String(process.env.ALLOCATION_SKIP_PERSIST_ON_READ || '').toLowerCase() === 'true';
  const cacheMs = parseInt(process.env.ALLOCATION_PLAN_CACHE_MS || '0', 10);
  if (
    cacheMs > 0 &&
    _lastPlan &&
    Date.now() - new Date(_lastPlan.generatedAt).getTime() < cacheMs
  ) {
    const cached = enrichPlan(_lastPlan, await loadLatestPolicyState(), {
      cacheHit: true,
      persistenceMode: 'cache',
    });
    return { ok: true, cached: true, ...cached };
  }
  const plan = await buildCapitalAllocationPlan(options);
  if (!skipAllocPersist) {
    await persistAllocationPlan(plan, {
      cacheHit: false,
      forceHistoryAppend: options.forceHistoryAppend === true,
    });
  }
  return { ok: true, cached: false, ...plan };
}

async function getAllocationOverview() {
  let plan = await loadLatestAllocationPlan();
  if (!plan || !plan.generatedAt) {
    plan = await buildCapitalAllocationPlan({ skipAllocationPersistence: true });
  }
  const policyState = await loadLatestPolicyState();
  const full = plan.allocationVersion ? plan : enrichPlan(plan, policyState, {});
  return {
    ok: true,
    generatedAt: full.generatedAt,
    allocationVersion: full.allocationVersion || ALLOCATION_VERSION,
    portfolioRiskMode: full.portfolio?.portfolioRiskMode,
    deployableCapitalPct: full.diagnostics?.deployablePct,
    minCashReservePct: full.diagnostics?.minCashReservePct,
    uncappedConcentrationScore: full.diagnostics?.uncappedConcentrationScore,
    postCapConcentrationScore: full.diagnostics?.postCapConcentrationScore,
    topStrategyWeights: (full.strategyAllocations || []).slice(0, 8),
    topSymbolWeights: (full.symbolAllocations || []).slice(0, 8),
    allocationWarnings: full.diagnostics?.allocationWarnings || [],
    bindingReadinessScore: full.bindingReadinessScore,
    capitalEfficiencyScore: full.capitalEfficiencyScore,
  };
}

module.exports = {
  ALLOCATION_VERSION,
  buildCapitalAllocationPlan,
  loadLatestPolicyState,
  loadLatestAllocationPlan,
  saveLatestAllocationPlan,
  appendAllocationPlanHistory,
  persistAllocationPlan,
  readAllocationHistory,
  computeEntityBaseWeights,
  normalizeWeights,
  applyRiskCaps,
  buildStrategyAllocations,
  buildSymbolAllocations,
  buildPortfolioAllocationSummary,
  getCapitalAllocationPlan,
  getAllocationOverview,
  computeAllocationConfigFingerprint,
};
