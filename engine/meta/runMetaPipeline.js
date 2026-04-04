#!/usr/bin/env node
'use strict';

/**
 * Meta Pipeline
 *
 * Objectif :
 * - lire les batch results par actif / timeframe
 * - regrouper les résultats par setupId
 * - calculer :
 *    1) cross-asset score
 *    2) timeframe robustness
 *    3) meta ranking
 * - construire le champion portfolio
 * - écrire les sorties dans $DATA_ROOT/discovery/
 *
 * Sorties :
 * - discovery/meta_ranking.json
 * - discovery/strategy_portfolio.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const dataRoot = require('../dataRoot');
const {
  evaluateCrossAssetScore,
  evaluateTimeframeRobustness,
  computeMetaRanking,
  buildChampionPortfolio,
  writePortfolio,
} = require('./index');
const { clusterAndFilter } = require('../clustering/familyPortfolioFilter');
const { loadChampionRegistrySync } = require('../champions/loadChampionRegistry');
const { selectDiversifiedPortfolio } = require('./strategyCorrelation');
const { computeReturnCorrelationMatrix } = require('./strategyReturnCorrelation');
const { isValidResult } = require('../contracts/researchResultContract');
const { run: buildMutationPerfFromBatchResults } = require('../evolution/buildMutationPerfFromBatchResults');
const { rulesToFamilySignature } = require('../evolution/familyExpansionEngine');
const { computeCanonicalSetupId } = require('../evolution/canonicalSetupId');
const { createWatchdogHeartbeatEmitter } = require('../ops/watchdogHeartbeat');
const { appendPhaseMetric, estimateEtaSec } = require('../ops/phaseMetricsStore');
const { resolvePhase4Workers, PHASE_KEY: PHASE4_TUNER_PHASE_KEY } = require('../ops/phase4WorkerTuner');
const {
  startPhaseSubstep,
  recordPhaseSubstepProgress,
  logPhaseBottleneckSummary,
} = require('../ops/phaseSubstepTimer');

/** Watchdog liveness (shared module: loop_logs/heartbeat.log + last_progress.ts). */
const neuropilotMetaHeartbeat = createWatchdogHeartbeatEmitter();

function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function parseUpperCsvSet(raw) {
  const s = String(raw || '').trim();
  if (!s) return new Set();
  return new Set(
    s
      .split(',')
      .map((x) => String(x || '').trim().toUpperCase())
      .filter(Boolean)
  );
}

function round6(v) {
  return Math.round(safeNum(v) * 1e6) / 1e6;
}

function nowMs() {
  return Date.now();
}

let CURRENT_META_RUN_ID = null;
let CURRENT_META_WORKERS_MODE = null;
let CURRENT_META_WORKERS_USED = null;

