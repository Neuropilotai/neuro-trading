#!/usr/bin/env node
'use strict';

/**
 * Renewal shadow → graduation report (read-only).
 *
 * Reads:
 *   <dataRoot>/governance/paper_trades.jsonl (live)
 *   <dataRoot>/governance/paper_trades_renewal_shadow.jsonl (shadow → split injected / base)
 *   <dataRoot>/governance/paper_exec_v1_last_run_shadow.json (optional snapshot)
 *   engine/governance/renewalShadowEvaluationPolicy.v1.json (thresholds)
 *
 * Writes:
 *   <dataRoot>/governance/renewal_shadow_evaluation_report.json
 *
 * Does NOT: write live JSONL, touch throttle, smart replay, promotion, or any execution path.
 *
 * Env overrides (optional):
 *   NP_RENEWAL_EVAL_LIVE_JSONL, NP_RENEWAL_EVAL_SHADOW_JSONL, NP_RENEWAL_EVAL_LAST_RUN_SHADOW,
 *   NP_RENEWAL_EVAL_OUT, NP_RENEWAL_EVAL_POLICY
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dataRoot = require('../dataRoot');

const DEFAULT_POLICY = path.join(__dirname, 'renewalShadowEvaluationPolicy.v1.json');

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function parseJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

function isValidTrade(t) {
  if (!t || typeof t !== 'object') return false;
  if (String(t.reason || '').toLowerCase() === 'skip') return false;
  return Number.isFinite(Number(t.pnl));
}

function strategyKey(t) {
  const s = String(t.strategyId || '').trim();
  if (s) return s;
  const u = String(t.setupId || '').trim();
  if (u) return u;
  return 'unknown';
}

function round8(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.round(x * 1e8) / 1e8;
}

/**
 * @param {object[]} trades
 * @returns {object}
 */
function computeRenewalMetrics(trades) {
  const valid = trades.filter(isValidTrade);
  const n = valid.length;
  const empty = {
    tradeCount: 0,
    winRate: null,
    avgPnl: null,
    expectancy: null,
    profitFactor: null,
    profitFactorInfinite: false,
    outcomeMix: {},
    avgBarsHeld: null,
    worstSinglePnl: null,
    cvarProxy: null,
    pnlVariance: null,
    coefficientOfVariation: null,
    maxDrawdownProxy: null,
  };
  if (n === 0) return empty;

  const pnls = valid.map((t) => Number(t.pnl));
  const wins = pnls.filter((p) => p > 0).length;
  const sumPnl = pnls.reduce((a, b) => a + b, 0);
  const avg = sumPnl / n;
  const sumWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const sumLoss = pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0);

  let profitFactor = null;
  let profitFactorInfinite = false;
  if (sumLoss === 0) {
    if (sumWin > 0) profitFactorInfinite = true;
  } else {
    profitFactor = round8(sumWin / Math.abs(sumLoss));
  }

  const mix = {};
  for (const t of valid) {
    const r = String(t.reason || 'unknown').trim() || 'unknown';
    mix[r] = (mix[r] || 0) + 1;
  }

  const bars = valid.map((t) => Number(t.barsHeld)).filter((x) => Number.isFinite(x));
  const avgBarsHeld = bars.length ? round8(bars.reduce((a, b) => a + b, 0) / bars.length) : null;

  const sorted = [...pnls].sort((a, b) => a - b);
  const worstSinglePnl = sorted[0];
  const k = Math.min(Math.max(1, 5), n);
  const worstSlice = sorted.slice(0, k);
  const cvarProxy = round8(worstSlice.reduce((a, b) => a + b, 0) / k);

  const mean = avg;
  const varP =
    n > 1 ? pnls.reduce((acc, p) => acc + (p - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(varP);
  const coefficientOfVariation =
    Math.abs(mean) > 1e-12 ? round8(stdev / Math.abs(mean)) : null;

  const ordered = [...valid].sort((a, b) => {
    const ta = String(a.simulatedAt || '');
    const tb = String(b.simulatedAt || '');
    if (ta && tb && ta !== tb) return ta.localeCompare(tb);
    return 0;
  });
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const t of ordered) {
    cum += Number(t.pnl);
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDd) maxDd = dd;
  }
  const maxDrawdownProxy = round8(maxDd);

  return {
    tradeCount: n,
    winRate: round8(wins / n),
    avgPnl: round8(avg),
    expectancy: round8(avg),
    profitFactor,
    profitFactorInfinite,
    outcomeMix: mix,
    avgBarsHeld,
    worstSinglePnl: round8(worstSinglePnl),
    cvarProxy,
    pnlVariance: round8(varP),
    coefficientOfVariation,
    maxDrawdownProxy,
  };
}

