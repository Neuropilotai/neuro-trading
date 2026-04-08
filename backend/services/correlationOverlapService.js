'use strict';

/**
 * Correlation / overlap / crowding intelligence (advisory, governance).
 * Heuristic portfolio overlap — not live execution binding.
 */

const fs = require('fs').promises;
const path = require('path');
const closedTradeAnalyticsService = require('./closedTradeAnalyticsService');
const reinforcementLearningService = require('./reinforcementLearningService');

const CORRELATION_OVERLAP_VERSION = 1;

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getOverlapLatestPath() {
  return path.join(getDataDir(), 'correlation_overlap_latest.json');
}

function getOverlapHistoryPath() {
  return path.join(getDataDir(), 'correlation_overlap_history.jsonl');
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function parseOverlapEnv() {
  return {
    wSymbol: parseFloat(process.env.OVERLAP_SHARED_SYMBOL_WEIGHT || '0.35'),
    wStrategy: parseFloat(process.env.OVERLAP_SHARED_STRATEGY_WEIGHT || '0.3'),
    wRegime: parseFloat(process.env.OVERLAP_SHARED_REGIME_WEIGHT || '0.15'),
    wHour: parseFloat(process.env.OVERLAP_SHARED_HOUR_WEIGHT || '0.08'),
    wDecision: parseFloat(process.env.OVERLAP_SHARED_DECISION_WEIGHT || '0.12'),
    wRealizedCorr: parseFloat(process.env.OVERLAP_REALIZED_CORRELATION_WEIGHT || '0.2'),
    corrMinObs: parseInt(process.env.CORR_MIN_OBSERVATIONS || '8', 10),
    corrMinShared: parseInt(process.env.CORR_MIN_SHARED_OBSERVATIONS || '5', 10),
    crowdingWarn: parseFloat(process.env.CROWDING_WARN_THRESHOLD || '0.35'),
    crowdingHigh: parseFloat(process.env.CROWDING_HIGH_THRESHOLD || '0.55'),
    crowdingSevere: parseFloat(process.env.CROWDING_SEVERE_THRESHOLD || '0.72'),
    policyCrowdingWarn: parseFloat(process.env.POLICY_CROWDING_WARN || '0.35'),
    policyCrowdingHigh: parseFloat(process.env.POLICY_CROWDING_HIGH || '0.55'),
    policyCrowdingSevere: parseFloat(process.env.POLICY_CROWDING_SEVERE || '0.72'),
    overlapPenaltyMax: parseFloat(process.env.POLICY_OVERLAP_PENALTY_MAX || '0.45'),
    dupEdgePenaltyMax: parseFloat(process.env.POLICY_DUPLICATE_EDGE_PENALTY_MAX || '0.35'),
    maxClusterWeight: parseFloat(process.env.ALLOCATION_MAX_CLUSTER_WEIGHT || '0.38'),
    maxDupEdgeWeight: parseFloat(process.env.ALLOCATION_MAX_DUPLICATE_EDGE_WEIGHT || '0.32'),
  };
}

function computeEnvFingerprint() {
  const E = parseOverlapEnv();
  return [
    `wS=${E.wSymbol}`,
    `wSt=${E.wStrategy}`,
    `wR=${E.wRegime}`,
    `wH=${E.wHour}`,
    `wD=${E.wDecision}`,
    `wC=${E.wRealizedCorr}`,
    `cmin=${E.corrMinObs}`,
    `cs=${E.corrMinShared}`,
    `cwd=${E.crowdingWarn}`,
    `ch=${E.crowdingHigh}`,
    `csv=${E.crowdingSevere}`,
  ].join(';');
}

function rowKey(r) {
  return `${r.entityType}|${r.entityKey}`;
}

/** @param {object} policyState */
function buildExposureRowsFromPolicy(policyState) {
  const entities = Array.isArray(policyState?.entities) ? policyState.entities : [];
  const rows = [];
  for (const e of entities) {
    const et = String(e.entityType || '');
    const ek = String(e.entityKey || '');
    if (!et || !ek) continue;
    let strategy = null;
    let symbol = null;
    let regime = null;
    let hourUTC = null;
    if (et === 'strategy') strategy = ek;
    else if (et === 'symbol') symbol = ek.toUpperCase();
    else if (et === 'regime') regime = ek;
    else if (et === 'hourUTC') hourUTC = ek;
    else if (et === 'strategy+regime') {
      const p = ek.split('|');
      strategy = p[0] || null;
      regime = p[1] || null;
    } else if (et === 'symbol+hourUTC') {
      const p = ek.split('|');
      symbol = (p[0] || '').toUpperCase() || null;
      hourUTC = p[1] || null;
    }
    rows.push({
      entityType: et,
      entityKey: et === 'symbol' ? ek.toUpperCase() : ek,
      strategy,
      symbol,
      regime,
      hourUTC,
      decision: String(e.decision || 'keep'),
      confidence: Number(e.confidence) || 0,
      allocationMultiplier: Number(e.allocationMultiplier) || 1,
      policyEligible: e.eligible !== false,
      policyRiskLevel: e.policyRiskLevel || null,
      recommendedWeight: null,
      realizedPnL: null,
      tradeCount: Number(e.effectiveSampleSize) || 0,
      winRate: null,
      avgHoldingMinutes: null,
      sourceKeys: ['policy'],
      metadata: { fromPolicy: true },
    });
  }
  return rows;
}

/** @param {object} allocationPlan */
function buildExposureRowsFromAllocation(allocationPlan) {
  const rows = [];
  const deploy = Number(allocationPlan?.portfolio?.recommendedDeployableCapital) || 0;
  for (const r of allocationPlan?.strategyAllocations || []) {
    const k = String(r.strategy || '');
    if (!k) continue;
    const w = Number(r.weight) || 0;
    rows.push({
      entityType: 'strategy',
      entityKey: k,
      strategy: k,
      symbol: null,
      regime: null,
      hourUTC: null,
      decision: String(r.decision || 'keep'),
      confidence: Number(r.confidence) || 0,
      allocationMultiplier: Number(r.allocationMultiplier) || 1,
      policyEligible: r.eligible !== false,
      policyRiskLevel: null,
      recommendedWeight: round4(w),
      realizedPnL: null,
      tradeCount: 0,
      winRate: null,
      avgHoldingMinutes: null,
      sourceKeys: ['allocation'],
      metadata: { deployableCapital: deploy },
    });
  }
  for (const r of allocationPlan?.symbolAllocations || []) {
    const k = String(r.symbol || '').toUpperCase();
    if (!k) continue;
    const w = Number(r.weight) || 0;
    rows.push({
      entityType: 'symbol',
      entityKey: k,
      strategy: null,
      symbol: k,
      regime: null,
      hourUTC: null,
      decision: String(r.decision || 'keep'),
      confidence: Number(r.confidence) || 0,
      allocationMultiplier: 1,
      policyEligible: r.eligible !== false,
      policyRiskLevel: null,
      recommendedWeight: round4(w),
      realizedPnL: null,
      tradeCount: 0,
      winRate: null,
      avgHoldingMinutes: null,
      sourceKeys: ['allocation'],
      metadata: {},
    });
  }
  return rows;
}

/** @param {object[]} closedTrades */
function buildExposureRowsFromClosedTrades(closedTrades, options = {}) {
  void options;
  const trades = Array.isArray(closedTrades) ? closedTrades : [];
  const byStrat = new Map();
  const bySym = new Map();
  const byPair = new Map();
  const byReg = new Map();
  const byRegSym = new Map();

  function bump(map, key, extra, pnl, won, holdMin) {
    if (!key) return;
    const cur = map.get(key) || {
      tradeCount: 0,
      realizedPnL: 0,
      wins: 0,
      holdSum: 0,
      ...extra,
    };
    cur.tradeCount += 1;
    cur.realizedPnL += pnl;
    cur.wins += won;
    cur.holdSum += holdMin;
    map.set(key, cur);
  }

  for (const t of trades) {
    const sym = String(t.symbol || '').toUpperCase();
    const strat = t.strategy != null ? String(t.strategy) : null;
    const reg = t.regime != null ? String(t.regime) : 'unknown';
    const pnl = Number(t.realizedPnL) || 0;
    const won = pnl > 0 ? 1 : 0;
    const holdMin = Number(t.holdingTimeMin) || 0;

    bump(bySym, sym, { symbol: sym }, pnl, won, holdMin);
    if (strat) bump(byStrat, strat, { strategy: strat }, pnl, won, holdMin);
    if (strat && sym) bump(byPair, `${strat}|${sym}`, { strategy: strat, symbol: sym }, pnl, won, holdMin);
    bump(byReg, reg, { regime: reg }, pnl, won, holdMin);
    bump(byRegSym, `${reg}|${sym}`, { regime: reg, symbol: sym }, pnl, won, holdMin);
  }

  const rows = [];
  function emit(map, entityType, keyField) {
    for (const [k, v] of map) {
      const wr = v.tradeCount > 0 ? v.wins / v.tradeCount : 0;
      rows.push({
        entityType,
        entityKey: k,
        strategy: v.strategy || (entityType === 'strategy' ? k : null),
        symbol: v.symbol || (entityType === 'symbol' ? k : null),
        regime: v.regime || null,
        hourUTC: null,
        decision: 'keep',
        confidence: 0.5,
        allocationMultiplier: 1,
        policyEligible: true,
        policyRiskLevel: null,
        recommendedWeight: null,
        realizedPnL: round4(v.realizedPnL),
        tradeCount: v.tradeCount,
        winRate: round4(wr),
        avgHoldingMinutes: v.tradeCount > 0 ? round4(v.holdSum / v.tradeCount) : 0,
        sourceKeys: ['closed_trades'],
        metadata: { keyField },
      });
    }
  }
  emit(byStrat, 'strategy', 'strategy');
  emit(bySym, 'symbol', 'symbol');
  for (const [k, v] of byPair) {
    const wr = v.tradeCount > 0 ? v.wins / v.tradeCount : 0;
    rows.push({
      entityType: 'strategy+symbol',
      entityKey: k,
      strategy: v.strategy,
      symbol: v.symbol,
      regime: null,
      hourUTC: null,
      decision: 'keep',
      confidence: 0.5,
      allocationMultiplier: 1,
      policyEligible: true,
      policyRiskLevel: null,
      recommendedWeight: null,
      realizedPnL: round4(v.realizedPnL),
      tradeCount: v.tradeCount,
      winRate: round4(wr),
      avgHoldingMinutes: v.tradeCount > 0 ? round4(v.holdSum / v.tradeCount) : 0,
      sourceKeys: ['closed_trades'],
      metadata: {},
    });
  }
  emit(byReg, 'regime', 'regime');
  for (const [k, v] of byRegSym) {
    const wr = v.tradeCount > 0 ? v.wins / v.tradeCount : 0;
    rows.push({
      entityType: 'regime+symbol',
      entityKey: k,
      strategy: null,
      symbol: v.symbol,
      regime: v.regime,
      hourUTC: null,
      decision: 'keep',
      confidence: 0.5,
      allocationMultiplier: 1,
      policyEligible: true,
      policyRiskLevel: null,
      recommendedWeight: null,
      realizedPnL: round4(v.realizedPnL),
      tradeCount: v.tradeCount,
      winRate: round4(wr),
      avgHoldingMinutes: v.tradeCount > 0 ? round4(v.holdSum / v.tradeCount) : 0,
      sourceKeys: ['closed_trades'],
      metadata: {},
    });
  }

  return rows;
}

function mergeSources(a, b) {
  const s = new Set([...(a || []), ...(b || [])]);
  return [...s].sort();
}

/** Merge rows by entityType|entityKey */
function mergeExposureRows(...rowArrays) {
  const map = new Map();
  for (const arr of rowArrays) {
    for (const r of arr || []) {
      const k = rowKey(r);
      if (!k || k === '|') continue;
      const cur = map.get(k);
      if (!cur) {
        map.set(k, { ...r, sourceKeys: [...(r.sourceKeys || [])] });
      } else {
        cur.strategy = cur.strategy || r.strategy;
        cur.symbol = cur.symbol || r.symbol;
        cur.regime = cur.regime || r.regime;
        cur.hourUTC = cur.hourUTC || r.hourUTC;
        cur.confidence = Math.max(Number(cur.confidence) || 0, Number(r.confidence) || 0);
        cur.allocationMultiplier =
          Number(r.allocationMultiplier) != null && Number(r.allocationMultiplier) !== 1
            ? Number(r.allocationMultiplier)
            : cur.allocationMultiplier;
        cur.policyEligible = cur.policyEligible && r.policyEligible !== false;
        cur.recommendedWeight =
          r.recommendedWeight != null ? r.recommendedWeight : cur.recommendedWeight;
        cur.tradeCount = Math.max(cur.tradeCount || 0, r.tradeCount || 0);
        if (r.realizedPnL != null)
          cur.realizedPnL = (Number(cur.realizedPnL) || 0) + (Number(r.realizedPnL) || 0);
        if (r.winRate != null) cur.winRate = r.winRate;
        if (r.avgHoldingMinutes != null) cur.avgHoldingMinutes = r.avgHoldingMinutes;
        cur.decision = r.decision && r.decision !== 'keep' ? r.decision : cur.decision;
        cur.sourceKeys = mergeSources(cur.sourceKeys, r.sourceKeys);
      }
    }
  }
  return [...map.values()];
}

function decisionClass(d) {
  const x = String(d || 'keep').toLowerCase();
  if (x === 'promote') return 1;
  if (x === 'throttle' || x === 'demote') return 2;
  if (x === 'suspend') return 3;
  return 0;
}

function decisionClassSimilarity(a, b) {
  return decisionClass(a) === decisionClass(b) ? 1 : Math.abs(decisionClass(a) - decisionClass(b)) === 1 ? 0.5 : 0.2;
}

function rowSymbolForCorr(r) {
  if (!r) return null;
  if (r.entityType === 'symbol') return String(r.entityKey || '').toUpperCase() || null;
  if (r.symbol) return String(r.symbol).toUpperCase();
  return null;
}

function computePairwiseOverlapMatrix(rows, correlationHints = {}, corrPack = null) {
  const E = parseOverlapEnv();
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map();
  for (const r of list) {
    const k = rowKey(r);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  const keys = [...byKey.keys()].sort();
  const pairs = [];
  const wSum = Math.max(
    E.wSymbol + E.wStrategy + E.wRegime + E.wHour + E.wDecision + E.wRealizedCorr,
    1e-9
  );

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = byKey.get(keys[i]);
      const b = byKey.get(keys[j]);
      const reasons = [];
      let s = 0;
      const comp = { symbol: 0, strategy: 0, regime: 0, hourUTC: 0, decisionClass: 0, realizedCorrelation: 0 };

      if (a.symbol && b.symbol && a.symbol === b.symbol) {
        comp.symbol = 1;
        s += E.wSymbol;
        reasons.push('shared_symbol');
      }
      if (a.strategy && b.strategy && a.strategy === b.strategy) {
        comp.strategy = 1;
        s += E.wStrategy;
        reasons.push('shared_strategy');
      }
      if (a.regime && b.regime && a.regime === b.regime) {
        comp.regime = 1;
        s += E.wRegime;
        reasons.push('shared_regime');
      }
      if (a.hourUTC != null && b.hourUTC != null && a.hourUTC === b.hourUTC) {
        comp.hourUTC = 1;
        s += E.wHour;
        reasons.push('shared_hourUTC');
      }
      const dc = decisionClassSimilarity(a.decision, b.decision);
      comp.decisionClass = round4(dc);
      s += E.wDecision * dc;
      if (dc > 0.4) reasons.push('similar_policy_decision_class');

      const pk = `${keys[i]}||${keys[j]}`;
      let corrAbs = null;
      if (correlationHints[pk] != null && Number.isFinite(correlationHints[pk])) {
        corrAbs = Math.abs(correlationHints[pk]);
      } else if (corrPack && corrPack.pairs) {
        const sa = rowSymbolForCorr(a);
        const sb = rowSymbolForCorr(b);
        if (sa && sb) {
          const kk = sa < sb ? `${sa}||${sb}` : `${sb}||${sa}`;
          const ent = corrPack.pairs[kk];
          if (ent && ent.correlation != null && Number.isFinite(ent.correlation)) {
            corrAbs = Math.abs(ent.correlation);
          }
        }
      }
      if (corrAbs != null) {
        comp.realizedCorrelation = round4(corrAbs);
        s += E.wRealizedCorr * corrAbs;
        reasons.push('realized_correlation_evidence');
      }

      const overlapScore = round4(clamp(s / wSum, 0, 1));
      pairs.push({
        pairKeyA: keys[i],
        pairKeyB: keys[j],
        overlapScore,
        components: comp,
        reasons,
      });
    }
  }
  pairs.sort((x, y) => y.overlapScore - x.overlapScore);
  return { pairs, keys };
}

