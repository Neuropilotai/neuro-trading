'use strict';

/**
 * Lightweight adaptive policy layer (tabular / bucket scores, not a neural net).
 * Advisory only — does not execute trades. Best-effort persistence.
 */

const fs = require('fs').promises;
const path = require('path');
const closedTradeAnalyticsService = require('./closedTradeAnalyticsService');
const tradeLifecycleService = require('./tradeLifecycleService');

function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getLearningStatePath() {
  return path.join(getDataDir(), 'learning_state_v2.json');
}

function parseThresholds() {
  return {
    promoteScore: parseFloat(process.env.RL_PROMOTE_SCORE || '0.75'),
    promoteConfidence: parseFloat(process.env.RL_PROMOTE_CONFIDENCE || '0.6'),
    keepScore: parseFloat(process.env.RL_KEEP_SCORE || '0.45'),
    throttleScore: parseFloat(process.env.RL_THROTTLE_SCORE || '0.2'),
    demoteScore: parseFloat(process.env.RL_DEMOTE_SCORE || '-0.1'),
    suspendScore: parseFloat(process.env.RL_SUSPEND_SCORE || '-0.1'),
    suspendConfidence: parseFloat(process.env.RL_SUSPEND_CONFIDENCE || '0.45'),
    minSamplesForConfidence: parseInt(process.env.RL_MIN_SAMPLES || '8', 10),
    maxBuckets: parseInt(process.env.RL_MAX_BUCKETS || '400', 10),
  };
}

function round4(x) {
  return Math.round(Number(x) * 1e4) / 1e4;
}

function _mean(arr) {
  const a = (arr || []).filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}

function _stdSample(arr) {
  const a = (arr || []).filter(Number.isFinite);
  if (a.length < 2) return 0;
  const m = _mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}

function bucketKeysForTrade(t) {
  const s = t.strategy != null ? String(t.strategy) : 'null';
  const sym = String(t.symbol || '').toUpperCase().trim() || 'UNKNOWN';
  const reg = t.regime != null ? String(t.regime) : 'unknown';
  const hour =
    t.closedAtHourUTC != null ? String(t.closedAtHourUTC) : String(new Date(t.exitTimestamp || 0).getUTCHours());
  return [
    `strategy|${s}`,
    `symbol|${sym}`,
    `regime|${reg}`,
    `hourUTC|${hour}`,
    `strategy+regime|${s}|${reg}`,
    `symbol+hourUTC|${sym}|${hour}`,
  ];
}

function emptyAcc() {
  return {
    count: 0,
    wins: 0,
    losses: 0,
    sumPnl: 0,
    sumWin: 0,
    sumLoss: 0,
    pnls: [],
    mfes: [],
    maes: [],
    effs: [],
    holds: [],
    mini: [],
  };
}

/**
 * Aggregate closed trades into RL state buckets (LONG-aware; SHORT-ready keying).
 */
function buildStateBuckets(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  const map = new Map();

  for (const t of rows) {
    const keys = bucketKeysForTrade(t);
    const pnl = Number(t.realizedPnL) || 0;
    for (const k of keys) {
      if (!map.has(k)) map.set(k, emptyAcc());
      const acc = map.get(k);
      acc.count++;
      acc.sumPnl += pnl;
      acc.pnls.push(pnl);
      if (pnl > 0) {
        acc.wins++;
        acc.sumWin += pnl;
      } else if (pnl < 0) {
        acc.losses++;
        acc.sumLoss += pnl;
      }
      if (Number.isFinite(Number(t.mfe))) acc.mfes.push(Number(t.mfe));
      if (Number.isFinite(Number(t.mae))) acc.maes.push(Number(t.mae));
      if (Number.isFinite(Number(t.efficiencyRatio))) acc.effs.push(Number(t.efficiencyRatio));
      acc.holds.push(Number(t.holdingTimeSec) || 0);
      acc.mini.push({
        exitTimestamp: t.exitTimestamp || '',
        pnl,
      });
    }
  }

  const buckets = {};
  for (const [key, acc] of map) {
    buckets[key] = finalizeBucketAccumulator(key, acc);
  }
  return buckets;
}

