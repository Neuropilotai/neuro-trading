#!/usr/bin/env node
'use strict';

/**
 * Institutional capital allocation simulation for replay budget / selection (desk-quant).
 * Non-destructive; influences scores and caps only. Does not touch paper_trades.jsonl.
 */

const fs = require('fs');
const path = require('path');
const replayBoostPolicyCore = require('./replayBoostPolicyCore');

const POLICY_SCHEMA_VERSION = 1;

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function toNum(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function envBool(name, defaultTrue = false) {
  const v = String(process.env[name] == null ? (defaultTrue ? '1' : '0') : process.env[name])
    .trim()
    .toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  return defaultTrue;
}

function envNum(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}

function parseCapitalAllocationEnv() {
  const mm = process.env.NP_CAPITAL_ALLOCATION_REQUIRE_MULTI_MARKET_FOR_CORE;
  return {
    enable: envBool('NP_CAPITAL_ALLOCATION_ENABLE', false),
    strictSuspend: envBool('NP_CAPITAL_ALLOCATION_STRICT_SUSPEND', true),
    coreBonus: envNum('NP_CAPITAL_ALLOCATION_CORE_BONUS', 5),
    activeBonus: envNum('NP_CAPITAL_ALLOCATION_ACTIVE_BONUS', 1),
    reducedPenalty: envNum('NP_CAPITAL_ALLOCATION_REDUCED_PENALTY', 10),
    suspendedPenalty: envNum('NP_CAPITAL_ALLOCATION_SUSPENDED_PENALTY', 48),
    confidenceWeight: envNum('NP_CAPITAL_ALLOCATION_CONFIDENCE_WEIGHT', 6),
    maxSetupShare: clamp(envNum('NP_CAPITAL_ALLOCATION_MAX_SETUP_SHARE', 0.88), 0.2, 1),
    maxFamilyShare: clamp(envNum('NP_CAPITAL_ALLOCATION_MAX_FAMILY_SHARE', 0.42), 0.15, 0.85),
    maxMarketShare: clamp(envNum('NP_CAPITAL_ALLOCATION_MAX_MARKET_SHARE', 0.52), 0.2, 0.9),
    maxRegimeShare: clamp(envNum('NP_CAPITAL_ALLOCATION_MAX_REGIME_SHARE', 0.72), 0.25, 0.95),
    minTradesForCore: Math.max(1, Math.floor(envNum('NP_CAPITAL_ALLOCATION_MIN_TRADES_FOR_CORE', 6))),
    requireMultiMarketForCore:
      mm == null || mm === ''
        ? true
        : !['0', 'false', 'no', 'off'].includes(String(mm).trim().toLowerCase()),
    defaultMaxBars: Math.max(0, Math.floor(envNum('NP_CAPITAL_ALLOCATION_DEFAULT_MAX_BARS', 3))),
    suspendedScoreMax: envNum('NP_CAPITAL_ALLOCATION_SUSPENDED_SCORE_MAX', 28),
    coreScoreMin: envNum('NP_CAPITAL_ALLOCATION_CORE_SCORE_MIN', 72),
    activeScoreMin: envNum('NP_CAPITAL_ALLOCATION_ACTIVE_SCORE_MIN', 48),
  };
}

function familyKeyFromSetup(setupKey) {
  const k = String(setupKey || '').toLowerCase();
  if (k.startsWith('mut_')) return 'mut_';
  if (k.startsWith('familyexp_')) return 'familyexp_';
  if (k.startsWith('example_')) return 'example_';
  return 'other';
}

function marketKeyFromValRow(valRow) {
  if (!valRow) return 'UNKNOWN';
  const s =
    valRow.symbol ||
    valRow.primarySymbol ||
    valRow.market ||
    valRow.instrument;
  const u = s != null ? String(s).trim().toUpperCase() : '';
  return u || 'UNKNOWN';
}

function regimeKeyForSetup(valRow, latest) {
  if (valRow && valRow.regime != null && String(valRow.regime).trim()) {
    return String(valRow.regime).trim().toLowerCase();
  }
  if (!latest || typeof latest !== 'object') return 'unknown';
  const r =
    latest.regime ||
    latest.marketRegime ||
    latest.trendRegime ||
    latest.focusRegime;
  return r != null && String(r).trim() ? String(r).trim().toLowerCase() : 'unknown';
}

function analysisRowBySetupKey(analysisDoc) {
  const m = new Map();
  const rows =
    analysisDoc && Array.isArray(analysisDoc.setupRows)
      ? analysisDoc.setupRows
      : analysisDoc && Array.isArray(analysisDoc.rowsBySetup)
        ? analysisDoc.rowsBySetup
        : [];
  for (const row of rows) {
    const k = row && row.setupKey != null ? String(row.setupKey).trim() : '';
    if (k) m.set(k, row);
  }
  return m;
}

function distinctMarketCountFromRow(row) {
  if (!row || !row.markets || typeof row.markets !== 'object') return 0;
  return Object.keys(row.markets).filter((k) => toNum(row.markets[k], 0) > 0).length;
}

function stagnationFromTrend(trendLines) {
  if (!Array.isArray(trendLines) || trendLines.length < 2) return false;
  const a = toNum(trendLines[trendLines.length - 2].promoted_and_paper_recent, -1);
  const b = toNum(trendLines[trendLines.length - 1].promoted_and_paper_recent, -2);
  return a === b && a >= 0;
}

function policyModeFromHealth(health, cb) {
  const st = String(cb && cb.state ? cb.state : 'CLOSED').toUpperCase();
  if (st === 'OPEN') return 'circuit_breaker';
  const o = String(health && health.overallStatus ? health.overallStatus : 'OK').toUpperCase();
  if (['CRITICAL', 'DOWN'].includes(o)) return 'critical';
  if (['DEGRADED', 'STALLED'].includes(o)) return 'degraded';
  if (o === 'WATCH') return 'conservative';
  return 'normal';
}

/**
 * @param {object} ctx
 */
function scoreCapitalAllocationCandidate(ctx) {
  const reasons = [];
  let s = 52;
  let neg = 0;
  let pos = 0;

  const valRow = ctx.valRow || null;
  const tier = valRow && String(valRow.tier || '').trim();
  const strictScore = valRow && toNum(valRow.score, NaN);
  const autoDecision = ctx.autoThrottleDecision ? String(ctx.autoThrottleDecision).toUpperCase() : null;

  if (tier === 'promote_candidate') {
    s += 10;
    pos += 1;
    reasons.push({ code: 'promote_candidate', message: 'Promote candidate tier', value: null });
  }
  if (Number.isFinite(strictScore) && strictScore >= 60) {
    s += 6;
    pos += 1;
    reasons.push({ code: 'strict_ok', message: 'Strict score supportive', value: strictScore });
  } else if (Number.isFinite(strictScore) && strictScore < 44) {
    s -= 10;
    neg += 1;
    reasons.push({ code: 'strict_weak', message: 'Strict score weak', value: strictScore });
  }

  if (ctx.replayBoostTier === 'boosted') {
    s += 5;
    pos += 1;
    reasons.push({ code: 'replay_boost_boosted', message: 'Replay boost boosted', value: null });
  } else if (ctx.replayBoostTier === 'frozen' || ctx.replayBoostTier === 'throttled') {
    s -= 12;
    neg += 1;
    reasons.push({ code: 'replay_boost_stressed', message: 'Replay boost throttled/frozen', value: ctx.replayBoostTier });
  }

  if (autoDecision === 'PROTECT') {
    s += 8;
    pos += 1;
    reasons.push({ code: 'auto_throttle_protect', message: 'Auto-throttle PROTECT', value: null });
  } else if (autoDecision === 'THROTTLE') {
    s -= 8;
    neg += 1;
    reasons.push({ code: 'auto_throttle_throttle', message: 'Auto-throttle THROTTLE', value: null });
  } else if (autoDecision === 'FROZEN') {
    s -= 22;
    neg += 2;
    reasons.push({ code: 'auto_throttle_frozen', message: 'Auto-throttle FROZEN', value: null });
  }

  if (Number.isFinite(ctx.expectancy7d) && ctx.trades7d >= 3 && ctx.expectancy7d < 0) {
    s -= 12;
    neg += 1;
    reasons.push({ code: 'exp7_neg', message: 'Negative recent expectancy', value: ctx.expectancy7d });
  }
  if (Number.isFinite(ctx.expectancyAllTime) && ctx.tradesAllTime >= 5 && ctx.expectancyAllTime < 0) {
    s -= 10;
    neg += 1;
    reasons.push({ code: 'exp_all_neg', message: 'Negative all-time expectancy', value: ctx.expectancyAllTime });
  }
  if (
    Number.isFinite(ctx.expectancy7d) &&
    ctx.expectancy7d > 0 &&
    Number.isFinite(ctx.expectancyAllTime) &&
    ctx.expectancyAllTime > 0
  ) {
    s += 6;
    pos += 1;
    reasons.push({ code: 'exp_positive', message: 'Positive expectancy windows', value: null });
  }

  if (Number.isFinite(ctx.pfAllTime) && ctx.tradesAllTime >= 4 && ctx.pfAllTime >= 1.02) {
    s += 4;
    pos += 1;
    reasons.push({ code: 'pf_ok', message: 'PF acceptable', value: ctx.pfAllTime });
  } else if (Number.isFinite(ctx.pfAllTime) && ctx.tradesAllTime >= 5 && ctx.pfAllTime < 0.88) {
    s -= 8;
    neg += 1;
    reasons.push({ code: 'pf_weak', message: 'PF weak with sample', value: ctx.pfAllTime });
  }

  if (ctx.globalDup > 450 && Number.isFinite(strictScore) && strictScore < 56) {
    s -= 8;
    neg += 1;
    reasons.push({ code: 'dup_pressure', message: 'Duplicate pressure vs strict', value: ctx.globalDup });
  }

  if (ctx.distinctMarketCount >= 2) {
    s += 5;
    pos += 1;
    reasons.push({ code: 'multi_market', message: 'Multi-market coverage', value: ctx.distinctMarketCount });
  } else if (ctx.distinctMarketCount <= 1 && ctx.tradesAllTime >= 14) {
    s -= 5;
    neg += 1;
    reasons.push({ code: 'single_market_long', message: 'Single-market concentration', value: ctx.distinctMarketCount });
  }

  if (ctx.effectiveAppendedGlobal > 0 && ctx.replayBarsThisSetup > 0) {
    s += 3;
    pos += 1;
    reasons.push({ code: 'append_and_replay', message: 'Global append with local replay', value: null });
  }

  if (ctx.stagnationHint) {
    s -= 6;
    neg += 1;
    reasons.push({ code: 'stagnation', message: 'Convergence stagnation hint', value: null });
  }

  s = clamp(Math.round(s * 10) / 10, 0, 100);
  return { capitalAllocationScore: s, reasons, negativeSignals: neg, positiveSignals: pos };
}

/**
 * @param {number} score
 * @param {object} ctx
 * @param {ReturnType<typeof parseCapitalAllocationEnv>} opts
 */
function classifyCapitalAllocationBucket(score, ctx, opts) {
  const autoD = ctx.autoThrottleDecision ? String(ctx.autoThrottleDecision).toUpperCase() : null;
  if (autoD === 'FROZEN') return 'SUSPENDED';
  if (score <= opts.suspendedScoreMax && ctx.negativeSignals >= 2) return 'SUSPENDED';
  if (autoD === 'THROTTLE' && score < opts.activeScoreMin + 8) return 'REDUCED';

  const coreOkTrades = ctx.tradesAllTime >= opts.minTradesForCore;
  const coreOkMulti =
    !opts.requireMultiMarketForCore || ctx.distinctMarketCount >= 2 || ctx.distinctMarketCount === 0;
  if (
    score >= opts.coreScoreMin &&
    coreOkTrades &&
    coreOkMulti &&
    ctx.negativeSignals <= 1 &&
    autoD !== 'THROTTLE'
  ) {
    return 'CORE';
  }
  if (score < opts.activeScoreMin) return 'REDUCED';
  return 'ACTIVE';
}

function loadInputsForCapitalAllocationBuild(roots) {
  const { dataRoot, opsDir } = roots;
  const gov = path.join(dataRoot, 'governance');
  const read = (p) => readJsonSafe(p);

  let trendLines = [];
  try {
    const convPath = path.join(gov, 'promoted_convergence_trend.jsonl');
    if (fs.existsSync(convPath)) {
      const lines = fs.readFileSync(convPath, 'utf8').split(/\r?\n/).filter(Boolean);
      trendLines = lines.slice(-6).map((line) => JSON.parse(line));
    }
  } catch {
    /* optional */
  }

  return {
    dataRoot,
    opsDir,
    lastRun: read(path.join(gov, 'paper_exec_v1_last_run.json')),
    analysis: read(path.join(gov, 'paper_trades_by_setup_analysis.json')),
    strictReport: read(path.join(gov, 'paper_trades_strict_mapping_report.json')),
    replayBoostPolicy: read(path.join(gov, 'replay_boost_policy.json')),
    autoThrottlePolicy: read(path.join(gov, 'auto_throttle_policy.json')),
    previousPolicy: read(path.join(gov, 'capital_allocation_policy.json')),
    strategyValidation: read(path.join(opsDir, 'strategy_validation.json')),
    latest: read(path.join(opsDir, 'latest.json')),
    health: read(path.join(opsDir, 'neuropilot_health.json')),
    circuitBreaker: read(path.join(opsDir, 'circuit_breaker_status.json')),
    smartReplaySelection: read(path.join(opsDir, 'smart_replay_selection.json')),
    autoThrottleSelection: read(path.join(opsDir, 'auto_throttle_selection.json')),
    trendLines,
  };
}

function collectCandidateSetupKeys(inputs) {
  const keys = new Set();
  const vRows = inputs.strategyValidation && Array.isArray(inputs.strategyValidation.rows)
    ? inputs.strategyValidation.rows
    : [];
  for (const r of vRows) {
    const sid = r && r.strategyId != null ? String(r.strategyId).trim() : '';
    if (sid) keys.add(sid);
  }
  const analysisRows =
    inputs.analysis && Array.isArray(inputs.analysis.setupRows)
      ? inputs.analysis.setupRows
      : inputs.analysis && Array.isArray(inputs.analysis.rowsBySetup)
        ? inputs.analysis.rowsBySetup
        : [];
  for (const r of analysisRows) {
    const k = r && r.setupKey != null ? String(r.setupKey).trim() : '';
    if (k) keys.add(k);
  }
  for (const a of replayBoostPolicyCore.getPolicyAllocationsArray(inputs.replayBoostPolicy || null)) {
    const id = a && a.setupId != null ? String(a.setupId).trim() : '';
    if (id) keys.add(id);
  }
  const sr = inputs.strictReport || {};
  for (const arr of [sr.promoted_not_seen_in_paper_last_7d, sr.promoted_and_paper_recent]) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const k = row && row.setupKey != null ? String(row.setupKey).trim() : '';
      if (k) keys.add(k);
    }
  }
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function buildCapitalAllocationPolicy(inputs, optsOverride) {
  const opts = optsOverride || parseCapitalAllocationEnv();
  const policyMode = policyModeFromHealth(inputs.health || {}, inputs.circuitBreaker || {});
  const stagnationHint = stagnationFromTrend(inputs.trendLines || []);

  const lastRun = inputs.lastRun || {};
  const barsBy =
    lastRun.promotedReplayBarsBySetup && typeof lastRun.promotedReplayBarsBySetup === 'object'
      ? lastRun.promotedReplayBarsBySetup
      : {};
  const globalDup = toNum(lastRun.duplicateSkippedPersistent, 0);
  const effectiveAppended = toNum(lastRun.effectiveAppended, 0);

  const analysisMap = analysisRowBySetupKey(inputs.analysis || {});
  const valMap = new Map();
  for (const r of inputs.strategyValidation && Array.isArray(inputs.strategyValidation.rows)
    ? inputs.strategyValidation.rows
    : []) {
    const sid = r && r.strategyId != null ? String(r.strategyId).trim() : '';
    if (sid) valMap.set(sid, r);
  }

  const replayMap = new Map();
  for (const a of replayBoostPolicyCore.getPolicyAllocationsArray(inputs.replayBoostPolicy || null)) {
    const id = a && a.setupId != null ? String(a.setupId).trim() : '';
    if (!id) continue;
    const t = String(a.priorityTier || 'neutral').trim().toLowerCase();
    replayMap.set(id, ['boosted', 'neutral', 'throttled', 'frozen'].includes(t) ? t : 'neutral');
  }

  const autoMap = new Map();
  for (const a of inputs.autoThrottlePolicy && Array.isArray(inputs.autoThrottlePolicy.allocations)
    ? inputs.autoThrottlePolicy.allocations
    : []) {
    const k = a && a.setupKey != null ? String(a.setupKey).trim() : '';
    if (k) autoMap.set(k, a);
  }

  let globalReplayFactor = 1;
  if (policyMode === 'circuit_breaker') globalReplayFactor = 0.62;
  else if (policyMode === 'critical') globalReplayFactor = 0.7;
  else if (policyMode === 'degraded') globalReplayFactor = 0.8;
  else if (policyMode === 'conservative') globalReplayFactor = 0.88;

  const latest = inputs.latest || {};
  const keys = collectCandidateSetupKeys(inputs);
  const n = keys.length || 1;

  const raw = [];
  for (const setupKey of keys) {
    const valRow = valMap.get(setupKey) || null;
    const analysisRow = analysisMap.get(setupKey) || null;
    const wAll = analysisRow && analysisRow.windows && analysisRow.windows.all_time ? analysisRow.windows.all_time : {};
    const w7 = analysisRow && analysisRow.windows && analysisRow.windows.last_7d ? analysisRow.windows.last_7d : {};
    const exAll = wAll.expectancy != null ? wAll.expectancy : wAll.avgPnl;
    const ex7 = w7.expectancy != null ? w7.expectancy : w7.avgPnl;

    const autoRow = autoMap.get(setupKey) || null;
    const autoThrottleDecision = autoRow && autoRow.decision != null ? String(autoRow.decision) : null;

    const ctxScore = {
      valRow,
      replayBoostTier: replayMap.get(setupKey) || null,
      autoThrottleDecision,
      expectancy7d: toNum(ex7, NaN),
      expectancyAllTime: toNum(exAll, NaN),
      pfAllTime: toNum(wAll.profitFactor, NaN),
      tradesAllTime: Math.floor(toNum(wAll.totalTrades, 0)),
      trades7d: Math.floor(toNum(w7.totalTrades, 0)),
      globalDup,
      effectiveAppendedGlobal: effectiveAppended,
      distinctMarketCount: analysisRow ? distinctMarketCountFromRow(analysisRow) : 0,
      replayBarsThisSetup: barsBy[setupKey] != null ? toNum(barsBy[setupKey], 0) : 0,
      stagnationHint,
    };

    const scored = scoreCapitalAllocationCandidate(ctxScore);
    let bucket = classifyCapitalAllocationBucket(scored.capitalAllocationScore, scored, opts);

    const fam = familyKeyFromSetup(setupKey);
    const mkt = marketKeyFromValRow(valRow);
    const reg = regimeKeyForSetup(valRow, latest);

    const confidence = clamp(scored.capitalAllocationScore / 100, 0, 1);
    let replayWeight =
      bucket === 'CORE' ? 1.12 : bucket === 'ACTIVE' ? 1 : bucket === 'REDUCED' ? 0.52 : 0.08;
    replayWeight = clamp(replayWeight * globalReplayFactor, 0.05, 1.15);

    let maxBars = opts.defaultMaxBars;
    if (bucket === 'CORE') maxBars = Math.min(maxBars + 1, 5);
    if (bucket === 'REDUCED') maxBars = Math.max(0, Math.min(maxBars, 2));
    if (bucket === 'SUSPENDED') maxBars = 0;
    maxBars = Math.max(0, Math.floor(maxBars * globalReplayFactor));

    const bypassEligible = bucket !== 'SUSPENDED' && bucket !== 'REDUCED';
    const selectionAdj =
      bucket === 'CORE'
        ? -Math.abs(opts.coreBonus)
        : bucket === 'ACTIVE'
          ? -Math.abs(opts.activeBonus)
          : bucket === 'REDUCED'
            ? Math.abs(opts.reducedPenalty)
            : Math.abs(opts.suspendedPenalty);

    raw.push({
      setupKey,
      bucket,
      capitalAllocationScore: scored.capitalAllocationScore,
      recommendedReplayWeight: Math.round(replayWeight * 1000) / 1000,
      recommendedMaxBarsPerSetup: maxBars,
      recommendedBypassEligibility: bypassEligible,
      recommendedSelectionAdjustment: selectionAdj,
      reasons: scored.reasons.slice(0, 16),
      metricsSnapshot: {
        familyKey: fam,
        marketKey: mkt,
        regimeKey: reg,
        strictScore: valRow ? toNum(valRow.score, null) : null,
        tradesAllTime: ctxScore.tradesAllTime,
        distinctMarketCount: ctxScore.distinctMarketCount,
        autoThrottleDecision,
        negativeSignals: scored.negativeSignals,
        positiveSignals: scored.positiveSignals,
        confidence,
      },
      _fam: fam,
      _mkt: mkt,
      _reg: reg,
    });
  }

  const famCounts = new Map();
  const mktCounts = new Map();
  const regCounts = new Map();
  for (const r of raw) {
    famCounts.set(r._fam, (famCounts.get(r._fam) || 0) + 1);
    mktCounts.set(r._mkt, (mktCounts.get(r._mkt) || 0) + 1);
    regCounts.set(r._reg, (regCounts.get(r._reg) || 0) + 1);
  }

  for (const r of raw) {
    const fs = (famCounts.get(r._fam) || 0) / n;
    const ms = (mktCounts.get(r._mkt) || 0) / n;
    if (fs > opts.maxFamilyShare && r.bucket === 'CORE') {
      r.bucket = 'ACTIVE';
      r.reasons.push({
        code: 'family_concentration_cap',
        message: 'Downgraded CORE→ACTIVE: family share exceeds cap',
        value: fs,
      });
      r.recommendedReplayWeight = clamp(r.recommendedReplayWeight * 0.92, 0.05, 1.1);
      r.recommendedMaxBarsPerSetup = Math.max(0, Math.min(r.recommendedMaxBarsPerSetup, opts.defaultMaxBars));
    }
    if (ms > opts.maxMarketShare && (r.bucket === 'CORE' || r.bucket === 'ACTIVE')) {
      r.bucket = 'REDUCED';
      r.reasons.push({
        code: 'market_concentration_cap',
        message: 'Downgraded to REDUCED: market share exceeds cap',
        value: ms,
      });
      r.recommendedReplayWeight = 0.45;
      r.recommendedMaxBarsPerSetup = Math.max(0, Math.min(r.recommendedMaxBarsPerSetup, 1));
      r.recommendedBypassEligibility = false;
      r.recommendedSelectionAdjustment = Math.abs(opts.reducedPenalty);
    }
  }

  let hhi = 0;
  for (const c of famCounts.values()) {
    const p = c / n;
    hhi += p * p;
  }

  const topFamily = Array.from(famCounts.entries()).sort((a, b) => b[1] - a[1])[0] || ['none', 0];
  const topMarket = Array.from(mktCounts.entries()).sort((a, b) => b[1] - a[1])[0] || ['none', 0];
  const topRegime = Array.from(regCounts.entries()).sort((a, b) => b[1] - a[1])[0] || ['none', 0];

  const concentrationRisk = {
    herfindahlFamily: Math.round(hhi * 1000) / 1000,
    topFamily: topFamily[0],
    topFamilyShare: Math.round((topFamily[1] / n) * 1000) / 1000,
    topMarket: topMarket[0],
    topMarketShare: Math.round((topMarket[1] / n) * 1000) / 1000,
    topRegime: topRegime[0],
    topRegimeShare: Math.round((topRegime[1] / n) * 1000) / 1000,
    candidateCount: n,
  };

  const familyAllocations = [];
  for (const fk of Array.from(famCounts.keys()).sort()) {
    const cnt = famCounts.get(fk) || 0;
    const share = cnt / n;
    familyAllocations.push({
      familyKey: fk,
      setupCount: cnt,
      recommendedFamilyWeight: Math.round(clamp(1 - (share - 1 / Math.max(famCounts.size, 1)), 0.2, 1.2) * 1000) / 1000,
      recommendedFamilyCapShare: Math.min(opts.maxFamilyShare, share + 0.05),
      reasons: share > opts.maxFamilyShare
        ? [{ code: 'family_near_cap', message: 'Family concentration elevated', value: share }]
        : [],
    });
  }

  const marketAllocations = [];
  for (const mk of Array.from(mktCounts.keys()).sort()) {
    const cnt = mktCounts.get(mk) || 0;
    const share = cnt / n;
    marketAllocations.push({
      marketKey: mk,
      setupCount: cnt,
      recommendedMarketWeight: Math.round(clamp(1.05 - share, 0.25, 1.15) * 1000) / 1000,
      recommendedMarketCapShare: Math.min(opts.maxMarketShare, share + 0.06),
      reasons: share > opts.maxMarketShare * 0.92
        ? [{ code: 'market_elevated', message: 'Market share elevated', value: share }]
        : [],
    });
  }

  const regimeAllocations = [];
  for (const rk of Array.from(regCounts.keys()).sort()) {
    const cnt = regCounts.get(rk) || 0;
    const share = cnt / n;
    regimeAllocations.push({
      regimeKey: rk,
      setupCount: cnt,
      recommendedRegimeWeight: Math.round(clamp(1.02 - share * 0.5, 0.3, 1.1) * 1000) / 1000,
      recommendedRegimeCapShare: Math.min(opts.maxRegimeShare, share + 0.08),
      reasons: [],
    });
  }

  const globalControls = {
    recommendedGlobalReplayFactor: globalReplayFactor,
    recommendedMaxSetupShare: opts.maxSetupShare,
    recommendedMaxFamilyShare: opts.maxFamilyShare,
    recommendedMaxMarketShare: opts.maxMarketShare,
    recommendedMaxRegimeShare: opts.maxRegimeShare,
    policyModeDerived: policyMode,
  };

  const allocations = raw.map((r) => {
    const { _fam, _mkt, _reg, ...rest } = r;
    return rest;
  });

  const summary = {
    candidateCount: allocations.length,
    coreCount: allocations.filter((a) => a.bucket === 'CORE').length,
    activeCount: allocations.filter((a) => a.bucket === 'ACTIVE').length,
    reducedCount: allocations.filter((a) => a.bucket === 'REDUCED').length,
    suspendedCount: allocations.filter((a) => a.bucket === 'SUSPENDED').length,
  };

  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    dataRoot: inputs.dataRoot,
    policyMode,
    summary,
    globalControls,
    concentrationRisk,
    familyAllocations,
    marketAllocations,
    regimeAllocations,
    allocations: allocations.sort((a, b) => a.setupKey.localeCompare(b.setupKey)),
    inputsProvenance: {
      validationRows: valMap.size,
      analysisRows: analysisMap.size,
      autoThrottleRows: autoMap.size,
    },
  };
}