function computeClusterOverlap(rows, kind) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  for (const r of list) {
    let k = null;
    if (kind === 'symbol' && r.symbol) k = r.symbol;
    else if (kind === 'strategy' && r.strategy) k = r.strategy;
    else if (kind === 'strategy+symbol' && r.strategy && r.symbol) k = `${r.strategy}|${r.symbol}`;
    else if (kind === 'regime' && r.regime) k = r.regime;
    else if (kind === 'regime+symbol' && r.regime && r.symbol) k = `${r.regime}|${r.symbol}`;
    if (!k) continue;
    const g = groups.get(k) || [];
    g.push(r);
    groups.set(k, g);
  }

  const clusters = [];
  for (const [clusterKey, members] of groups) {
    if (members.length < 2) continue;
    const weights = members.map((m) => Math.max(0, Number(m.recommendedWeight) || 0.05));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const confs = members.map((m) => Number(m.confidence) || 0);
    const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    const decisions = {};
    for (const m of members) {
      const d = String(m.decision || 'keep');
      decisions[d] = (decisions[d] || 0) + 1;
    }
    const pnl = members.map((m) => Number(m.realizedPnL) || 0);
    const realizedSummary = {
      aggregatePnL: round4(pnl.reduce((a, b) => a + b, 0)),
      memberWithTrades: members.filter((m) => (m.tradeCount || 0) > 0).length,
    };
    const overlapScore = round4(clamp(members.length / Math.max(list.length, 1), 0, 1));
    const crowdingContribution = round4(totalWeight * overlapScore);
    clusters.push({
      clusterKind: kind,
      clusterKey,
      memberCount: members.length,
      totalWeight: round4(totalWeight),
      avgConfidence: round4(avgConf),
      concentrationContribution: round4(totalWeight / (weights.length || 1)),
      decisionMix: decisions,
      realizedPerformanceSummary: realizedSummary,
      overlapScore,
      crowdingContribution,
      memberKeys: members.map(rowKey).slice(0, 20),
    });
  }
  clusters.sort((a, b) => b.crowdingContribution - a.crowdingContribution);
  return clusters;
}