function streaksFromMini(mini) {
  const chrono = [...mini].sort((a, b) =>
    String(a.exitTimestamp).localeCompare(String(b.exitTimestamp))
  );
  let winStreak = 0;
  let lossStreak = 0;
  let curW = 0;
  let curL = 0;
  for (const x of chrono) {
    if (x.pnl > 0) {
      curW++;
      curL = 0;
      winStreak = Math.max(winStreak, curW);
    } else if (x.pnl < 0) {
      curL++;
      curW = 0;
      lossStreak = Math.max(lossStreak, curL);
    } else {
      curW = 0;
      curL = 0;
    }
  }
  return { winStreak, lossStreak, currentWinStreak: curW, currentLossStreak: curL };
}

function drawdownPressure(mini) {
  const chrono = [...mini].sort((a, b) =>
    String(a.exitTimestamp).localeCompare(String(b.exitTimestamp))
  );
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const x of chrono) {
    cum += x.pnl;
    if (cum > peak) peak = cum;
    maxDd = Math.max(maxDd, peak - cum);
  }
  const range = Math.max(1e-9, Math.abs(peak) + Math.abs(cum));
  return maxDd / range;
}

function finalizeBucketAccumulator(bucketKey, acc) {
  const n = acc.count;
  const wr = n > 0 ? acc.wins / n : 0;
  const avgWin = acc.wins > 0 ? acc.sumWin / acc.wins : 0;
  const avgLoss = acc.losses > 0 ? acc.sumLoss / acc.losses : 0;
  const lossMag = acc.losses > 0 ? Math.abs(avgLoss) : 0;
  const expectancy = wr * avgWin - (1 - wr) * lossMag;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const p of acc.pnls) {
    if (p > 0) grossProfit += p;
    if (p < 0) grossLoss += p;
  }
  const profitFactor = grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : null;
  const sig = _stdSample(acc.pnls);
  const sharpeProxy = sig > 1e-12 ? _mean(acc.pnls) / sig : null;
  const avgMFE = acc.mfes.length ? _mean(acc.mfes) : null;
  const avgMAE = acc.maes.length ? _mean(acc.maes) : null;
  const avgEfficiency = acc.effs.length ? _mean(acc.effs) : null;
  const avgHoldingTimeSec = acc.holds.length ? Math.round(_mean(acc.holds)) : 0;
  const payoffRatio =
    acc.losses > 0 && lossMag > 0 && avgWin !== 0 ? avgWin / lossMag : null;

  const st = streaksFromMini(acc.mini);
  const ddPressure = drawdownPressure(acc.mini);
  const m = _mean(acc.pnls);
  const cv = Math.abs(m) > 1e-9 ? sig / Math.abs(m) : sig;
  const stabilityScore = Math.max(0, Math.min(1, 1 / (1 + cv)));

  const T = parseThresholds();
  const sampleConfidence = Math.min(1, n / Math.max(1, T.minSamplesForConfidence));
  const confidence = round4(sampleConfidence * (0.5 + 0.5 * stabilityScore));

  return {
    bucketKey,
    tradeCount: n,
    wins: acc.wins,
    losses: acc.losses,
    totalRealizedPnL: round4(acc.sumPnl),
    expectancy: round4(expectancy),
    avgMFE: avgMFE != null ? round4(avgMFE) : null,
    avgMAE: avgMAE != null ? round4(avgMAE) : null,
    avgEfficiency: avgEfficiency != null ? round4(avgEfficiency) : null,
    avgHoldingTimeSec,
    profitFactor: profitFactor != null ? round4(profitFactor) : null,
    payoffRatio: payoffRatio != null ? round4(payoffRatio) : null,
    sharpeProxy: sharpeProxy != null ? round4(sharpeProxy) : null,
    winStreak: st.winStreak,
    lossStreak: st.lossStreak,
    drawdownPressureProxy: round4(ddPressure),
    stabilityScore: round4(stabilityScore),
    confidence,
  };
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Transparent score from bucket stats. Returns components summing to ~score in [-1,1] practical range.
 */