function policyDocumentForWrite(doc) {
  if (!doc) return doc;
  const { inputsProvenance, ...rest } = doc;
  return rest;
}

function loadCapitalAllocationPolicy(policyPath) {
  const doc = readJsonSafe(policyPath);
  if (!doc || doc.schemaVersion !== POLICY_SCHEMA_VERSION) return null;
  if (!Array.isArray(doc.allocations)) return null;
  return doc;
}

function writeCapitalAllocationPolicy(policyPath, doc) {
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  const out = policyDocumentForWrite(doc) || doc;
  fs.writeFileSync(policyPath, JSON.stringify(out, null, 2), 'utf8');
}

function buildCapitalAllocationRowBySetupMap(policyDoc) {
  const m = new Map();
  if (!policyDoc || !Array.isArray(policyDoc.allocations)) return m;
  for (const a of policyDoc.allocations) {
    const k = a && a.setupKey != null ? String(a.setupKey).trim() : '';
    if (k) m.set(k, a);
  }
  return m;
}

/**
 * Replay selection score adjustment (additive before clamp).
 */
function computeCapitalAllocationAdjustment(row, ctx, envOpts) {
  const codes = [];
  if (!row) return { adj: 0, codes, bucket: null, recommendedMaxBarsPerSetup: null, bypassEligible: true };

  const bucket = String(row.bucket || 'ACTIVE').toUpperCase();
  let adj = 0;

  if (bucket === 'CORE') {
    adj += Math.abs(toNum(envOpts.coreBonus, 5));
    codes.push('capital_core_bonus');
  } else if (bucket === 'ACTIVE') {
    adj += Math.abs(toNum(envOpts.activeBonus, 1));
    codes.push('capital_active_small_bonus');
  } else if (bucket === 'REDUCED') {
    adj -= Math.abs(toNum(envOpts.reducedPenalty, 10));
    codes.push('capital_reduced_penalty');
  } else if (bucket === 'SUSPENDED') {
    adj -= Math.abs(toNum(envOpts.suspendedPenalty, 48));
    codes.push('capital_suspended_penalty');
  }

  const conf = row.metricsSnapshot && row.metricsSnapshot.confidence != null
    ? toNum(row.metricsSnapshot.confidence, 0)
    : clamp(toNum(row.capitalAllocationScore, 50) / 100, 0, 1);
  adj += clamp(conf * toNum(envOpts.confidenceWeight, 6), 0, 8);
  if (conf > 0.55) codes.push('capital_confidence_tail');

  return {
    adj: Math.round(adj * 100) / 100,
    codes,
    bucket,
    recommendedMaxBarsPerSetup:
      row.recommendedMaxBarsPerSetup != null
        ? Math.max(0, Math.floor(toNum(row.recommendedMaxBarsPerSetup, 3)))
        : null,
    bypassEligible: row.recommendedBypassEligibility !== false,
  };
}

module.exports = {
  POLICY_SCHEMA_VERSION,
  parseCapitalAllocationEnv,
  scoreCapitalAllocationCandidate,
  classifyCapitalAllocationBucket,
  loadInputsForCapitalAllocationBuild,
  buildCapitalAllocationPolicy,
  loadCapitalAllocationPolicy,
  writeCapitalAllocationPolicy,
  policyDocumentForWrite,
  buildCapitalAllocationRowBySetupMap,
  computeCapitalAllocationAdjustment,
  familyKeyFromSetup,
  marketKeyFromValRow,
};
