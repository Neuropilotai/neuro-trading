#!/usr/bin/env node
'use strict';

/**
 * Auto-throttle / auto-kill policy (desk-quant): per-setup replay discipline.
 * Read-only inputs; writes governance/auto_throttle_policy.json via builder.
 * Does not delete setups, mutate manifests, or touch paper_trades.jsonl.
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

/** @returns {object} runtime knobs for build + replay integration */
function parseAutoThrottleEnv() {
  const ms = process.env.NP_AUTO_THROTTLE_REQUIRE_MULTI_SIGNAL_FOR_FREEZE;
  return {
    enable: envBool('NP_AUTO_THROTTLE_ENABLE', false),
    freezeEnable: envBool('NP_AUTO_THROTTLE_FREEZE_ENABLE', true),
    strictFreeze: envBool('NP_AUTO_THROTTLE_STRICT_FREEZE', true),
    negExpectancyPenalty: envNum('NP_AUTO_THROTTLE_NEG_EXPECTANCY_PENALTY', 14),
    lowPfPenalty: envNum('NP_AUTO_THROTTLE_LOW_PF_PENALTY', 12),
    duplicatePressurePenalty: envNum('NP_AUTO_THROTTLE_DUPLICATE_PRESSURE_PENALTY', 10),
    stagnationPenalty: envNum('NP_AUTO_THROTTLE_STAGNATION_PENALTY', 9),
    protectBonus: envNum('NP_AUTO_THROTTLE_PROTECT_BONUS', 6),
    throttlePenalty: envNum('NP_AUTO_THROTTLE_THROTTLE_PENALTY', 12),
    freezePenalty: envNum('NP_AUTO_THROTTLE_FREEZE_PENALTY', 55),
    minTradesForFreeze: Math.max(1, Math.floor(envNum('NP_AUTO_THROTTLE_MIN_TRADES_FOR_FREEZE', 8))),
    requireMultiSignalForFreeze:
      ms == null || ms === ''
        ? true
        : !['0', 'false', 'no', 'off'].includes(String(ms).trim().toLowerCase()),
    protectScoreMin: envNum('NP_AUTO_THROTTLE_PROTECT_SCORE_MIN', 68),
    neutralScoreMin: envNum('NP_AUTO_THROTTLE_NEUTRAL_SCORE_MIN', 42),
    throttleScoreMin: envNum('NP_AUTO_THROTTLE_THROTTLE_SCORE_MIN', 24),
    maxFrozenShare: clamp(envNum('NP_AUTO_THROTTLE_MAX_FROZEN_SHARE', 0.22), 0.05, 0.45),
    maxProtectedShare: clamp(envNum('NP_AUTO_THROTTLE_MAX_PROTECTED_SHARE', 0.35), 0.1, 0.6),
    defaultMaxBars: Math.max(0, Math.floor(envNum('NP_AUTO_THROTTLE_DEFAULT_MAX_BARS', 3))),
    frozenScoreMax: envNum('NP_AUTO_THROTTLE_FROZEN_SCORE_MAX', 22),
  };
}

/**
 * @param {object} ctx
 * @returns {{ autoThrottleScore: number, reasons: {code:string,message:string,value?:number|null}[], negativeSignals: number, positiveSignals: number }}
 */