function scoreBucket(bucket) {
  if (!bucket || !bucket.tradeCount) {
    return {
      bucketKey: bucket && bucket.bucketKey,
      score: 0,
      confidence: 0,
      decision: 'keep',
      components: {},
    };
  }

  const T = parseThresholds();
  const n = bucket.tradeCount;
  const samplePenalty = -0.25 * (1 - Math.min(1, n / Math.max(1, T.minSamplesForConfidence)));

  const exp = Number(bucket.expectancy) || 0;
  const expC = clamp(exp / (Math.abs(exp) + 2), -0.35, 0.35);

  let pfC = 0;
  if (bucket.profitFactor != null && Number.isFinite(bucket.profitFactor)) {
    const pf = bucket.profitFactor;
    pfC = clamp((pf - 1) * 0.15, -0.2, 0.2);
  }

  let effC = 0;
  if (bucket.avgEfficiency != null && Number.isFinite(bucket.avgEfficiency)) {
    effC = clamp((bucket.avgEfficiency - 0.5) * 0.2, -0.15, 0.15);
  }

  let maePen = 0;
  if (
    bucket.avgMFE != null &&
    bucket.avgMAE != null &&
    bucket.avgMFE > 1e-9
  ) {
    const ratio = bucket.avgMAE / bucket.avgMFE;
    maePen = -clamp((ratio - 0.5) * 0.12, 0, 0.2);
  }

  let streakPen = 0;
  if (bucket.lossStreak >= 4) streakPen -= 0.12;
  else if (bucket.lossStreak >= 3) streakPen -= 0.06;

  let sharpeC = 0;
  if (bucket.sharpeProxy != null && Number.isFinite(bucket.sharpeProxy)) {
    sharpeC = clamp(bucket.sharpeProxy * 0.08, -0.12, 0.12);
  }

  let ddPen = 0;
  if (bucket.drawdownPressureProxy != null) {
    ddPen = -clamp(bucket.drawdownPressureProxy * 0.15, 0, 0.15);
  }

  let regimeInstabilityPen = 0;
  if (bucket.stabilityScore != null && bucket.stabilityScore < 0.35) {
    regimeInstabilityPen = -0.08;
  }

  const components = {
    expectancy: round4(expC),
    profitFactor: round4(pfC),
    efficiency: round4(effC),
    maeMfePenalty: round4(maePen),
    lossStreakPenalty: round4(streakPen),
    sharpe: round4(sharpeC),
    drawdownPenalty: round4(ddPen),
    stabilityPenalty: round4(regimeInstabilityPen),
    samplePenalty: round4(samplePenalty),
  };

  const score = round4(
    expC +
      pfC +
      effC +
      maePen +
      streakPen +
      sharpeC +
      ddPen +
      regimeInstabilityPen +
      samplePenalty
  );

  const decision = derivePolicyDecision(score, bucket.confidence);

  return {
    bucketKey: bucket.bucketKey,
    score,
    confidence: bucket.confidence,
    decision,
    components,
  };
}

function derivePolicyDecision(score, confidence) {
  const T = parseThresholds();
  const s = Number(score);
  const c = Number(confidence) || 0;
  if (s < T.suspendScore && c >= T.suspendConfidence) return 'suspend';
  if (s >= T.promoteScore && c >= T.promoteConfidence) return 'promote';
  if (s >= T.keepScore) return 'keep';
  if (s >= T.throttleScore) return 'throttle';
  return 'demote';
}

async function loadLearningState() {
  const file = getLearningStatePath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.warn(`[rl] loadLearningState: ${e.message}`);
    return {};
  }
}

async function saveLearningState(state) {
  const file = getLearningStatePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const payload = JSON.stringify(state, null, 2);
    await fs.writeFile(file, payload, 'utf8');
    return true;
  } catch (e) {
    console.warn(`[rl] saveLearningState: ${e.message}`);
    return false;
  }
}

function limitBuckets(buckets, maxN) {
  const entries = Object.entries(buckets || {});
  if (entries.length <= maxN) return buckets;
  entries.sort((a, b) => (b[1].tradeCount || 0) - (a[1].tradeCount || 0));
  const out = {};
  for (let i = 0; i < maxN; i++) out[entries[i][0]] = entries[i][1];
  return out;
}

/**
 * @param {object[]} trades
 * @param {object[]} lifecycleSummaries - optional journal rows
 */