function computeStrategySymbolOverlap(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const stratToSyms = new Map();
  const symToStrats = new Map();
  const stratRegime = new Map();
  for (const r of list) {
    if (r.strategy && r.symbol) {
      const s = stratToSyms.get(r.strategy) || new Set();
      s.add(r.symbol);
      stratToSyms.set(r.strategy, s);
      const t = symToStrats.get(r.symbol) || new Set();
      t.add(r.strategy);
      symToStrats.set(r.symbol, t);
    }
    if (r.strategy && r.regime) {
      const s = stratRegime.get(r.strategy) || new Set();
      s.add(r.regime);
      stratRegime.set(r.strategy, s);
    }
  }
  let sameStrategyMultiSymbol = 0;
  for (const [, syms] of stratToSyms) {
    if (syms.size > 1) sameStrategyMultiSymbol++;
  }
  let sameSymbolMultiStrategy = 0;
  for (const [, st] of symToStrats) {
    if (st.size > 1) sameSymbolMultiStrategy++;
  }
  let sameStrategySameRegime = 0;
  for (const [, regs] of stratRegime) {
    if (regs.size > 1) sameStrategySameRegime++;
  }
  const duplicateExpressionEstimate = sameStrategyMultiSymbol + sameSymbolMultiStrategy;
  return {
    sameStrategyMultiSymbolOverlap: sameStrategyMultiSymbol,
    sameSymbolMultiStrategyOverlap: sameSymbolMultiStrategy,
    sameStrategySameRegimeOverlap: sameStrategySameRegime,
    repeatedEdgeClusters: duplicateExpressionEstimate,
    duplicateExpressionCount: duplicateExpressionEstimate,
  };
}

