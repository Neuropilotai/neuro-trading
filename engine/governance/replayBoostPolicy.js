'use strict';

/**
 * Paper-only replay boost: priority score + tier + per-setup bar budgets.
 * Pure/deterministic helpers — no I/O. Callers load JSON and pass inputs.
 *
 * Env parsing for production: parseReplayBoostEnv() (used from runPaperExecutionV1.js).
 */

const POLICY_VERSION = 1;

const TIER_ORDER = { A: 0, B: 1, C: 2, D: 3 };

/** @typedef {{ setupId: string, replayPriorityScore: number, replayPriorityTier: 'A'|'B'|'C'|'D', reasons: string[], budgetAssigned: number, scoreRaw?: number }} ReplayBoostSetupRow */

/**
 * @returns {{ enabled: boolean, maxTierACap: number|null, maxTierBCap: number|null, minTradesForPfMalus: number, requirePromoted: boolean, tierBarsA: number, tierBarsB: number, tierBarsC: number }}
 */
function parseReplayBoostEnv() {
  const enabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_ENABLE || '').trim().toLowerCase()
  );
  const maxTierA = parseOptionalPositiveInt(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_MAX_TIER_A);
  const maxTierB = parseOptionalPositiveInt(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_MAX_TIER_B);
  const minTradesForPfMalus = Math.max(
    1,
    Math.floor(
      Number(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_MIN_TRADES_FOR_PF_MALUS) || 8
    )
  );
  const requirePromoted = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_REQUIRE_PROMOTED || '').trim().toLowerCase()
  );
  return {
    enabled,
    maxTierACap: maxTierA,
    maxTierBCap: maxTierB,
    minTradesForPfMalus,
    requirePromoted,
    tierBarsA: Math.max(1, Math.floor(Number(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_TIER_A_BARS) || 5)),
    tierBarsB: Math.max(1, Math.floor(Number(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_TIER_B_BARS) || 3)),
    tierBarsC: Math.max(0, Math.floor(Number(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_TIER_C_BARS) || 1)),
    tierBarsD: Math.max(0, Math.floor(Number(process.env.NEUROPILOT_PAPER_REPLAY_BOOST_TIER_D_BARS) || 0)),
  };
}