function computePolicyScores(trades, lifecycleSummaries, options = {}) {
  void lifecycleSummaries;
  const T = parseThresholds();
  let buckets = buildStateBuckets(trades);
  buckets = limitBuckets(buckets, T.maxBuckets);

  const scoreCards = [];
  for (const k of Object.keys(buckets)) {
    scoreCards.push(scoreBucket(buckets[k]));
  }

  const decisions = { promote: [], keep: [], throttle: [], demote: [], suspend: [] };
  for (const sc of scoreCards) {
    const d = sc.decision || 'keep';
    if (decisions[d]) decisions[d].push(sc.bucketKey);
  }

  const sortedByScore = [...scoreCards].sort((a, b) => b.score - a.score);
  const topPromoted = sortedByScore.filter((x) => x.decision === 'promote').slice(0, 10);
  const topDemoted = [...scoreCards]
    .filter((x) => x.decision === 'demote' || x.decision === 'suspend')
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);
  const topSuspended = scoreCards.filter((x) => x.decision === 'suspend').slice(0, 10);

  const prevScores = options.previousScores || {};
  const deltas = [];
  for (const sc of scoreCards) {
    const prev = prevScores[sc.bucketKey];
    if (prev != null && Number.isFinite(prev)) {
      deltas.push({ bucketKey: sc.bucketKey, delta: round4(sc.score - prev) });
    }
  }
  deltas.sort((a, b) => b.delta - a.delta);
  const topImprovingBuckets = deltas.slice(0, 10);
  const topDeterioratingBuckets = [...deltas].sort((a, b) => a.delta - b.delta).slice(0, 10);

  return {
    buckets,
    scoreCards,
    decisions,
    topPromoted,
    topDemoted,
    topSuspended,
    topImprovingBuckets,
    topDeterioratingBuckets,
    diagnostics: {
      bucketCount: Object.keys(buckets).length,
      tradeRowsUsed: Array.isArray(trades) ? trades.length : 0,
      lifecycleRowsUsed: Array.isArray(lifecycleSummaries) ? lifecycleSummaries.length : 0,
    },
  };
}

async function runLearningCycle(options = {}) {
  const generatedAt = new Date().toISOString();
  let trades = [];
  let lifecycles = [];
  try {
    trades = await closedTradeAnalyticsService.listClosedTrades({
      from: options.from,
      to: options.to,
      symbol: options.symbol,
      strategy: options.strategy,
      limit: options.limit,
    });
  } catch (e) {
    trades = [];
  }
  try {
    lifecycles = await tradeLifecycleService.loadLifecycleSummaries();
  } catch (e) {
    lifecycles = [];
  }

  const prev = await loadLearningState();
  const prevScores = {};
  if (Array.isArray(prev.scoreCards)) {
    for (const sc of prev.scoreCards) {
      if (sc && sc.bucketKey != null) prevScores[sc.bucketKey] = Number(sc.score);
    }
  }

  const computed = computePolicyScores(trades, lifecycles, { previousScores: prevScores });

  const state = {
    generatedAt,
    buckets: computed.buckets,
    scoreCards: computed.scoreCards,
    decisions: computed.decisions,
    topPromoted: computed.topPromoted,
    topDemoted: computed.topDemoted,
    topSuspended: computed.topSuspended,
    topImprovingBuckets: computed.topImprovingBuckets,
    topDeterioratingBuckets: computed.topDeterioratingBuckets,
    diagnostics: {
      ...computed.diagnostics,
      thresholds: parseThresholds(),
    },
  };

  await saveLearningState(state);
  return state;
}

async function getLearningOverview() {
  const state = await loadLearningState();
  const generatedAt = state.generatedAt || null;
  const scoreCards = Array.isArray(state.scoreCards) ? state.scoreCards : [];
  const decisions = state.decisions || {};
  return {
    ok: true,
    generatedAt,
    summary: {
      bucketCount: Object.keys(state.buckets || {}).length,
      scoreCardCount: scoreCards.length,
      promote: (decisions.promote || []).length,
      keep: (decisions.keep || []).length,
      throttle: (decisions.throttle || []).length,
      demote: (decisions.demote || []).length,
      suspend: (decisions.suspend || []).length,
    },
    topPromoted: state.topPromoted || [],
    topDemoted: state.topDemoted || [],
    topSuspended: state.topSuspended || [],
    topImprovingBuckets: state.topImprovingBuckets || [],
    topDeterioratingBuckets: state.topDeterioratingBuckets || [],
    diagnostics: state.diagnostics || {},
  };
}

async function getLearningBuckets() {
  const state = await loadLearningState();
  return {
    ok: true,
    generatedAt: state.generatedAt || null,
    buckets: state.buckets || {},
    count: Object.keys(state.buckets || {}).length,
  };
}

async function getLearningDecisions() {
  const state = await loadLearningState();
  return {
    ok: true,
    generatedAt: state.generatedAt || null,
    decisions: state.decisions || {},
    scoreCards: state.scoreCards || [],
  };
}

module.exports = {
  getLearningStatePath,
  loadLearningState,
  saveLearningState,
  computePolicyScores,
  buildStateBuckets,
  scoreBucket,
  derivePolicyDecision,
  getLearningOverview,
  runLearningCycle,
  getLearningBuckets,
  getLearningDecisions,
  parseThresholds,
};