function computePortfolioCrowding(rows, clustersByKind, pairwise) {
  const E = parseOverlapEnv();
  const symClusters = clustersByKind.symbol || [];
  const stratClusters = clustersByKind.strategy || [];
  const regClusters = clustersByKind.regime || [];
  const topPairs = (pairwise?.pairs || []).slice(0, 15);

  const symScore = round4(
    symClusters.reduce((s, c) => s + c.crowdingContribution, 0) / Math.max(symClusters.length, 1) || 0
  );
  const stratScore = round4(
    stratClusters.reduce((s, c) => s + c.crowdingContribution, 0) / Math.max(stratClusters.length, 1) || 0
  );
  const regScore = round4(
    regClusters.reduce((s, c) => s + c.crowdingContribution, 0) / Math.max(regClusters.length, 1) || 0
  );

  const ov = computeStrategySymbolOverlap(rows);
  const duplicateEdgeScore = round4(clamp(ov.duplicateExpressionCount / 8, 0, 1));
  const distinctClusters =
    symClusters.length + stratClusters.length + (clustersByKind['strategy+symbol'] || []).length;
  const distinctEntities = new Set(rows.map(rowKey)).size;
  const falseDiv = distinctEntities > 0 ? round4(clamp(1 - distinctClusters / distinctEntities, 0, 1)) : 0;

  const totalCrowdingScore = round4(
    clamp(
      symScore * 0.35 + stratScore * 0.35 + regScore * 0.15 + duplicateEdgeScore * 0.15 + falseDiv * 0.1,
      0,
      1
    )
  );

  const concentratedSymbols = symClusters.slice(0, 8).map((c) => ({
    key: c.clusterKey,
    score: c.overlapScore,
  }));
  const concentratedStrategies = stratClusters.slice(0, 8).map((c) => ({
    key: c.clusterKey,
    score: c.overlapScore,
  }));
  const crowdedRegimes = regClusters.slice(0, 6).map((c) => ({
    key: c.clusterKey,
    score: c.overlapScore,
  }));

  return {
    totalCrowdingScore,
    symbolCrowdingScore: symScore,
    strategyCrowdingScore: stratScore,
    regimeCrowdingScore: regScore,
    duplicateEdgeScore,
    falseDiversificationScore: falseDiv,
    topCrowdedClusters: [
      ...symClusters.slice(0, 5),
      ...stratClusters.slice(0, 5),
    ].slice(0, 10),
    topPairwiseOverlaps: topPairs.slice(0, 10),
    concentratedSymbols,
    concentratedStrategies,
    crowdedRegimes,
  };
}