function scoreAutoThrottleCandidate(ctx) {
  const reasons = [];
  let s = 50;
  let neg = 0;
  let pos = 0;

  const valRow = ctx.valRow || null;
  const tier = valRow && String(valRow.tier || '').trim();
  const strictScore = valRow && toNum(valRow.score, NaN);
  const learningScore = valRow && toNum(valRow.learningScore, NaN);
  const expAll = ctx.expectancyAllTime;
  const exp7 = ctx.expectancy7d;
  const pfAll = ctx.pfAllTime;
  const pf7 = ctx.pf7d;
  const tradesAll = ctx.tradesAllTime;
  const trades7 = ctx.trades7d;
  const replayBoostTier = ctx.replayBoostTier || null;
  const barsReplay = ctx.replayBarsThisSetup;
  const globalDup = ctx.globalDuplicateSkips;
  const effectiveAppended = ctx.effectiveAppendedGlobal;
  const marketCount = ctx.distinctMarketCount || 0;

  if (tier === 'promote_candidate') {
    s += 12;
    pos += 1;
    reasons.push({ code: 'promote_candidate_tier', message: 'Validation tier promote_candidate', value: null });
  }
  if (Number.isFinite(strictScore) && strictScore >= 62) {
    s += 6;
    pos += 1;
    reasons.push({ code: 'strict_score_healthy', message: 'Strict validation score healthy', value: strictScore });
  } else if (Number.isFinite(strictScore) && strictScore < 45) {
    s -= 8;
    neg += 1;
    reasons.push({ code: 'strict_score_weak', message: 'Strict validation score weak', value: strictScore });
  }

  if (Number.isFinite(exp7) && trades7 >= 3 && exp7 < 0) {
    s -= 15;
    neg += 1;
    reasons.push({ code: 'expectancy_7d_negative', message: 'Negative expectancy in recent window', value: exp7 });
  }
  if (Number.isFinite(expAll) && tradesAll >= 5 && expAll < 0) {
    s -= 12;
    neg += 1;
    reasons.push({ code: 'expectancy_alltime_negative', message: 'Negative expectancy all-time with sample', value: expAll });
  }
  if (Number.isFinite(exp7) && exp7 > 0 && Number.isFinite(expAll) && expAll > 0) {
    s += 8;
    pos += 1;
    reasons.push({ code: 'expectancy_positive_both', message: 'Positive expectancy recent and all-time', value: exp7 });
  }

  if (Number.isFinite(pf7) && trades7 >= 3 && pf7 < 0.88) {
    s -= 10;
    neg += 1;
    reasons.push({ code: 'pf_7d_weak', message: 'Profit factor weak in 7d window', value: pf7 });
  }
  if (Number.isFinite(pfAll) && tradesAll >= 5 && pfAll < 0.85) {
    s -= 10;
    neg += 1;
    reasons.push({ code: 'pf_alltime_weak', message: 'Profit factor weak all-time', value: pfAll });
  }
  if (Number.isFinite(pfAll) && pfAll >= 1.05 && tradesAll >= 4) {
    s += 5;
    pos += 1;
    reasons.push({ code: 'pf_acceptable', message: 'Profit factor acceptable', value: pfAll });
  }

  if (globalDup > 400 && Number.isFinite(strictScore) && strictScore < 58) {
    s -= 9;
    neg += 1;
    reasons.push({ code: 'global_duplicate_pressure', message: 'High duplicate skips with middling strict score', value: globalDup });
  }

  if (barsReplay >= 2 && effectiveAppended === 0 && trades7 >= 2) {
    s -= 8;
    neg += 1;
    reasons.push({ code: 'replay_without_global_append', message: 'Replay activity but no effective append globally', value: barsReplay });
  }
  if (barsReplay >= 3 && Number.isFinite(exp7) && exp7 <= 0) {
    s -= 7;
    neg += 1;
    reasons.push({ code: 'replay_stagnation_negative_exp', message: 'Multiple replay bars with non-positive recent expectancy', value: barsReplay });
  }

  if (replayBoostTier === 'boosted') {
    s += 5;
    pos += 1;
    reasons.push({ code: 'replay_boost_boosted', message: 'Replay boost tier boosted', value: null });
  } else if (replayBoostTier === 'throttled' || replayBoostTier === 'frozen') {
    s -= 8;
    neg += 1;
    reasons.push({ code: 'replay_boost_penalized', message: 'Replay boost tier throttled/frozen', value: replayBoostTier });
  }

  if (marketCount >= 2) {
    s += 4;
    pos += 1;
    reasons.push({ code: 'multi_market_hint', message: 'Multiple markets in analysis', value: marketCount });
  } else if (marketCount === 1 && tradesAll >= 12) {
    s -= 4;
    neg += 1;
    reasons.push({ code: 'single_market_only_sampled', message: 'Single market only with material sample', value: marketCount });
  }

  if (ctx.stagnationHint === true) {
    s -= 8;
    neg += 1;
    reasons.push({ code: 'convergence_stagnation', message: 'Promoted convergence trend flat / stagnation hint', value: null });
  }

  if (Number.isFinite(learningScore) && learningScore >= 58 && tier !== 'reject') {
    s += 4;
    pos += 1;
    reasons.push({ code: 'learning_score_ok', message: 'Learning score supportive', value: learningScore });
  }

  s = clamp(Math.round(s * 10) / 10, 0, 100);

  return {
    autoThrottleScore: s,
    reasons,
    negativeSignals: neg,
    positiveSignals: pos,
  };
}