function metricsByKey(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  const out = {};
  const keys = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
  for (const k of keys) {
    out[k] = computeRenewalMetrics(map.get(k));
  }
  return out;
}

function compareSegments(mA, mB) {
  const dE =
    mA.expectancy != null && mB.expectancy != null
      ? round8(mA.expectancy - mB.expectancy)
      : null;
  const dPf =
    mA.profitFactor != null && mB.profitFactor != null
      ? round8(mA.profitFactor - mB.profitFactor)
      : null;
  const dDd =
    mA.maxDrawdownProxy != null && mB.maxDrawdownProxy != null
      ? round8(mA.maxDrawdownProxy - mB.maxDrawdownProxy)
      : null;
  return {
    deltaExpectancy: dE,
    deltaProfitFactor: dPf,
    drawdownProxyDelta: dDd,
  };
}

function consecutiveStopMax(trades) {
  const ordered = [...trades].filter(isValidTrade).sort((a, b) => {
    const ta = String(a.simulatedAt || '');
    const tb = String(b.simulatedAt || '');
    return ta.localeCompare(tb);
  });
  let run = 0;
  let maxRun = 0;
  for (const t of ordered) {
    const r = String(t.reason || '').toLowerCase();
    const stopish =
      r.includes('stop') && !r.includes('target');
    if (stopish) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  return maxRun;
}

function datasetShare(trades) {
  const valid = trades.filter(isValidTrade);
  const n = valid.length;
  if (!n) return { maxShare: null, dominantDatasetKey: null };
  const counts = {};
  for (const t of valid) {
    const dk = t.datasetKey != null ? String(t.datasetKey).trim() : 'unknown';
    counts[dk] = (counts[dk] || 0) + 1;
  }
  let dom = null;
  let mx = 0;
  for (const [k, c] of Object.entries(counts)) {
    if (c > mx) {
      mx = c;
      dom = k;
    }
  }
  return { maxShare: round8(mx / n), dominantDatasetKey: dom };
}

function worstBucketExpectancy(metricsByDataset) {
  let worst = null;
  for (const [dk, m] of Object.entries(metricsByDataset)) {
    if (m.tradeCount === 0) continue;
    if (m.expectancy == null) continue;
    if (worst == null || m.expectancy < worst.expectancy) {
      worst = { datasetKey: dk, expectancy: m.expectancy, tradeCount: m.tradeCount };
    }
  }
  return worst;
}

function evaluateStrategyGraduation({
  strategyId,
  inj,
  base,
  live,
  policy,
  globalInjectedTrades,
}) {
  const th = policy.thresholds || {};
  const labels = policy.labels || {};
  const nMin = Math.max(0, Math.floor(Number(th.nMinPerStrategy) || 0));
  const pfMin = Number(th.profitFactorMin);
  const deltaE = Number(th.deltaExpectancyVsLive);
  const deltaPf = Number(th.deltaProfitFactorVsLive);
  const nLiveFloor = Math.max(0, Math.floor(Number(th.nLiveFloorForComparative) || 0));
  const cvarK = Math.max(1, Math.floor(Number(th.cvarWorstCount) || 5));
  const maxDs = th.maxDatasetShare != null ? Number(th.maxDatasetShare) : null;
  const cvMax = th.maxCoefficientOfVariation != null ? Number(th.maxCoefficientOfVariation) : null;
  const consecStop = Math.max(0, Math.floor(Number(th.consecutiveStopsForExclusion) || 0));
  const beta = Number(th.setupDominanceShareBeta);
  const minPerDs = Math.max(0, Math.floor(Number(th.minTradesPerDatasetBucket) || 0));
  const wFloor = th.worstSingleTradeFloor != null ? Number(th.worstSingleTradeFloor) : null;

  const mInj = computeRenewalMetrics(inj);
  const mLive = computeRenewalMetrics(live);
  const mBase = computeRenewalMetrics(base);

  const gateResults = {};
  const exclusionsTriggered = [];
  const notes = [];

  if (consecStop > 0 && consecutiveStopMax(inj) >= consecStop) {
    exclusionsTriggered.push('consecutive_stops');
  }

  if (Number.isFinite(beta) && beta > 0 && beta < 1 && globalInjectedTrades.length > 0) {
    const share = inj.length / globalInjectedTrades.length;
    if (share > beta) {
      const others = globalInjectedTrades.filter((t) => strategyKey(t) !== strategyId);
      const mOthers = computeRenewalMetrics(others);
      if (others.length > 0 && mOthers.expectancy != null && mOthers.expectancy < 0) {
        exclusionsTriggered.push('setup_dominance_negative_rest');
      }
    }
  }

  gateResults.H1_trade_count = mInj.tradeCount >= nMin;
  gateResults.H2_expectancy_positive = mInj.expectancy != null && mInj.expectancy > 0;
  let pfOk = true;
  if (Number.isFinite(pfMin) && pfMin > 0) {
    if (mInj.profitFactorInfinite) pfOk = true;
    else if (mInj.profitFactor == null) pfOk = false;
    else pfOk = mInj.profitFactor >= pfMin;
  }
  gateResults.H3_profit_factor = pfOk;

  let hWorst = true;
  if (wFloor != null && Number.isFinite(wFloor) && mInj.worstSinglePnl != null) {
    hWorst = mInj.worstSinglePnl >= wFloor;
  }
  gateResults.H4_worst_trade_floor = hWorst;

  const byDs = metricsByKey(inj, (t) =>
    t.datasetKey != null && String(t.datasetKey).trim() ? String(t.datasetKey).trim() : 'unknown'
  );
  let hDataset = true;
  for (const [dk, mm] of Object.entries(byDs)) {
    if (mm.tradeCount >= minPerDs && mm.expectancy != null && mm.expectancy < 0) {
      hDataset = false;
      notes.push(`dataset_bucket_negative:${dk}`);
      break;
    }
  }
  gateResults.H5_no_negative_dataset_bucket = hDataset;

  const { maxShare } = datasetShare(inj);
  let sShare = true;
  if (maxDs != null && Number.isFinite(maxDs) && maxShare != null) {
    sShare = maxShare <= maxDs;
  }
  gateResults.S2_dataset_concentration = sShare;

  let sCv = true;
  if (cvMax != null && Number.isFinite(cvMax) && mInj.coefficientOfVariation != null) {
    sCv = mInj.coefficientOfVariation <= cvMax;
  }
  gateResults.S3_coefficient_of_variation = sCv;

  const hardOk =
    gateResults.H1_trade_count &&
    gateResults.H2_expectancy_positive &&
    gateResults.H3_profit_factor &&
    gateResults.H4_worst_trade_floor &&
    gateResults.H5_no_negative_dataset_bucket &&
    exclusionsTriggered.length === 0;

  let relativeOk = false;
  if (mLive.tradeCount >= nLiveFloor && mLive.expectancy != null && mInj.expectancy != null) {
    const de = mInj.expectancy - mLive.expectancy;
    const dpf =
      mInj.profitFactor != null && mLive.profitFactor != null
        ? mInj.profitFactor - mLive.profitFactor
        : null;
    relativeOk = de >= deltaE && (dpf == null || dpf >= deltaPf);
    gateResults.R_vs_live_expectancy = de >= deltaE;
    gateResults.R_vs_live_pf = dpf == null || dpf >= deltaPf;
    notes.push('comparative_reference_live');
    if (mBase.tradeCount > 0 && mBase.expectancy != null) {
      gateResults.R_vs_shadowBase_expectancy = mInj.expectancy >= mBase.expectancy + deltaE;
    } else {
      gateResults.R_vs_shadowBase_expectancy = null;
    }
  } else if (mBase.tradeCount > 0 && mBase.expectancy != null && mInj.expectancy != null) {
    relativeOk = mInj.expectancy >= mBase.expectancy + deltaE;
    gateResults.R_vs_live_expectancy = null;
    gateResults.R_vs_live_pf = null;
    gateResults.R_vs_shadowBase_expectancy = relativeOk;
    notes.push('comparative_reference_shadowBase');
  } else {
    gateResults.R_vs_live_expectancy = null;
    gateResults.R_vs_live_pf = null;
    gateResults.R_vs_shadowBase_expectancy = null;
    relativeOk = false;
    notes.push('no_comparative_reference');
  }

  let level = 0;
  let label = labels['0'] || 'reject';

  if (exclusionsTriggered.length > 0) {
    level = 0;
    label = labels['0'] || 'reject';
  } else if (!hardOk) {
    level = 0;
    label = labels['0'] || 'reject';
  } else if (!relativeOk) {
    level = 1;
    label = labels['1'] || 'observe';
  } else if (!sShare || !sCv) {
    level = 2;
    label = labels['2'] || 'candidate';
  } else {
    const autoMax = Math.min(3, Math.max(0, Math.floor(Number(th.autoPolicyIntegrationMaxLevel) || 3)));
    level = Math.min(3, autoMax);
    label = labels[String(level)] || 'controlled_promotion';
  }

  return {
    strategyId,
    setupId: inj[0] && inj[0].setupId != null ? String(inj[0].setupId).trim() : null,
    graduationLevel: level,
    graduationLabel: label,
    gateResults,
    exclusionsTriggered,
    notes,
    metricsSummary: {
      tradeCountInjected: mInj.tradeCount,
      tradeCountLive: mLive.tradeCount,
      tradeCountShadowBase: mBase.tradeCount,
      expectancyInjected: mInj.expectancy,
      expectancyLive: mLive.expectancy,
      expectancyShadowBase: mBase.expectancy,
      profitFactorInjected: mInj.profitFactorInfinite ? null : mInj.profitFactor,
      profitFactorInfiniteInjected: mInj.profitFactorInfinite,
      cvarProxyInjected: mInj.cvarProxy,
      cvarWorstCount: cvarK,
    },
  };
}

function inputHashParts({ livePath, shadowPath, policyVersion, liveTrades, shadowTrades, policyRaw }) {
  const pol = crypto.createHash('sha256').update(JSON.stringify(policyRaw)).digest('hex').slice(0, 16);
  const h = crypto.createHash('sha256');
  h.update(policyVersion || '');
  h.update('|');
  h.update(pol);
  h.update('|');
  h.update(String(livePath || ''));
  h.update('|');
  h.update(String(shadowPath || ''));
  h.update('|');
  h.update(String(liveTrades.length));
  h.update('|');
  h.update(String(shadowTrades.length));
  for (const t of liveTrades) {
    if (isValidTrade(t)) h.update(String(t.strategyId || t.setupId || ''));
  }
  for (const t of shadowTrades) {
    if (isValidTrade(t)) h.update(String(t.strategyId || t.setupId || ''));
  }
  return `sha256:${h.digest('hex')}`;
}

function main() {
  const root = dataRoot.getDataRoot();
  const govDir = path.join(root, 'governance');
  const livePath =
    process.env.NP_RENEWAL_EVAL_LIVE_JSONL || path.join(govDir, 'paper_trades.jsonl');
  const shadowPath =
    process.env.NP_RENEWAL_EVAL_SHADOW_JSONL ||
    path.join(govDir, 'paper_trades_renewal_shadow.jsonl');
  const lastRunPath =
    process.env.NP_RENEWAL_EVAL_LAST_RUN_SHADOW ||
    path.join(govDir, 'paper_exec_v1_last_run_shadow.json');
  const outPath =
    process.env.NP_RENEWAL_EVAL_OUT ||
    path.join(govDir, 'renewal_shadow_evaluation_report.json');
  const policyPath = process.env.NP_RENEWAL_EVAL_POLICY || DEFAULT_POLICY;

  const policy = readJsonSafe(policyPath);
  if (!policy || !policy.policyVersion) {
    console.error(`[renewal_graduation] missing or invalid policy: ${policyPath}`);
    process.exit(1);
  }

  const liveTrades = parseJsonl(livePath);
  const shadowTrades = parseJsonl(shadowPath);
  const shadowInjected = shadowTrades.filter((t) => t && t.shadowInjection === true);
  const shadowBase = shadowTrades.filter((t) => !t || t.shadowInjection !== true);

  const segLive = computeRenewalMetrics(liveTrades);
  const segBase = computeRenewalMetrics(shadowBase);
  const segInj = computeRenewalMetrics(shadowInjected);

  const comparisons = {
    shadowInjected_vs_live: compareSegments(segInj, segLive),
    shadowBase_vs_live: compareSegments(segBase, segLive),
    shadowInjected_vs_shadowBase: compareSegments(segInj, segBase),
  };

  const lastRunSnapshot = readJsonSafe(lastRunPath);
  const lrSnap =
    lastRunSnapshot && typeof lastRunSnapshot === 'object'
      ? {
          renewalInjectionSignalsAdded: lastRunSnapshot.renewalInjectionSignalsAdded ?? null,
          renewalShadowTradesWritten: lastRunSnapshot.renewalShadowTradesWritten ?? null,
          renewalShadowInjectedTradesWritten:
            lastRunSnapshot.renewalShadowInjectedTradesWritten ?? null,
          renewalShadowBaseTradesWritten: lastRunSnapshot.renewalShadowBaseTradesWritten ?? null,
        }
      : {
          renewalInjectionSignalsAdded: null,
          renewalShadowTradesWritten: null,
          renewalShadowInjectedTradesWritten: null,
          renewalShadowBaseTradesWritten: null,
        };

  const strategyIds = new Set();
  for (const t of shadowInjected) {
    strategyIds.add(strategyKey(t));
  }

  const strategies = [];
  for (const sid of Array.from(strategyIds).sort((a, b) => a.localeCompare(b))) {
    const inj = shadowInjected.filter((t) => strategyKey(t) === sid);
    const base = shadowBase.filter((t) => strategyKey(t) === sid);
    const live = liveTrades.filter((t) => strategyKey(t) === sid);
    strategies.push(
      evaluateStrategyGraduation({
        strategyId: sid,
        inj,
        base,
        live,
        policy,
        globalInjectedTrades: shadowInjected,
      })
    );
  }

  const maxLevel =
    strategies.length === 0 ? 0 : Math.max(...strategies.map((s) => s.graduationLevel));

  const report = {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    generatedAt: new Date().toISOString(),
    inputs: {
      liveTradesPath: path.resolve(livePath),
      shadowTradesPath: path.resolve(shadowPath),
      shadowLastRunPath: path.resolve(lastRunPath),
      policyPath: path.resolve(policyPath),
      inputHash: inputHashParts({
        livePath,
        shadowPath,
        policyVersion: policy.policyVersion,
        liveTrades,
        shadowTrades,
        policyRaw: policy,
      }),
      lineCounts: {
        live: liveTrades.length,
        shadow: shadowTrades.length,
        shadowInjected: shadowInjected.length,
        shadowBase: shadowBase.length,
      },
    },
    lastRunSnapshot: lrSnap,
    segments: {
      live: {
        metrics: segLive,
        byDatasetKey: metricsByKey(liveTrades, (t) =>
          t.datasetKey != null && String(t.datasetKey).trim()
            ? String(t.datasetKey).trim()
            : 'unknown'
        ),
        byStrategyId: metricsByKey(liveTrades, strategyKey),
      },
      shadowBase: {
        metrics: segBase,
        byDatasetKey: metricsByKey(shadowBase, (t) =>
          t.datasetKey != null && String(t.datasetKey).trim()
            ? String(t.datasetKey).trim()
            : 'unknown'
        ),
        byStrategyId: metricsByKey(shadowBase, strategyKey),
      },
      shadowInjected: {
        metrics: segInj,
        byDatasetKey: metricsByKey(shadowInjected, (t) =>
          t.datasetKey != null && String(t.datasetKey).trim()
            ? String(t.datasetKey).trim()
            : 'unknown'
        ),
        byStrategyId: metricsByKey(shadowInjected, strategyKey),
      },
    },
    comparisons,
    institutional: {
      tailRisk: {
        shadowInjected: {
          worstSinglePnl: segInj.worstSinglePnl,
          cvarProxy: segInj.cvarProxy,
        },
        live: {
          worstSinglePnl: segLive.worstSinglePnl,
          cvarProxy: segLive.cvarProxy,
        },
      },
      worstDatasetBucketInjected: worstBucketExpectancy(
        metricsByKey(shadowInjected, (t) =>
          t.datasetKey != null && String(t.datasetKey).trim()
            ? String(t.datasetKey).trim()
            : 'unknown'
        )
      ),
    },
    strategies,
    globalVerdict: {
      maxLevel,
      strategiesEvaluated: strategies.length,
      summary: `maxLevel=${maxLevel} strategiesEvaluated=${strategies.length} policy=${policy.policyVersion}`,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  const candidatesPath = path.join(path.dirname(outPath), 'renewal_shadow_graduation_candidates.json');
  const candBody = {
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    generatedAt: report.generatedAt,
    minLevel: 2,
    candidates: strategies
      .filter((s) => s.graduationLevel >= 2)
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId)),
  };
  fs.writeFileSync(candidatesPath, JSON.stringify(candBody, null, 2), 'utf8');

  console.error(
    `[renewal_graduation] wrote ${outPath} + ${candidatesPath} (strategies=${strategies.length} maxLevel=${maxLevel})`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  parseJsonl,
  isValidTrade,
  computeRenewalMetrics,
  metricsByKey,
  compareSegments,
  evaluateStrategyGraduation,
  inputHashParts,
};