/** Daily realized return series per symbol for correlation */
function computeRealizedCorrelationFromClosedTrades(closedTrades, options = {}) {
  const E = parseOverlapEnv();
  const trades = Array.isArray(closedTrades) ? closedTrades : [];
  const bySymDay = new Map();
  for (const t of trades) {
    const sym = String(t.symbol || '').toUpperCase();
    if (!sym) continue;
    const day = t.exitTimestamp ? String(t.exitTimestamp).slice(0, 10) : null;
    if (!day) continue;
    const ret =
      Number.isFinite(Number(t.realizedPnLPercent))
        ? Number(t.realizedPnLPercent) / 100
        : null;
    if (ret == null || !Number.isFinite(ret)) continue;
    const key = `${sym}|${day}`;
    bySymDay.set(key, (bySymDay.get(key) || 0) + ret);
  }
  const symDays = new Map();
  for (const [k, v] of bySymDay) {
    const [sym, day] = k.split('|');
    if (!symDays.has(sym)) symDays.set(sym, new Map());
    symDays.get(sym).set(day, v);
  }
  const syms = [...symDays.keys()].sort();
  const out = {};
  const hints = {};
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const A = syms[i];
      const B = syms[j];
      const daysA = symDays.get(A);
      const daysB = symDays.get(B);
      const shared = [...daysA.keys()].filter((d) => daysB.has(d));
      if (shared.length < E.corrMinShared) {
        out[`${A}||${B}`] = { correlation: null, reason: 'insufficient_shared_days' };
        continue;
      }
      const xs = [];
      const ys = [];
      for (const d of shared) {
        xs.push(daysA.get(d));
        ys.push(daysB.get(d));
      }
      if (xs.length < E.corrMinObs) {
        out[`${A}||${B}`] = { correlation: null, reason: 'insufficient_observations' };
        continue;
      }
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0;
      let dxa = 0;
      let dyb = 0;
      for (let k = 0; k < xs.length; k++) {
        const dx = xs[k] - mx;
        const dy = ys[k] - my;
        num += dx * dy;
        dxa += dx * dx;
        dyb += dy * dy;
      }
      const den = Math.sqrt(dxa * dyb);
      const r = den > 1e-12 ? num / den : null;
      const correlation = r != null && Number.isFinite(r) ? round4(clamp(r, -1, 1)) : null;
      out[`${A}||${B}`] = { correlation, sampleDays: xs.length };
      const pk = `symbol|${A}|symbol|${B}`;
      if (correlation != null) hints[pk] = Math.abs(correlation);
    }
  }
  return { pairs: out, matrixHints: hints };
}

async function loadLatestCorrelationOverlapState() {
  try {
    const raw = await fs.readFile(getOverlapLatestPath(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    return {};
  }
}

async function saveLatestCorrelationOverlapState(state) {
  const file = getOverlapLatestPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn(`[overlap] save latest failed: ${e.message}`);
    return false;
  }
}

async function appendCorrelationOverlapHistory(state) {
  const file = getOverlapHistoryPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(state)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.warn(`[overlap] append history failed: ${e.message}`);
    return false;
  }
}