/**
 * @param {number} autoThrottleScore
 * @param {{ negativeSignals: number, positiveSignals: number, tradesAllTime: number }} ctx
 * @param {ReturnType<typeof parseAutoThrottleEnv>} opts
 */
function classifyAutoThrottleDecision(autoThrottleScore, ctx, opts) {
  const { negativeSignals, positiveSignals, tradesAllTime } = ctx;
  if (
    opts.freezeEnable &&
    autoThrottleScore <= opts.frozenScoreMax &&
    tradesAllTime >= opts.minTradesForFreeze
  ) {
    const multiOk = !opts.requireMultiSignalForFreeze || negativeSignals >= 2;
    if (multiOk) return 'FROZEN';
  }
  if (autoThrottleScore >= opts.protectScoreMin && positiveSignals >= 1 && negativeSignals <= 1) {
    return 'PROTECT';
  }
  if (autoThrottleScore <= opts.throttleScoreMin) return 'THROTTLE';
  if (autoThrottleScore < opts.neutralScoreMin) return 'THROTTLE';
  if (autoThrottleScore >= opts.neutralScoreMin && autoThrottleScore < opts.protectScoreMin) return 'NEUTRAL';
  if (negativeSignals >= 3 && autoThrottleScore < opts.protectScoreMin + 5) return 'THROTTLE';
  return 'NEUTRAL';
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

/**
 * @param {{ dataRoot: string, repoRoot: string, opsDir: string }} roots
 */
function loadInputsForAutoThrottleBuild(roots) {
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
    previousPolicy: read(path.join(gov, 'auto_throttle_policy.json')),
    strategyValidation: read(path.join(opsDir, 'strategy_validation.json')),
    latest: read(path.join(opsDir, 'latest.json')),
    health: read(path.join(opsDir, 'neuropilot_health.json')),
    incident: read(path.join(opsDir, 'incident_status.json')),
    circuitBreaker: read(path.join(opsDir, 'circuit_breaker_status.json')),
    smartReplaySelection: read(path.join(opsDir, 'smart_replay_selection.json')),
    trendLines,
  };
}

function collectCandidateSetupKeys(inputs) {
  const keys = new Set();
  const valRows = inputs.strategyValidation && Array.isArray(inputs.strategyValidation.rows)
    ? inputs.strategyValidation.rows
    : [];
  for (const r of valRows) {
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
  const rb = replayBoostPolicyCore.getPolicyAllocationsArray(inputs.replayBoostPolicy || null);
  for (const a of rb) {
    const id = a && a.setupId != null ? String(a.setupId).trim() : '';
    if (id) keys.add(id);
  }
  const addStrict = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const row of arr) {
      const k = row && row.setupKey != null ? String(row.setupKey).trim() : '';
      if (k) keys.add(k);
    }
  };
  const sr = inputs.strictReport || {};
  addStrict(sr.promoted_not_seen_in_paper_last_7d);
  addStrict(sr.promoted_and_paper_recent);
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function buildRowMetrics(setupKey, inputs, ctxBuild) {
  const analysisRow = ctxBuild.analysisMap.get(setupKey) || null;
  const wAll = analysisRow && analysisRow.windows && analysisRow.windows.all_time ? analysisRow.windows.all_time : {};
  const w7 = analysisRow && analysisRow.windows && analysisRow.windows.last_7d ? analysisRow.windows.last_7d : {};
  const exAll = wAll.expectancy != null ? wAll.expectancy : wAll.avgPnl;
  const ex7 = w7.expectancy != null ? w7.expectancy : w7.avgPnl;
  return {
    setupKey,
    strictScore: ctxBuild.valMap.get(setupKey) ? toNum(ctxBuild.valMap.get(setupKey).score, null) : null,
    expectancyAllTime: toNum(exAll, NaN),
    expectancy7d: toNum(ex7, NaN),
    pfAllTime: toNum(wAll.profitFactor, NaN),
    pf7d: toNum(w7.profitFactor, NaN),
    tradesAllTime: Math.floor(toNum(wAll.totalTrades, 0)),
    trades7d: Math.floor(toNum(w7.totalTrades, 0)),
    replayBoostTier: ctxBuild.replayMap.get(setupKey) || null,
    replayBarsThisSetup: ctxBuild.barsBySetup[setupKey] != null ? toNum(ctxBuild.barsBySetup[setupKey], 0) : 0,
    globalDuplicateSkips: ctxBuild.globalDup,
    effectiveAppendedGlobal: ctxBuild.effectiveAppended,
    distinctMarketCount: analysisRow ? distinctMarketCountFromRow(analysisRow) : 0,
    stagnationHint: ctxBuild.stagnationHint,
    valRow: ctxBuild.valMap.get(setupKey) || null,
  };
}