function appendTimingJsonlBestEffort(payload) {
  try {
    const root = process.env.NEUROPILOT_DATA_ROOT || dataRoot.getDataRoot();
    const dir = path.join(root, 'loop_logs');
    const file = path.join(dir, 'pipeline_stage_timings.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (_) {
    // best effort only: never block meta/pipeline if timing log fails
  }
}

function appendMetaPerfJsonlBestEffort(payload) {
  try {
    const root = process.env.NEUROPILOT_DATA_ROOT || dataRoot.getDataRoot();
    const dir = path.join(root, 'loop_logs');
    const file = path.join(dir, 'meta_perf.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (_) {
    // best effort only: never block meta/pipeline if perf log fails
  }
}

function parseMetaStageName(name) {
  const raw = String(name || '').trim();
  if (!raw) return { stage: raw, event: 'info' };
  if (raw === '1_batch_files_discovered') return { stage: raw, event: 'done' };
  if (raw === '7_meta_complete') return { stage: raw, event: 'done' };
  if (raw.endsWith('_start')) return { stage: raw.replace(/_start$/, ''), event: 'start' };
  if (raw.endsWith('_done')) return { stage: raw.replace(/_done$/, ''), event: 'done' };
  return { stage: raw, event: 'info' };
}

function readPositiveIntEnv(name, fallback = 0) {
  const raw = Number(process.env[name] || 0);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

function setupCountFromBatchContents(batchContents) {
  const ids = new Set();
  for (const b of batchContents || []) {
    const rows = Array.isArray(b && b.results) ? b.results : [];
    for (const r of rows) {
      const id = String((r && r.setupId) || '');
      if (id) ids.add(id);
    }
  }
  return ids.size;
}

function preCorrFamilyKey(row) {
  if (!row) return 'unknown_family';
  const parentFamilyId = row.parentFamilyId || row.parent_family_id;
  const familyKey = row.familyKey || row.family_key;
  const parentSetupId = row.parentSetupId || row.parent_setup_id;
  const setupId = row.setupId || row.setup_id;
  return String(parentFamilyId || familyKey || parentSetupId || setupId || 'unknown_family');
}

/** Batch result rows carry symbol/timeframe (see researchResultContract / batch JSON). */
function preCorrSymbolTimeframeKey(row) {
  if (!row) return 'unknown|unknown';
  const sym = String(row.symbol || row.Symbol || '').trim() || 'unknown';
  const tf = String(row.timeframe || row.timeFrame || row.interval || '').trim() || 'unknown';
  return `${sym}|${tf}`;
}

function preCorrTrades(row) {
  const t = Number(row && (row.trades ?? row.totalTrades ?? row.total_trades));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Deterministic ordering for pre-correlation ranking (higher / earlier = better).
 * Tie-break: metaScore → expectancy → profitFactor → trades → setupId (stable).
 * Uses only fields present on batch result rows (no opaque scores).
 */
function comparePreCorrRows(rowA, rowB) {
  const msA = Number(rowA && (rowA.metaScore ?? rowA.meta_score));
  const msB = Number(rowB && (rowB.metaScore ?? rowB.meta_score));
  const msOkA = Number.isFinite(msA);
  const msOkB = Number.isFinite(msB);
  if (msOkA !== msOkB) return msOkA ? -1 : 1;
  if (msOkA && msOkB && msB !== msA) return msB - msA;

  const exA = Number(rowA && rowA.expectancy);
  const exB = Number(rowB && rowB.expectancy);
  const exOkA = Number.isFinite(exA);
  const exOkB = Number.isFinite(exB);
  if (exOkA !== exOkB) return exOkA ? -1 : 1;
  if (exOkA && exOkB && exB !== exA) return exB - exA;

  const pfA = Number(rowA && (rowA.profitFactor ?? rowA.profit_factor));
  const pfB = Number(rowB && (rowB.profitFactor ?? rowB.profit_factor));
  const pfOkA = Number.isFinite(pfA);
  const pfOkB = Number.isFinite(pfB);
  if (pfOkA !== pfOkB) return pfOkA ? -1 : 1;
  if (pfOkA && pfOkB && pfB !== pfA) return pfB - pfA;

  const tA = preCorrTrades(rowA);
  const tB = preCorrTrades(rowB);
  if (tB !== tA) return tB - tA;

  const idA = String((rowA && rowA.setupId) || '');
  const idB = String((rowB && rowB.setupId) || '');
  return idA.localeCompare(idB);
}

const DEFAULT_CORRELATION_PREFILTER_POLICY = Object.freeze({
  enabled: false,
  mode: 'topk_global',
  maxSetups: 0,
  minTrades: 0,
  preservePerFamily: 0,
  maxPerFamily: 0,
  maxPerSymbolTimeframe: 0,
  preservePerSymbolTimeframe: 0,
  dedupeStructural: false,
});

function loadCorrelationPrefilterPolicySync() {
  const base = { ...DEFAULT_CORRELATION_PREFILTER_POLICY };
  try {
    const root = process.env.NEUROPILOT_DATA_ROOT || dataRoot.getDataRoot();
    const policyPath = path.join(root, 'governance', 'correlation_prefilter_policy.json');
    if (!fs.existsSync(policyPath)) {
      return { ...base, policyPath, policySource: 'missing' };
    }
    const raw = fs.readFileSync(policyPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('policy_not_object');
    return {
      ...base,
      ...parsed,
      policyPath,
      policySource: 'file',
    };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    // eslint-disable-next-line no-console -- ops visibility; no secrets
    console.warn('[CORR_PREFILTER_POLICY]', { warning: 'fallback_defaults', message: msg });
    return {
      ...base,
      policyPath: null,
      policySource: 'error',
      policyError: msg,
    };
  }
}

/**
 * Env wins when set to a positive value; otherwise policy applies when enabled.
 * Modes: topk_global (cap only), topk_diverse (same engine + optional per-bucket caps).
 * Diversity: greedy pass in global quality order — max per symbol|timeframe, then per family, stop at maxSetups.
 */
function resolvePreCorrelationFilterOpts(policy) {
  const envMin = readPositiveIntEnv('NEUROPILOT_META_PRE_CORR_MIN_TRADES', 0);
  const envFam = readPositiveIntEnv('NEUROPILOT_META_PRE_CORR_MAX_PER_FAMILY', 0);
  const envSymTf = readPositiveIntEnv('NEUROPILOT_META_PRE_CORR_MAX_PER_SYMBOL_TF', 0);
  const envMax = readPositiveIntEnv('NEUROPILOT_META_PRE_CORR_MAX_TOTAL', 0);

  const active = policy && policy.enabled === true;
  const modeRaw = active ? String(policy.mode || 'topk_global').trim() : 'topk_global';
  const mode = modeRaw || 'topk_global';
  const allowedModes = new Set(['topk_global', 'topk_diverse']);
  if (active && !allowedModes.has(mode)) {
    // eslint-disable-next-line no-console -- ops visibility
    console.warn('[CORR_PREFILTER_POLICY]', { warning: 'unknown_mode_fallback', mode, fallback: 'topk_global' });
  }

  let policyMin = 0;
  let policyMaxSetups = 0;
  let policyFam = 0;
  let policySymTf = 0;
  if (active) {
    if (Number.isFinite(Number(policy.minTrades)) && Number(policy.minTrades) > 0) {
      policyMin = Math.floor(Number(policy.minTrades));
    }
    if (Number.isFinite(Number(policy.maxSetups)) && Number(policy.maxSetups) > 0) {
      policyMaxSetups = Math.floor(Number(policy.maxSetups));
    }
    if (Number.isFinite(Number(policy.maxPerFamily)) && Number(policy.maxPerFamily) > 0) {
      policyFam = Math.floor(Number(policy.maxPerFamily));
    } else if (Number.isFinite(Number(policy.preservePerFamily)) && Number(policy.preservePerFamily) > 0) {
      policyFam = Math.floor(Number(policy.preservePerFamily));
    }
    if (Number.isFinite(Number(policy.maxPerSymbolTimeframe)) && Number(policy.maxPerSymbolTimeframe) > 0) {
      policySymTf = Math.floor(Number(policy.maxPerSymbolTimeframe));
    } else if (
      Number.isFinite(Number(policy.preservePerSymbolTimeframe)) &&
      Number(policy.preservePerSymbolTimeframe) > 0
    ) {
      policySymTf = Math.floor(Number(policy.preservePerSymbolTimeframe));
    }
  }

  const minTrades = envMin > 0 ? envMin : policyMin;
  const maxPerFamily = envFam > 0 ? envFam : policyFam;
  const maxPerSymbolTimeframe = envSymTf > 0 ? envSymTf : policySymTf;
  const maxTotal = envMax > 0 ? envMax : policyMaxSetups;

  const policyMeta = {
    policyEnabled: active,
    policyMode: mode,
    policyPath: policy.policyPath != null ? String(policy.policyPath) : null,
    policySource: policy.policySource != null ? String(policy.policySource) : 'unknown',
    sortKey:
      'metaScore|meta_score, expectancy, profitFactor|profit_factor, trades, setupId',
    diversityOrder: 'global_sort_then_greedy_symbolTf_cap_then_family_cap_then_maxSetups_stop',
    envOverride: {
      minTrades: envMin > 0,
      maxPerFamily: envFam > 0,
      maxPerSymbolTimeframe: envSymTf > 0,
      maxTotal: envMax > 0,
    },
    effective: { minTrades, maxPerFamily, maxPerSymbolTimeframe, maxTotal },
  };

  return { minTrades, maxPerFamily, maxPerSymbolTimeframe, maxTotal, policyMeta };
}

function preFilterBatchContentsForCorrelation(batchContents, opts = {}) {
  const minTrades = Number.isFinite(Number(opts.minTrades)) ? Number(opts.minTrades) : 0;
  const maxPerFamily = Number.isFinite(Number(opts.maxPerFamily)) ? Number(opts.maxPerFamily) : 0;
  const maxPerSymbolTimeframe = Number.isFinite(Number(opts.maxPerSymbolTimeframe))
    ? Math.max(0, Math.floor(Number(opts.maxPerSymbolTimeframe)))
    : 0;
  const maxTotal = Number.isFinite(Number(opts.maxTotal)) ? Number(opts.maxTotal) : 0;
  const policyMeta = opts.policyMeta && typeof opts.policyMeta === 'object' ? opts.policyMeta : null;
  if (minTrades <= 0 && maxPerFamily <= 0 && maxPerSymbolTimeframe <= 0 && maxTotal <= 0) {
    return { batchContents, stats: { enabled: false, policy: policyMeta } };
  }

  const bestBySetup = new Map();
  for (const b of batchContents || []) {
    const rows = Array.isArray(b && b.results) ? b.results : [];
    for (const r of rows) {
      const setupId = String((r && r.setupId) || '');
      if (!setupId) continue;
      const trades = preCorrTrades(r);
      if (minTrades > 0 && trades < minTrades) continue;
      const prev = bestBySetup.get(setupId);
      if (!prev || comparePreCorrRows(r, prev.row) < 0) {
        bestBySetup.set(setupId, {
          row: r,
          trades,
          family: preCorrFamilyKey(r),
          symTf: preCorrSymbolTimeframeKey(r),
          setupId,
        });
      }
    }
  }

  let selected = Array.from(bestBySetup.values()).sort((a, b) => comparePreCorrRows(a.row, b.row));
  const setupCountBefore = setupCountFromBatchContents(batchContents);
  const eligibleBefore = selected.length;

  const useGreedy =
    maxPerSymbolTimeframe > 0 || maxPerFamily > 0 || maxTotal > 0;
  if (useGreedy) {
    const symTfCounts = new Map();
    const familyCounts = new Map();
    const capped = [];
    for (const it of selected) {
      if (maxPerSymbolTimeframe > 0) {
        const n = symTfCounts.get(it.symTf) || 0;
        if (n >= maxPerSymbolTimeframe) continue;
      }
      if (maxPerFamily > 0) {
        const n = familyCounts.get(it.family) || 0;
        if (n >= maxPerFamily) continue;
      }
      if (maxPerSymbolTimeframe > 0) {
        symTfCounts.set(it.symTf, (symTfCounts.get(it.symTf) || 0) + 1);
      }
      if (maxPerFamily > 0) {
        familyCounts.set(it.family, (familyCounts.get(it.family) || 0) + 1);
      }
      capped.push(it);
      if (maxTotal > 0 && capped.length >= maxTotal) break;
    }
    selected = capped;
  }

  const selectedIds = new Set(selected.map((x) => x.setupId));
  const filtered = [];
  for (const b of batchContents || []) {
    const rows = Array.isArray(b && b.results) ? b.results : [];
    const keptRows = rows.filter((r) => selectedIds.has(String((r && r.setupId) || '')));
    if (keptRows.length) filtered.push({ ...b, results: keptRows });
  }

  return {
    batchContents: filtered,
    stats: {
      enabled: true,
      minTrades,
      maxPerFamily,
      maxPerSymbolTimeframe,
      maxTotal,
      setupCountBefore,
      eligibleBefore,
      setupCountAfter: selectedIds.size,
      batchFilesAfter: filtered.length,
      policy: policyMeta,
    },
  };
}

function metaStage(name, extra = {}) {
  const ts = new Date().toISOString();
  const parsed = parseMetaStageName(name);
  appendTimingJsonlBestEffort({
    ts,
    run: CURRENT_META_RUN_ID || null,
    component: 'meta',
    stage: parsed.stage,
    event: parsed.event,
    metaWorkersMode: CURRENT_META_WORKERS_MODE,
    metaWorkersUsed: CURRENT_META_WORKERS_USED,
    ...extra,
  });
  // eslint-disable-next-line no-console -- targeted runtime tracing for stuck meta diagnostics
  console.log('[META_STAGE]', { ts, stage: name, ...extra });
}

function isChildStrategy(strategy) {
  return !!(strategy && (strategy.parentSetupId || strategy.parentFamilyId || String(strategy.setupId || '').startsWith('familyexp_')));
}

/**
 * Lineage depth: number of "familyexp_" segments in setupId (proxy for generations in family expansion).
 */
function computeLineageDepth(setupId) {
  return (String(setupId || '').match(/familyexp_/g) || []).length;
}

/**
 * Lineage depth penalty factor (multiplicative): reduce score for deep lineages without killing good ones.
 * 0–2: no penalty; 3–4: small; 5–6: medium; 7+: stronger.
 */
function computeLineageDepthPenaltyFactor(depth) {
  if (!Number.isFinite(depth) || depth <= 2) return 1;
  if (depth <= 4) return 0.97;
  if (depth <= 6) return 0.92;
  return 0.85;
}

/**
 * Attach lineage_depth and lineage_depth_penalty_factor to each strategy for ranking.
 */
function applyLineageDepthPenalty(strategies) {
  const arr = Array.isArray(strategies) ? strategies : [];

  return arr.map((strategy) => {
    const depth = computeLineageDepth(strategy && strategy.setupId);
    const factor = computeLineageDepthPenaltyFactor(depth);

    return {
      ...strategy,
      lineage_depth: depth,
      lineage_depth_penalty_factor: factor,
    };
  });
}

function buildFamilyDiversityKey(strategy) {
  if (!strategy || typeof strategy !== 'object') return 'unknown|base';

  const mutationType = String(strategy.mutationType || 'base');

  const parentFamilyId =
    strategy.parentFamilyId ||
    strategy.parentSetupId ||
    null;

  if (parentFamilyId) {
    return `${String(parentFamilyId)}|${mutationType}`;
  }

  const baseFamily =
    strategy.familyKey ||
    strategy.setupId ||
    'unknown_base';

  return `${String(baseFamily)}|${mutationType}`;
}

function applyFamilyDiversityPenalty(strategies) {
  const arr = Array.isArray(strategies) ? strategies.slice() : [];
  const counts = {};

  return arr.map((strategy) => {
    const key = buildFamilyDiversityKey(strategy);
    counts[key] = (counts[key] || 0) + 1;

    const rankWithinFamily = counts[key];

    let factor = 1;
    if (rankWithinFamily === 2) factor = 0.85;
    else if (rankWithinFamily === 3) factor = 0.65;
    else if (rankWithinFamily >= 4) factor = 0.45;

    return {
      ...strategy,
      family_diversity_key: key,
      family_diversity_rank: rankWithinFamily,
      family_diversity_penalty_factor: factor,
    };
  });
}

function computeRecencyPenalty(strategy) {
  if (!isChildStrategy(strategy)) return 0;

  const generation = safeNum(strategy.generation, 0);
  const trades = safeNum(strategy.trades, 0);

  // Enfant récent mais peu validé -> petit malus
  if (generation <= 1 && trades < 250) return 0.08;
  if (generation <= 1 && trades < 500) return 0.05;
  if (generation <= 2 && trades < 750) return 0.025;

  return 0;
}

function computeInnovationBonus(strategy) {
  if (!isChildStrategy(strategy)) return 0;

  const beatsParentRate = safeNum(strategy.beatsParentRate, 0);
  const avgParentVsChildScore = safeNum(strategy.avgParentVsChildScore, 0);
  const trades = safeNum(strategy.trades, 0);

  // Bonus plafonné: on veut encourager, pas laisser un enfant voler tout le portefeuille
  let bonus = 0;
  bonus += Math.min(0.06, beatsParentRate * 0.06);
  bonus += Math.min(0.04, Math.max(0, avgParentVsChildScore) * 0.01);

  // Petit bonus seulement si minimum de validation
  if (trades >= 250) bonus += 0.015;
  if (trades >= 500) bonus += 0.01;

  return Math.min(0.10, bonus);
}

function computeHybridPortfolioScore(strategy, registryEntry) {
  const metaScore = safeNum(strategy.meta_score, 0);
  const lineagePenaltyFactor = safeNum(strategy.lineage_depth_penalty_factor, 1);
  const familyDiversityFactor = safeNum(strategy.family_diversity_penalty_factor, 1);
  const validationGateFactor = safeNum(strategy.validation_gate_factor, 1);
  const adjustedMetaScore =
    metaScore * lineagePenaltyFactor * familyDiversityFactor * validationGateFactor;

  const promotionBonus = safeNum(
    strategy.decayed_promotion_bonus,
    safeNum(
      strategy.effective_promotion_bonus,
      safeNum(strategy.promotion_bonus, 0)
    )
  );
  const breadthBonus = safeNum(strategy.promotion_breadth_score, 0);
  const adjustedSurvivalScore = safeNum(
    registryEntry && registryEntry.adjustedSurvivalScore,
    safeNum(strategy.adjustedSurvivalScore, 0)
  );
  const beatsParentRate = safeNum(
    registryEntry && registryEntry.beatsParentRate,
    safeNum(strategy.beatsParentRate, 0)
  );
  const avgParentVsChildScore = safeNum(
    registryEntry && registryEntry.avgParentVsChildScore,
    safeNum(strategy.avgParentVsChildScore, 0)
  );

  const parentBonus = Math.max(0, Math.min(0.05, avgParentVsChildScore * 0.01));
  const innovationBonus = computeInnovationBonus({
    ...strategy,
    beatsParentRate,
    avgParentVsChildScore,
  });
  const recencyPenalty = computeRecencyPenalty(strategy);

  const validationBonus =
    strategy && strategy.validationPassed === true
      ? safeNum(process.env.WALKFORWARD_VALIDATION_BONUS, 0.03)
      : 0;

  const raw =
    adjustedMetaScore * 0.55 +
    adjustedSurvivalScore * 0.30 +
    beatsParentRate * 0.08 +
    parentBonus +
    innovationBonus +
    promotionBonus +
    breadthBonus +
    validationBonus -
    recencyPenalty;

  return round6(Math.max(0, raw));
}

/**
 * Build map setupId -> registry entry (adjustedSurvivalScore, beatsParentRate, avgParentVsChildScore).
 * Registry entries use survivalScore (the adjusted value written by strategyEvolution).
 */
function buildRegistryMap(registry) {
  const map = new Map();
  if (!registry || !Array.isArray(registry.champions)) return map;
  for (const e of registry.champions) {
    const id = e.setupId || e.setup_id;
    if (!id) continue;
    map.set(String(id), {
      adjustedSurvivalScore: safeNum(e.survivalScore, 0),
      beatsParentRate: safeNum(e.beatsParentRate, 0),
      avgParentVsChildScore: safeNum(e.avgParentVsChildScore, 0),
    });
  }
  return map;
}

/**
 * Enrich portfolioCandidates with registry data and hybrid portfolio_score, sort by portfolio_score desc.
 */
function enrichAndSortByPortfolioScore(portfolioCandidates, registryMap) {
  const enriched = (portfolioCandidates || []).map((strategy) => {
    const registryEntry = registryMap.get(String(strategy.setupId)) || null;

    const adjustedSurvivalScore = safeNum(
      registryEntry && registryEntry.adjustedSurvivalScore,
      0
    );
    const beatsParentRate = safeNum(
      registryEntry && registryEntry.beatsParentRate,
      0
    );
    const avgParentVsChildScore = safeNum(
      registryEntry && registryEntry.avgParentVsChildScore,
      0
    );

    const portfolio_score = computeHybridPortfolioScore(strategy, registryEntry);

    return {
      ...strategy,
      adjustedSurvivalScore,
      beatsParentRate,
      avgParentVsChildScore,
      portfolio_score,
      isChild: isChildStrategy(strategy),
      recencyPenalty: round6(computeRecencyPenalty(strategy)),
      innovationBonus: round6(
        computeInnovationBonus({
          ...strategy,
          beatsParentRate,
          avgParentVsChildScore,
        })
      ),
    };
  });

  enriched.sort((a, b) => {
    return (
      safeNum(b.portfolio_score, 0) - safeNum(a.portfolio_score, 0) ||
      safeNum(
        b.decayed_promotion_bonus,
        safeNum(b.effective_promotion_bonus, safeNum(b.promotion_bonus, 0))
      ) -
        safeNum(
          a.decayed_promotion_bonus,
          safeNum(a.effective_promotion_bonus, safeNum(a.promotion_bonus, 0))
        ) ||
      safeNum(b.adjustedSurvivalScore, 0) - safeNum(a.adjustedSurvivalScore, 0) ||
      safeNum(b.meta_score, 0) - safeNum(a.meta_score, 0) ||
      safeNum(b.expectancy, 0) - safeNum(a.expectancy, 0)
    );
  });

  return enriched;
}

function selectCoreAndChallengers(candidates, opts = {}) {
  const maxStrategies = Math.max(1, Number(opts.maxStrategies || 12));
  const challengerSlots = Math.max(0, Number(opts.challengerSlots || 2));
  const coreSlots = Math.max(0, maxStrategies - challengerSlots);

  const all = Array.isArray(candidates) ? candidates.slice() : [];

  const corePool = all.filter((s) => !isChildStrategy(s));
  const challengerPool = all.filter((s) => isChildStrategy(s));

  corePool.sort((a, b) => {
    return (
      safeNum(b.portfolio_score, 0) - safeNum(a.portfolio_score, 0) ||
      safeNum(b.adjustedSurvivalScore, 0) - safeNum(a.adjustedSurvivalScore, 0) ||
      safeNum(b.meta_score, 0) - safeNum(a.meta_score, 0)
    );
  });

  challengerPool.sort((a, b) => {
    return (
      safeNum(b.portfolio_score, 0) - safeNum(a.portfolio_score, 0) ||
      safeNum(b.beatsParentRate, 0) - safeNum(a.beatsParentRate, 0) ||
      safeNum(b.avgParentVsChildScore, 0) - safeNum(a.avgParentVsChildScore, 0) ||
      safeNum(b.meta_score, 0) - safeNum(a.meta_score, 0)
    );
  });

  const selected = [];
  const used = new Set();

  for (const s of corePool) {
    if (selected.length >= coreSlots) break;
    if (used.has(s.setupId)) continue;
    selected.push(s);
    used.add(s.setupId);
  }

  for (const s of challengerPool) {
    if (selected.length >= maxStrategies) break;
    if (selected.filter((x) => isChildStrategy(x)).length >= challengerSlots) break;
    if (used.has(s.setupId)) continue;
    selected.push(s);
    used.add(s.setupId);
  }

  // Backfill si pas assez de challengers ou pas assez de core
  for (const s of all) {
    if (selected.length >= maxStrategies) break;
    if (used.has(s.setupId)) continue;
    selected.push(s);
    used.add(s.setupId);
  }

  selected.sort((a, b) => {
    return (
      safeNum(b.portfolio_score, 0) - safeNum(a.portfolio_score, 0) ||
      safeNum(b.meta_score, 0) - safeNum(a.meta_score, 0)
    );
  });

  return selected;
}

function buildStrategyIndex(strategies) {
  const map = new Map();
  for (const s of strategies || []) {
    if (!s || !s.setupId) continue;
    map.set(String(s.setupId), s);
  }
  return map;
}

function computeParentVsChildScore(child, parent) {
  if (!child || !parent) {
    return {
      hasParentComparison: false,
      beats_parent: false,
      parent_delta_expectancy: null,
      parent_delta_meta_score: null,
      parent_delta_winRate: null,
      parent_delta_trades_ratio: null,
      parent_vs_child_score: null,
    };
  }

  const childExpectancy = safeNum(child.expectancy, 0);
  const parentExpectancy = safeNum(parent.expectancy, 0);
  const childMeta = safeNum(child.meta_score, 0);
  const parentMeta = safeNum(parent.meta_score, 0);
  const childWinRate = safeNum(child.winRate, 0);
  const parentWinRate = safeNum(parent.winRate, 0);
  const childTrades = Math.max(0, safeNum(child.trades, 0));
  const parentTrades = Math.max(0, safeNum(parent.trades, 0));

  const deltaExpectancy = childExpectancy - parentExpectancy;
  const deltaMeta = childMeta - parentMeta;
  const deltaWinRate = childWinRate - parentWinRate;
  const tradesRatio = parentTrades > 0 ? (childTrades / parentTrades) : (childTrades > 0 ? 1 : 0);

  const normalizedTrades = Math.max(0, Math.min(1.5, tradesRatio)) / 1.5;

  const score =
    (deltaMeta * 100.0) +
    (deltaExpectancy * 10000.0) +
    (deltaWinRate * 10.0) +
    (normalizedTrades * 0.25);

  const beatsParent =
    (deltaMeta > 0 && deltaExpectancy >= 0) ||
    (deltaExpectancy > 0 && deltaWinRate >= 0 && tradesRatio >= 0.75);

  return {
    hasParentComparison: true,
    beats_parent: !!beatsParent,
    parent_delta_expectancy: round6(deltaExpectancy),
    parent_delta_meta_score: round6(deltaMeta),
    parent_delta_winRate: round6(deltaWinRate),
    parent_delta_trades_ratio: round6(tradesRatio),
    parent_vs_child_score: round6(score),
  };
}

function annotateParentVsChild(strategies) {
  const index = buildStrategyIndex(strategies);
  return (strategies || []).map((s) => {
    if (!s || !s.parentSetupId) {
      return {
        ...s,
        hasParentComparison: false,
        beats_parent: false,
        parent_delta_expectancy: null,
        parent_delta_meta_score: null,
        parent_delta_winRate: null,
        parent_delta_trades_ratio: null,
        parent_vs_child_score: null,
      };
    }

    const parent = index.get(String(s.parentSetupId));
    return {
      ...s,
      ...computeParentVsChildScore(s, parent),
    };
  });
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadPromotedChildren() {
  const discoveryDir = dataRoot.getPath('discovery');
  const promotedPath = path.join(discoveryDir, 'promoted_children.json');
  const json = safeReadJson(promotedPath);

  if (!json || !Array.isArray(json.strategies)) {
    return [];
  }

  return json.strategies.filter((s) => s && s.setupId);
}

function buildPromotedMap(promotedRows) {
  const map = new Map();
  for (const row of promotedRows || []) {
    if (!row || !row.setupId) continue;
    map.set(String(row.setupId), row);
  }
  return map;
}

function computePromotionBonus(strategy, promotedRow) {
  if (!promotedRow) return 0;
  if (promotedRow.beats_parent !== true) return 0;

  const score = safeNum(promotedRow.parent_vs_child_score, 0);
  const expectancy = safeNum(promotedRow.expectancy, 0);
  const trades = safeNum(promotedRow.trades, 0);
  const breadthScore = safeNum(promotedRow.promotion_breadth_score, 0);

  let bonus = 0;
  bonus += Math.min(0.12, Math.max(0, score) * 20.0);
  bonus += Math.min(0.06, Math.max(0, expectancy) * 25.0);
  bonus += Math.min(0.10, Math.max(0, breadthScore));
  if (trades >= 50) bonus += 0.015;
  if (trades >= 100) bonus += 0.015;
  if (trades >= 200) bonus += 0.02;

  return round6(Math.min(0.22, bonus));
}

function enrichWithPromotedChildren(strategies, promotedMap) {
  return (strategies || []).map((strategy) => {
    const promotedRow = promotedMap.get(String(strategy.setupId)) || null;
    const promotion_bonus = computePromotionBonus(strategy, promotedRow);
    const depth = computeLineageDepth(strategy && strategy.setupId);
    const lineageDepthPenaltyFactor = computeLineageDepthPenaltyFactor(depth);

    return {
      ...strategy,
      promotedLeader: !!(promotedRow && promotedRow.promotedLeader),
      promotion_bonus,
      promotion_penalty_factor: 1,
      effective_promotion_bonus: promotion_bonus,
      promotion_decay_factor: 1,
      decayed_promotion_bonus: promotion_bonus,
      distinctBatchFiles: promotedRow ? safeNum(promotedRow.distinctBatchFiles, 0) : safeNum(strategy.distinctBatchFiles, 0),
      promotion_breadth_score: promotedRow ? safeNum(promotedRow.promotion_breadth_score, 0) : safeNum(strategy.promotion_breadth_score, 0),
      firstPromotedAt: promotedRow ? promotedRow.firstPromotedAt || promotedRow.promotedAt || null : null,
      promotedAt: promotedRow ? promotedRow.promotedAt || null : null,
      promotionReason: promotedRow ? promotedRow.promotionReason || null : null,
      familyKey: promotedRow && promotedRow.familyKey ? promotedRow.familyKey : strategy.familyKey,
      parent_vs_child_score: promotedRow && Number.isFinite(Number(promotedRow.parent_vs_child_score))
        ? Number(promotedRow.parent_vs_child_score)
        : strategy.parent_vs_child_score,
      beats_parent: promotedRow && promotedRow.beats_parent === true ? true : !!strategy.beats_parent,
      lineage_depth: depth,
      lineage_depth_penalty_factor: lineageDepthPenaltyFactor,
    };
  });
}

/**
 * Apply saturation penalty to promoted children so the top meta does not get overrun
 * by too many similar promoted variants from the same mutationType or familyKey.
 *
 * Rule:
 * - first 2 of same mutationType: full promotion_bonus
 * - 3rd-4th of same mutationType: 50% bonus
 * - 5th+ of same mutationType: 25% bonus
 *
 * - first of same familyKey: full promotion_bonus
 * - 2nd of same familyKey: 50% bonus
 * - 3rd+ of same familyKey: 25% bonus
 */
function applyPromotionSaturationPenalty(strategies) {
  const arr = Array.isArray(strategies) ? strategies.slice() : [];

  const mutationTypeCounts = {};
  const familyKeyCounts = {};

  return arr.map((strategy) => {
    if (!strategy || !strategy.promotedLeader) {
      return {
        ...strategy,
        promotion_penalty_factor: 1,
        effective_promotion_bonus: safeNum(strategy && strategy.promotion_bonus, 0),
      };
    }

    const mutationType = String(strategy.mutationType || 'unknown');
    const familyKey = String(strategy.familyKey || 'no_family');

    mutationTypeCounts[mutationType] = (mutationTypeCounts[mutationType] || 0) + 1;
    familyKeyCounts[familyKey] = (familyKeyCounts[familyKey] || 0) + 1;

    const mutationRank = mutationTypeCounts[mutationType];
    const familyRank = familyKeyCounts[familyKey];

    let mutationFactor = 1;
    if (mutationRank >= 5) mutationFactor = 0.25;
    else if (mutationRank >= 3) mutationFactor = 0.5;

    let familyFactor = 1;
    if (familyRank >= 3) familyFactor = 0.25;
    else if (familyRank >= 2) familyFactor = 0.5;

    const penaltyFactor = Math.min(mutationFactor, familyFactor);
    const baseBonus = safeNum(strategy.promotion_bonus, 0);
    const effectiveBonus = round6(baseBonus * penaltyFactor);

    return {
      ...strategy,
      promotion_penalty_factor: penaltyFactor,
      effective_promotion_bonus: effectiveBonus,
    };
  });
}

function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function computePromotionDecayFactor(strategy) {
  const promotedAtMs = parseDateMs(strategy && strategy.promotedAt);
  if (!promotedAtMs) return 1;

  const nowMs = Date.now();
  const ageMs = Math.max(0, nowMs - promotedAtMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);

  // Decay schedule:
  // 0-1 day   -> 1.00
  // 1-2 days  -> 0.75
  // 2-3 days  -> 0.50
  // 3+ days   -> 0.25
  if (ageDays >= 3) return 0.25;
  if (ageDays >= 2) return 0.50;
  if (ageDays >= 1) return 0.75;
  return 1.00;
}

/**
 * Apply time decay to promotion bonus so older promoted children
 * must keep re-earning their place instead of staying privileged forever.
 */
function applyPromotionDecay(strategies) {
  const arr = Array.isArray(strategies) ? strategies.slice() : [];

  return arr.map((strategy) => {
    const baseEffectiveBonus = safeNum(
      strategy && strategy.effective_promotion_bonus,
      safeNum(strategy && strategy.promotion_bonus, 0)
    );

    const decayFactor = computePromotionDecayFactor(strategy);
    const decayedBonus = round6(baseEffectiveBonus * decayFactor);

    return {
      ...strategy,
      promotion_decay_factor: decayFactor,
      decayed_promotion_bonus: decayedBonus,
    };
  });
}

/**
 * Composite score without family diversity (depth + promo + breadth only).
 * Used for initial pool sort before greedy selection.
 */
function computePreDiversityComposite(strategy) {
  const depth = safeNum(strategy.lineage_depth, computeLineageDepth(strategy.setupId));
  const depthFactor = safeNum(
    strategy.lineage_depth_penalty_factor,
    computeLineageDepthPenaltyFactor(depth)
  );
  const validationGateFactor = safeNum(strategy.validation_gate_factor, 1);

  return (
    safeNum(strategy.meta_score, 0) * depthFactor * validationGateFactor +
    safeNum(strategy.decayed_promotion_bonus, 0) +
    safeNum(strategy.promotion_breadth_score, 0)
  );
}

/**
 * Final composite including family diversity penalty computed from current familyCounts.
 * Used by greedy reranker so family_diversity_rank reflects rank in the final order.
 */
function computeFinalCompositeWithPenalties(strategy, familyCounts = {}) {
  const depth = safeNum(strategy.lineage_depth, computeLineageDepth(strategy.setupId));
  const depthFactor = safeNum(
    strategy.lineage_depth_penalty_factor,
    computeLineageDepthPenaltyFactor(depth)
  );

  const familyKey = buildFamilyDiversityKey(strategy);
  const nextRank = (familyCounts[familyKey] || 0) + 1;

  let familyFactor = 1;
  if (nextRank === 2) familyFactor = 0.85;
  else if (nextRank === 3) familyFactor = 0.65;
  else if (nextRank >= 4) familyFactor = 0.45;

  const validationGateFactor = safeNum(strategy.validation_gate_factor, 1);

  const composite =
    safeNum(strategy.meta_score, 0) *
      depthFactor *
      familyFactor *
      validationGateFactor +
    safeNum(strategy.decayed_promotion_bonus, 0) +
    safeNum(strategy.promotion_breadth_score, 0);

  return {
    composite,
    familyKey,
    familyRank: nextRank,
    familyPenaltyFactor: familyFactor,
    depth,
    depthFactor,
  };
}

/**
 * Greedy reranker: build final ranking one position at a time, recomputing family diversity
 * from already-selected strategies. So family_diversity_rank is the real rank in the final order.
 */
function sortRankedStrategies(strategies) {
  const penalized = applyPromotionSaturationPenalty(strategies);
  const decayed = applyPromotionDecay(penalized);
  const depthAdjusted = applyLineageDepthPenalty(decayed);
  const pool = Array.isArray(depthAdjusted) ? depthAdjusted.slice() : [];

  // Base sort first, without family diversity
  pool.sort((a, b) => {
    return (
      computePreDiversityComposite(b) - computePreDiversityComposite(a) ||
      safeNum(b.parent_vs_child_score, 0) - safeNum(a.parent_vs_child_score, 0) ||
      safeNum(b.expectancy, 0) - safeNum(a.expectancy, 0) ||
      safeNum(b.trades, 0) - safeNum(a.trades, 0)
    );
  });

  // Greedy final ranking with live family diversity penalty
  const selected = [];
  const remaining = pool.slice();
  const familyCounts = {};

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    let bestMeta = null;

    for (let i = 0; i < remaining.length; i += 1) {
      const s = remaining[i];
      const meta = computeFinalCompositeWithPenalties(s, familyCounts);

      const score = meta.composite;
      const currentBestMetaScore = bestMeta ? bestMeta.composite : -Infinity;

      if (
        score > bestScore ||
        (score === bestScore &&
          (safeNum(s.parent_vs_child_score, 0) >
            safeNum(remaining[bestIdx]?.parent_vs_child_score, 0) ||
            (safeNum(s.parent_vs_child_score, 0) ===
              safeNum(remaining[bestIdx]?.parent_vs_child_score, 0) &&
              safeNum(s.expectancy, 0) > safeNum(remaining[bestIdx]?.expectancy, 0)) ||
            (safeNum(s.parent_vs_child_score, 0) ===
              safeNum(remaining[bestIdx]?.parent_vs_child_score, 0) &&
              safeNum(s.expectancy, 0) === safeNum(remaining[bestIdx]?.expectancy, 0) &&
              safeNum(s.trades, 0) > safeNum(remaining[bestIdx]?.trades, 0))))
      ) {
        bestIdx = i;
        bestScore = score;
        bestMeta = meta;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    familyCounts[bestMeta.familyKey] = bestMeta.familyRank;

    selected.push({
      ...chosen,
      lineage_depth: safeNum(chosen.lineage_depth, bestMeta.depth),
      lineage_depth_penalty_factor: safeNum(
        chosen.lineage_depth_penalty_factor,
        bestMeta.depthFactor
      ),
      family_diversity_key: bestMeta.familyKey,
      family_diversity_rank: bestMeta.familyRank,
      family_diversity_penalty_factor: bestMeta.familyPenaltyFactor,
    });
  }

  return selected;
}

/**
 * Hard cap by diversity: keep at most maxCount strategies, with at most maxPerParentFamily
 * per parentFamilyId and maxPerFamilyDiversityKey per family_diversity_key. Applied in rank order.
 */
function capRankedStrategiesByDiversity(strategies, opts = {}) {
  const arr = Array.isArray(strategies) ? strategies.slice() : [];
  const maxCount = Math.max(1, safeNum(opts.maxCount, arr.length));
  const maxPerParentFamily = Math.max(1, safeNum(opts.maxPerParentFamily, 2));
  const maxPerFamilyDiversityKey = Math.max(1, safeNum(opts.maxPerFamilyDiversityKey, 2));

  const out = [];
  const byParentFamily = {};
  const byFamilyDiversityKey = {};

  for (const s of arr) {
    if (out.length >= maxCount) break;

    const parentFamily = String(
      s.parentFamilyId ||
        s.parentSetupId ||
        s.familyKey ||
        s.setupId ||
        'unknown_parent_family'
    );

    const familyKey = String(s.family_diversity_key || buildFamilyDiversityKey(s));

    const parentFamilyCount = byParentFamily[parentFamily] || 0;
    const familyKeyCount = byFamilyDiversityKey[familyKey] || 0;

    if (parentFamilyCount >= maxPerParentFamily) continue;
    if (familyKeyCount >= maxPerFamilyDiversityKey) continue;

    byParentFamily[parentFamily] = parentFamilyCount + 1;
    byFamilyDiversityKey[familyKey] = familyKeyCount + 1;

    out.push({
      ...s,
      top_diversity_parent_family_count: byParentFamily[parentFamily],
      top_diversity_family_key_count: byFamilyDiversityKey[familyKey],
    });
  }

  return out;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listBatchFiles(batchDir) {
  if (!fs.existsSync(batchDir)) return [];
  return fs.readdirSync(batchDir)
    .filter((f) => /^strategy_batch_results_.*\.json$/i.test(f))
    .map((f) => path.join(batchDir, f))
    .sort();
}

function parseBatchIdentity(fileName, json) {
  const base = path.basename(fileName, '.json');
  const rest = base.replace(/^strategy_batch_results_/i, '');
  const parts = rest.split('_');
  if (parts.length >= 2) {
    const symbol = parts.slice(0, -1).join('_').toUpperCase();
    const timeframe = parts[parts.length - 1].toLowerCase();
    return {
      symbol,
      timeframe,
      dataGroup: json && json.dataGroup ? json.dataGroup : null,
    };
  }
  return {
    symbol: null,
    timeframe: null,
    dataGroup: json && json.dataGroup ? json.dataGroup : null,
  };
}

function groupResultsBySetup(batchFiles) {
  const bySetup = new Map();
  const sourceSummaries = [];

  for (const file of batchFiles) {
    const json = safeReadJson(file);
    if (!json || !Array.isArray(json.results)) continue;

    const id = parseBatchIdentity(file, json);

    const validRows = [];
    let invalidCount = 0;

    for (const r of json.results) {
      if (!r || !r.setupId) continue;

      const valid = isValidResult(r);
      if (!valid) {
        invalidCount += 1;
        continue;
      }

      validRows.push(r);
    }

    sourceSummaries.push({
      file,
      symbol: id.symbol,
      timeframe: id.timeframe,
      dataGroup: id.dataGroup,
      count: json.results.length,
      validCount: validRows.length,
      invalidCount,
    });

    for (const r of validRows) {
      const setupId = String(r.setupId);
      if (!bySetup.has(setupId)) {
        bySetup.set(setupId, []);
      }

      bySetup.get(setupId).push({
        setupId,
        symbol: id.symbol,
        timeframe: id.timeframe,
        asset: id.symbol && id.timeframe ? `${id.symbol}_${id.timeframe}` : null,
        expectancy: Number.isFinite(r.expectancy) ? r.expectancy : 0,
        trades: Number.isFinite(r.trades) ? r.trades : 0,
        winRate: Number.isFinite(r.winRate) ? r.winRate : null,
        drawdown: Number.isFinite(r.drawdown) ? r.drawdown : 0,
        raw: r,
        file,
      });
    }
  }

  return {
    bySetup,
    sourceSummaries,
  };
}

function processBatchFilesChunk(batchFiles) {
  const bySetupObj = {};
  const sourceSummaries = [];

  for (const file of batchFiles || []) {
    const json = safeReadJson(file);
    if (!json || !Array.isArray(json.results)) continue;
    const id = parseBatchIdentity(file, json);
    const validRows = [];
    let invalidCount = 0;
    for (const r of json.results) {
      if (!r || !r.setupId) continue;
      if (!isValidResult(r)) {
        invalidCount += 1;
        continue;
      }
      validRows.push(r);
    }
    sourceSummaries.push({
      file,
      symbol: id.symbol,
      timeframe: id.timeframe,
      dataGroup: id.dataGroup,
      count: json.results.length,
      validCount: validRows.length,
      invalidCount,
    });
    for (const r of validRows) {
      const setupId = String(r.setupId);
      if (!bySetupObj[setupId]) bySetupObj[setupId] = [];
      bySetupObj[setupId].push({
        setupId,
        symbol: id.symbol,
        timeframe: id.timeframe,
        asset: id.symbol && id.timeframe ? `${id.symbol}_${id.timeframe}` : null,
        expectancy: Number.isFinite(r.expectancy) ? r.expectancy : 0,
        trades: Number.isFinite(r.trades) ? r.trades : 0,
        winRate: Number.isFinite(r.winRate) ? r.winRate : null,
        drawdown: Number.isFinite(r.drawdown) ? r.drawdown : 0,
        raw: r,
        file,
      });
    }
  }

  return { bySetupObj, sourceSummaries };
}

function mergeChunkOutputs(chunks) {
  const bySetup = new Map();
  const sourceSummaries = [];
  for (const chunk of chunks || []) {
    if (!chunk) continue;
    if (Array.isArray(chunk.sourceSummaries)) sourceSummaries.push(...chunk.sourceSummaries);
    const obj = chunk.bySetupObj && typeof chunk.bySetupObj === 'object' ? chunk.bySetupObj : {};
    for (const [setupId, entries] of Object.entries(obj)) {
      if (!bySetup.has(setupId)) bySetup.set(setupId, []);
      if (Array.isArray(entries) && entries.length) bySetup.get(setupId).push(...entries);
    }
  }
  sourceSummaries.sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')));
  return { bySetup, sourceSummaries };
}

function chunkArray(arr, n) {
  const src = Array.isArray(arr) ? arr : [];
  if (n <= 1 || src.length <= 1) return [src.slice()];
  const chunks = Array.from({ length: n }, () => []);
  for (let i = 0; i < src.length; i += 1) chunks[i % n].push(src[i]);
  return chunks.filter((c) => c.length > 0);
}

function readCpuIdlePercent() {
  try {
    // iostat can hang on some macOS environments; bound it hard.
    const out = execSync('iostat -c 2 2', { encoding: 'utf8', timeout: 5000 });
    const lines = String(out || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const parts = lines[i].split(/\s+/).map((p) => Number(p));
      if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) return parts[2];
    }
  } catch (_) {
    // fallback below
  }
  return null;
}

function decideMetaWorkers(requestedMode, opts = {}) {
  const ncpu = Math.max(1, Number(os.cpus && os.cpus().length) || 1);
  const minW = Math.max(1, Number(opts.minWorkers || process.env.NEUROPILOT_META_WORKERS_MIN || 1));
  const maxW = Math.max(minW, Number(opts.maxWorkers || process.env.NEUROPILOT_META_WORKERS_MAX || 6));
  const idleThreshold = Number(
    opts.idleCpuThreshold || process.env.NEUROPILOT_META_WORKERS_IDLE_CPU_THRESHOLD || 60
  );
  const stalledBoost = Math.max(
    0,
    Number(opts.stalledBoost || process.env.NEUROPILOT_META_WORKERS_STALLED_BOOST || 2)
  );
  const modeRaw = String(requestedMode || process.env.NEUROPILOT_META_WORKERS || '1').trim().toLowerCase();
  const stalled = String(process.env.NEUROPILOT_META_STALLED || '').trim() === '1';
  const cpuIdleAtStart = modeRaw === 'auto' ? readCpuIdlePercent() : null;

  let workersRequested = 1;
  if (modeRaw === 'auto') {
    if (Number.isFinite(cpuIdleAtStart)) {
      if (cpuIdleAtStart >= 75) workersRequested = Math.floor(ncpu * 0.7);
      else if (cpuIdleAtStart >= idleThreshold) workersRequested = Math.floor(ncpu * 0.5);
      else if (cpuIdleAtStart >= 35) workersRequested = Math.floor(ncpu * 0.35);
      else workersRequested = 2;
    } else {
      workersRequested = Math.floor(ncpu * 0.5);
    }
    if (stalled) workersRequested += stalledBoost;
  } else {
    workersRequested = Number.isFinite(Number(modeRaw)) ? Number(modeRaw) : 1;
  }

  workersRequested = Math.max(1, Math.floor(workersRequested));
  const workersUsed =
    modeRaw === 'auto'
      ? Math.min(maxW, Math.max(minW, workersRequested))
      : Math.min(maxW, workersRequested);

  return {
    metaWorkersMode: modeRaw,
    metaWorkersRequested: workersRequested,
    metaWorkersUsed: workersUsed,
    cpuIdleAtStart,
    stalledBoostApplied: modeRaw === 'auto' && stalled ? stalledBoost : 0,
  };
}

async function groupResultsBySetupParallel(batchFiles, workersUsed) {
  const files = Array.isArray(batchFiles) ? batchFiles : [];
  const timeoutMsRaw = Number(process.env.NEUROPILOT_META_GROUP_WORKER_TIMEOUT_MS || 0);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : 0;
  // If timeout is enabled, prefer worker-based file reads even in "single worker" mode to avoid
  // unbounded hangs in fs.readFileSync/JSON.parse on some environments.
  if ((workersUsed <= 1 || files.length <= 1) && timeoutMs === 0) return groupResultsBySetup(files);

  async function processFilesWithPerFileWorkers() {
    const bySetup = new Map();
    const sourceSummaries = [];
    const skippedFiles = [];

    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop -- bounded N (typically < 50), improves determinism
      const out = await new Promise((resolve) => {
        const w = new Worker(__filename, {
          workerData: { mode: 'groupOneFile', filePath: file },
        });
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(v);
        };
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                try {
                  w.terminate();
                } catch (_) {
                  // ignore
                }
                done({ ok: false, file, error: `meta file worker timeout after ${timeoutMs}ms` });
              }, timeoutMs)
            : null;
        w.on('message', (msg) => done({ ok: true, ...msg }));
        w.on('error', (e) => done({ ok: false, file, error: e && e.message ? String(e.message) : String(e) }));
        w.on('exit', (code) => {
          if (code !== 0) done({ ok: false, file, error: `meta file worker exited with code ${code}` });
        });
      });

      if (!out || out.ok !== true) {
        skippedFiles.push({ file, error: out && out.error ? out.error : 'unknown_error' });
        continue;
      }

      if (out.sourceSummary) sourceSummaries.push(out.sourceSummary);
      const entries = out.entriesBySetupId || {};
      for (const [setupId, arr] of Object.entries(entries)) {
        if (!bySetup.has(setupId)) bySetup.set(setupId, []);
        bySetup.get(setupId).push(...(Array.isArray(arr) ? arr : []));
      }
    }

    if (skippedFiles.length) {
      // eslint-disable-next-line no-console -- ops audit: skipped batch files are critical to see
      console.warn('[META_NON_FATAL_SKIP_BATCH_FILES]', {
        skipped: skippedFiles.length,
        timeoutMs,
        skippedFiles: skippedFiles.slice(0, 12),
      });
    }

    sourceSummaries.sort((a, b) => String(a.file || '').localeCompare(String(b.file || '')));
    return { bySetup, sourceSummaries };
  }

  if (timeoutMs > 0) {
    return await processFilesWithPerFileWorkers();
  }
  const chunks = chunkArray(files, Math.min(workersUsed, files.length));
  const tasks = chunks.map((chunk) => new Promise((resolve, reject) => {
    const w = new Worker(__filename, {
      workerData: { mode: 'groupResultsChunk', batchFiles: chunk },
    });
    let settled = false;
    const finalize = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };
    const ok = finalize(resolve);
    const fail = finalize(reject);

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              w.terminate();
            } catch (_) {
              // ignore
            }
            fail(new Error(`meta worker timeout after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

    w.on('message', (msg) => ok(msg));
    w.on('error', (e) => fail(e));
    w.on('exit', (code) => {
      if (code !== 0) fail(new Error(`meta worker exited with code ${code}`));
    });
  }));
  const outputs = await Promise.all(tasks);
  return mergeChunkOutputs(outputs);
}

async function computeReturnCorrelationMatrixWithTimeout(batchContents) {
  const timeoutMsRaw = Number(process.env.NEUROPILOT_META_CORRELATION_TIMEOUT_MS || 0);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : 0;
  if (timeoutMs === 0) {
    return computeReturnCorrelationMatrix(batchContents);
  }
  return await new Promise((resolve, reject) => {
    const w = new Worker(__filename, {
      workerData: { mode: 'returnCorrelation', batchContents: Array.isArray(batchContents) ? batchContents : [] },
    });
    let settled = false;
    const doneResolve = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    const doneReject = (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    };
    const timer = setTimeout(() => {
      try {
        w.terminate();
      } catch (_) {
        // ignore
      }
      doneReject(new Error(`meta correlation timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    w.on('message', (msg) => doneResolve(msg));
    w.on('error', (e) => doneReject(e));
    w.on('exit', (code) => {
      if (code !== 0) doneReject(new Error(`meta correlation worker exited with code ${code}`));
    });
  });
}

/**
 * True for next-gen champion children: batch/source + setupId fallback (older rows may omit source).
 */
function isChampionMutationChildStrategy(s) {
  if (!s || !s.parentSetupId) return false;
  if (String(s.source || '') === 'champion_mutation') return true;
  if (String(s.setupId || '').startsWith('mut_')) return true;
  return false;
}

function readEnvNonEmptyNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function isTruthyEnvFlag(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Opt-in: relaxed min-trades for champion_mutation / mut_* children only. Default off = legacy behavior. */
function isMetaChildMinTradesRelaxEnabled() {
  return (
    isTruthyEnvFlag(process.env.NEUROPILOT_META_CHILD_MIN_TRADES_RELAX) ||
    isTruthyEnvFlag(process.env.META_RELAX_CHILD_MIN_TRADES)
  );
}

function bucketTradesLabel(t) {
  const n = safeNum(t, 0);
  if (n <= 1) return '0_1';
  if (n <= 7) return '2_7';
  if (n <= 14) return '8_14';
  if (n <= 29) return '15_29';
  return '30_plus';
}

/**
 * Core filter + audit report. When relax is off, behavior matches pre-2026 logic for ALL children.
 * When relax is on, champion_mutation / mut_* children use a lower absolute floor (and optional parent ratio).
 */
function runChildMinTradesFilter(strategies, opts = {}) {
  const minTradesAbsolute = Math.max(0, safeNum(opts.minTradesAbsolute, 30));
  const minTradesRatio = Math.max(0, Math.min(1, safeNum(opts.minTradesRatio, 0.3)));
  const bySetupId = new Map((strategies || []).map((s) => [String(s.setupId), s]));
  const relax = isMetaChildMinTradesRelaxEnabled();

  const MUT_ABS_DEFAULT = 12;
  const MUT_RATIO_DEFAULT = 0.15;
  const mutationMinAbs = Math.max(
    0,
    opts.minTradesForMutationChild != null && Number.isFinite(Number(opts.minTradesForMutationChild))
      ? Number(opts.minTradesForMutationChild)
      : readEnvNonEmptyNumber(
          'NEUROPILOT_META_CHILD_MIN_TRADES_ABS',
          readEnvNonEmptyNumber(
            'META_MUTATION_CHILD_MIN_TRADES',
            readEnvNonEmptyNumber('META_MUTATION_CHILD_MIN_TRADES_ABSOLUTE', MUT_ABS_DEFAULT)
          )
        )
  );
  const mutationMinRatio = Math.max(
    0,
    Math.min(
      1,
      opts.minTradesRatioForMutationChild != null &&
        Number.isFinite(Number(opts.minTradesRatioForMutationChild))
        ? Number(opts.minTradesRatioForMutationChild)
        : readEnvNonEmptyNumber(
            'NEUROPILOT_META_CHILD_MIN_TRADES_RATIO',
            readEnvNonEmptyNumber('META_MUTATION_CHILD_MIN_TRADES_RATIO', MUT_RATIO_DEFAULT)
          )
    )
  );
  const mutationUseParentRatio =
    isTruthyEnvFlag(process.env.NEUROPILOT_META_CHILD_MIN_TRADES_USE_PARENT_RATIO) ||
    isTruthyEnvFlag(process.env.META_USE_PARENT_RATIO_FOR_MUTATION_CHILD) ||
    String(process.env.META_MUTATION_CHILD_USE_PARENT_RATIO || '').trim() === '1';

  const histDropped = { '0_1': 0, '2_7': 0, '8_14': 0, '15_29': 0, '30_plus': 0 };
  const sampleDropped = [];
  const maxSamples = 40;

  const bumpHist = (trades) => {
    const k = bucketTradesLabel(trades);
    if (histDropped[k] != null) histDropped[k] += 1;
  };
  const pushSample = (setupId, trades, minRequired, pathLabel) => {
    bumpHist(trades);
    if (sampleDropped.length < maxSamples) {
      sampleDropped.push({
        setupId: String(setupId || ''),
        childTrades: safeNum(trades, 0),
        minRequired,
        path: pathLabel,
      });
    }
  };

  let childrenIn = 0;
  let childrenKept = 0;
  let droppedStrict = 0;
  let mutEval = 0;
  let mutKeptStrict = 0;
  let mutDroppedStrict = 0;
  let mutKeptRelax = 0;
  let mutDroppedRelax = 0;

  const list = strategies || [];
  const kept = list.filter((s) => {
    if (!s.parentSetupId) return true;

    childrenIn += 1;
    const childTrades = safeNum(s.trades, 0);
    const parent = bySetupId.get(String(s.parentSetupId));
    const parentTrades = parent ? Math.max(0, safeNum(parent.trades, 0)) : 0;
    const strictMin =
      parentTrades > 0
        ? Math.max(minTradesAbsolute, Math.floor(parentTrades * minTradesRatio))
        : minTradesAbsolute;

    const isMut = isChampionMutationChildStrategy(s);
    if (isMut) mutEval += 1;

    if (relax && isMut) {
      let minTr = mutationMinAbs;
      if (mutationUseParentRatio && parentTrades > 0) {
        minTr = Math.max(mutationMinAbs, Math.floor(parentTrades * mutationMinRatio));
      }
      if (childTrades >= minTr) {
        mutKeptRelax += 1;
        childrenKept += 1;
        return true;
      }
      mutDroppedRelax += 1;
      pushSample(s.setupId, childTrades, minTr, 'mutation_relax');
      return false;
    }

    if (childTrades >= strictMin) {
      if (isMut) mutKeptStrict += 1;
      childrenKept += 1;
      return true;
    }
    droppedStrict += 1;
    if (isMut) mutDroppedStrict += 1;
    pushSample(s.setupId, childTrades, strictMin, 'strict');
    return false;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    relaxEnabled: relax,
    strict: { minTradesAbsolute, minTradesRatio },
    relaxParams: relax
      ? {
          mutationMinAbs,
          mutationMinRatio,
          mutationUseParentRatio,
        }
      : null,
    counts: {
      strategiesIn: list.length,
      strategiesOut: kept.length,
      childrenIn,
      childrenKept,
      childrenDropped: childrenIn - childrenKept,
      droppedStrictPath: droppedStrict,
      droppedMutationRelaxPath: mutDroppedRelax,
      mutationChildrenEvaluated: mutEval,
      mutationChildrenKeptStrict: mutKeptStrict,
      mutationChildrenDroppedStrict: mutDroppedStrict,
      mutationChildrenKeptRelax: mutKeptRelax,
      mutationChildrenDroppedRelax: mutDroppedRelax,
    },
    droppedTradesHistogram: histDropped,
    sampleDropped,
  };

  return { strategies: kept, report };
}

/**
 * Filter out child strategies that have too few trades vs parent.
 * minTradesAbsolute: minimum trades for any child (e.g. 30).
 * minTradesRatio: child must have at least parentTrades * ratio (e.g. 0.3).
 * Effective min for a child = max(minTradesAbsolute, parentTrades * minTradesRatio) when parent is known.
 *
 * Opt-in relaxed path (champion_mutation / mut_* only): set NEUROPILOT_META_CHILD_MIN_TRADES_RELAX=1.
 * See META_MUTATION_CHILD_MIN_TRADES.md and discovery/meta_child_min_trades_filter.json (written by runMetaPipeline).
 */
function filterChildrenByMinTrades(strategies, opts = {}) {
  return runChildMinTradesFilter(strategies, opts).strategies;
}

function average(nums) {
  const arr = (nums || []).filter((x) => Number.isFinite(x));
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(nums) {
  return (nums || []).filter((x) => Number.isFinite(x)).reduce((a, b) => a + b, 0);
}

function pickValidationEntries(entries) {
  const all = Array.isArray(entries) ? entries : [];

  const validationTagged = all.filter((e) => {
    const raw = e && e.raw;
    return (
      raw &&
      (raw.walkforwardSplit === 'validation' ||
        raw.datasetSplit === 'validation' ||
        raw.isValidation === true)
    );
  });

  if (validationTagged.length) return validationTagged;

  return [];
}

function pickTrainEntries(entries) {
  const all = Array.isArray(entries) ? entries : [];

  return all.filter((e) => {
    const raw = e && e.raw;
    return raw && (raw.walkforwardSplit === 'train' || raw.datasetSplit === 'train');
  });
}

/** Timeframe-aware minimum validation trades for confidence (low-frequency strategies not unfairly rejected). */
function getMinValidationTradesForTimeframe(timeframe, opts = {}) {
  const override = safeNum(opts.minValidationTrades, NaN);
  if (Number.isFinite(override)) return Math.max(1, override);

  const envVal = process.env.WALKFORWARD_MIN_VALIDATION_TRADES;
  if (envVal && /^\d+$/.test(String(envVal).trim())) {
    return Math.max(1, parseInt(envVal, 10));
  }

  const tf = String(timeframe || '').toLowerCase().replace(/\s/g, '');
  const byTf = {
    '1m': 30,
    '2m': 25,
    '5m': 15,
    '15m': 12,
    '30m': 10,
    '1h': 8,
    '4h': 5,
    '1d': 4,
  };
  return Math.max(1, byTf[tf] || 10);
}

/**
 * Multi-factor validation score in [0, 1]. Replaces binary pass/fail.
 * Factors: expectancy (allow slight negative), trade count confidence, win rate, degradation vs train.
 * Avoids overfitting: penalizes large degradation from train; does not reward randomness.
 */
function computeValidationScore(metrics, opts = {}) {
  const {
    validationExpectancy,
    validationTrades,
    validationWinRate,
    trainExpectancy,
    trainTrades,
  } = metrics;

  const timeframe = opts.timeframe || null;
  const minTrades = getMinValidationTradesForTimeframe(timeframe, opts);

  const weightExpectancy = safeNum(opts.weightExpectancy, 0.35);
  const weightTrades = safeNum(opts.weightTrades, 0.25);
  const weightWinRate = safeNum(opts.weightWinRate, 0.2);
  const weightDegradation = safeNum(opts.weightDegradation, 0.2);

  const exp = Number.isFinite(validationExpectancy) ? validationExpectancy : 0;
  const trades = Math.max(0, safeNum(validationTrades, 0));
  const wr = Number.isFinite(validationWinRate) ? Math.max(0, Math.min(1, validationWinRate)) : 0.5;

  const expectancyComponent = Math.max(
    0,
    Math.min(1, 0.5 + exp * 5)
  );

  const tradesConfidence =
    minTrades <= 0 ? 1 : Math.min(1, trades / Math.max(minTrades * 2, 1));

  const winRateComponent = wr;

  let degradationComponent = 0.5;
  if (Number.isFinite(trainExpectancy) && Number.isFinite(validationExpectancy)) {
    const trainAbs = Math.max(0.01, Math.abs(trainExpectancy));
    const degradation = (validationExpectancy - trainExpectancy) / trainAbs;
    degradationComponent = Math.max(0, Math.min(1, 0.5 - degradation * 0.5));
  }

  const rawScore =
    weightExpectancy * expectancyComponent +
    weightTrades * tradesConfidence +
    weightWinRate * winRateComponent +
    weightDegradation * degradationComponent;

  const score = Math.max(0, Math.min(1, rawScore));
  return round6(score);
}

/**
 * Graduated validation gate factor in [0.4, 1.1]. Strong validation can boost; weak penalized.
 * Replaces binary 1.0 / 0.55.
 */
function computeValidationGateFactor(strategy, opts = {}) {
  const requireValidationForFullScore =
    opts.requireValidationForFullScore != null
      ? !!opts.requireValidationForFullScore
      : String(process.env.WALKFORWARD_REQUIRE_VALIDATION || '1') === '1';

  const missingFactor = Math.max(
    0,
    Math.min(1, safeNum(process.env.WALKFORWARD_MISSING_FACTOR, 0.75))
  );

  if (!requireValidationForFullScore) return 1;

  if (!strategy || strategy.validationAvailable === false) {
    return missingFactor;
  }

  const score = safeNum(strategy.validation_score, 0);

  const gateMin = Math.max(0.2, Math.min(0.5, safeNum(process.env.WALKFORWARD_GATE_MIN, 0.4)));
  const gateMax = Math.max(1, Math.min(1.2, safeNum(process.env.WALKFORWARD_GATE_MAX, 1.05)));

  const factor = gateMin + (gateMax - gateMin) * score;
  return round6(Math.max(gateMin, Math.min(gateMax, factor)));
}

function computeValidationMetrics(entries, opts = {}) {
  const validationEntries = pickValidationEntries(entries);
  const trainEntries = pickTrainEntries(entries);

  const timeframe =
    (Array.isArray(entries) && entries[0] && entries[0].timeframe) || opts.timeframe || null;

  if (!validationEntries.length) {
    return {
      validationAvailable: false,
      validationExpectancy: null,
      validationTrades: 0,
      validationWinRate: null,
      validationPassed: false,
      validation_score: 0,
      trainExpectancy: null,
      trainTrades: 0,
    };
  }

  const validationExpectancy = average(validationEntries.map((e) => safeNum(e.expectancy, 0)));
  const validationTrades = sum(validationEntries.map((e) => safeNum(e.trades, 0)));
  const validationWinRate = average(
    validationEntries.map((e) => e.winRate).filter((x) => Number.isFinite(x))
  );

  const trainExpectancy = trainEntries.length
    ? average(trainEntries.map((e) => safeNum(e.expectancy, 0)))
    : null;
  const trainTrades = trainEntries.length ? sum(trainEntries.map((e) => safeNum(e.trades, 0))) : 0;

  const validation_score = computeValidationScore(
    {
      validationExpectancy,
      validationTrades,
      validationWinRate,
      trainExpectancy,
      trainTrades,
    },
    { timeframe, ...opts }
  );

  const passThreshold = Math.max(
    0.3,
    Math.min(0.6, safeNum(process.env.WALKFORWARD_PASS_THRESHOLD, 0.45))
  );
  const validationPassed = validation_score >= passThreshold;

  return {
    validationAvailable: true,
    validationExpectancy,
    validationTrades,
    validationWinRate,
    validationPassed,
    validation_score,
    trainExpectancy,
    trainTrades,
  };
}

/**
 * Index setupId -> rules from generated_strategies (setup_*.js, setup_mut_*.json).
 * Fills gaps when batch rows omit rules.
 */
function loadRulesBySetupIdFromGeneratedStrategies(strategiesDir) {
  const map = new Map();
  if (!strategiesDir || !fs.existsSync(strategiesDir)) return map;
  const names = fs.readdirSync(strategiesDir);
  for (const f of names) {
    const full = path.join(strategiesDir, f);
    try {
      if (f.endsWith('.js') && f.startsWith('setup_')) {
        const mod = require(full);
        if (!mod || (!mod.name && !mod.rules)) continue;
        const name = mod.name || f.replace('.js', '');
        const rules = mod.rules && typeof mod.rules === 'object' ? mod.rules : {};
        if (!Object.keys(rules).length) continue;
        const id = computeCanonicalSetupId({ name, rules });
        map.set(id, rules);
      } else if (f.endsWith('.json') && f.startsWith('setup_mut_')) {
        const j = safeReadJson(full);
        if (!j || !j.rules || typeof j.rules !== 'object' || !Object.keys(j.rules).length) continue;
        const id = j.setupId || computeCanonicalSetupId({ name: j.setupId || f, rules: j.rules });
        map.set(String(id), j.rules);
      }
    } catch (_) { /* skip */ }
  }
  return map;
}

function buildStrategiesForMeta(bySetup, opts = {}) {
  const strategiesDir = opts.generatedStrategiesDir || dataRoot.getPath('generated_strategies');
  const rulesFromDisk = loadRulesBySetupIdFromGeneratedStrategies(strategiesDir);

  const strategies = [];

  for (const [setupId, entries] of bySetup.entries()) {
    const perAsset = [];
    const perTimeframe = [];

    for (const e of entries) {
      if (e.asset) {
        perAsset.push({
          asset: e.asset,
          expectancy: e.expectancy,
          trades: e.trades,
          winRate: e.winRate,
        });
      }

      if (e.timeframe) {
        perTimeframe.push({
          timeframe: e.timeframe,
          expectancy: e.expectancy,
          trades: e.trades,
          winRate: e.winRate,
        });
      }
    }

    const cross = evaluateCrossAssetScore(perAsset);
    const tf = evaluateTimeframeRobustness(perTimeframe);

    const expectancy = average(entries.map((e) => e.expectancy));
    const trades = sum(entries.map((e) => e.trades));
    const winRate = average(entries.map((e) => e.winRate));
    const drawdown = average(entries.map((e) => e.drawdown));

    const entryWithRules = entries.find(
      (e) =>
        e.raw &&
        e.raw.rules &&
        typeof e.raw.rules === 'object' &&
        Object.keys(e.raw.rules).length > 0
    );
    const firstRawWithRules = entryWithRules?.raw || null;

    const firstRawWithSource =
      entries.find((e) => e.raw && e.raw.source)?.raw || null;

    const firstRawWithParentSetup =
      entries.find((e) => e.raw && e.raw.parentSetupId)?.raw || null;

    const firstRawWithParentFamily =
      entries.find((e) => e.raw && e.raw.parentFamilyId)?.raw || null;

    const firstRawWithMutationType =
      entries.find((e) => e.raw && e.raw.mutationType)?.raw || null;

    const latestGeneratedAt = entries
      .map((e) => e.raw && e.raw.generatedAt)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || null;

    const maxGeneration = Math.max(
      ...entries.map((e) => safeNum(e.raw && e.raw.generation, 0))
    );

    let rulesObj = firstRawWithRules?.rules || null;
    if (!rulesObj || typeof rulesObj !== 'object' || !Object.keys(rulesObj).length) {
      rulesObj = rulesFromDisk.get(String(setupId)) || null;
    }
    const hasRules = !!(rulesObj && typeof rulesObj === 'object' && Object.keys(rulesObj).length > 0);

    const validation = computeValidationMetrics(entries, opts);

    const strategy = {
      setupId,
      name: firstRawWithRules?.name || firstRawWithSource?.name || setupId,
      rules: hasRules && rulesObj ? rulesObj : null,
      hasRules,
      familyKey:
        hasRules && rulesObj
          ? rulesToFamilySignature(rulesObj)
          : setupId,

      validationAvailable: validation.validationAvailable,
      validationExpectancy: validation.validationExpectancy,
      validationTrades: validation.validationTrades,
      validationWinRate: validation.validationWinRate,
      validationPassed: validation.validationPassed,
      validation_score: validation.validation_score,
      trainExpectancy: validation.trainExpectancy,
      trainTrades: validation.trainTrades,
      validation_gate_factor: computeValidationGateFactor(
        {
          validationAvailable: validation.validationAvailable,
          validationPassed: validation.validationPassed,
          validation_score: validation.validation_score,
        },
        opts
      ),

      // ---- lineage / evolution metadata from raw ----
      parentSetupId: firstRawWithParentSetup?.parentSetupId || null,
      parentFamilyId: firstRawWithParentFamily?.parentFamilyId || null,
      mutationType: firstRawWithMutationType?.mutationType || null,
      generation: maxGeneration,

      promotedLeader: !!firstRawWithSource?.promotedLeader,
      promotedAt: firstRawWithSource?.promotedAt || null,

      backtestValid: true,

      expectancy,
      trades,
      winRate,
      drawdown,

      cross_asset_score: cross.cross_asset_score,
      timeframe_stability_score: tf.timeframe_stability_score,
      stability: average([
        cross.cross_asset_score,
        tf.timeframe_stability_score,
      ]),

      byAsset: cross.byAsset,
      byTimeframe: tf.byTimeframe,

      variants: entries.map((e) => ({
        symbol: e.symbol,
        timeframe: e.timeframe,
        asset: e.asset,
        expectancy: e.expectancy,
        trades: e.trades,
        winRate: e.winRate,
        drawdown: e.drawdown,
        file: e.file,
      })),

      source: firstRawWithSource?.source || 'grid',

      promotion_bonus: 0,
      promotion_penalty_factor: 1,
      effective_promotion_bonus: 0,
      promotion_decay_factor: 1,
      decayed_promotion_bonus: 0,
      distinctBatchFiles: 0,
      promotion_breadth_score: 0,
      firstPromotedAt: null,
      promotionReason: null,
      lineage_depth: 0,
      lineage_depth_penalty_factor: 1,
      family_diversity_key: null,
      family_diversity_rank: 1,
      family_diversity_penalty_factor: 1,
      top_diversity_parent_family_count: 0,
      top_diversity_family_key_count: 0,

      validation_state: {
        backtestValid: true,
        oosPassed: null,
        walkForwardPassed: null,
        lastValidationAt: latestGeneratedAt,
      },

      deployment_status: 'discovered',
      research_status: 'active',

      historical_metrics: {
        expectancy,
        trades,
        winRate,
        drawdown,
        cross_asset_score: cross.cross_asset_score,
        timeframe_stability_score: tf.timeframe_stability_score,
        lastSeenAt: latestGeneratedAt,
      },
    };

    strategies.push(strategy);
  }

  if (String(process.env.VALIDATION_DEBUG || '') === '1' && strategies.length > 0) {
    const passed = strategies.filter((s) => s.validationPassed === true).length;
    const withScore = strategies.filter((s) => Number.isFinite(s.validation_score)).length;
    const avgScore =
      withScore > 0
        ? strategies.reduce((a, s) => a + safeNum(s.validation_score, 0), 0) / withScore
        : 0;
    console.log('VALIDATION_DEBUG summary:', {
      total: strategies.length,
      validationPassed: passed,
      withValidationScore: withScore,
      avgValidationScore: round6(avgScore),
    });
    strategies.slice(0, 15).forEach((s) => {
      console.log('VALIDATION_DEBUG', {
        setupId: s.setupId,
        validation_score: s.validation_score,
        validationTrades: s.validationTrades,
        validationExpectancy: s.validationExpectancy,
        gate_factor: s.validation_gate_factor,
        decision: s.validationPassed ? 'pass' : 'fail',
      });
    });
  }

  return strategies;
}

function writeMetaRanking(metaRanking, outPath, extra = {}) {
  const strategies = (Array.isArray(metaRanking) ? metaRanking : []).map((s) => ({
    ...s,
    rules:
      s.rules && typeof s.rules === 'object' && Object.keys(s.rules).length > 0 ? s.rules : null,
    hasRules: !!(s.rules && typeof s.rules === 'object' && Object.keys(s.rules).length > 0),
    lineage_depth: safeNum(s.lineage_depth, computeLineageDepth(s.setupId)),
    lineage_depth_penalty_factor: safeNum(
      s.lineage_depth_penalty_factor,
      computeLineageDepthPenaltyFactor(computeLineageDepth(s.setupId))
    ),
    family_diversity_key: s.family_diversity_key || buildFamilyDiversityKey(s),
    family_diversity_rank: safeNum(s.family_diversity_rank, 1),
    family_diversity_penalty_factor: safeNum(s.family_diversity_penalty_factor, 1),
    top_diversity_parent_family_count: safeNum(s.top_diversity_parent_family_count, 0),
    top_diversity_family_key_count: safeNum(s.top_diversity_family_key_count, 0),
    validationAvailable:
      typeof s.validationAvailable === 'boolean' ? s.validationAvailable : false,
    validationExpectancy: Number.isFinite(s.validationExpectancy) ? s.validationExpectancy : null,
    validationTrades: safeNum(s.validationTrades, 0),
    validationWinRate: Number.isFinite(s.validationWinRate) ? s.validationWinRate : null,
    validationPassed: !!s.validationPassed,
    validation_score: safeNum(s.validation_score, 0),
    validation_gate_factor: safeNum(s.validation_gate_factor, 1),
  }));

  const payload = {
    generatedAt: new Date().toISOString(),
    count: strategies.length,
    ...extra,
    strategies,
  };

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  return outPath;
}

function buildMetaRankingSymbolAudit(reranked, top, sourceSummaries, topN) {
  const countBySymbol = (arr) => {
    const m = new Map();
    for (const s of Array.isArray(arr) ? arr : []) {
      const seen = new Set();
      const variants = Array.isArray(s && s.variants) ? s.variants : [];
      for (const v of variants) {
        const sym = String(v && v.symbol ? v.symbol : '')
          .trim()
          .toUpperCase();
        if (!sym) continue;
        seen.add(sym);
      }
      if (seen.size === 0) {
        const byAsset = Array.isArray(s && s.byAsset) ? s.byAsset : [];
        for (const a of byAsset) {
          const raw = String(a && a.asset ? a.asset : '').trim().toUpperCase();
          const sym = raw.includes('_') ? raw.split('_')[0] : raw;
          if (sym) seen.add(sym);
        }
      }
      for (const sym of seen) {
        m.set(sym, (m.get(sym) || 0) + 1);
      }
    }
    const out = {};
    for (const [k, v] of Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      out[k] = v;
    }
    return out;
  };

  const before = countBySymbol(reranked);
  const after = countBySymbol(top);
  const missing = Object.keys(before).filter((sym) => !Object.prototype.hasOwnProperty.call(after, sym));

  return {
    generatedAt: new Date().toISOString(),
    totalBatchFilesSeen: Array.isArray(sourceSummaries) ? sourceSummaries.length : 0,
    totalStrategiesReranked: Array.isArray(reranked) ? reranked.length : 0,
    totalStrategiesAfterCap: Array.isArray(top) ? top.length : 0,
    topN,
    countsBySymbolBeforeCap: before,
    countsBySymbolAfterCap: after,
    symbolsMissingFromTop: missing,
  };
}

function inferPrimarySymbol(strategy) {
  const variants = Array.isArray(strategy && strategy.variants) ? strategy.variants : [];
  for (const v of variants) {
    const sym = String(v && v.symbol ? v.symbol : '')
      .trim()
      .toUpperCase();
    if (sym) return sym;
  }
  const byAsset = Array.isArray(strategy && strategy.byAsset) ? strategy.byAsset : [];
  for (const a of byAsset) {
    const asset = String(a && a.asset ? a.asset : '')
      .trim()
      .toUpperCase();
    if (!asset) continue;
    return asset.includes('_') ? asset.split('_')[0] : asset;
  }
  return '';
}

function applyWave1Representation(reranked, opts = {}) {
  const src = Array.isArray(reranked) ? reranked : [];
  const symbols = opts.wave1Symbols instanceof Set ? opts.wave1Symbols : new Set();
  const minPerSymbol = Math.max(0, safeNum(opts.minPerSymbol, 0));
  const minAvgMetaScore = safeNum(opts.minAvgMetaScore, -Infinity);
  if (symbols.size === 0 || minPerSymbol <= 0) return src.slice();

  const picked = [];
  const pickedId = new Set();
  const perSymbol = new Map();
  for (const s of src) {
    const setupId = String(s && s.setupId ? s.setupId : '');
    if (!setupId || pickedId.has(setupId)) continue;
    const sym = inferPrimarySymbol(s);
    if (!symbols.has(sym)) continue;
    const score = Number(s && s.avgMetaScore);
    if (!Number.isFinite(score) || score < minAvgMetaScore) continue;
    const n = perSymbol.get(sym) || 0;
    if (n >= minPerSymbol) continue;
    picked.push(s);
    pickedId.add(setupId);
    perSymbol.set(sym, n + 1);
  }

  if (!picked.length) return src.slice();
  return [...picked, ...src.filter((s) => !pickedId.has(String(s && s.setupId ? s.setupId : '')))];
}

function avgNum(values) {
  const arr = (values || []).filter((v) => Number.isFinite(Number(v))).map(Number);
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function isChildSetupId(setupId) {
  return String(setupId || '').startsWith('familyexp_');
}

function buildCorrelationSummary(selectedForPortfolio, diversifiedSelection) {
  const selected = Array.isArray(selectedForPortfolio) ? selectedForPortfolio : [];
  const corr =
    diversifiedSelection && diversifiedSelection.correlationSummary
      ? diversifiedSelection.correlationSummary
      : null;

  return {
    selection_mode: corr?.selection_mode || 'score_minus_correlation_penalty',
    selected_count: selected.length,
    avg_pairwise_similarity: round6(corr?.avg_pairwise_similarity ?? 0),
    max_pairwise_similarity: round6(corr?.max_pairwise_similarity ?? 0),
    pairwise_count: safeNum(corr?.pairwise_count, 0),
    avg_return_correlation: corr?.avg_return_correlation ?? null,
    max_return_correlation: corr?.max_return_correlation ?? null,
    return_series_count: safeNum(corr?.return_series_count, 0),
  };
}

/**
 * Cash deployment policy: conservative | core_reinforcement | innovation_accelerator.
 * Computes cash_policy (mode, deployable_cash, reserve_cash) and optionally redistributes.
 */
function applyCashDeploymentPolicy(portfolio, selectedForPortfolio, opts = {}) {
  const cashWeight = safeNum(portfolio.cash_weight, 0);
  const mode =
    opts.cashDeploymentPolicy ||
    (process.env.PORTFOLIO_CASH_DEPLOYMENT_POLICY || 'conservative').toLowerCase();
  const deployableRatio = Math.max(0, Math.min(1, safeNum(opts.cashDeployableRatio, 0.5)));

  if (cashWeight <= 1e-9) {
    portfolio.cash_policy = {
      mode: 'none',
      cash_weight: 0,
      deployable_cash: 0,
      reserve_cash: 0,
    };
    return portfolio;
  }

  const selected = Array.isArray(selectedForPortfolio) ? selectedForPortfolio : [];
  const bySetupId = new Map(selected.map((s) => [String(s.setupId), s]));
  const core = selected.filter((s) => !isChildStrategy(s));
  const challengers = selected.filter((s) => isChildStrategy(s));

  const bestCoreScore = core.length
    ? Math.max(...core.map((s) => safeNum(s.portfolio_score, 0)))
    : 0;
  const bestChallengerScore = challengers.length
    ? Math.max(...challengers.map((s) => safeNum(s.portfolio_score, 0)))
    : 0;

  const qualifyingChallenger = challengers.find((c) => {
    const beats = safeNum(c.beatsParentRate, 0);
    const score = safeNum(c.portfolio_score, 0);
    const parent = c.parentSetupId ? bySetupId.get(String(c.parentSetupId)) : null;
    const parentScore = parent ? safeNum(parent.portfolio_score, 0) : 0;
    return beats > 0.65 && parentScore > 0 && score > parentScore * 1.2;
  });

  // Conservative: keep all cash as protection (best_challenger < best_core × 1.05 → cash stays).
  // Core reinforcement: deploy share to core. Innovation accelerator: deploy share to qualifying challenger.
  let deployableCash = 0;
  let reserveCash = cashWeight;
  if (mode === 'core_reinforcement') {
    deployableCash = round6(cashWeight * deployableRatio);
    reserveCash = round6(cashWeight - deployableCash);
  } else if (mode === 'innovation_accelerator' && qualifyingChallenger) {
    deployableCash = round6(cashWeight * deployableRatio);
    reserveCash = round6(cashWeight - deployableCash);
  }

  portfolio.cash_policy = {
    mode,
    cash_weight: round6(cashWeight),
    deployable_cash: round6(deployableCash),
    reserve_cash: round6(reserveCash),
  };

  const strategies = portfolio.strategies || [];
  if (deployableCash <= 1e-9) return portfolio;

  if (mode === 'core_reinforcement' && core.length) {
    const coreIds = new Set(core.map((s) => String(s.setupId)));
    const coreStrategies = strategies.filter((s) => coreIds.has(String(s.setupId)));
    const coreWeightSum = coreStrategies.reduce((sum, s) => sum + safeNum(s.allocation_weight, 0), 0);
    for (const row of strategies) {
      if (!coreIds.has(String(row.setupId))) continue;
      const w = safeNum(row.allocation_weight, 0);
      const add = coreWeightSum > 0 ? (deployableCash * w) / coreWeightSum : deployableCash / coreStrategies.length;
      row.allocation_weight = round6(w + add);
    }
    portfolio.cash_weight = reserveCash;
  } else if (mode === 'innovation_accelerator' && qualifyingChallenger) {
    const id = String(qualifyingChallenger.setupId);
    const row = strategies.find((s) => String(s.setupId) === id);
    if (row) {
      row.allocation_weight = round6(safeNum(row.allocation_weight, 0) + deployableCash);
      portfolio.cash_weight = reserveCash;
    }
  }

  return portfolio;
}

function buildPortfolioCompositionSummary(selectedForPortfolio, weightedPortfolio) {
  const selected = Array.isArray(selectedForPortfolio) ? selectedForPortfolio : [];
  const weighted = Array.isArray(weightedPortfolio?.strategies) ? weightedPortfolio.strategies : [];

  const weightedById = new Map(weighted.map((s) => [s.setupId, s]));

  const core = [];
  const challengers = [];

  for (const s of selected) {
    const row = {
      setupId: s.setupId,
      portfolio_score: Number.isFinite(Number(s.portfolio_score)) ? Number(s.portfolio_score) : null,
      meta_score: Number.isFinite(Number(s.meta_score)) ? Number(s.meta_score) : null,
      expected_return: Number.isFinite(Number(s.expectancy)) ? Number(s.expectancy) : null,
      allocation_weight: weightedById.has(s.setupId)
        ? Number(weightedById.get(s.setupId).allocation_weight || 0)
        : 0,
      trades: Number.isFinite(Number(s.trades)) ? Number(s.trades) : 0,
    };

    const isChild =
      !!s.parentSetupId ||
      !!s.parentFamilyId ||
      !!s.isChild ||
      isChildSetupId(s.setupId);

    if (isChild) challengers.push(row);
    else core.push(row);
  }

  return {
    core_count: core.length,
    challenger_count: challengers.length,
    selected_core_ids: core.map((x) => x.setupId),
    selected_challenger_ids: challengers.map((x) => x.setupId),
    avg_core_portfolio_score: round6(avgNum(core.map((x) => x.portfolio_score))),
    avg_challenger_portfolio_score: round6(avgNum(challengers.map((x) => x.portfolio_score))),
    avg_core_expected_return: round6(avgNum(core.map((x) => x.expected_return))),
    avg_challenger_expected_return: round6(avgNum(challengers.map((x) => x.expected_return))),
    core_allocation_weight: round6(core.reduce((sum, x) => sum + (x.allocation_weight || 0), 0)),
    challenger_allocation_weight: round6(challengers.reduce((sum, x) => sum + (x.allocation_weight || 0), 0)),
  };
}

async function runMetaPipeline(opts = {}) {
  neuropilotMetaHeartbeat('meta_node_start', { force: true });
  try {
  const metaPerfRunStartMs = nowMs();
  /** @type {Array<{phase:string,durationMs:number,count:number|null,avgMsPerItem:number|null,itemsPerSec:number|null,extra:object}>} */
  const metaPerfRows = [];
  function recordMetaPerf(phase, durationMs, count = null, extra = {}) {
    const d = Number(durationMs);
    const c = Number(count);
    const hasCount = Number.isFinite(c) && c >= 0;
    const avgMsPerItem = hasCount && c > 0 ? round6(d / c) : null;
    const itemsPerSec = hasCount && d > 0 ? round6((c * 1000) / d) : null;
    const row = {
      phase: String(phase),
      durationMs: Number.isFinite(d) ? Math.max(0, Math.round(d)) : 0,
      count: hasCount ? c : null,
      avgMsPerItem,
      itemsPerSec,
      extra: extra && typeof extra === 'object' ? extra : {},
    };
    metaPerfRows.push(row);
    appendMetaPerfJsonlBestEffort({
      ts: new Date().toISOString(),
      run: CURRENT_META_RUN_ID || null,
      component: 'meta_perf',
      ...row,
    });
  }

  const batchDir = opts.batchDir || dataRoot.getPath('batch_results');
  const discoveryDir = opts.discoveryDir || dataRoot.getPath('discovery');
  const envTopN = Number(process.env.NEUROPILOT_META_TOP_N);
  const topN = Number.isFinite(opts.topN) ? opts.topN : Number.isFinite(envTopN) && envTopN > 0 ? envTopN : 20;
  const portfolioMax = Number.isFinite(opts.portfolioMax) ? opts.portfolioMax : 12;
  const maxPerFamily = Number.isFinite(opts.maxPerFamily) ? opts.maxPerFamily : 1;
  const experimentId = opts.experimentId || process.env.EXPERIMENT_ID || null;
  const baseWorkerDecision = decideMetaWorkers(opts.metaWorkers, opts);
  let workerDecision = { ...baseWorkerDecision };
  try {
    const tunerDecision = resolvePhase4Workers(baseWorkerDecision.metaWorkersUsed, experimentId);
    const tunedWorkers = Number(tunerDecision.selectedWorkers);
    if (Number.isFinite(tunedWorkers) && tunedWorkers > 0) {
      workerDecision.metaWorkersUsed = Math.max(1, Math.floor(tunedWorkers));
      workerDecision.metaWorkersMode = `${baseWorkerDecision.metaWorkersMode}|phase4_tuner`;
    }
    // eslint-disable-next-line no-console -- explicit tuning trace for ops auditability
    console.log(
      JSON.stringify({
        tag: 'PHASE_TUNER_DECISION',
        phase: PHASE4_TUNER_PHASE_KEY,
        runId: experimentId || null,
        decision: tunerDecision.decision,
        reason: tunerDecision.reason,
        currentWorkers: tunerDecision.currentWorkers,
        candidateWorkers: tunerDecision.candidateWorkers,
        selectedWorkers: workerDecision.metaWorkersUsed,
      })
    );
  } catch (e) {
    // eslint-disable-next-line no-console -- fail-soft: never block meta on tuner failures
    console.warn(
      JSON.stringify({
        tag: 'PHASE_TUNER_WARNING',
        phase: PHASE4_TUNER_PHASE_KEY,
        reason: 'TUNER_FAIL_SOFT',
        message: e && e.message ? String(e.message) : String(e),
      })
    );
  }
  CURRENT_META_RUN_ID = experimentId || null;
  CURRENT_META_WORKERS_MODE = workerDecision.metaWorkersMode;
  CURRENT_META_WORKERS_USED = workerDecision.metaWorkersUsed;
  const maxRerank = Math.max(0, Number(process.env.NEUROPILOT_META_MAX_RERANK) || 0);
  const correlationPrefilterPolicy = loadCorrelationPrefilterPolicySync();
  const preCorrResolved = resolvePreCorrelationFilterOpts(correlationPrefilterPolicy);
  const preCorrMinTrades = preCorrResolved.minTrades;
  const preCorrMaxPerFamily = preCorrResolved.maxPerFamily;
  const preCorrMaxPerSymbolTimeframe = preCorrResolved.maxPerSymbolTimeframe;
  const preCorrMaxTotal = preCorrResolved.maxTotal;
  if (
    correlationPrefilterPolicy.enabled === true ||
    preCorrResolved.policyMeta.envOverride.minTrades ||
    preCorrResolved.policyMeta.envOverride.maxPerFamily ||
    preCorrResolved.policyMeta.envOverride.maxPerSymbolTimeframe ||
    preCorrResolved.policyMeta.envOverride.maxTotal
  ) {
    // eslint-disable-next-line no-console -- bounded projection; no secrets
    console.log('[CORR_PREFILTER_RESOLVED]', {
      policyPath: preCorrResolved.policyMeta.policyPath,
      policySource: preCorrResolved.policyMeta.policySource,
      policyEnabled: preCorrResolved.policyMeta.policyEnabled,
      effective: preCorrResolved.policyMeta.effective,
      envOverride: preCorrResolved.policyMeta.envOverride,
    });
  }
  const wave1Symbols = parseUpperCsvSet(process.env.NEUROPILOT_WAVE1_SYMBOLS);
  const wave1MinRepresentation = Math.max(
    0,
    Number.isFinite(Number(process.env.NEUROPILOT_WAVE1_MIN_REPRESENTATION))
      ? Number(process.env.NEUROPILOT_WAVE1_MIN_REPRESENTATION)
      : 0
  );
  const wave1MinAvgMetaScore = Number.isFinite(Number(process.env.NEUROPILOT_WAVE1_MIN_AVG_META_SCORE))
    ? Number(process.env.NEUROPILOT_WAVE1_MIN_AVG_META_SCORE)
    : 0.47;

  neuropilotMetaHeartbeat('meta_node_load_inputs', {
    extra: { step: 'inputs_begin' },
  });

  const batchFiles = listBatchFiles(batchDir);
  metaStage('1_batch_files_discovered', { batchFiles: batchFiles.length });

  if (!batchFiles.length) {
    throw new Error(`No batch result files found in ${batchDir}`);
  }

  // eslint-disable-next-line no-console -- ops visibility (counts only)
  console.log('META_START', {
    experimentId,
    batchDir,
    batchFiles: batchFiles.length,
    metaWorkersMode: workerDecision.metaWorkersMode,
    metaWorkersUsed: workerDecision.metaWorkersUsed,
  });

  let bySetup;
  let sourceSummaries;
  const timeoutMsRaw = Number(process.env.NEUROPILOT_META_GROUP_WORKER_TIMEOUT_MS || 0);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.floor(timeoutMsRaw) : 0;
  const tGroup = nowMs();
  neuropilotMetaHeartbeat('meta_node_processing', {
    force: true,
    extra: { phase: 'grouping_begin', total: batchFiles.length },
  });
  metaStage('2_grouping_start', {
    workersUsed: workerDecision.metaWorkersUsed,
    timeoutMs,
  });
  try {
    ({ bySetup, sourceSummaries } = await groupResultsBySetupParallel(
      batchFiles,
      workerDecision.metaWorkersUsed
    ));
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    const isWorkerHang = msg.includes('meta worker timeout');
    appendTimingJsonlBestEffort({
      ts: new Date().toISOString(),
      run: CURRENT_META_RUN_ID || null,
      component: 'meta',
      stage: '2_grouping',
      event: isWorkerHang ? 'timeout_fallback' : 'fallback',
      metaWorkersMode: CURRENT_META_WORKERS_MODE,
      metaWorkersUsed: CURRENT_META_WORKERS_USED,
      message: msg,
    });
    // eslint-disable-next-line no-console -- ops visibility; fallback is intentional and safe
    console.warn('[META_NON_FATAL_FALLBACK]', {
      reason: isWorkerHang ? 'meta_group_worker_timeout' : 'meta_group_parallel_failed',
      message: msg,
      fallback: 'groupResultsBySetup_single_thread',
    });
    ({ bySetup, sourceSummaries } = groupResultsBySetup(batchFiles));
  }
  metaStage('2_grouping_done', {
    durationMs: nowMs() - tGroup,
    setupCount: bySetup ? bySetup.size : null,
    sourceSummaries: Array.isArray(sourceSummaries) ? sourceSummaries.length : null,
  });
  recordMetaPerf('grouping', nowMs() - tGroup, batchFiles.length, {
    setupCount: bySetup ? bySetup.size : 0,
    sourceSummaries: Array.isArray(sourceSummaries) ? sourceSummaries.length : 0,
  });

  if (!bySetup.size) {
    throw new Error('Batch result files found, but no valid setup results were extracted.');
  }

  neuropilotMetaHeartbeat('meta_node_inputs_ready', {
    extra: {
      setupCount: bySetup.size,
      batchFiles: batchFiles.length,
    },
  });

  const tCorr = nowMs();
  metaStage('4_correlation_start');
  const corrWorkers = Number(workerDecision.metaWorkersUsed) || 1;
  const corrPhaseName = PHASE4_TUNER_PHASE_KEY;
  /** Fine-grained substep timings for bottleneck diagnosis (observability only). */
  const phase4SubstepRows = [];

  const subRead = startPhaseSubstep({
    cycleId: experimentId || null,
    phase: corrPhaseName,
    substep: 'phase4_read_parse_batch_json',
    workerCount: corrWorkers,
    meta: { batchFileCount: batchFiles.length },
  });
  const tReadBatchJson = nowMs();
  const batchContentsRaw = [];
  const nBatchFiles = batchFiles.length;
  for (let bi = 0; bi < nBatchFiles; bi += 1) {
    const j = safeReadJson(batchFiles[bi]);
    if (j && Array.isArray(j.results)) {
      batchContentsRaw.push(j);
    }
    if (bi === 0 || bi === nBatchFiles - 1 || bi % 100 === 0) {
      neuropilotMetaHeartbeat('meta_node_processing', {
        extra: {
          phase: 'read_batch_json',
          index: bi,
          total: nBatchFiles,
        },
      });
      const completedUnits = bi + 1;
      const elapsedSec = Math.max(0, Math.floor((nowMs() - tCorr) / 1000));
      const etaSec = estimateEtaSec(corrPhaseName, elapsedSec, completedUnits, nBatchFiles);
      const throughputPerMin = elapsedSec > 0
        ? Number(((completedUnits / elapsedSec) * 60).toFixed(3))
        : null;
      // eslint-disable-next-line no-console -- bounded progress logs for operator ETA visibility
      console.log(
        JSON.stringify({
          tag: 'PHASE_PROGRESS',
          phase: corrPhaseName,
          startedAt: new Date(tCorr).toISOString(),
          elapsedSec,
          etaSec,
          workerCount: corrWorkers,
          completedUnits,
          totalUnits: nBatchFiles,
          throughputPerMin,
        })
      );
      recordPhaseSubstepProgress(subRead, completedUnits, nBatchFiles, { index: bi });
    }
  }
  recordMetaPerf('read_batch_json', nowMs() - tReadBatchJson, nBatchFiles, {
    parsedBatchFiles: batchContentsRaw.length,
  });
  if (subRead) {
    subRead.end({
      status: 'success',
      itemsProcessed: nBatchFiles,
      meta: { parsedBatchObjects: batchContentsRaw.length },
    });
    phase4SubstepRows.push({
      substep: 'phase4_read_parse_batch_json',
      durationMs: nowMs() - tReadBatchJson,
      status: 'success',
    });
  }

  const tPre = nowMs();
  const subPre = startPhaseSubstep({
    cycleId: experimentId || null,
    phase: corrPhaseName,
    substep: 'phase4_prefilter_correlation',
    workerCount: corrWorkers,
    meta: { rawBatchObjects: batchContentsRaw.length },
  });
  let preCorr;
  try {
    preCorr = preFilterBatchContentsForCorrelation(batchContentsRaw, {
      minTrades: preCorrMinTrades,
      maxPerFamily: preCorrMaxPerFamily,
      maxPerSymbolTimeframe: preCorrMaxPerSymbolTimeframe,
      maxTotal: preCorrMaxTotal,
      policyMeta: preCorrResolved.policyMeta,
    });
  } catch (preErr) {
    if (subPre) {
      subPre.end({
        status: 'error',
        meta: { message: preErr && preErr.message ? String(preErr.message) : String(preErr) },
      });
    }
    throw preErr;
  }
  const batchContents = preCorr.batchContents;
  const preDur = nowMs() - tPre;
  if (subPre) {
    subPre.end({
      status: 'success',
      itemsProcessed: batchContents.length,
      meta: {
        preCorrFilterEnabled: !!(preCorr.stats && preCorr.stats.enabled),
        setupCountAfter: setupCountFromBatchContents(batchContents),
      },
    });
    phase4SubstepRows.push({
      substep: 'phase4_prefilter_correlation',
      durationMs: preDur,
      status: 'success',
    });
  }
  if (preCorr.stats && preCorr.stats.enabled) {
    // eslint-disable-next-line no-console -- ops visibility for correlation cost control
    console.log('[META_PRE_CORR_FILTER]', preCorr.stats);
  }
  let returnCorrMatrix = null;
  const tCompute = nowMs();
  const subCompute = startPhaseSubstep({
    cycleId: experimentId || null,
    phase: corrPhaseName,
    substep: 'phase4_correlation_compute',
    workerCount: corrWorkers,
    meta: { batchContentsForCorr: batchContents.length },
  });
  try {
    returnCorrMatrix = await computeReturnCorrelationMatrixWithTimeout(batchContents);
    const computeDur = nowMs() - tCompute;
    if (subCompute) subCompute.end({ status: 'success', itemsProcessed: batchContents.length });
    phase4SubstepRows.push({
      substep: 'phase4_correlation_compute',
      durationMs: computeDur,
      status: 'success',
    });

    const corrDurationMs = nowMs() - tCorr;
    const subEmit = startPhaseSubstep({
      cycleId: experimentId || null,
      phase: corrPhaseName,
      substep: 'phase4_correlation_emit_observers',
      workerCount: corrWorkers,
    });
    const tEmit = nowMs();
    metaStage('4_correlation_done', {
      durationMs: corrDurationMs,
      batchContents: batchContents.length,
      corrSetupCountBefore: setupCountFromBatchContents(batchContentsRaw),
      corrSetupCountAfter: setupCountFromBatchContents(batchContents),
      preCorrFilterEnabled: !!(preCorr.stats && preCorr.stats.enabled),
    });
    appendPhaseMetric({
      ts: new Date().toISOString(),
      cycleId: experimentId || null,
      phase: corrPhaseName,
      startedAt: new Date(tCorr).toISOString(),
      endedAt: new Date(tCorr + corrDurationMs).toISOString(),
      durationMs: corrDurationMs,
      workerCount: corrWorkers,
      status: 'success',
      itemsProcessed: batchContents.length,
      throughputPerMin:
        corrDurationMs > 0 ? Number((((batchContents.length * 1000) / corrDurationMs) * 60).toFixed(3)) : null,
    });
    // eslint-disable-next-line no-console -- completion marker for phase-level countdown stream
    console.log(
      JSON.stringify({
        tag: 'PHASE_DONE',
        phase: corrPhaseName,
        status: 'success',
        durationMs: corrDurationMs,
        workerCount: corrWorkers,
        itemsProcessed: batchContents.length,
      })
    );
    const emitDur = nowMs() - tEmit;
    if (subEmit) {
      subEmit.end({ status: 'success', meta: { phaseLevelDurationMs: corrDurationMs } });
      phase4SubstepRows.push({
        substep: 'phase4_correlation_emit_observers',
        durationMs: emitDur,
        status: 'success',
      });
    }
    logPhaseBottleneckSummary({
      cycleId: experimentId || null,
      phase: corrPhaseName,
      substeps: phase4SubstepRows,
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    const computeDur = nowMs() - tCompute;
    if (subCompute) subCompute.end({ status: 'degraded', meta: { error: msg } });
    phase4SubstepRows.push({
      substep: 'phase4_correlation_compute',
      durationMs: computeDur,
      status: 'degraded',
    });

    const timeoutMs = Number(process.env.NEUROPILOT_META_CORRELATION_TIMEOUT_MS || 0) || null;
    const isTimeout = msg.includes('timeout');
    appendTimingJsonlBestEffort({
      ts: new Date().toISOString(),
      run: CURRENT_META_RUN_ID || null,
      component: 'meta',
      stage: '4_correlation',
      event: isTimeout ? 'timeout_fallback' : 'fallback',
      metaWorkersMode: CURRENT_META_WORKERS_MODE,
      metaWorkersUsed: CURRENT_META_WORKERS_USED,
      timeoutMs,
      message: msg,
    });
    // eslint-disable-next-line no-console -- keep run alive; correlation is advisory for diversification
    console.warn('[META_NON_FATAL_FALLBACK]', {
      reason: 'return_correlation_failed',
      message: msg,
      fallback: 'disable_return_correlation_penalty_for_this_run',
    });
    const corrDurationMs = nowMs() - tCorr;
    const subEmitFail = startPhaseSubstep({
      cycleId: experimentId || null,
      phase: corrPhaseName,
      substep: 'phase4_correlation_emit_observers',
      workerCount: corrWorkers,
      meta: { degraded: true },
    });
    const tEmitFail = nowMs();
    metaStage('4_correlation_done', {
      durationMs: corrDurationMs,
      batchContents: batchContents.length,
      corrSetupCountBefore: setupCountFromBatchContents(batchContentsRaw),
      corrSetupCountAfter: setupCountFromBatchContents(batchContents),
      preCorrFilterEnabled: !!(preCorr.stats && preCorr.stats.enabled),
      degraded: true,
    });
    appendPhaseMetric({
      ts: new Date().toISOString(),
      cycleId: experimentId || null,
      phase: corrPhaseName,
      startedAt: new Date(tCorr).toISOString(),
      endedAt: new Date(tCorr + corrDurationMs).toISOString(),
      durationMs: corrDurationMs,
      workerCount: corrWorkers,
      status: 'degraded',
      itemsProcessed: batchContents.length,
      error: msg,
    });
    // eslint-disable-next-line no-console -- completion marker for phase-level countdown stream
    console.log(
      JSON.stringify({
        tag: 'PHASE_DONE',
        phase: corrPhaseName,
        status: 'degraded',
        durationMs: corrDurationMs,
        workerCount: corrWorkers,
        itemsProcessed: batchContents.length,
      })
    );
    const emitFailDur = nowMs() - tEmitFail;
    if (subEmitFail) {
      subEmitFail.end({ status: 'degraded', meta: { error: msg } });
      phase4SubstepRows.push({
        substep: 'phase4_correlation_emit_observers',
        durationMs: emitFailDur,
        status: 'degraded',
      });
    }
    logPhaseBottleneckSummary({
      cycleId: experimentId || null,
      phase: corrPhaseName,
      substeps: phase4SubstepRows,
    });
    returnCorrMatrix = null;
  }

  const tRank = nowMs();
  metaStage('3_ranking_start');
  const tBuildStrategies = nowMs();
  const strategies = buildStrategiesForMeta(bySetup, opts);
  recordMetaPerf('build_strategies', nowMs() - tBuildStrategies, strategies.length, {
    bySetupSize: bySetup ? bySetup.size : 0,
  });
  const tFilter = nowMs();
  const childMinTrades = runChildMinTradesFilter(strategies, {
    minTradesAbsolute: opts.minTradesForChild ?? 30,
    minTradesRatio: opts.minTradesRatioForChild ?? 0.3,
    minTradesForMutationChild: opts.minTradesForMutationChild,
    minTradesRatioForMutationChild: opts.minTradesRatioForMutationChild,
  });
  const strategiesFiltered = childMinTrades.strategies;
  recordMetaPerf(
    'filter_child_min_trades',
    nowMs() - tFilter,
    childMinTrades && childMinTrades.report && childMinTrades.report.counts
      ? childMinTrades.report.counts.strategiesIn
      : strategies.length,
    {
      strategiesOut: strategiesFiltered.length,
      childrenDropped:
        childMinTrades && childMinTrades.report && childMinTrades.report.counts
          ? childMinTrades.report.counts.childrenDropped
          : null,
    }
  );
  neuropilotMetaHeartbeat('meta_node_processing', {
    extra: {
      phase: 'strategies_filtered',
      count: strategiesFiltered.length,
    },
  });
  try {
    const auditPath = path.join(discoveryDir, 'meta_child_min_trades_filter.json');
    fs.writeFileSync(auditPath, JSON.stringify(childMinTrades.report, null, 2), 'utf8');
  } catch (e) {
    console.warn('runMetaPipeline: could not write meta_child_min_trades_filter.json', e && e.message);
  }
  // eslint-disable-next-line no-console -- operational audit (counts only, no secrets)
  console.log('META_CHILD_MIN_TRADES_FILTER', {
    relaxEnabled: childMinTrades.report.relaxEnabled,
    strategiesIn: childMinTrades.report.counts.strategiesIn,
    strategiesOut: childMinTrades.report.counts.strategiesOut,
    childrenIn: childMinTrades.report.counts.childrenIn,
    childrenDropped: childMinTrades.report.counts.childrenDropped,
    mutationEval: childMinTrades.report.counts.mutationChildrenEvaluated,
    mutationKeptRelax: childMinTrades.report.counts.mutationChildrenKeptRelax,
    mutationDroppedRelax: childMinTrades.report.counts.mutationChildrenDroppedRelax,
    mutationDroppedStrict: childMinTrades.report.counts.mutationChildrenDroppedStrict,
    droppedHistogram: childMinTrades.report.droppedTradesHistogram,
  });
  const rankedBase = computeMetaRanking(strategiesFiltered);
  const ranked = annotateParentVsChild(rankedBase);

  const promotedChildren = loadPromotedChildren();
  const promotedMap = buildPromotedMap(promotedChildren);
  const annotatedWithPromotions = enrichWithPromotedChildren(ranked, promotedMap);

  const reranked = sortRankedStrategies(annotatedWithPromotions);
  neuropilotMetaHeartbeat('meta_node_merge_done', {
    extra: { ranked: reranked.length },
  });
  const rerankedBounded =
    maxRerank > 0 && reranked.length > maxRerank ? reranked.slice(0, maxRerank) : reranked;
  const rerankedForCap = applyWave1Representation(rerankedBounded, {
    wave1Symbols,
    minPerSymbol: wave1MinRepresentation,
    minAvgMetaScore: wave1MinAvgMetaScore,
  });

  const top = capRankedStrategiesByDiversity(rerankedForCap, {
    maxCount: topN,
    maxPerParentFamily: 2,
    maxPerFamilyDiversityKey: 2,
  });
  metaStage('3_ranking_done', {
    durationMs: nowMs() - tRank,
    ranked: reranked.length,
    topCount: top.length,
  });
  recordMetaPerf('ranking', nowMs() - tRank, reranked.length, {
    topCount: top.length,
  });

  const metaAuditPath = path.join(discoveryDir, 'meta_ranking_audit.json');
  try {
    const audit = buildMetaRankingSymbolAudit(rerankedForCap, top, sourceSummaries, topN);
    audit.metaMaxRerank = maxRerank;
    audit.wave1Representation = {
      symbols: Array.from(wave1Symbols),
      minPerSymbol: wave1MinRepresentation,
      minAvgMetaScore: wave1MinAvgMetaScore,
    };
    audit.metaWorkersMode = workerDecision.metaWorkersMode;
    audit.metaWorkersRequested = workerDecision.metaWorkersRequested;
    audit.metaWorkersUsed = workerDecision.metaWorkersUsed;
    audit.cpuIdleAtStart = workerDecision.cpuIdleAtStart;
    audit.stalledBoostApplied = workerDecision.stalledBoostApplied;
    fs.writeFileSync(metaAuditPath, JSON.stringify(audit, null, 2), 'utf8');
  } catch (e) {
    console.warn('runMetaPipeline: could not write meta_ranking_audit.json', e && e.message);
  }

  // Clustering + family filter: at most maxPerFamily per family, then cap at portfolioMax
  const { filtered: portfolioCandidates } = clusterAndFilter(
    { strategies: top },
    { maxPerFamily, maxStrategies: portfolioMax }
  );

  // Load current champion registry and enrich candidates with evolution metrics for portfolio selection
  const championDir = opts.championDir || dataRoot.getPath('champion_setups', false);
  const registry = loadChampionRegistrySync(championDir);
  const registryMap = buildRegistryMap(registry);
  const tPortfolio = nowMs();
  metaStage('5_portfolio_start');
  const candidatesByPortfolioScore = enrichAndSortByPortfolioScore(portfolioCandidates, registryMap);

  const strictValidationForPortfolio =
    String(process.env.WALKFORWARD_STRICT_PORTFOLIO || '1') === '1';

  const validatedPortfolioCandidates = strictValidationForPortfolio
    ? candidatesByPortfolioScore.filter((s) => s && s.validationPassed === true)
    : candidatesByPortfolioScore.slice();

  const portfolioInputCandidates =
    validatedPortfolioCandidates.length >= Math.min(portfolioMax, 3)
      ? validatedPortfolioCandidates
      : candidatesByPortfolioScore;

  // Hard cap for portfolio: at most 1 per parent family and 1 per family_diversity_key (in portfolio-score order)
  const portfolioCandidatesCapped = capRankedStrategiesByDiversity(portfolioInputCandidates, {
    maxCount: portfolioMax,
    maxPerParentFamily: 1,
    maxPerFamilyDiversityKey: 1,
  });

  const challengerSlots = Number(
    opts.challengerSlots != null
      ? opts.challengerSlots
      : process.env.PORTFOLIO_CHALLENGER_SLOTS || 2
  );

  const hybridSelected = selectCoreAndChallengers(portfolioCandidatesCapped, {
    maxStrategies: portfolioMax,
    challengerSlots,
  });

  const diversifiedSelection = selectDiversifiedPortfolio(hybridSelected, {
    maxStrategies: portfolioMax,
    penaltyScale:
      opts.correlationPenaltyScale != null
        ? Number(opts.correlationPenaltyScale)
        : Number(process.env.PORTFOLIO_CORRELATION_PENALTY_SCALE || 0.35),
    floorIgnore:
      opts.correlationFloorIgnore != null
        ? Number(opts.correlationFloorIgnore)
        : Number(process.env.PORTFOLIO_CORRELATION_FLOOR_IGNORE || 0.15),
    maxSimilarityThreshold:
      opts.maxSimilarityThreshold != null
        ? Number(opts.maxSimilarityThreshold)
        : Number(process.env.PORTFOLIO_MAX_SIMILARITY || 0.75),
    forceDiversifiedSlot:
      opts.forceDiversifiedSlot != null
        ? !!opts.forceDiversifiedSlot
        : String(process.env.PORTFOLIO_FORCE_DIVERSIFIED_SLOT || '1') === '1',
    returnCorrMatrix,
    returnCorrelationPenaltyScale:
      opts.returnCorrelationPenaltyScale != null
        ? Number(opts.returnCorrelationPenaltyScale)
        : Number(process.env.RETURN_CORR_PENALTY_SCALE || 0.45),
    returnCorrelationFloorIgnore:
      opts.returnCorrelationFloorIgnore != null
        ? Number(opts.returnCorrelationFloorIgnore)
        : Number(process.env.RETURN_CORR_FLOOR_IGNORE || 0.2),
  });

  const selectedForPortfolio = diversifiedSelection.selected || [];

  const allowCashBuffer =
    opts.allowCashBuffer != null
      ? !!opts.allowCashBuffer
      : String(process.env.PORTFOLIO_ALLOW_CASH_BUFFER || '0') === '1';

  const portfolio = buildChampionPortfolio(selectedForPortfolio, {
    maxStrategies: portfolioMax,
    allocationBy: 'portfolio_score',
    allowCashBuffer,
  });

  const cashDeploymentPolicy =
    opts.cashDeploymentPolicy ||
    (process.env.PORTFOLIO_CASH_DEPLOYMENT_POLICY || 'conservative').toLowerCase();
  const cashDeployableRatio =
    opts.cashDeployableRatio != null
      ? Number(opts.cashDeployableRatio)
      : Number(process.env.PORTFOLIO_CASH_DEPLOYABLE_RATIO || '0.5');

  applyCashDeploymentPolicy(portfolio, selectedForPortfolio, {
    cashDeploymentPolicy,
    cashDeployableRatio,
  });

  const portfolioComposition = buildPortfolioCompositionSummary(selectedForPortfolio, portfolio);
  portfolio.portfolio_composition = portfolioComposition;

  const correlationSummary = buildCorrelationSummary(selectedForPortfolio, diversifiedSelection);
  portfolio.correlation_summary = correlationSummary;
  metaStage('5_portfolio_done', {
    durationMs: nowMs() - tPortfolio,
    selectedForPortfolio: selectedForPortfolio.length,
  });
  recordMetaPerf('portfolio', nowMs() - tPortfolio, selectedForPortfolio.length, {
    candidates: Array.isArray(portfolioCandidates) ? portfolioCandidates.length : 0,
  });

  const metaPath = path.join(discoveryDir, 'meta_ranking.json');
  const portfolioPath = path.join(discoveryDir, 'strategy_portfolio.json');
  const tWrite = nowMs();
  neuropilotMetaHeartbeat('meta_node_write_outputs', {
    extra: { step: 'before_write' },
  });
  metaStage('6_write_outputs_start');
  writePortfolio(portfolio, portfolioPath);

  writeMetaRanking(top, metaPath, {
    experimentId,
    batchFiles: sourceSummaries,
    totalStrategiesRanked: reranked.length,
    topN,
  });

  const tMutationPerf = nowMs();
  const mutationPerf = buildMutationPerfFromBatchResults({
    batchDir,
    discoveryDir,
    minTrades: Number(process.env.MUTATION_PERF_MIN_TRADES || 20),
  });
  recordMetaPerf(
    'mutation_perf_build',
    nowMs() - tMutationPerf,
    mutationPerf && Number.isFinite(Number(mutationPerf.childRowsEligible))
      ? Number(mutationPerf.childRowsEligible)
      : null,
    {
      rowsSeen:
        mutationPerf && Number.isFinite(Number(mutationPerf.rowsSeen))
          ? Number(mutationPerf.rowsSeen)
          : null,
      childRowsSeen:
        mutationPerf && Number.isFinite(Number(mutationPerf.childRowsSeen))
          ? Number(mutationPerf.childRowsSeen)
          : null,
      childRowsEligible:
        mutationPerf && Number.isFinite(Number(mutationPerf.childRowsEligible))
          ? Number(mutationPerf.childRowsEligible)
          : null,
      filesRead:
        mutationPerf && Number.isFinite(Number(mutationPerf.filesRead))
          ? Number(mutationPerf.filesRead)
          : null,
    }
  );
  metaStage('6_write_outputs_done', {
    durationMs: nowMs() - tWrite,
    metaPath,
    portfolioPath,
  });
  recordMetaPerf('write_outputs', nowMs() - tWrite, top.length, {
    metaPath,
    portfolioPath,
  });
  metaStage('7_meta_complete');

  const metaPerfTotalMs = nowMs() - metaPerfRunStartMs;
  recordMetaPerf('total_meta_pipeline', metaPerfTotalMs, null, {
    batchFiles: batchFiles.length,
  });
  const top5 = metaPerfRows
    .filter((r) => r.phase !== 'total_meta_pipeline')
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map((r) => ({
      phase: r.phase,
      durationMs: r.durationMs,
      pctTotal: metaPerfTotalMs > 0 ? round6((r.durationMs / metaPerfTotalMs) * 100) : 0,
      count: r.count,
      avgMsPerItem: r.avgMsPerItem,
      itemsPerSec: r.itemsPerSec,
    }));
  appendMetaPerfJsonlBestEffort({
    ts: new Date().toISOString(),
    run: CURRENT_META_RUN_ID || null,
    component: 'meta_perf',
    phase: 'summary_top5',
    durationMs: metaPerfTotalMs,
    count: null,
    avgMsPerItem: null,
    itemsPerSec: null,
    extra: { top5 },
  });
  // eslint-disable-next-line no-console -- operational profiling summary
  console.log('[META_PERF_TOP5]', {
    totalMs: metaPerfTotalMs,
    top5,
  });

  neuropilotMetaHeartbeat('meta_node_done', { force: true });

  return {
    batchDir,
    discoveryDir,
    batchFiles: sourceSummaries,
    totalStrategiesRanked: reranked.length,
    topN,
    metaPath,
    metaAuditPath,
    metaWorkersMode: workerDecision.metaWorkersMode,
    metaWorkersRequested: workerDecision.metaWorkersRequested,
    metaWorkersUsed: workerDecision.metaWorkersUsed,
    cpuIdleAtStart: workerDecision.cpuIdleAtStart,
    stalledBoostApplied: workerDecision.stalledBoostApplied,
    portfolioPath,
    top,
    ranked: reranked,
    rankedForCap: rerankedForCap,
    portfolioCandidates,
    portfolioCandidatesByScore: candidatesByPortfolioScore,
    selectedForPortfolio,
    portfolio,
    portfolioComposition,
    correlationSummary,
    diversifiedSelection,
  };
  } catch (err) {
    neuropilotMetaHeartbeat('meta_node_error', {
      force: true,
      extra: {
        message: err && err.message ? String(err.message).slice(0, 120) : 'unknown',
      },
    });
    throw err;
  }
}

if (!isMainThread && workerData && workerData.mode === 'groupResultsChunk') {
  const out = processBatchFilesChunk(workerData.batchFiles || []);
  if (parentPort) parentPort.postMessage(out);
}

if (!isMainThread && workerData && workerData.mode === 'groupOneFile') {
  const file = workerData.filePath;
  const json = safeReadJson(file);
  if (!json || !Array.isArray(json.results)) {
    if (parentPort) parentPort.postMessage({ sourceSummary: null, entriesBySetupId: {} });
  } else {
    const id = parseBatchIdentity(file, json);
    const entriesBySetupId = {};
    const validRows = [];
    let invalidCount = 0;
    for (const r of json.results) {
      if (!r || !r.setupId) continue;
      if (!isValidResult(r)) {
        invalidCount += 1;
        continue;
      }
      validRows.push(r);
    }
    const sourceSummary = {
      file,
      symbol: id.symbol,
      timeframe: id.timeframe,
      dataGroup: id.dataGroup,
      count: json.results.length,
      validCount: validRows.length,
      invalidCount,
    };
    for (const r of validRows) {
      const setupId = String(r.setupId);
      if (!entriesBySetupId[setupId]) entriesBySetupId[setupId] = [];
      entriesBySetupId[setupId].push({
        setupId,
        symbol: id.symbol,
        timeframe: id.timeframe,
        asset: id.symbol && id.timeframe ? `${id.symbol}_${id.timeframe}` : null,
        expectancy: Number.isFinite(r.expectancy) ? r.expectancy : 0,
        trades: Number.isFinite(r.trades) ? r.trades : 0,
        winRate: Number.isFinite(r.winRate) ? r.winRate : null,
        drawdown: Number.isFinite(r.drawdown) ? r.drawdown : 0,
        raw: r,
        file,
      });
    }
    if (parentPort) parentPort.postMessage({ sourceSummary, entriesBySetupId });
  }
}

if (!isMainThread && workerData && workerData.mode === 'returnCorrelation') {
  const out = computeReturnCorrelationMatrix(workerData.batchContents || []);
  if (parentPort) parentPort.postMessage(out);
}

async function main() {
  try {
    const topNArg = Number(process.argv[2]);
    const portfolioMaxArg = Number(process.argv[3]);

    const result = await runMetaPipeline({
      topN: Number.isFinite(topNArg) && topNArg > 0 ? topNArg : 20,
      portfolioMax: Number.isFinite(portfolioMaxArg) && portfolioMaxArg > 0 ? portfolioMaxArg : 12,
    });

    console.log('Meta Pipeline done.');
    console.log('  Batch files:', result.batchFiles.length);
    console.log('  Strategies ranked:', result.totalStrategiesRanked);
    console.log('  Top N:', result.topN);
    console.log('  Meta ranking:', result.metaPath);
    console.log('  Portfolio:', result.portfolioPath);
  } catch (err) {
    console.error('Meta Pipeline failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

if (require.main === module && isMainThread) {
  main();
}

module.exports = {
  runMetaPipeline,
  listBatchFiles,
  groupResultsBySetup,
  filterChildrenByMinTrades,
  /** @public Full filter + audit report (same as pipeline uses internally). */
  runChildMinTradesFilter,
  buildStrategiesForMeta,
  writeMetaRanking,
  /** @public For auditMetaSetupFunnel.js — same ordering as runMetaPipeline inner funnel */
  annotateParentVsChild,
  sortRankedStrategies,
  capRankedStrategiesByDiversity,
  loadPromotedChildren,
  buildPromotedMap,
  enrichWithPromotedChildren,
  decideMetaWorkers,
  groupResultsBySetupParallel,
};