async function readCorrelationOverlapHistory(limit = 50) {
  const maxRead = parseInt(process.env.CORRELATION_OVERLAP_HISTORY_MAX_READ || '2000', 10);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), maxRead);
  try {
    const text = await fs.readFile(getOverlapHistoryPath(), 'utf8');
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

async function buildCorrelationOverlapState(options = {}) {
  const generatedAt = new Date().toISOString();
  const E = parseOverlapEnv();
  const policyState = options.policyState && typeof options.policyState === 'object' ? options.policyState : {};
  const allocationPlan =
    options.allocationPlan && typeof options.allocationPlan === 'object' ? options.allocationPlan : {};

  let closedTrades = options.closedTrades;
  if (!Array.isArray(closedTrades)) {
    try {
      closedTrades = await closedTradeAnalyticsService.listClosedTrades({
        limit: options.closedTradeLimit || 2000,
      });
    } catch (e) {
      closedTrades = [];
    }
  }

  let learningState = options.learningState;
  if (!learningState) {
    try {
      learningState = await reinforcementLearningService.loadLearningState();
    } catch (e) {
      learningState = {};
    }
  }

  const rPolicy = buildExposureRowsFromPolicy(policyState);
  const rAlloc = buildExposureRowsFromAllocation(allocationPlan);
  const rTrades = buildExposureRowsFromClosedTrades(closedTrades, options);
  const exposures = mergeExposureRows(rPolicy, rAlloc, rTrades);

  const corrPack = computeRealizedCorrelationFromClosedTrades(closedTrades, options);
  const pairwiseMatrix = computePairwiseOverlapMatrix(exposures, {}, corrPack);

  const clusters = {
    symbol: computeClusterOverlap(exposures, 'symbol'),
    strategy: computeClusterOverlap(exposures, 'strategy'),
    'strategy+symbol': computeClusterOverlap(exposures, 'strategy+symbol'),
    regime: computeClusterOverlap(exposures, 'regime'),
    'regime+symbol': computeClusterOverlap(exposures, 'regime+symbol'),
  };

  const overlapDiagnostics = computeStrategySymbolOverlap(exposures);
  const crowdingDiagnostics = computePortfolioCrowding(exposures, clusters, pairwiseMatrix);

  const warnings = [];
  if (!exposures.length) warnings.push('NO_EXPOSURE_ROWS');
  if (crowdingDiagnostics.totalCrowdingScore >= E.crowdingWarn)
    warnings.push('ELEVATED_PORTFOLIO_CROWDING');
  if (overlapDiagnostics.duplicateExpressionCount >= 3) warnings.push('DUPLICATE_EDGE_EXPRESSIONS');
  if (crowdingDiagnostics.falseDiversificationScore >= 0.45) warnings.push('FALSE_DIVERSIFICATION_RISK');

  const summary = {
    exposureRowCount: exposures.length,
    pairwisePairCount: pairwiseMatrix.pairs.length,
    clusterCounts: {
      symbol: clusters.symbol.length,
      strategy: clusters.strategy.length,
      strategySymbol: clusters['strategy+symbol'].length,
    },
    totalCrowdingScore: crowdingDiagnostics.totalCrowdingScore,
    duplicateEdgeScore: crowdingDiagnostics.duplicateEdgeScore,
    falseDiversificationScore: crowdingDiagnostics.falseDiversificationScore,
    correlationPairsComputed: Object.values(corrPack.pairs).filter((x) => x.correlation != null).length,
  };

  return {
    correlationOverlapVersion: CORRELATION_OVERLAP_VERSION,
    generatedAt,
    sourceLearningGeneratedAt: learningState?.generatedAt || null,
    sourcePolicyGeneratedAt: policyState?.generatedAt || null,
    sourceAllocationGeneratedAt: allocationPlan?.generatedAt || null,
    envFingerprint: computeEnvFingerprint(),
    summary,
    matrices: {
      pairwiseTop: pairwiseMatrix.pairs.slice(0, 80),
      entityKeys: pairwiseMatrix.keys,
    },
    exposures: exposures.slice(0, 200),
    overlapDiagnostics,
    crowdingDiagnostics,
    clusters,
    realizedCorrelationDiagnostics: {
      pairResults: Object.keys(corrPack.pairs).length,
      insufficientDataRate:
        Object.values(corrPack.pairs).filter((x) => x.correlation == null).length /
        Math.max(Object.keys(corrPack.pairs).length, 1),
    },
    warnings,
  };
}

async function runCorrelationOverlapCycle(options = {}) {
  console.log('[overlap] build start');
  const state = await buildCorrelationOverlapState(options);
  await saveLatestCorrelationOverlapState(state);
  await appendCorrelationOverlapHistory(state);
  if ((state.warnings || []).length) {
    console.log(`[overlap] warnings: ${state.warnings.join(', ')}`);
  }
  console.log('[overlap] build end');
  return state;
}

function crowdingRiskLevelFromScore(score, env = parseOverlapEnv()) {
  const s = Number(score) || 0;
  if (s >= env.policyCrowdingSevere) return 'severe';
  if (s >= env.policyCrowdingHigh) return 'high';
  if (s >= env.policyCrowdingWarn) return 'medium';
  return 'low';
}

/**
 * Per-entity crowding from clusters + pairwise max involving this entity.
 */
function buildEntityCrowdingIndex(overlapState) {
  const idx = new Map();
  const pairs = overlapState?.matrices?.pairwiseTop || [];
  for (const p of pairs) {
    for (const k of [p.pairKeyA, p.pairKeyB]) {
      const cur = idx.get(k) || { overlapScore: 0, crowdingScore: 0, reasons: [] };
      cur.overlapScore = Math.max(cur.overlapScore, p.overlapScore);
      if (p.overlapScore >= 0.35) cur.reasons.push(`pair_overlap=${p.pairKeyA}<->${p.pairKeyB}`);
      idx.set(k, cur);
    }
  }
  for (const c of overlapState?.crowdingDiagnostics?.topCrowdedClusters || []) {
    for (const mk of c.memberKeys || []) {
      const cur = idx.get(mk) || { overlapScore: 0, crowdingScore: 0, reasons: [] };
      cur.crowdingScore = Math.max(cur.crowdingScore, c.crowdingContribution || c.overlapScore || 0);
      cur.reasons.push(`cluster:${c.clusterKind}:${c.clusterKey}`);
      idx.set(mk, cur);
    }
  }
  const total = Number(overlapState?.crowdingDiagnostics?.totalCrowdingScore) || 0;
  for (const [k, v] of idx) {
    v.crowdingScore = round4(Math.max(v.crowdingScore, v.overlapScore * total));
    v.reasons = [...new Set(v.reasons)].slice(0, 8);
  }
  return idx;
}

function applyPolicyCrowdingPenalties(policyState, overlapState) {
  const E = parseOverlapEnv();
  const entities = Array.isArray(policyState?.entities) ? policyState.entities : [];
  if (!entities.length || !overlapState?.summary) {
    return {
      entities: entities.map((e) => ({
        ...e,
        crowdingScore: 0,
        overlapScore: 0,
        crowdingRiskLevel: 'low',
        overlapPenaltyMultiplier: 1,
        falseDiversificationPenalty: 0,
        duplicateEdgePenalty: 0,
        crowdedClusterPenalty: 0,
        concentrationPenaltyReasons: [],
        crowdingReasons: [],
      })),
      globalPolicyCrowding: {
        crowdingMode: 'normal',
        maxCrowdingTolerance: 1,
        crowdingFlags: [],
        recommendedCrowdingAction: 'normal',
      },
    };
  }

  const idx = buildEntityCrowdingIndex(overlapState);
  const dup = Number(overlapState.overlapDiagnostics?.duplicateExpressionCount) || 0;
  const falseDiv = Number(overlapState.crowdingDiagnostics?.falseDiversificationScore) || 0;
  const totalCrowd = Number(overlapState.crowdingDiagnostics?.totalCrowdingScore) || 0;

  const crowdingFlags = [...(overlapState.warnings || [])];
  let crowdingMode = 'normal';
  let recommendedCrowdingAction = 'normal';
  if (totalCrowd >= E.policyCrowdingSevere) {
    crowdingMode = 'severe';
    recommendedCrowdingAction = 'defensive_crowding_mode';
    crowdingFlags.push('SEVERE_CROWDING');
  } else if (totalCrowd >= E.policyCrowdingHigh) {
    crowdingMode = 'elevated';
    recommendedCrowdingAction = 'cap_symbol_clusters';
    crowdingFlags.push('HIGH_CROWDING');
  } else if (totalCrowd >= E.policyCrowdingWarn) {
    crowdingMode = 'watch';
    recommendedCrowdingAction = 'reduce_duplicate_expressions';
    crowdingFlags.push('CROWDING_WATCH');
  }
  if (dup >= 4) {
    recommendedCrowdingAction = 'reduce_duplicate_expressions';
    crowdingFlags.push('DUPLICATE_EDGE');
  }
  if (falseDiv >= 0.5) {
    crowdingFlags.push('FALSE_DIVERSIFICATION');
    if (recommendedCrowdingAction === 'normal') recommendedCrowdingAction = 'throttle_new_entries';
  }

  const outEntities = entities.map((e) => {
    const k = `${e.entityType}|${e.entityKey}`;
    const occ = idx.get(k) || { overlapScore: 0, crowdingScore: 0, reasons: [] };
    const overlapScore = round4(occ.overlapScore);
    const crowdingScore = round4(occ.crowdingScore);
    const crowdingRisk = crowdingRiskLevelFromScore(Math.max(overlapScore, crowdingScore, totalCrowd * 0.6));

    const dupPen = round4(clamp((dup / 10) * E.dupEdgePenaltyMax, 0, E.dupEdgePenaltyMax));
    const falsePen = round4(clamp(falseDiv * E.overlapPenaltyMax * 0.5, 0, E.overlapPenaltyMax));
    const clusterPen = round4(
      clamp(crowdingScore * E.overlapPenaltyMax, 0, E.overlapPenaltyMax)
    );
    let overlapPenaltyMultiplier = round4(
      clamp(1 - Math.min(E.overlapPenaltyMax, clusterPen + falsePen * 0.5 + dupPen * 0.3), 0.2, 1)
    );

    let decision = e.decision;
    let allocationMultiplier = Number(e.allocationMultiplier) || 1;
    let maxExposureMultiplier = Number(e.maxExposureMultiplier) || 1;
    let throttleFactor = Number(e.throttleFactor) || 1;
    const crowdingReasons = [...occ.reasons];

    if (decision === 'suspend') {
      return {
        ...e,
        crowdingScore,
        overlapScore,
        crowdingRiskLevel: crowdingRisk,
        overlapPenaltyMultiplier: 1,
        falseDiversificationPenalty: falsePen,
        duplicateEdgePenalty: dupPen,
        crowdedClusterPenalty: clusterPen,
        concentrationPenaltyReasons: crowdingReasons,
        crowdingReasons,
      };
    }

    allocationMultiplier = round4(allocationMultiplier * overlapPenaltyMultiplier);
    maxExposureMultiplier = round4(maxExposureMultiplier * overlapPenaltyMultiplier);
    throttleFactor = round4(throttleFactor * overlapPenaltyMultiplier);

    if (crowdingRisk === 'severe' && decision === 'promote') {
      decision = 'throttle';
      crowdingReasons.push('demoted_promote_to_throttle_severe_crowding');
    } else if (crowdingRisk === 'severe' && decision === 'throttle') {
      decision = 'demote';
      crowdingReasons.push('demoted_throttle_to_demote_severe_crowding');
    } else if (crowdingRisk === 'high' && decision === 'promote') {
      decision = 'throttle';
      crowdingReasons.push('demoted_promote_to_throttle_high_crowding');
    }

    return {
      ...e,
      decision,
      allocationMultiplier,
      maxExposureMultiplier,
      throttleFactor,
      crowdingScore,
      overlapScore,
      crowdingRiskLevel: crowdingRisk,
      overlapPenaltyMultiplier,
      falseDiversificationPenalty: falsePen,
      duplicateEdgePenalty: dupPen,
      crowdedClusterPenalty: clusterPen,
      concentrationPenaltyReasons: crowdingReasons,
      crowdingReasons,
    };
  });

  return {
    entities: outEntities,
    globalPolicyCrowding: {
      crowdingMode,
      maxCrowdingTolerance: round4(1 - totalCrowd * 0.5),
      crowdingFlags: [...new Set(crowdingFlags)],
      recommendedCrowdingAction,
      portfolioCrowdingScore: round4(totalCrowd),
      duplicateEdgeScore: overlapState.crowdingDiagnostics?.duplicateEdgeScore,
      falseDiversificationScore: overlapState.crowdingDiagnostics?.falseDiversificationScore,
    },
  };
}

function applyCrowdingCaps(plan, correlationOverlapState) {
  if (String(process.env.ALLOCATION_CROWDING_CAP_ENABLED || 'true').toLowerCase() === 'false') {
    return { plan, crowdingAdjusted: false };
  }
  const E = parseOverlapEnv();
  const state = correlationOverlapState && typeof correlationOverlapState === 'object' ? correlationOverlapState : {};
  const cd = state.crowdingDiagnostics || {};
  const totalCrowd = Number(cd.totalCrowdingScore) || 0;
  if (totalCrowd < parseOverlapEnv().crowdingWarn * 0.25) {
    return { plan, crowdingAdjusted: false };
  }

  const maxCluster = E.maxClusterWeight;
  const maxDup = E.maxDupEdgeWeight;
  const dup = Number(state.overlapDiagnostics?.duplicateExpressionCount) || 0;
  const effCap = round4(Math.min(maxCluster, maxDup + (dup > 3 ? 0.05 : 0)));

  const preS = {};
  const preY = {};
  for (const r of plan.strategyAllocations || []) preS[r.strategy] = r.weight;
  for (const r of plan.symbolAllocations || []) preY[r.symbol] = r.weight;

  const cappedS = {};
  const cappedY = {};
  for (const r of plan.strategyAllocations || []) {
    let w = Number(r.weight) || 0;
    if (totalCrowd >= E.crowdingWarn) w = Math.min(w, effCap);
    cappedS[r.strategy] = w;
  }
  for (const r of plan.symbolAllocations || []) {
    let w = Number(r.weight) || 0;
    if (totalCrowd >= E.crowdingWarn) w = Math.min(w, effCap);
    cappedY[r.symbol] = w;
  }

  const normS = normalizeWeightsObj(cappedS);
  const normY = normalizeWeightsObj(cappedY);
  const deploy = Number(plan.portfolio?.recommendedDeployableCapital) || 0;

  const stratRows = (plan.strategyAllocations || []).map((r) => {
    const w = normS[r.strategy] != null ? normS[r.strategy] : r.weight;
    return {
      ...r,
      weight: round4(w),
      recommendedCapital: round4(deploy * w),
    };
  });
  const symRows = (plan.symbolAllocations || []).map((r) => {
    const w = normY[r.symbol] != null ? normY[r.symbol] : r.weight;
    return {
      ...r,
      weight: round4(w),
      recommendedCapital: round4(deploy * w),
    };
  });

  const lossS = l1WeightLoss(preS, normS);
  const lossY = l1WeightLoss(preY, normY);
  const conc = herfindahl(normS) * 100;

  return {
    plan: {
      ...plan,
      strategyAllocations: stratRows,
      symbolAllocations: symRows,
      diagnostics: {
        ...plan.diagnostics,
        crowdingAdjusted: true,
        preCrowdingWeights: { strategies: preS, symbols: preY },
        postCrowdingWeights: { strategies: normS, symbols: normY },
        crowdingWeightLoss: round4(lossS + lossY),
        duplicateEdgeWeightLoss: round4(lossS * 0.5),
        falseDiversificationPenalty: cd.falseDiversificationScore,
        crowdedClusterCapsApplied: effCap,
        overlapWarnings: state.warnings || [],
        crowdingWarnings: state.warnings || [],
        crowdingAdjustedConcentrationScore: round4(conc),
      },
    },
    crowdingAdjusted: true,
  };
}

function normalizeWeightsObj(obj) {
  const keys = Object.keys(obj || {});
  let s = 0;
  for (const k of keys) s += Math.max(0, Number(obj[k]) || 0);
  const out = {};
  if (s <= 1e-12) return out;
  for (const k of keys) out[k] = round4(Math.max(0, Number(obj[k]) || 0) / s);
  return out;
}

function l1WeightLoss(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let loss = 0;
  for (const k of keys) {
    loss += Math.abs((Number(a[k]) || 0) - (Number(b[k]) || 0));
  }
  return round4(loss / 2);
}

function herfindahl(w) {
  let s = 0;
  for (const v of Object.values(w || {})) s += (Number(v) || 0) ** 2;
  return s;
}

function summarizeAllocationOverlapImpact(planBefore, planAfter) {
  return {
    crowdingAdjusted: !!planAfter?.diagnostics?.crowdingAdjusted,
    crowdingWeightLoss: planAfter?.diagnostics?.crowdingWeightLoss ?? null,
    topOverlappingStrategies: planAfter?.diagnostics?.preCrowdingWeights?.strategies
      ? Object.entries(planAfter.diagnostics.preCrowdingWeights.strategies)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, v]) => ({ strategy: k, weight: v }))
      : [],
    topOverlappingSymbols: planAfter?.diagnostics?.preCrowdingWeights?.symbols
      ? Object.entries(planAfter.diagnostics.preCrowdingWeights.symbols)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([k, v]) => ({ symbol: k, weight: v }))
      : [],
  };
}