/**
 * @param {ReturnType<typeof loadInputsForAutoThrottleBuild>} inputs
 * @param {ReturnType<typeof parseAutoThrottleEnv>} [optsOverride]
 */
function buildAutoThrottlePolicy(inputs, optsOverride) {
  const opts = optsOverride || parseAutoThrottleEnv();
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
  const vRows = inputs.strategyValidation && Array.isArray(inputs.strategyValidation.rows)
    ? inputs.strategyValidation.rows
    : [];
  for (const r of vRows) {
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

  const ctxBuild = {
    analysisMap,
    valMap,
    replayMap,
    barsBySetup: barsBy,
    globalDup,
    effectiveAppended,
    stagnationHint,
  };

  const prevMap = new Map();
  const prevAlloc = inputs.previousPolicy && Array.isArray(inputs.previousPolicy.allocations)
    ? inputs.previousPolicy.allocations
    : [];
  for (const a of prevAlloc) {
    const k = a && a.setupKey != null ? String(a.setupKey).trim() : '';
    if (k) prevMap.set(k, a);
  }

  let globalThrottleFactor = 1;
  if (policyMode === 'circuit_breaker') globalThrottleFactor = 0.65;
  else if (policyMode === 'critical') globalThrottleFactor = 0.72;
  else if (policyMode === 'degraded') globalThrottleFactor = 0.82;
  else if (policyMode === 'conservative') globalThrottleFactor = 0.9;

  const rawAllocations = [];
  for (const setupKey of collectCandidateSetupKeys(inputs)) {
    const m = buildRowMetrics(setupKey, inputs, ctxBuild);
    const scored = scoreAutoThrottleCandidate(m);
    let decision = classifyAutoThrottleDecision(scored.autoThrottleScore, {
      negativeSignals: scored.negativeSignals,
      positiveSignals: scored.positiveSignals,
      tradesAllTime: m.tradesAllTime,
    }, opts);
    const prev = prevMap.get(setupKey);
    if (prev && prev.decision === 'FROZEN' && decision === 'THROTTLE' && scored.autoThrottleScore < 35) {
      decision = 'FROZEN';
      scored.reasons.push({
        code: 'hysteresis_prior_frozen',
        message: 'Retained FROZEN from prior policy (weak score)',
        value: null,
      });
    }

    const replayWeight =
      decision === 'PROTECT'
        ? 1.05
        : decision === 'NEUTRAL'
          ? 1
          : decision === 'THROTTLE'
            ? 0.55
            : 0;

    const baseBars = opts.defaultMaxBars;
    let maxBars = baseBars;
    if (decision === 'THROTTLE') maxBars = Math.max(0, Math.min(maxBars, 2));
    if (decision === 'FROZEN') maxBars = 0;
    if (decision === 'PROTECT') maxBars = Math.max(maxBars, baseBars);
    maxBars = Math.max(0, Math.floor(maxBars * globalThrottleFactor));

    const bypassEligible = decision !== 'FROZEN' && decision !== 'THROTTLE';

    const selectionPenalty =
      decision === 'PROTECT'
        ? -Math.abs(opts.protectBonus)
        : decision === 'NEUTRAL'
          ? 0
          : decision === 'THROTTLE'
            ? Math.abs(opts.throttlePenalty)
            : Math.abs(opts.freezePenalty);

    rawAllocations.push({
      setupKey,
      decision,
      autoThrottleScore: scored.autoThrottleScore,
      recommendedReplayWeight: Math.round(replayWeight * 100) / 100,
      recommendedMaxBarsPerSetup: maxBars,
      recommendedBypassEligibility: bypassEligible,
      recommendedSelectionPenalty: selectionPenalty,
      reasons: scored.reasons.slice(0, 14),
      metricsSnapshot: {
        strictScore: m.strictScore,
        expectancy7d: Number.isFinite(m.expectancy7d) ? m.expectancy7d : null,
        expectancyAllTime: Number.isFinite(m.expectancyAllTime) ? m.expectancyAllTime : null,
        pf7d: Number.isFinite(m.pf7d) ? m.pf7d : null,
        pfAllTime: Number.isFinite(m.pfAllTime) ? m.pfAllTime : null,
        trades7d: m.trades7d,
        tradesAllTime: m.tradesAllTime,
        replayBarsThisSetup: m.replayBarsThisSetup,
        replayBoostTier: m.replayBoostTier,
        distinctMarketCount: m.distinctMarketCount,
        negativeSignals: scored.negativeSignals,
        positiveSignals: scored.positiveSignals,
      },
    });
  }

  const n = rawAllocations.length || 1;
  let frozen = rawAllocations.filter((a) => a.decision === 'FROZEN');
  const maxFrozen = Math.max(1, Math.ceil(n * opts.maxFrozenShare));
  if (frozen.length > maxFrozen) {
    frozen.sort((a, b) => a.autoThrottleScore - b.autoThrottleScore);
    const keep = new Set(frozen.slice(0, maxFrozen).map((x) => x.setupKey));
    for (const a of rawAllocations) {
      if (a.decision === 'FROZEN' && !keep.has(a.setupKey)) {
        a.decision = 'THROTTLE';
        a.recommendedMaxBarsPerSetup = Math.max(0, Math.min(a.recommendedMaxBarsPerSetup, 1));
        a.recommendedReplayWeight = 0.5;
        a.recommendedBypassEligibility = false;
        a.recommendedSelectionPenalty = Math.abs(opts.throttlePenalty);
        a.reasons.push({
          code: 'frozen_cap_downgrade',
          message: 'Downgraded from FROZEN to THROTTLE (max frozen share)',
          value: opts.maxFrozenShare,
        });
      }
    }
  }

  let protect = rawAllocations.filter((a) => a.decision === 'PROTECT');
  const maxProt = Math.max(1, Math.ceil(n * opts.maxProtectedShare));
  if (protect.length > maxProt) {
    protect.sort((a, b) => b.autoThrottleScore - a.autoThrottleScore);
    const keepP = new Set(protect.slice(0, maxProt).map((x) => x.setupKey));
    for (const a of rawAllocations) {
      if (a.decision === 'PROTECT' && !keepP.has(a.setupKey)) {
        a.decision = 'NEUTRAL';
        a.recommendedReplayWeight = 1;
        a.recommendedMaxBarsPerSetup = Math.max(0, Math.floor(opts.defaultMaxBars * globalThrottleFactor));
        a.recommendedBypassEligibility = true;
        a.recommendedSelectionPenalty = 0;
        a.reasons.push({
          code: 'protect_cap_downgrade',
          message: 'Downgraded from PROTECT to NEUTRAL (max protected share)',
          value: opts.maxProtectedShare,
        });
      }
    }
  }

  const summary = {
    candidateCount: rawAllocations.length,
    protectCount: rawAllocations.filter((a) => a.decision === 'PROTECT').length,
    neutralCount: rawAllocations.filter((a) => a.decision === 'NEUTRAL').length,
    throttleCount: rawAllocations.filter((a) => a.decision === 'THROTTLE').length,
    frozenCount: rawAllocations.filter((a) => a.decision === 'FROZEN').length,
  };

  const globalControls = {
    recommendedGlobalThrottleFactor: globalThrottleFactor,
    recommendedMaxFrozenShare: opts.maxFrozenShare,
    recommendedMaxProtectedShare: opts.maxProtectedShare,
    policyModeDerived: policyMode,
  };

  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    dataRoot: inputs.dataRoot,
    policyMode,
    summary,
    globalControls,
    inputsProvenance: {
      lastRunPresent: Boolean(inputs.lastRun && Object.keys(inputs.lastRun).length),
      analysisRows: analysisMap.size,
      validationRows: valMap.size,
      replayBoostAllocations: replayBoostPolicyCore.getPolicyAllocationsArray(inputs.replayBoostPolicy || null)
        .length,
      trendLinesUsed: (inputs.trendLines || []).length,
    },
    allocations: rawAllocations.sort((a, b) => a.setupKey.localeCompare(b.setupKey)),
  };
}