function parseOptionalPositiveInt(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function assignTierFromScore(score) {
  if (score >= 70) return 'A';
  if (score >= 50) return 'B';
  if (score >= 30) return 'C';
  return 'D';
}

/**
 * @param {number} score
 * @param {{ tierBarsA: number, tierBarsB: number, tierBarsC: number, tierBarsD: number }} caps
 * @param {number} baseMaxBarsFromEnv — NEUROPILOT_PAPER_PROMOTED_REPLAY_MAX_BARS_PER_SETUP
 */
function tierToMaxBars(tier, caps, baseMaxBarsFromEnv) {
  const b = Math.max(0, Math.floor(baseMaxBarsFromEnv));
  switch (tier) {
    case 'A':
      return Math.max(b, caps.tierBarsA);
    case 'B':
      return Math.max(b, caps.tierBarsB);
    case 'C':
      return Math.min(b, caps.tierBarsC > 0 ? caps.tierBarsC : b);
    case 'D':
    default:
      if (caps.tierBarsD > 0) return Math.min(b, caps.tierBarsD);
      return b;
  }
}

function readJsonSafe(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  return null;
}

function validationRowByStrategyId(validationDoc) {
  const map = new Map();
  const rows =
    validationDoc && Array.isArray(validationDoc.rows) ? validationDoc.rows : [];
  for (const row of rows) {
    const sid = row && row.strategyId != null ? String(row.strategyId).trim() : '';
    if (sid) map.set(sid, row);
  }
  return map;
}

function manifestSetupIds(manifestDoc) {
  const s = new Set();
  const items = manifestDoc && Array.isArray(manifestDoc.items) ? manifestDoc.items : [];
  for (const it of items) {
    const id = it && it.setupId != null ? String(it.setupId).trim() : '';
    if (id) s.add(id);
  }
  return s;
}

function strictSetupKeys(strictDoc) {
  const notSeen = new Set();
  const recent = new Map();
  const t1 = strictDoc && Array.isArray(strictDoc.promoted_not_seen_in_paper_last_7d)
    ? strictDoc.promoted_not_seen_in_paper_last_7d
    : [];
  for (const row of t1) {
    const k = row && row.setupKey != null ? String(row.setupKey).trim() : '';
    if (k) notSeen.add(k);
  }
  const t2 = strictDoc && Array.isArray(strictDoc.promoted_and_paper_recent)
    ? strictDoc.promoted_and_paper_recent
    : [];
  for (const row of t2) {
    const k = row && row.setupKey != null ? String(row.setupKey).trim() : '';
    if (!k) continue;
    recent.set(k, {
      tradesRecent: Number(row.tradesRecent),
      pnlRecent: Number(row.pnlRecent),
    });
  }
  return { notSeen, recent };
}

function findSetupAnalysisRow(setupAnalysisDoc, setupId) {
  const rows =
    setupAnalysisDoc && Array.isArray(setupAnalysisDoc.setupRows)
      ? setupAnalysisDoc.setupRows
      : [];
  return rows.find((r) => r && String(r.setupKey || '').trim() === setupId) || null;
}

function getLast7dWindow(setupRow) {
  const w = setupRow && setupRow.windows && setupRow.windows.last_7d;
  return w && typeof w === 'object' ? w : null;
}

/**
 * Parse last N JSONL records from promoted_convergence_trend (newest last).
 * @param {string} [content]
 * @returns {object[]}
 */
function parseConvergenceTail(content, maxLines = 6) {
  if (!content || typeof content !== 'string') return [];
  const lines = content.trim().split('\n').filter(Boolean);
  const out = [];
  const slice = lines.slice(-maxLines);
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

function globalPipelineStallMalus(tail) {
  if (!Array.isArray(tail) || tail.length < 3) return { malus: 0, reasons: [] };
  const last3 = tail.slice(-3);
  let allZeroAppend = true;
  let dupSum = 0;
  for (const row of last3) {
    const a = Number(row && row.appended_last_run);
    const d = Number(row && row.duplicateSkippedPersistent_last_run);
    if (Number.isFinite(a) && a > 0) allZeroAppend = false;
    if (Number.isFinite(d)) dupSum += d;
  }
  if (allZeroAppend && dupSum >= 30) {
    return { malus: 12, reasons: ['global_pipeline_stall_high_dup_skips'] };
  }
  return { malus: 0, reasons: [] };
}

/**
 * @param {object} inputs
 * @param {object|null} inputs.strategyValidation
 * @param {object|null} inputs.strictMappingReport
 * @param {object|null} inputs.setupAnalysis
 * @param {object|null} inputs.lastRun
 * @param {object|null} inputs.promotedManifest
 * @param {object|null} inputs.latestSnapshot — ops-snapshot latest.json (optional)
 * @param {object[]} [inputs.convergenceTail]
 * @param {object} options — parseReplayBoostEnv() merged with overrides in tests
 * @returns {{ setups: ReplayBoostSetupRow[], stall: { malus: number, reasons: string[] }, promotedManifestSetupCount: number }}
 */
function computeReplayBoostPriority(inputs, options) {
  const validationDoc = readJsonSafe(inputs.strategyValidation);
  const strictDoc = readJsonSafe(inputs.strictMappingReport);
  const setupAnalysisDoc = readJsonSafe(inputs.setupAnalysis);
  const manifestDoc = readJsonSafe(inputs.promotedManifest);

  const valMap = validationRowByStrategyId(validationDoc);
  const manifestIds = manifestSetupIds(manifestDoc);
  const { notSeen: notSeen7d, recent: recentPaper } = strictSetupKeys(strictDoc);

  const setupIds = new Set();
  for (const sid of valMap.keys()) setupIds.add(sid);
  for (const sid of manifestIds) setupIds.add(sid);
  for (const k of notSeen7d) setupIds.add(k);
  for (const k of recentPaper.keys()) setupIds.add(k);
  if (setupAnalysisDoc && Array.isArray(setupAnalysisDoc.setupRows)) {
    for (const r of setupAnalysisDoc.setupRows) {
      if (r && r.isPromoted && r.setupKey) setupIds.add(String(r.setupKey).trim());
    }
  }

  const stall = globalPipelineStallMalus(inputs.convergenceTail || []);

  const setups = [];
  for (const setupId of Array.from(setupIds).sort((a, b) => a.localeCompare(b))) {
    const row = valMap.get(setupId) || null;
    const reasons = [];
    let score = 50;

    if (options.requirePromoted && !manifestIds.has(setupId)) {
      setups.push({
        setupId,
        replayPriorityScore: 0,
        replayPriorityTier: 'D',
        reasons: ['not_in_promoted_manifest_require_promoted'],
        budgetAssigned: 0,
        scoreRaw: 0,
      });
      continue;
    }

    if (notSeen7d.has(setupId)) {
      score += 20;
      reasons.push('promoted_not_seen_in_paper_last_7d');
    }
    if (manifestIds.has(setupId)) {
      score += 5;
      reasons.push('in_promoted_manifest');
    }

    const sc = row && Number(row.score);
    if (Number.isFinite(sc) && sc >= 60) {
      score += 15;
      reasons.push('strict_score_good');
    }
    const ls = row && Number(row.learningScore);
    if (Number.isFinite(ls) && ls >= 60) {
      score += 10;
      reasons.push('learning_score_good');
    }

    const trades = row && Number(row.trades);
    if (Number.isFinite(trades) && trades >= 1 && trades <= 30) {
      score += 10;
      reasons.push('low_trade_count_band');
    }

    const symCount = row && Number(row.symbolCount);
    const hf = row && Array.isArray(row.hardFails) ? row.hardFails.map(String).join(' ') : '';
    if (
      (Number.isFinite(symCount) && symCount < 2) ||
      hf.includes('single_market_required')
    ) {
      score += 8;
      reasons.push('multi_market_or_coverage_gap');
    }

    const ex = row && Number(row.expectancy);
    if (Number.isFinite(ex) && ex > 0) {
      score += 8;
      reasons.push('positive_expectancy');
    }

    const pfVal = row && Number(row.profitFactor);
    if (Number.isFinite(pfVal) && pfVal > 1.1) {
      score += 8;
      reasons.push('profit_factor_ok');
    }

    const minTr = options.minTradesForPfMalus;
    if (Number.isFinite(trades) && trades >= minTr && Number.isFinite(pfVal) && pfVal < 1.0) {
      score -= 10;
      reasons.push('profit_factor_low_sample_sufficient');
    }
    if (Number.isFinite(trades) && trades >= minTr && Number.isFinite(ex) && ex < 0) {
      score -= 10;
      reasons.push('negative_expectancy_sample_sufficient');
    }

    const hfStr = hf.toLowerCase();
    if (
      hfStr.includes('negative_expectancy') &&
      hfStr.includes('low_profit_factor') &&
      Number.isFinite(trades) &&
      trades >= 15
    ) {
      score -= 15;
      reasons.push('structural_hard_fails_heavy');
    }

    const ana = findSetupAnalysisRow(setupAnalysisDoc, setupId);
    const w7 = getLast7dWindow(ana);
    const pf7 = w7 && Number(w7.profitFactor);
    const t7 = w7 && Number(w7.totalTrades);
    if (Number.isFinite(t7) && t7 >= 12 && Number.isFinite(pf7) && pf7 < 1.0 && pf7 > 0) {
      score -= 8;
      reasons.push('last_7d_pf_weak');
    }

    const recent = recentPaper.get(setupId);
    if (recent && Number.isFinite(recent.tradesRecent) && recent.tradesRecent >= 8) {
      score -= 6;
      reasons.push('promoted_and_paper_recent_heavy');
    }

    if (Number.isFinite(trades) && trades >= 80) {
      score -= 10;
      reasons.push('high_trade_count_saturation');
    }

    score -= stall.malus;
    if (stall.malus) reasons.push(...stall.reasons);

    const scoreClamped = Math.max(0, Math.min(100, Math.round(score)));
    const tier = assignTierFromScore(scoreClamped);

    setups.push({
      setupId,
      replayPriorityScore: scoreClamped,
      replayPriorityTier: tier,
      reasons,
      budgetAssigned: 0,
      scoreRaw: score,
    });
  }

  applyTierCapsToSetups(setups, options);

  const baseBars = options.baseMaxBarsFromEnv || 3;
  for (const s of setups) {
    s.budgetAssigned = tierToMaxBars(s.replayPriorityTier, options, baseBars);
  }

  return {
    setups,
    stall,
    promotedManifestSetupCount: manifestIds.size,
  };
}

/**
 * Optional caps: demote excess A -> B, B -> C for budget purposes only.
 * @param {ReplayBoostSetupRow[]} setups
 */
function applyTierCapsToSetups(setups, options) {
  const byScore = setups
    .filter((s) => s.replayPriorityTier === 'A')
    .sort((a, b) => {
      if (b.replayPriorityScore !== a.replayPriorityScore) return b.replayPriorityScore - a.replayPriorityScore;
      return a.setupId.localeCompare(b.setupId);
    });
  if (options.maxTierACap != null && byScore.length > options.maxTierACap) {
    const drop = new Set(byScore.slice(options.maxTierACap).map((x) => x.setupId));
    for (const s of setups) {
      if (drop.has(s.setupId) && s.replayPriorityTier === 'A') {
        s.replayPriorityTier = 'B';
        s.reasons.push('demoted_excess_tier_a_cap');
      }
    }
  }
  const bTier = setups.filter((s) => s.replayPriorityTier === 'B');
  bTier.sort((a, b) => {
    if (b.replayPriorityScore !== a.replayPriorityScore) return b.replayPriorityScore - a.replayPriorityScore;
    return a.setupId.localeCompare(b.setupId);
  });
  if (options.maxTierBCap != null && bTier.length > options.maxTierBCap) {
    const allowedB = new Set(bTier.slice(0, options.maxTierBCap).map((x) => x.setupId));
    for (const s of setups) {
      if (s.replayPriorityTier === 'B' && !allowedB.has(s.setupId)) {
        s.replayPriorityTier = 'C';
        s.reasons.push('demoted_excess_tier_b_cap');
      }
    }
  }
}

/** Stable ordering: promoted_manifest first, then tier A→D, score desc, setupId, original index. */
function orderSignalsForReplayBoostStable(signals, setupById) {
  const decorated = (Array.isArray(signals) ? signals : []).map((sig, idx) => ({ sig, idx }));
  decorated.sort((a, b) => {
    const isPmA = a.sig && a.sig.signalSource === 'promoted_manifest';
    const isPmB = b.sig && b.sig.signalSource === 'promoted_manifest';
    const bucketA = isPmA ? 0 : 1;
    const bucketB = isPmB ? 0 : 1;
    if (bucketA !== bucketB) return bucketA - bucketB;
    if (isPmA && isPmB) {
      const sidA = String(a.sig.setupId || a.sig.strategyId || '').trim();
      const sidB = String(b.sig.setupId || b.sig.strategyId || '').trim();
      const rowA = setupById.get(sidA);
      const rowB = setupById.get(sidB);
      const tierA = rowA ? rowA.replayPriorityTier : 'D';
      const tierB = rowB ? rowB.replayPriorityTier : 'D';
      const ordA = TIER_ORDER[tierA] != null ? TIER_ORDER[tierA] : 9;
      const ordB = TIER_ORDER[tierB] != null ? TIER_ORDER[tierB] : 9;
      if (ordA !== ordB) return ordA - ordB;
      const scA = rowA ? rowA.replayPriorityScore : 0;
      const scB = rowB ? rowB.replayPriorityScore : 0;
      if (scB !== scA) return scB - scA;
      if (sidA !== sidB) return sidA.localeCompare(sidB);
    }
    return a.idx - b.idx;
  });
  return decorated.map((d) => d.sig);
}

function buildSetupMapFromComputed(computed) {
  const m = new Map();
  for (const s of computed.setups) m.set(s.setupId, s);
  return m;
}

/**
 * @param {string} dataRoot
 * @param {{ readJson?: (p: string) => object | null }} [io] — inject for tests
 */
function loadReplayBoostInputsFromRoot(dataRoot, io) {
  const fs = require('fs');
  const path = require('path');
  const readJson =
    io && typeof io.readJson === 'function'
      ? io.readJson
      : (p) => {
          try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
          } catch {
            return null;
          }
        };
  const gov = path.join(dataRoot, 'governance');
  const disc = path.join(dataRoot, 'discovery');
  const ops = path.join(dataRoot, '..', 'ops-snapshot');
  const convergencePath = path.join(gov, 'promoted_convergence_trend.jsonl');
  let convergenceTail = [];
  try {
    if (fs.existsSync(convergencePath)) {
      const raw = fs.readFileSync(convergencePath, 'utf8');
      convergenceTail = parseConvergenceTail(raw, 8);
    }
  } catch {
    /* optional */
  }

  return {
    strategyValidation: readJson(path.join(ops, 'strategy_validation.json')),
    strictMappingReport: readJson(path.join(gov, 'paper_trades_strict_mapping_report.json')),
    setupAnalysis: readJson(path.join(gov, 'paper_trades_by_setup_analysis.json')),
    lastRun: readJson(path.join(gov, 'paper_exec_v1_last_run.json')),
    promotedManifest: readJson(path.join(disc, 'promoted_manifest.json')),
    latestSnapshot: readJson(path.join(ops, 'latest.json')),
    governanceDashboard: readJson(path.join(ops, 'governance_dashboard.json')),
    convergenceTail,
  };
}

/**
 * @param {ReturnType<typeof computeReplayBoostPriority>} computed
 * @param {object} meta
 */
function buildReplayBoostArtifactDoc(computed, meta) {
  return {
    generatedAt: meta.generatedAt || new Date().toISOString(),
    policyVersion: POLICY_VERSION,
    replayBoostEnabled: meta.replayBoostEnabled,
    promotedReplayBypassEnabled: meta.promotedReplayBypassEnabled,
    globalBudget: {
      maxPerRun: meta.promotedReplayMaxPerRun,
      used: meta.usedBypassCount,
    },
    baseMaxBarsPerSetup: meta.baseMaxBarsPerSetup,
    tierBarCaps: {
      A: meta.tierBarsA,
      B: meta.tierBarsB,
      C: meta.tierBarsC,
      D: meta.tierBarsD,
    },
    setups: computed.setups.map((s) => ({
      setupId: s.setupId,
      replayPriorityScore: s.replayPriorityScore,
      replayPriorityTier: s.replayPriorityTier,
      budgetAssigned: s.budgetAssigned,
      reasons: s.reasons.slice(),
    })),
    replayBoostBypassByTier: meta.replayBoostBypassByTier || { A: 0, B: 0, C: 0, D: 0 },
    stallSignal: computed.stall || { malus: 0, reasons: [] },
    inputsSummary: {
      promotedManifestSetupCount: computed.promotedManifestSetupCount,
    },
  };
}

function countTiers(setups) {
  const o = { A: 0, B: 0, C: 0, D: 0 };
  for (const s of setups) {
    const t = s.replayPriorityTier;
    if (o[t] != null) o[t] += 1;
  }
  return o;
}

module.exports = {
  POLICY_VERSION,
  parseReplayBoostEnv,
  assignTierFromScore,
  tierToMaxBars,
  computeReplayBoostPriority,
  orderSignalsForReplayBoostStable,
  buildSetupMapFromComputed,
  loadReplayBoostInputsFromRoot,
  buildReplayBoostArtifactDoc,
  countTiers,
  parseConvergenceTail,
  globalPipelineStallMalus,
};