async function getCorrelationOverlapOverview() {
  const s = await loadLatestCorrelationOverlapState();
  return {
    ok: true,
    generatedAt: s.generatedAt || null,
    correlationOverlapVersion: s.correlationOverlapVersion ?? CORRELATION_OVERLAP_VERSION,
    summary: s.summary || {},
    totalCrowdingScore: s.crowdingDiagnostics?.totalCrowdingScore ?? null,
    symbolCrowdingScore: s.crowdingDiagnostics?.symbolCrowdingScore ?? null,
    strategyCrowdingScore: s.crowdingDiagnostics?.strategyCrowdingScore ?? null,
    falseDiversificationScore: s.crowdingDiagnostics?.falseDiversificationScore ?? null,
    duplicateEdgeScore: s.crowdingDiagnostics?.duplicateEdgeScore ?? null,
    topCrowdedClusters: s.crowdingDiagnostics?.topCrowdedClusters || [],
    warnings: s.warnings || [],
  };
}

async function getCorrelationOverlapMatrix() {
  const s = await loadLatestCorrelationOverlapState();
  return { ok: true, generatedAt: s.generatedAt, matrices: s.matrices || { pairwiseTop: [], entityKeys: [] } };
}

async function getCorrelationOverlapClusters() {
  const s = await loadLatestCorrelationOverlapState();
  return { ok: true, generatedAt: s.generatedAt, clusters: s.clusters || {} };
}