function policyDocumentForWrite(doc) {
  if (!doc) return doc;
  const { inputsProvenance, ...rest } = doc;
  return rest;
}

function loadAutoThrottlePolicy(policyPath) {
  const doc = readJsonSafe(policyPath);
  if (!doc || doc.schemaVersion !== POLICY_SCHEMA_VERSION) return null;
  if (!Array.isArray(doc.allocations)) return null;
  return doc;
}

function writeAutoThrottlePolicy(policyPath, doc) {
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  const out = policyDocumentForWrite(doc) || doc;
  fs.writeFileSync(policyPath, JSON.stringify(out, null, 2), 'utf8');
}

function buildAutoThrottleRowBySetupMap(policyDoc) {
  const m = new Map();
  if (!policyDoc || !Array.isArray(policyDoc.allocations)) return m;
  for (const a of policyDoc.allocations) {
    const k = a && a.setupKey != null ? String(a.setupKey).trim() : '';
    if (k) m.set(k, a);
  }
  return m;
}

/**
 * Selection score adjustment from allocation row (for smart replay fusion).
 * selectionPenalty: positive = bad (we subtract from score after inverting).
 * Actually row.recommendedSelectionPenalty: PROTECT stored as negative bonus magnitude.
 */
function computeAutoThrottleAdjustment(row, envOpts) {
  const codes = [];
  if (!row) return { adj: 0, codes, decision: null, recommendedMaxBarsPerSetup: null, bypassEligible: true };

  const decision = String(row.decision || 'NEUTRAL').toUpperCase();
  let adj = 0;

  if (decision === 'PROTECT') {
    adj += Math.abs(toNum(envOpts.protectBonus, 6));
    codes.push('auto_throttle_protect_bonus');
  } else if (decision === 'NEUTRAL') {
    adj += 0;
    codes.push('auto_throttle_neutral');
  } else if (decision === 'THROTTLE') {
    adj -= Math.abs(toNum(envOpts.throttlePenalty, 12));
    codes.push('auto_throttle_throttle_penalty');
  } else if (decision === 'FROZEN') {
    adj -= Math.abs(toNum(envOpts.freezePenalty, 55));
    codes.push('auto_throttle_freeze_penalty');
  }

  return {
    adj: Math.round(adj * 100) / 100,
    codes,
    decision,
    recommendedMaxBarsPerSetup:
      row.recommendedMaxBarsPerSetup != null ? Math.max(0, Math.floor(toNum(row.recommendedMaxBarsPerSetup, 3))) : null,
    bypassEligible: row.recommendedBypassEligibility !== false,
  };
}

module.exports = {
  POLICY_SCHEMA_VERSION,
  parseAutoThrottleEnv,
  scoreAutoThrottleCandidate,
  classifyAutoThrottleDecision,
  loadInputsForAutoThrottleBuild,
  buildAutoThrottlePolicy,
  loadAutoThrottlePolicy,
  writeAutoThrottlePolicy,
  policyDocumentForWrite,
  buildAutoThrottleRowBySetupMap,
  computeAutoThrottleAdjustment,
};