async function getCorrelationOverlapWarnings() {
  const s = await loadLatestCorrelationOverlapState();
  return { ok: true, generatedAt: s.generatedAt, warnings: s.warnings || [] };
}

module.exports = {
  CORRELATION_OVERLAP_VERSION,
  computeEnvFingerprint,
  buildExposureRowsFromPolicy,
  buildExposureRowsFromAllocation,
  buildExposureRowsFromClosedTrades,
  mergeExposureRows,
  computeStrategySymbolOverlap,
  computeClusterOverlap,
  computePairwiseOverlapMatrix,
  computePortfolioCrowding,
  computeRealizedCorrelationFromClosedTrades,
  loadLatestCorrelationOverlapState,
  saveLatestCorrelationOverlapState,
  appendCorrelationOverlapHistory,
  readCorrelationOverlapHistory,
  buildCorrelationOverlapState,
  runCorrelationOverlapCycle,
  applyPolicyCrowdingPenalties,
  applyCrowdingCaps,
  computeCrowdingAdjustedWeights: applyCrowdingCaps,
  summarizeAllocationOverlapImpact,
  getCorrelationOverlapOverview,
  getCorrelationOverlapMatrix,
  getCorrelationOverlapClusters,
  getCorrelationOverlapWarnings,
  crowdingRiskLevelFromScore,
  buildEntityCrowdingIndex,
};
