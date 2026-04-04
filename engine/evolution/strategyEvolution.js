#!/usr/bin/env node
'use strict';

/**
 * Strategy Evolution Engine
 *
 * Nouveau flux:
 * - priorité à discovery/meta_ranking.json
 * - fallback éventuel vers l'ancien loader historique si besoin
 *
 * Sortie:
 * - champion_setups/champion_registry.json
 */

const fs = require('fs');
const path = require('path');

const dataRoot = require('../dataRoot');
const { loadMarketContext } = require('../market-context/loadMarketContext');
const {
  readStagnationSignals,
  loadMetricsHistoryFromLog,
  defaultLogPath: evolutionMetricsLogPath,
} = require('./adaptive/stagnationSignals');
const { deriveAdaptiveWildcardOpts } = require('./adaptive/deriveWildcardTuning');
const { computeLearningScores } = require('./instrumentation/computeLearningScores');
const { loadNightlyHistory } = require('./loadNightlyHistory');
const {
  scoreSetupSurvival,
  isPositiveNight,
} = require('./scoreSetupSurvival');
const { createWatchdogHeartbeatEmitter } = require('../ops/watchdogHeartbeat');

/** Optional denser throttle for evolution only (ms). If unset, uses watchdogHeartbeat defaults. */
const _evHbMs = process.env.NEUROPILOT_EVOLUTION_HEARTBEAT_MIN_INTERVAL_MS;
const _evHbN =
  _evHbMs != null && String(_evHbMs).trim() !== '' ? Number(_evHbMs) : NaN;
const evolutionHeartbeat = createWatchdogHeartbeatEmitter(
  Number.isFinite(_evHbN) && _evHbN > 0 ? { minIntervalMs: _evHbN } : {}
);

function safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function avgValues(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** meta_score from a nightly row (flat or .raw). */
function metaScoreFromNight(h) {
  if (!h || typeof h !== 'object') return null;
  if (Number.isFinite(Number(h.meta_score))) return Number(h.meta_score);
  if (h.raw && Number.isFinite(Number(h.raw.meta_score)))
    return Number(h.raw.meta_score);
  return null;
}

/**
 * Momentum-weighted meta: recent nights weigh much more (weights ∝ (i+1)³, oldest i=0).
 */
function momentumWeightedAvgMeta(history) {
  const h = Array.isArray(history) ? history : [];
  const n = h.length;
  if (!n) return null;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const s = metaScoreFromNight(h[i]);
    if (!Number.isFinite(s)) continue;
    const w = Math.pow(i + 1, 3);
    num += s * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Deterministic rank within competition group (higher = better). */
function compareGroupMembers(a, b) {
  const ma = Number.isFinite(Number(a.momentumMetaScore))
    ? Number(a.momentumMetaScore)
    : Number(a.avgMetaScore) || -Infinity;
  const mb = Number.isFinite(Number(b.momentumMetaScore))
    ? Number(b.momentumMetaScore)
    : Number(b.avgMetaScore) || -Infinity;
  if (mb !== ma) return mb - ma;
  const aa = Number(a.avgMetaScore),
    ab = Number(b.avgMetaScore);
  const fa = Number.isFinite(aa) ? aa : -Infinity;
  const fb = Number.isFinite(ab) ? ab : -Infinity;
  if (fb !== fa) return fb - fa;
  const na = Number(a.nightsSurvived) || 0;
  const nb = Number(b.nightsSurvived) || 0;
  if (nb !== na) return nb - na;
  const isMut = (x) =>
    !!(x.parentSetupId && String(x.parentSetupId) !== String(x.setupId));
  if (isMut(a) && !isMut(b)) return -1;
  if (!isMut(a) && isMut(b)) return 1;
  return String(a.setupId).localeCompare(String(b.setupId));
}

function competitionGroupKey(e) {
  if (!e || !e.setupId) return null;
  const ps = e.parentSetupId;
  if (ps && String(ps) !== String(e.setupId)) return String(ps);
  return String(e.setupId);
}

function isMutationEntry(e) {
  return !!(e.parentSetupId && String(e.parentSetupId) !== String(e.setupId));
}

/** Float tolerance for avgMetaScore in wildcard tie-break only (not Number.EPSILON). */
const WILDCARD_TIEBREAK_META_EPS = 1e-9;

/**
 * Wildcard tie-break after momentum is treated as equal (caller checks |Δmomentum| ≤ eps).
 * Does NOT re-compare momentum. Lower return = candidate ranks above champion.
 * Order: avgMetaScore → nightsSurvived → nightsInHistory → mutation over base → setupId.
 */
function compareWildcardTieBreak(candidate, champion) {
  if (!candidate || !champion) return 1;
  const ca = safeNum(Number(candidate.avgMetaScore), -Infinity);
  const cb = safeNum(Number(champion.avgMetaScore), -Infinity);
  if (ca > cb + WILDCARD_TIEBREAK_META_EPS) return -1;
  if (cb > ca + WILDCARD_TIEBREAK_META_EPS) return 1;

  const nsa = safeNum(Number(candidate.nightsSurvived), 0);
  const nsb = safeNum(Number(champion.nightsSurvived), 0);
  if (nsa > nsb) return -1;
  if (nsb > nsa) return 1;

  const hia = safeNum(Number(candidate.nightsInHistory), 0);
  const hib = safeNum(Number(champion.nightsInHistory), 0);
  if (hia > hib) return -1;
  if (hib > hia) return 1;

  if (isMutationEntry(candidate) && !isMutationEntry(champion)) return -1;
  if (!isMutationEntry(candidate) && isMutationEntry(champion)) return 1;

  const sid = String(candidate.setupId).localeCompare(String(champion.setupId));
  if (sid < 0) return -1;
  if (sid > 0) return 1;
  return 1;
}

/** @param {object} opts */
function readWildcardEqualityEps(opts = {}) {
  const o = opts.equalityEps;
  if (o != null && o !== '') {
    const n = Number(o);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const raw = process.env.EVOLUTION_WILDCARD_EQUALITY_EPS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const legacy = process.env.EVOLUTION_WILDCARD_TIE_EPS;
  if (legacy != null && String(legacy).trim() !== '') {
    const n = Number(legacy);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 1e-9;
}

function cleanLineageEntry(e) {
  const o = { ...e };
  if (o.parentSetupId && String(o.parentSetupId) === String(o.setupId)) {
    o.parentSetupId = null;
  }
  if (!isMutationEntry(o)) {
    o.mutationType = null;
  }
  return o;
}

/**
 * Single canonical winner per parent-lineage group.
 * Replaces ad-hoc promoteMutationsOverParents ordering.
 */
function normalizeChampionPerGroup(entries) {
  const arr = Array.isArray(entries)
    ? entries.filter((e) => e && e.setupId)
    : [];
  const byKey = Object.create(null);
  for (const e of arr) {
    const k = competitionGroupKey(e);
    if (!k) continue;
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push(e);
  }

  const CHAMP_LINE = Number(process.env.GROUP_CHAMPION_MIN_MOMENTUM || 0.47);
  const VALID_PROMOTE = Number(
    process.env.GROUP_PROMOTE_VALIDATED_MIN_MOMENTUM || 0.48
  );

  for (const k of Object.keys(byKey)) {
    const grp = byKey[k].slice().sort(compareGroupMembers);
    const winner = grp[0];
    const wMom = Number.isFinite(Number(winner.momentumMetaScore))
      ? Number(winner.momentumMetaScore)
      : Number(winner.avgMetaScore) || 0;
    const hadChampion = grp.some((x) => x.status === 'champion');
    const wChamp = winner.status === 'champion';

    let assignChampion = wMom >= CHAMP_LINE || hadChampion || wChamp;
    if (
      !assignChampion &&
      winner.status === 'validated' &&
      wMom >= VALID_PROMOTE
    ) {
      assignChampion = true;
    }

    if (assignChampion) {
      const parentId = winner.parentSetupId;
      const winnerIsChild =
        parentId && String(parentId) !== String(winner.setupId);
      const parentInGroup =
        winnerIsChild &&
        grp.some((x) => String(x.setupId) === String(parentId));

      for (const e of grp) {
        if (String(e.setupId) === String(winner.setupId)) {
          e.status = 'champion';
          if (winnerIsChild && parentInGroup) {
            e.statusReason = 'promoted_over_parent';
          } else {
            e.statusReason = 'group_winner_normalized';
          }
        } else if (e.status === 'champion') {
          e.status = 'validated';
          e.statusReason =
            winnerIsChild && String(e.setupId) === String(parentId)
              ? 'replaced_by_mutation'
              : 'replaced_by_better_variant';
        }
      }
    } else {
      for (const e of grp) {
        if (e.status === 'champion') {
          e.status = 'validated';
          e.statusReason = 'replaced_by_better_variant';
        }
      }
    }
  }

  return arr.map((e) => cleanLineageEntry(e));
}

function applyPostNormalizeStagnation(entries) {
  return (Array.isArray(entries) ? entries : []).map((e) => {
    if (!e || e.status === 'champion') return e;
    const nightsInHistory = Number(e.nightsInHistory) || 0;
    const positiveNights = Number(e.nightsSurvived) || 0;
    const stagnationScore =
      e.momentumMetaScore != null ? e.momentumMetaScore : e.avgMetaScore;
    if (
      (nightsInHistory >= 4 || positiveNights >= 4) &&
      Number.isFinite(Number(stagnationScore)) &&
      Number(stagnationScore) < 0.48
    ) {
      return { ...e, status: 'candidate', statusReason: 'stagnation_drop' };
    }
    return { ...e };
  });
}

function applyExtinctionStructural(entries) {
  const EC_N = Math.max(1, Number(process.env.EXTINCTION_CANDIDATE_MIN_NIGHTS || 4));
  const EC_MOM = Number(process.env.EXTINCTION_CANDIDATE_MIN_MOMENTUM || 0.47);
  const EV_N = Math.max(1, Number(process.env.EXTINCTION_VALIDATED_MIN_NIGHTS || 6));
  const EV_MOM = Number(process.env.EXTINCTION_VALIDATED_MIN_MOMENTUM || 0.475);
  const ECH_MOM = Number(process.env.EXTINCTION_CHAMPION_MIN_MOMENTUM || 0.478);
  const MIN_STABILITY = Math.max(
    0,
    Number(process.env.EVOLUTION_MIN_STABILITY_NIGHTS_EXTINCTION || 5)
  );

  return (Array.isArray(entries) ? entries : []).map((e) => {
    if (!e) return e;
    let status = e.status;
    let statusReason = e.statusReason || null;
    let liveStatus = e.liveStatus || 'active';
    const nightsInHistory = Number(e.nightsInHistory) || 0;
    const positiveNights = Number(e.nightsSurvived) || 0;
    const mom =
      e.momentumMetaScore != null ? e.momentumMetaScore : e.avgMetaScore;
    const skipExtinction = nightsInHistory < MIN_STABILITY;

    if (!skipExtinction) {
      if (status === 'champion') {
        const halfOrLess =
          positiveNights <= Math.ceil(Math.max(1, nightsInHistory) * 0.5);
        if (
          Number.isFinite(Number(mom)) &&
          Number(mom) < ECH_MOM &&
          halfOrLess
        ) {
          status = 'validated';
          statusReason = 'champion_decay_extinction';
        }
      }
      if (status === 'validated') {
        if (
          nightsInHistory >= EV_N &&
          Number.isFinite(Number(mom)) &&
          Number(mom) < EV_MOM
        ) {
          status = 'candidate';
          statusReason = 'extinction_validated_decay';
        }
      }
      if (status === 'candidate') {
        if (
          nightsInHistory >= EC_N &&
          Number.isFinite(Number(mom)) &&
          Number(mom) < EC_MOM
        ) {
          liveStatus = 'extinct';
          statusReason = 'extinction_low_momentum';
        }
      }
    }

    return { ...e, status, statusReason, liveStatus };
  });
}

function validateRegistryConsistency(entries, opts = {}) {
  const errors = [];
  const warnings = [];
  const STRUCT = new Set(['candidate', 'validated', 'champion']);
  const LIVE_OK = new Set(['active', 'extinct', 'killed']);

  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    if (!e || !e.setupId) continue;
    if (e.parentSetupId && String(e.parentSetupId) === String(e.setupId)) {
      errors.push({ setupId: e.setupId, code: 'self_parent' });
    }
    if (!STRUCT.has(e.status)) {
      errors.push({ setupId: e.setupId, code: 'invalid_status', status: e.status });
    }
    const ls = e.liveStatus != null ? e.liveStatus : 'active';
    if (!LIVE_OK.has(ls)) {
      warnings.push({ setupId: e.setupId, code: 'unexpected_liveStatus', liveStatus: ls });
    }
    if (!isMutationEntry(e) && e.mutationType) {
      errors.push({ setupId: e.setupId, code: 'base_has_mutationType' });
    }
  }

  const byKey = Object.create(null);
  for (const e of list) {
    if (!e || !e.setupId) continue;
    const k = competitionGroupKey(e);
    if (!k) continue;
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push(e);
  }

  let groupsWhereChampionIsNotTop = 0;
  for (const [k, grp] of Object.entries(byKey)) {
    const champs = grp.filter((x) => x.status === 'champion');
    if (champs.length > 1) {
      errors.push({ groupKey: k, code: 'multiple_champions', n: champs.length });
    }
    if (champs.length === 1) {
      const sorted = grp.slice().sort(compareGroupMembers);
      if (String(sorted[0].setupId) !== String(champs[0].setupId)) {
        errors.push({ groupKey: k, code: 'champion_not_group_top_momentum' });
        groupsWhereChampionIsNotTop += 1;
      }
    }
  }

  const ok = errors.length === 0;
  if (opts.strict && !ok) {
    throw new Error(
      `validateRegistryConsistency: ${errors.map((x) => JSON.stringify(x)).join('; ')}`
    );
  }
  return {
    ok,
    errors,
    warnings,
    stats: { groupsWhereChampionIsNotTop, groupCount: Object.keys(byKey).length },
  };
}

function buildEvolutionMetadata(entries, consistency, wildcardStats = null) {
  const list = Array.isArray(entries) ? entries : [];
  const byKey = Object.create(null);
  for (const e of list) {
    if (!e || !e.setupId) continue;
    const k = competitionGroupKey(e);
    if (!k) continue;
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push(e);
  }

  const keys = Object.keys(byKey);
  let groupsWithCompetition = 0;
  let groupsWithoutChampion = 0;
  for (const k of keys) {
    const g = byKey[k];
    if (g.length > 1) groupsWithCompetition += 1;
    if (!g.some((x) => x.status === 'champion')) groupsWithoutChampion += 1;
  }

  const champs = list.filter((e) => e.status === 'champion');
  const validated = list.filter((e) => e.status === 'validated');
  const cm = champs
    .map((e) => Number(e.momentumMetaScore))
    .filter(Number.isFinite);
  const vm = validated
    .map((e) => Number(e.momentumMetaScore))
    .filter(Number.isFinite);
  const mutChamps = champs.filter((e) => isMutationEntry(e)).length;

  const avgChampionMomentum = cm.length
    ? Math.round((cm.reduce((a, b) => a + b, 0) / cm.length) * 1e6) / 1e6
    : null;
  const avgValidatedMomentum = vm.length
    ? Math.round((vm.reduce((a, b) => a + b, 0) / vm.length) * 1e6) / 1e6
    : null;

  const base = {
    generatedAt: new Date().toISOString(),
    groupsTotal: keys.length,
    groupsWithCompetition,
    groupsWithoutChampion,
    groupsWhereChampionIsNotTop:
      consistency?.stats?.groupsWhereChampionIsNotTop ?? 0,
    mutationsPromoted: list.filter(
      (e) => e.statusReason === 'promoted_over_parent'
    ).length,
    championsDemoted: list.filter(
      (e) =>
        e.statusReason === 'replaced_by_mutation' ||
        e.statusReason === 'replaced_by_better_variant'
    ).length,
    championsDemotedByDiversity: list.filter(
      (e) => e.statusReason === 'champion_diversity_capped'
    ).length,
    championsProtectedByDiversity: list.filter(
      (e) => e.statusReason === 'champion_diversity_protected'
    ).length,
    championsDemotedByGlobalCap: list.filter(
      (e) => e.statusReason === 'champion_global_cap'
    ).length,
    wildcardPromotions: list.filter(
      (e) =>
        e.statusReason === 'wildcard_promoted' ||
        e.statusReason === 'wildcard_promoted_over_champion' ||
        e.statusReason === 'wildcard_promoted_over_champion_tiebreak' ||
        e.statusReason === 'wildcard_promoted_tiebreak_over_champion'
    ).length,
    extinctionCount: list.filter((e) => e.liveStatus === 'extinct').length,
    avgChampionMomentum,
    avgValidatedMomentum,
    avgChampionMomentumPostWildcard: avgChampionMomentum,
    avgValidatedMomentumPostWildcard: avgValidatedMomentum,
    mutationChampionRatio:
      champs.length > 0
        ? Math.round((mutChamps / champs.length) * 1e4) / 1e4
        : null,
    consistencyOk: consistency?.ok !== false,
    consistencyErrorCount: consistency?.errors?.length ?? 0,
  };

  if (wildcardStats && typeof wildcardStats === 'object') {
    base.wildcardPromotionsOverChampion = wildcardStats.wildcardPromotionsOverChampion ?? 0;
    base.wildcardCandidatesSeen = wildcardStats.wildcardCandidatesSeen ?? 0;
    base.wildcardBlockedFamilyLimit = wildcardStats.wildcardBlockedFamilyLimit ?? 0;
    base.wildcardBlockedGroupStrongerChampion = wildcardStats.wildcardBlockedGroupStrongerChampion ?? 0;
    base.wildcardBlockedLowDelta = wildcardStats.wildcardBlockedLowDelta ?? 0;
    base.wildcardBlockedTotalLimit = wildcardStats.wildcardBlockedTotalLimit ?? 0;
    base.avgWildcardPromotedMomentum = wildcardStats.avgWildcardPromotedMomentum ?? null;
    base.wildcardPromotionsTieBreak =
      wildcardStats.wildcardPromotionsTieBreak ?? 0;
    base.wildcardBlockedTieBreakLost =
      wildcardStats.wildcardBlockedTieBreakLost ?? 0;
    base.wildcardTieBreakComparisons =
      wildcardStats.wildcardTieBreakComparisons ?? 0;
    base.wildcardTieBreakAuditRejects =
      wildcardStats.wildcardTieBreakAuditRejects ?? 0;
  }

  return base;
}

function lineageDepthFromSetup(row, bySetupId) {
  let depth = 0;
  let current = row;
  const seen = new Set();

  while (current && current.parentSetupId) {
    const parentId = String(current.parentSetupId);
    if (seen.has(parentId)) break;
    seen.add(parentId);
    depth += 1;
    const parentRows = bySetupId[parentId];
    current = Array.isArray(parentRows) && parentRows.length ? parentRows[parentRows.length - 1] : null;
  }

  return depth;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractRootFamily(setupId) {
  if (!setupId) return null;
  const parts = String(setupId).split('familyexp_');
  return parts[parts.length - 1] || String(setupId);
}

function extractStableLineageRoot(setupId) {
  const root = extractRootFamily(setupId);
  if (!root) return null;
  return String(root).replace(/_[a-z0-9]{2,12}$/i, '');
}

function getEffectiveFamilyKey(row, setupId) {
  if (!row || typeof row !== 'object') return null;
  const fk = row.familyKey != null ? String(row.familyKey) : null;
  if (!fk) return null;
  if (fk === String(setupId)) return null;
  return fk;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function avg(arr) {
  const vals = (arr || []).filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function loadCurrentMetaRankingAsHistory() {
  const discoveryDir = dataRoot.getPath('discovery');
  const metaPath = path.join(discoveryDir, 'meta_ranking.json');
  const meta = safeReadJson(metaPath);

  if (!meta || !Array.isArray(meta.strategies)) {
    return {
      nights: [],
      bySetupId: {},
      source: 'none',
      metaPath,
    };
  }

  const generatedAt = meta.generatedAt || new Date().toISOString();
  const dateKey = generatedAt.slice(0, 10).replace(/-/g, '');
  const date = generatedAt.slice(0, 10);
  const bySetupId = {};

  for (const s of meta.strategies) {
    const setupId = s && s.setupId ? String(s.setupId) : null;
    if (!setupId) continue;

    const effectiveFamilyKey = getEffectiveFamilyKey(s, setupId);

    const row = {
      ts: generatedAt,
      dateKey,
      date,
      setupId,
      expectancy: Number.isFinite(s.expectancy) ? s.expectancy : null,
      trades: Number.isFinite(s.trades) ? s.trades : 0,
      winRate: Number.isFinite(s.winRate) ? s.winRate : null,
      drawdown: Number.isFinite(s.drawdown) ? s.drawdown : 0,
      bootstrap_risk: Number.isFinite(s.bootstrap_risk) ? s.bootstrap_risk : null,
      cross_asset_score: Number.isFinite(s.cross_asset_score) ? s.cross_asset_score : null,
      timeframe_stability_score: Number.isFinite(s.timeframe_stability_score)
        ? s.timeframe_stability_score
        : null,
      meta_score: Number.isFinite(s.meta_score) ? s.meta_score : null,
      rules: s.rules && typeof s.rules === 'object' ? s.rules : null,
      raw: s,
      parentSetupId: s.parentSetupId || null,
      parentFamilyId: s.parentFamilyId || null,
      familyKey: effectiveFamilyKey,
      lineageKey: String(
        s.lineageKey ||
          s.parentFamilyId ||
          effectiveFamilyKey ||
          extractStableLineageRoot(setupId) ||
          extractRootFamily(setupId) ||
          setupId
      ),
      mutationType: s.mutationType || null,
      source: s.source || 'grid',
      generation: Number.isFinite(s.generation) ? s.generation : 0,
      parent_vs_child_score: Number.isFinite(s.parent_vs_child_score)
        ? s.parent_vs_child_score
        : null,
      beats_parent: !!s.beats_parent,
      parent_delta_expectancy: Number.isFinite(s.parent_delta_expectancy)
        ? s.parent_delta_expectancy
        : null,
      parent_delta_meta_score: Number.isFinite(s.parent_delta_meta_score)
        ? s.parent_delta_meta_score
        : null,
      parent_delta_winRate: Number.isFinite(s.parent_delta_winRate)
        ? s.parent_delta_winRate
        : null,
      parent_delta_trades_ratio: Number.isFinite(s.parent_delta_trades_ratio)
        ? s.parent_delta_trades_ratio
        : null,
    };

    bySetupId[setupId] = [row];
  }

  return {
    nights: [generatedAt],
    bySetupId,
    source: 'meta_ranking',
    metaPath,
  };
}

function sortHistoryRows(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const aTs = String((a && a.ts) || '');
    const bTs = String((b && b.ts) || '');
    if (aTs !== bTs) return aTs.localeCompare(bTs);

    const aDateKey = String((a && a.dateKey) || '');
    const bDateKey = String((b && b.dateKey) || '');
    if (aDateKey !== bDateKey) return aDateKey.localeCompare(bDateKey);

    return String((a && a.setupId) || '').localeCompare(String((b && b.setupId) || ''));
  });
}

function normalizeEvolutionInputShape(input, fallbackSource, fallbackMetaPath) {
  const src = input && typeof input === 'object' ? input : {};
  const rawBySetupId = src.bySetupId && typeof src.bySetupId === 'object' ? src.bySetupId : {};
  const bySetupId = {};
  const nightsSet = new Set(Array.isArray(src.nights) ? src.nights : []);

  for (const [setupId, rows] of Object.entries(rawBySetupId)) {
    const safeSetupId = String(setupId);
    const arr = Array.isArray(rows) ? rows : [];

    const normalized = arr
      .filter(Boolean)
      .map((row) => {
        const safeRow = { ...(row || {}) };

        const effectiveFamilyKey =
          (safeRow.familyKey != null && String(safeRow.familyKey) !== safeSetupId)
            ? String(safeRow.familyKey)
            : (safeRow.raw &&
               safeRow.raw.familyKey != null &&
               String(safeRow.raw.familyKey) !== safeSetupId)
              ? String(safeRow.raw.familyKey)
              : null;

        safeRow.setupId = safeSetupId;
        safeRow.ts = safeRow.ts || safeRow.generatedAt || '';
        safeRow.dateKey =
          safeRow.dateKey ||
          (typeof safeRow.date === 'string' ? safeRow.date.replace(/-/g, '') : '') ||
          '';
        safeRow.date =
          safeRow.date ||
          (safeRow.dateKey && safeRow.dateKey.length === 8
            ? `${safeRow.dateKey.slice(0, 4)}-${safeRow.dateKey.slice(4, 6)}-${safeRow.dateKey.slice(6, 8)}`
            : '');
        safeRow.parentSetupId = safeRow.parentSetupId || null;
        safeRow.parentFamilyId =
          safeRow.parentFamilyId ||
          (safeRow.raw && safeRow.raw.parentFamilyId) ||
          null;
        safeRow.familyKey = effectiveFamilyKey;
        safeRow.lineageKey = String(
          safeRow.lineageKey ||
            safeRow.parentFamilyId ||
            effectiveFamilyKey ||
            (safeRow.raw && safeRow.raw.parentFamilyId) ||
            extractStableLineageRoot(safeSetupId) ||
            extractRootFamily(safeSetupId) ||
            safeSetupId
        );

        if (safeRow.ts) nightsSet.add(safeRow.ts);
        return safeRow;
      });

    bySetupId[safeSetupId] = normalized;
  }

  return {
    nights: Array.from(nightsSet).sort(),
    bySetupId,
    source: fallbackSource || src.source || 'unknown',
    metaPath: fallbackMetaPath != null ? fallbackMetaPath : src.metaPath || null,
  };
}

function mergeEvolutionInputs(baseInput, currentInput) {
  const base = normalizeEvolutionInputShape(baseInput, 'nightly_history', null);
  const current = normalizeEvolutionInputShape(currentInput, 'meta_ranking', currentInput && currentInput.metaPath);

  const mergedBySetupId = {};
  const allSetupIds = new Set([
    ...Object.keys(base.bySetupId || {}),
    ...Object.keys(current.bySetupId || {}),
  ]);

  for (const setupId of allSetupIds) {
    const baseRows = Array.isArray(base.bySetupId[setupId]) ? base.bySetupId[setupId] : [];
    const currentRows = Array.isArray(current.bySetupId[setupId]) ? current.bySetupId[setupId] : [];
    const combined = [...baseRows, ...currentRows];

    const dedup = new Map();

    for (const row of combined) {
      if (!row || typeof row !== 'object') continue;

      const ts = String(row.ts || '');
      const dateKey = String(row.dateKey || '');
      const key = `${setupId}::${dateKey}::${ts}`;

      // Keep the newest/richest version if duplicate keys appear
      dedup.set(key, row);
    }

    mergedBySetupId[setupId] = sortHistoryRows(Array.from(dedup.values()));
  }

  const nightsSet = new Set();

  for (const n of base.nights || []) nightsSet.add(String(n));
  for (const n of current.nights || []) nightsSet.add(String(n));

  for (const history of Object.values(mergedBySetupId)) {
    for (const row of history || []) {
      if (row && row.dateKey) nightsSet.add(String(row.dateKey));
    }
  }

  return {
    nights: Array.from(nightsSet).sort(),
    bySetupId: mergedBySetupId,
    source: 'merged_meta_and_nightly_history',
    metaPath: current.metaPath || base.metaPath || null,
  };
}

/**
 * Merge existing nightly history with current meta_ranking snapshot.
 * This allows evolution/champion grading to use prior nights instead of
 * collapsing to a single-night history whenever meta_ranking.json exists.
 */
async function loadPreferredEvolutionInput() {
  const fromMeta = normalizeEvolutionInputShape(
    loadCurrentMetaRankingAsHistory(),
    'meta_ranking',
    dataRoot.getPath('discovery')
  );

  const fromNightly = normalizeEvolutionInputShape(
    await loadNightlyHistory(),
    'nightly_history',
    null
  );

  const metaHasRows = Object.keys(fromMeta.bySetupId || {}).length > 0;
  const nightlyHasRows = Object.keys(fromNightly.bySetupId || {}).length > 0;

  if (metaHasRows && nightlyHasRows) {
    return mergeEvolutionInputs(fromNightly, fromMeta);
  }

  if (metaHasRows) {
    return {
      ...fromMeta,
      source: 'meta_ranking',
    };
  }

  if (nightlyHasRows) {
    return {
      ...fromNightly,
      source: 'nightly_history',
      metaPath: null,
    };
  }

  return {
    nights: [],
    bySetupId: {},
    source: 'none',
    metaPath: null,
  };
}

/**
 * One row per snapshot: use dateKey + ts so same day different snapshots are not collapsed.
 * Prevents 4 snapshots the same day from becoming 1 row (which forced maxNightsSurvived = 1).
 * @param {Array} rows - Sorted by ts, dateKey, setupId
 * @returns {Array}
 */
function rowHasNonEmptyRules(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.rules && typeof r.rules === 'object' && Object.keys(r.rules).length) return true;
  if (r.raw && r.raw.rules && typeof r.raw.rules === 'object' && Object.keys(r.raw.rules).length) {
    return true;
  }
  return false;
}

function dedupeByDateKey(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const map = new Map();
  for (const r of rows) {
    const key = (r.dateKey || '') + '::' + (r.ts || '');
    if (!map.has(key)) {
      map.set(key, r);
    } else {
      const prev = map.get(key);
      if (!rowHasNonEmptyRules(prev) && rowHasNonEmptyRules(r)) map.set(key, r);
    }
  }
  return sortHistoryRows(Array.from(map.values()));
}

function buildByLineageKey(bySetupId) {
  const byLineageKey = Object.create(null);

  for (const rows of Object.values(bySetupId || {})) {
    for (const row of rows || []) {
      if (!row || typeof row !== 'object') continue;

      const setupId = row.setupId ? String(row.setupId) : null;
      if (!setupId) continue;

      const key = String(
        row.lineageKey ||
          row.parentFamilyId ||
          row.familyKey ||
          extractStableLineageRoot(setupId) ||
          extractRootFamily(setupId) ||
          setupId
      );

      if (!byLineageKey[key]) byLineageKey[key] = [];
      byLineageKey[key].push(row);
    }
  }

  for (const key of Object.keys(byLineageKey)) {
    byLineageKey[key] = dedupeByDateKey(sortHistoryRows(byLineageKey[key]));
  }

  return byLineageKey;
}

function applyLineageHistoryToBySetupId(bySetupId, byLineageKey) {
  for (const [setupId, rows] of Object.entries(bySetupId || {})) {
    const sorted = sortHistoryRows(rows || []);
    const last = sorted.length ? sorted[sorted.length - 1] : null;

    const lineageKey = String(
      (last && last.lineageKey) ||
        (last && last.parentFamilyId) ||
        (last && last.familyKey) ||
        extractStableLineageRoot(setupId) ||
        extractRootFamily(setupId) ||
        setupId
    );

    const lineageHistory = byLineageKey[lineageKey];
    if (Array.isArray(lineageHistory) && lineageHistory.length) {
      let merged = lineageHistory.slice();
      const selfRules = pickLatestNonEmptyRules(rows || []);
      if (selfRules && !pickLatestNonEmptyRules(merged)) {
        const anchor = merged[merged.length - 1] || {};
        merged.push({
          ...anchor,
          setupId,
          dateKey: anchor.dateKey || '',
          date: anchor.date || '',
          ts: `${anchor.ts || ''}_rules_carry_${setupId}`.slice(0, 200),
          rules: selfRules,
          hasRules: true,
          source: 'lineage_rules_carry',
        });
      }
      bySetupId[setupId] = merged;
    }
  }

  return bySetupId;
}

function pickLatestNonEmptyRules(history, fallbackRow = null) {
  const rows = Array.isArray(history) ? history : [];

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row && row.rules && typeof row.rules === 'object' && Object.keys(row.rules).length) {
      return row.rules;
    }
    if (
      row &&
      row.raw &&
      row.raw.rules &&
      typeof row.raw.rules === 'object' &&
      Object.keys(row.raw.rules).length
    ) {
      return row.raw.rules;
    }
  }

  if (
    fallbackRow &&
    fallbackRow.rules &&
    typeof fallbackRow.rules === 'object' &&
    Object.keys(fallbackRow.rules).length
  ) {
    return fallbackRow.rules;
  }

  if (
    fallbackRow &&
    fallbackRow.raw &&
    fallbackRow.raw.rules &&
    typeof fallbackRow.raw.rules === 'object' &&
    Object.keys(fallbackRow.raw.rules).length
  ) {
    return fallbackRow.raw.rules;
  }

  return null;
}

function buildRegistryEntries(bySetupId) {
  const entries = [];

  for (const [setupId, history] of Object.entries(bySetupId || {})) {
    const scored = scoreSetupSurvival(setupId, history || []);
    const last = Array.isArray(history) && history.length ? history[history.length - 1] : null;

    const nightsInHistory = Array.isArray(history) ? history.length : 0;
    const avgExpectancy = avgValues(history.map((h) => h.expectancy));
    const avgBootstrapRisk = avgValues(history.map((h) => h.bootstrap_risk));
    const avgMetaScore = avgValues(history.map((h) => h.meta_score));
    const momentumWeighted = momentumWeightedAvgMeta(history || []);
    const momentumMetaScore =
      nightsInHistory >= 4 && momentumWeighted != null
        ? momentumWeighted
        : avgMetaScore;
    const avgCrossAssetScore = avgValues(history.map((h) => h.cross_asset_score));
    const avgTimeframeScore = avgValues(history.map((h) => h.timeframe_stability_score));
    const avgParentVsChildScore = avgValues(history.map((h) => h.parent_vs_child_score));
    const beatsParentRate = avgValues(history.map((h) => (h.beats_parent ? 1 : 0)));

    let adjustedSurvivalScore = safeNum(scored.survivalScore, 0);
    if (Number.isFinite(avgParentVsChildScore)) {
      adjustedSurvivalScore += Math.max(-0.2, Math.min(0.2, avgParentVsChildScore / 10));
    }
    if (Number.isFinite(beatsParentRate)) {
      adjustedSurvivalScore += beatsParentRate * 0.15;
    }
    adjustedSurvivalScore = Math.max(0, Math.min(1, adjustedSurvivalScore));

    const lineageDepth = lineageDepthFromSetup(last || {}, bySetupId);
    const positiveNights = (history || []).filter((h) => isPositiveNight(h)).length;

    const r = last || {};
    const rules = pickLatestNonEmptyRules(history, r);
    const familyKey =
      r.familyKey ||
      r.family_diversity_key ||
      (setupId ? String(setupId).split('_').slice(0, 3).join('_') : 'unknown_family');
    const parentFamilyId =
      r.parentFamilyId ||
      r.parentSetupId ||
      familyKey;
    const lineageKey =
      r.lineageKey ||
      `${familyKey}_L${lineageDepth || 0}`;

    const status = scored.status;
    const statusReason = scored.statusReason || null;

    entries.push({
      setupId,
      status,
      statusReason,
      liveStatus: 'active',
      survivalScore: adjustedSurvivalScore,
      nightsSurvived: positiveNights,
      nightsInHistory,
      avgExpectancy,
      avgBootstrapRisk,
      avgMetaScore,
      momentumMetaScore,
      avgCrossAssetScore,
      avgTimeframeScore,
      avgParentVsChildScore,
      beatsParentRate,
      lastTrades: last && Number.isFinite(last.trades) ? last.trades : 0,
      lastExpectancy: last && Number.isFinite(last.expectancy) ? last.expectancy : null,
      lastMetaScore: last && Number.isFinite(last.meta_score) ? last.meta_score : null,
      parentSetupId: last && last.parentSetupId ? last.parentSetupId : null,
      parentFamilyId,
      familyKey,
      lineageKey,
      mutationType: last && last.mutationType ? last.mutationType : null,
      source: last && last.source ? last.source : 'grid',
      generation: Number.isFinite(last && last.generation) ? last.generation : 0,
      lineageDepth,
      rules,
      hasRules: !!(rules && typeof rules === 'object' && Object.keys(rules).length),
    });
  }

  entries.sort((a, b) => {
    const rank = { champion: 3, validated: 2, candidate: 1 };
    const ra = rank[a.status] || 0;
    const rb = rank[b.status] || 0;
    if (rb !== ra) return rb - ra;

    const bScore = safeNum(b.survivalScore, -Infinity);
    const aScore = safeNum(a.survivalScore, -Infinity);
    if (bScore !== aScore) return bScore - aScore;

    const bBeats = safeNum(b.beatsParentRate, 0);
    const aBeats = safeNum(a.beatsParentRate, 0);
    if (bBeats !== aBeats) return bBeats - aBeats;

    const bParent = safeNum(b.avgParentVsChildScore, -999);
    const aParent = safeNum(a.avgParentVsChildScore, -999);
    if (bParent !== aParent) return bParent - aParent;

    const bMeta = safeNum(
      b.momentumMetaScore != null ? b.momentumMetaScore : b.avgMetaScore,
      -999
    );
    const aMeta = safeNum(
      a.momentumMetaScore != null ? a.momentumMetaScore : a.avgMetaScore,
      -999
    );
    return bMeta - aMeta;
  });

  return entries;
}

function entryMomentumForCap(e) {
  const m = Number(e && e.momentumMetaScore);
  if (Number.isFinite(m)) return m;
  const a = Number(e && e.avgMetaScore);
  return Number.isFinite(a) ? a : -Infinity;
}

function capChampionDiversity(entries, opts = {}) {
  const arr = Array.isArray(entries) ? entries.slice() : [];

  const maxPerParentFamily = Math.max(1, Number(opts.maxPerParentFamily || 2));
  const maxPerFamilyKey = Math.max(
    1,
    Number(
      opts.maxPerFamilyKey ??
        process.env.EVOLUTION_MAX_PER_FAMILY ??
        3
    )
  );

  const maxMutationPerParentFamily = Math.max(
    0,
    Number(
      opts.maxMutationPerParentFamily ??
        process.env.EVOLUTION_MAX_MUTATION_CHAMPIONS_PER_PARENT_FAMILY ??
        1
    )
  );
  const maxMutationPerFamilyKey = Math.max(
    0,
    Number(
      opts.maxMutationPerFamilyKey ??
        process.env.EVOLUTION_MAX_MUTATION_CHAMPIONS_PER_FAMILY_KEY ??
        1
    )
  );

  const rawMaxProt =
    opts.maxProtectedPerFamily ?? process.env.EVOLUTION_MAX_PROTECTED_PER_FAMILY;
  const maxProtectedPerFamily =
    rawMaxProt == null || rawMaxProt === ''
      ? 1
      : Math.max(0, Number(rawMaxProt));

  const maxTotalChampions = Math.max(
    0,
    Number(
      opts.maxTotalChampions ??
        process.env.EVOLUTION_MAX_TOTAL_CHAMPIONS ??
        0
    )
  );

  // Softer than strict `>` vs family min: allows ties / float noise so protection can fire
  // occasionally without raising max champions per family (still bounded by maxProtectedPerFamily).
  let protectFamilyMinEps = Number(
    opts.protectFamilyMinEps ??
      process.env.EVOLUTION_PROTECT_FAMILY_MIN_EPS ??
      0.001
  );
  if (!Number.isFinite(protectFamilyMinEps) || protectFamilyMinEps < 0) {
    protectFamilyMinEps = 0.001;
  }

  const champions = arr.filter((e) => e && e.status === 'champion');
  const championMomentums = champions
    .map(entryMomentumForCap)
    .filter((v) => Number.isFinite(v) && v > -Infinity);
  const minChampionMomentum =
    championMomentums.length > 0 ? Math.min(...championMomentums) : -Infinity;

  // Per-family minimum momentum (worst champion in that family).
  const minMomentumInFamily = Object.create(null);
  for (const e of champions) {
    const fk = e.familyKey || 'unknown_family';
    const mom = entryMomentumForCap(e);
    if (Number.isFinite(mom)) {
      if (minMomentumInFamily[fk] == null || mom < minMomentumInFamily[fk]) {
        minMomentumInFamily[fk] = mom;
      }
    }
  }

  const parentCounts = Object.create(null);
  const familyCounts = Object.create(null);
  const mutationParentCounts = Object.create(null);
  const mutationFamilyCounts = Object.create(null);
  const protectedPerFamily = Object.create(null);

  let out = arr.map((entry) => {
    if (!entry || entry.status !== 'champion') return entry;

    const parentKey = entry.parentFamilyId || 'unknown_parent';
    const familyKey = entry.familyKey || 'unknown_family';

    const isMutation =
      !!entry.parentSetupId ||
      !!entry.mutationType ||
      String(entry.setupId || '').startsWith('mut_') ||
      String(entry.setupId || '').startsWith('setup_familyexp_') ||
      String(entry.setupId || '').startsWith('familyexp_');

    const entryMom = entryMomentumForCap(entry);
    // Strict dominance vs global floor, with ε slack (ties / float noise) — same ε as family.
    const aboveGlobalMin =
      Number.isFinite(minChampionMomentum) &&
      Number.isFinite(entryMom) &&
      entryMom > minChampionMomentum - protectFamilyMinEps;
    const familyMin = minMomentumInFamily[familyKey];
    const beatsWorstInFamily =
      familyMin == null || !Number.isFinite(entryMom)
        ? false
        : entryMom >= familyMin - protectFamilyMinEps;
    const protectedSlotsLeft = (protectedPerFamily[familyKey] || 0) < maxProtectedPerFamily;
    const canProtect =
      aboveGlobalMin && protectedSlotsLeft && beatsWorstInFamily;

    if (isMutation) {
      const parentUsed = mutationParentCounts[parentKey] || 0;
      const familyUsed = mutationFamilyCounts[familyKey] || 0;

      if (
        parentUsed >= maxMutationPerParentFamily ||
        familyUsed >= maxMutationPerFamilyKey
      ) {
        if (canProtect) {
          protectedPerFamily[familyKey] = (protectedPerFamily[familyKey] || 0) + 1;
          return {
            ...entry,
            statusReason: 'champion_diversity_protected',
            statusReasonBeforeDiversityProtect: entry.statusReason || null,
          };
        }
        return {
          ...entry,
          status: 'validated',
          statusReason: 'champion_diversity_capped',
        };
      }

      mutationParentCounts[parentKey] = parentUsed + 1;
      mutationFamilyCounts[familyKey] = familyUsed + 1;

      return {
        ...entry,
        champion_diversity_parent_count: mutationParentCounts[parentKey],
        champion_diversity_family_count: mutationFamilyCounts[familyKey],
      };
    }

    const parentUsed = parentCounts[parentKey] || 0;
    const familyUsed = familyCounts[familyKey] || 0;

    if (parentUsed >= maxPerParentFamily || familyUsed >= maxPerFamilyKey) {
      if (canProtect) {
        protectedPerFamily[familyKey] = (protectedPerFamily[familyKey] || 0) + 1;
        return {
          ...entry,
          statusReason: 'champion_diversity_protected',
          statusReasonBeforeDiversityProtect: entry.statusReason || null,
        };
      }
      return {
        ...entry,
        status: 'validated',
        statusReason: 'champion_diversity_capped',
      };
    }

    parentCounts[parentKey] = parentUsed + 1;
    familyCounts[familyKey] = familyUsed + 1;

    return {
      ...entry,
      champion_diversity_parent_count: parentCounts[parentKey],
      champion_diversity_family_count: familyCounts[familyKey],
    };
  });

  if (maxTotalChampions > 0) {
    const stillChampions = out.filter((e) => e && e.status === 'champion');
    if (stillChampions.length > maxTotalChampions) {
      const byMomentum = stillChampions
        .map((e) => ({ entry: e, mom: entryMomentumForCap(e) }))
        .sort((a, b) => (b.mom - a.mom));
      const toDemote = byMomentum.slice(maxTotalChampions);
      const toDemoteIds = new Set(toDemote.map((x) => String(x.entry.setupId)));
      out = out.map((e) => {
        if (!e || e.status !== 'champion') return e;
        if (toDemoteIds.has(String(e.setupId))) {
          return {
            ...e,
            status: 'validated',
            statusReason: 'champion_global_cap',
          };
        }
        return e;
      });
    }
  }

  return out;
}

function makeZerosWildcardStats() {
  return {
    wildcardPromotions: 0,
    wildcardPromotionsOverChampion: 0,
    wildcardPromotionsTieBreak: 0,
    wildcardCandidatesSeen: 0,
    wildcardBlockedFamilyLimit: 0,
    wildcardBlockedGroupStrongerChampion: 0,
    wildcardBlockedTieBreakLost: 0,
    wildcardTieBreakComparisons: 0,
    wildcardTieBreakAuditRejects: 0,
    wildcardBlockedLowDelta: 0,
    wildcardBlockedTotalLimit: 0,
    avgWildcardPromotedMomentum: null,
    promotedMomenta: [],
  };
}

function compareWildcardCandidates(a, b) {
  if (b.mom !== a.mom) return b.mom - a.mom;
  if (b.deltaVsMin !== a.deltaVsMin) return b.deltaVsMin - a.deltaVsMin;
  const na = Number(a.entry.nightsSurvived) || 0;
  const nb = Number(b.entry.nightsSurvived) || 0;
  if (nb !== na) return nb - na;
  const isMut = (x) => !!(x.parentSetupId && String(x.parentSetupId) !== String(x.setupId));
  if (isMut(a.entry) && !isMut(b.entry)) return -1;
  if (!isMut(a.entry) && isMut(b.entry)) return 1;
  return String(a.entry.setupId).localeCompare(String(b.entry.setupId));
}

/**
 * Wildcard Promotion Pass: after capChampionDiversity, promote a bounded number of elite
 * validated to champion (empty group or replace weaker champion). Returns { entries, wildcardStats }.
 */
function applyWildcardPromotionPass(entries, opts = {}) {
  const arr = Array.isArray(entries) ? entries.slice() : [];
  const enable = opts.enable ?? process.env.EVOLUTION_WILDCARD_ENABLE ?? '1';
  if (String(enable) !== '1') {
    return { entries: arr, wildcardStats: makeZerosWildcardStats() };
  }

  const maxPromotions = Math.max(
    0,
    Math.min(10, Number(opts.maxPromotions ?? process.env.EVOLUTION_WILDCARD_MAX_PROMOTIONS ?? 4))
  );
  const minNights = Math.max(0, Number(opts.minNights ?? process.env.EVOLUTION_WILDCARD_MIN_NIGHTS ?? 4));
  const minDelta = Math.max(0, Number(opts.minDelta ?? process.env.EVOLUTION_WILDCARD_MIN_DELTA ?? 0.001));
  const wildcardMaxPerFamily = Math.max(
    0,
    Number(opts.wildcardMaxPerFamily ?? process.env.EVOLUTION_WILDCARD_MAX_PER_FAMILY ?? 1)
  );
  const allowDiversityCapped = String(opts.allowDiversityCapped ?? process.env.EVOLUTION_WILDCARD_ALLOW_DIVERSITY_CAPPED ?? '1') === '1';
  const requireValidatedStatus = String(opts.requireValidatedStatus ?? process.env.EVOLUTION_WILDCARD_REQUIRE_VALIDATED_STATUS ?? '1') === '1';
  const maxPerFamilyKey = Math.max(1, Number(opts.maxPerFamilyKey ?? process.env.EVOLUTION_MAX_PER_FAMILY ?? 3));
  const debugWildcard = process.env.EVOLUTION_DEBUG_WILDCARD === '1';
  const tieBreakEnable =
    String(opts.tieBreakEnable ?? process.env.EVOLUTION_WILDCARD_TIE_BREAK ?? '1') ===
    '1';
  const equalityEps = readWildcardEqualityEps(opts);

  const stats = makeZerosWildcardStats();

  function tieBreakDebugPayload(tag, gk, best, champ, champMom, deltaVsChampion, tbCmp, auditCmp, promoted) {
    const mom = entryMomentumForCap(best);
    let tieBreakWinner = 'tie';
    if (tbCmp < 0) tieBreakWinner = 'candidate';
    else if (tbCmp > 0) tieBreakWinner = 'champion';
    return {
      tag,
      group: gk,
      setupId: best.setupId,
      championSetupId: champ.setupId,
      candidateMomentum: mom,
      championMomentum: champMom,
      deltaVsChampion,
      equalityEps,
      minDeltaRequired: minDelta,
      candidateAvgMetaScore: Number.isFinite(Number(best.avgMetaScore))
        ? Number(best.avgMetaScore)
        : null,
      championAvgMetaScore: Number.isFinite(Number(champ.avgMetaScore))
        ? Number(champ.avgMetaScore)
        : null,
      candidateNightsSurvived: safeNum(Number(best.nightsSurvived), 0),
      championNightsSurvived: safeNum(Number(champ.nightsSurvived), 0),
      candidateNightsInHistory: safeNum(Number(best.nightsInHistory), 0),
      championNightsInHistory: safeNum(Number(champ.nightsInHistory), 0),
      candidateIsMutation: isMutationEntry(best),
      championIsMutation: isMutationEntry(champ),
      tieBreakWinner,
      auditGroupRankPrefersCandidate: auditCmp < 0,
      promoted: !!promoted,
    };
  }

  const champions = arr.filter((e) => e && e.status === 'champion');
  const championMomentums = champions
    .map(entryMomentumForCap)
    .filter((v) => Number.isFinite(v) && v > -Infinity);
  const minChampionMomentum =
    championMomentums.length > 0 ? Math.min(...championMomentums) : -Infinity;

  const championsPerFamily = Object.create(null);
  const championByGroup = Object.create(null);
  for (const e of champions) {
    const fk = e.familyKey || 'unknown_family';
    championsPerFamily[fk] = (championsPerFamily[fk] || 0) + 1;
    const gk = competitionGroupKey(e);
    if (gk) championByGroup[gk] = e;
  }

  const byGroup = Object.create(null);
  for (const e of arr) {
    if (!e || !e.setupId) continue;
    const gk = competitionGroupKey(e);
    if (!gk) continue;
    if (!byGroup[gk]) byGroup[gk] = [];
    byGroup[gk].push(e);
  }

  const candidates = [];
  for (const [gk, members] of Object.entries(byGroup)) {
    const validatedInGroup = members.filter(
      (e) =>
        e.status === 'validated' &&
        (e.liveStatus == null || e.liveStatus !== 'extinct')
    );
    if (validatedInGroup.length === 0) continue;
    const sorted = validatedInGroup.slice().sort(compareGroupMembers);
    const best = sorted[0];
    if (!allowDiversityCapped && best.statusReason === 'champion_diversity_capped') continue;
    const nights = Number(best.nightsInHistory) || 0;
    if (nights < minNights) continue;
    const mom = entryMomentumForCap(best);
    if (!Number.isFinite(mom) || !Number.isFinite(minChampionMomentum)) continue;
    const deltaVsMin = mom - minChampionMomentum;
    if (deltaVsMin < minDelta) {
      stats.wildcardBlockedLowDelta += 1;
      if (debugWildcard) {
        // eslint-disable-next-line no-console -- gated diagnostic (EVOLUTION_DEBUG_WILDCARD=1)
        console.log(
          JSON.stringify({
            tag: 'WILDCARD_BLOCKED_LOW_DELTA',
            group: gk,
            setupId: best.setupId,
            candidateMomentum: mom,
            minChampionMomentum,
            deltaVsMinChampionPool: deltaVsMin,
            minDeltaRequired: minDelta,
          })
        );
      }
      continue;
    }
    stats.wildcardCandidatesSeen += 1;

    const champ = championByGroup[gk];
    if (!champ) {
      candidates.push({
        entry: best,
        mom,
        deltaVsMin,
        replaceChampion: null,
        tieBreakPromotion: false,
      });
    } else {
      const champMom = entryMomentumForCap(champ);
      const deltaVsChampion =
        Number.isFinite(champMom) && Number.isFinite(mom) ? mom - champMom : NaN;

      if (!Number.isFinite(deltaVsChampion)) {
        stats.wildcardBlockedGroupStrongerChampion += 1;
        if (debugWildcard) {
          console.log(
            JSON.stringify({
              tag: 'WILDCARD_BLOCKED_GROUP_STRONGER_CHAMPION',
              group: gk,
              setupId: best.setupId,
              reason: 'non_finite_momentum',
            })
          );
        }
      } else if (mom > champMom + minDelta) {
        candidates.push({
          entry: best,
          mom,
          deltaVsMin,
          replaceChampion: champ,
          tieBreakPromotion: false,
        });
      } else if (tieBreakEnable && Math.abs(deltaVsChampion) <= equalityEps) {
        // Tie-break qualitatif (sans re-momentum) + garde audit : le champion doit rester
        // compareGroupMembers-first dans le groupe après remplacement.
        stats.wildcardTieBreakComparisons += 1;
        const tbCmp = compareWildcardTieBreak(best, champ);
        const auditCmp = compareGroupMembers(best, champ);
        const tieWins = tbCmp < 0;
        const auditOk = auditCmp < 0;
        const promoted = tieWins && auditOk;

        if (tieWins && !auditOk) {
          stats.wildcardTieBreakAuditRejects += 1;
        }

        if (promoted) {
          candidates.push({
            entry: best,
            mom,
            deltaVsMin,
            replaceChampion: champ,
            tieBreakPromotion: true,
          });
          if (debugWildcard) {
            console.log(
              JSON.stringify(
                tieBreakDebugPayload(
                  'WILDCARD_TIEBREAK_PROMOTED',
                  gk,
                  best,
                  champ,
                  champMom,
                  deltaVsChampion,
                  tbCmp,
                  auditCmp,
                  true
                )
              )
            );
          }
        } else {
          stats.wildcardBlockedTieBreakLost += 1;
          if (debugWildcard) {
            console.log(
              JSON.stringify(
                tieBreakDebugPayload(
                  'WILDCARD_TIEBREAK_BLOCKED',
                  gk,
                  best,
                  champ,
                  champMom,
                  deltaVsChampion,
                  tbCmp,
                  auditCmp,
                  false
                )
              )
            );
          }
        }
      } else {
        stats.wildcardBlockedGroupStrongerChampion += 1;
        if (debugWildcard) {
          console.log(
            JSON.stringify({
              tag: 'WILDCARD_BLOCKED_GROUP_STRONGER_CHAMPION',
              group: gk,
              setupId: best.setupId,
              championSetupId: champ.setupId,
              candidateMomentum: mom,
              championMomentum: Number.isFinite(champMom) ? champMom : null,
              deltaVsChampion: Number.isFinite(champMom) ? mom - champMom : null,
              minDeltaRequired: minDelta,
            })
          );
        }
      }
    }
  }

  candidates.sort(compareWildcardCandidates);

  const toPromote = [];
  const toDemote = [];
  const promotedPerFamily = Object.create(null);

  for (const c of candidates) {
    if (toPromote.length >= maxPromotions) {
      stats.wildcardBlockedTotalLimit += 1;
      continue;
    }
    const fk = c.entry.familyKey || 'unknown_family';
    const currentWildcardInFamily = promotedPerFamily[fk] || 0;
    if (currentWildcardInFamily >= wildcardMaxPerFamily) {
      stats.wildcardBlockedFamilyLimit += 1;
      continue;
    }
    toPromote.push(c);
    promotedPerFamily[fk] = currentWildcardInFamily + 1;
    if (c.replaceChampion) {
      toDemote.push(c.replaceChampion);
      stats.wildcardPromotionsOverChampion += 1;
      if (c.tieBreakPromotion) stats.wildcardPromotionsTieBreak += 1;
    }
  }

  const promoteIds = new Set(toPromote.map((c) => String(c.entry.setupId)));
  const demoteIds = new Set(toDemote.map((e) => String(e.setupId)));
  const wildcardDemoteReasonById = Object.create(null);
  for (const c of toPromote) {
    if (c.replaceChampion) {
      wildcardDemoteReasonById[String(c.replaceChampion.setupId)] =
        c.tieBreakPromotion ? 'replaced_by_wildcard_tiebreak' : 'replaced_by_wildcard';
    }
  }

  const promotedMomenta = toPromote.map((c) => c.mom).filter(Number.isFinite);
  stats.wildcardPromotions = toPromote.length;
  stats.promotedMomenta = promotedMomenta;
  stats.avgWildcardPromotedMomentum =
    promotedMomenta.length > 0
      ? Math.round(promotedMomenta.reduce((a, b) => a + b, 0) / promotedMomenta.length * 1e6) / 1e6
      : null;

  const out = arr.map((e) => {
    if (!e || !e.setupId) return e;
    if (demoteIds.has(String(e.setupId))) {
      const sr =
        wildcardDemoteReasonById[String(e.setupId)] || 'replaced_by_wildcard';
      return {
        ...e,
        status: 'validated',
        statusReason: sr,
        statusReasonBeforeWildcard: e.statusReason || null,
      };
    }
    if (promoteIds.has(String(e.setupId))) {
      const c = toPromote.find((x) => String(x.entry.setupId) === String(e.setupId));
      let reason = 'wildcard_promoted';
      if (c && c.replaceChampion) {
        reason = c.tieBreakPromotion
          ? 'wildcard_promoted_over_champion_tiebreak'
          : 'wildcard_promoted_over_champion';
      }
      return {
        ...e,
        status: 'champion',
        statusReason: reason,
        statusReasonBeforeWildcard: e.statusReason || null,
      };
    }
    return e;
  });

  return { entries: out, wildcardStats: stats };
}

/** Backward-compat wrapper: returns only entries. */
function applyWildcardPromotion(entries, opts = {}) {
  const { entries: out } = applyWildcardPromotionPass(entries, {
    ...opts,
    maxPromotions: opts.maxWildcards ?? opts.maxPromotions,
    minDelta: opts.wildcardMargin ?? opts.minDelta,
    wildcardMaxPerFamily: opts.maxPerFamilyKey ?? opts.wildcardMaxPerFamily,
  });
  return out;
}

/**
 * Load setupIds that were killed by live performance (champion_performance.json).
 * Used to exclude them from registry.champions so allowlist only has active champions.
 * @returns {Set<string>}
 */
function loadKilledChampionIds() {
  const championDir = dataRoot.getPath('champion_setups');
  const perfPath = path.join(championDir, 'champion_performance.json');
  const set = new Set();
  try {
    if (fs.existsSync(perfPath)) {
      const j = JSON.parse(fs.readFileSync(perfPath, 'utf8'));
      const bySetupId = j.bySetupId || {};
      for (const [id, entry] of Object.entries(bySetupId)) {
        if (entry && entry.active === false) set.add(String(id));
      }
    }
  } catch (e) {
    // ignore
  }
  return set;
}

function writeChampionRegistry(registry) {
  const championDir = dataRoot.getPath('champion_setups');
  ensureDir(championDir);

  const outPath = path.join(championDir, 'champion_registry.json');
  const tmpPath = path.join(championDir, 'champion_registry.json.tmp');
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf8');
  fs.renameSync(tmpPath, outPath);
  return outPath;
}

let evolutionGuardWarnedMissingRunHealth = false;

function evolutionDegradedGuardEnabled() {
  const v = process.env.NEUROPILOT_EVOLUTION_GUARD;
  if (v === '0' || String(v).toLowerCase() === 'false') return false;
  return true;
}

/**
 * Degraded keys from ops-snapshot/run_health.json only (degradedCriticalDatasets).
 * Independent of NEUROPILOT_DATA_GUARD_SKIP. Fail open: missing/invalid file → warn once, empty Set.
 * @returns {Set<string>} e.g. XAUUSD_5M
 */
function readDegradedCriticalDatasetKeysForEvolution() {
  const { readRunHealthOptional } = require('../data/datasetDegradedGuard');
  let h;
  try {
    h = readRunHealthOptional();
  } catch (_) {
    h = null;
  }
  if (!h || typeof h !== 'object') {
    if (!evolutionGuardWarnedMissingRunHealth) {
      evolutionGuardWarnedMissingRunHealth = true;
      console.warn(
        '[EVOLUTION_GUARD] run_health.json missing or unreadable — filter inactive (fail open)'
      );
    }
    return new Set();
  }
  const list = h.degradedCriticalDatasets;
  if (!Array.isArray(list) || list.length === 0) return new Set();
  const set = new Set();
  for (const k of list) {
    const u = String(k || '')
      .trim()
      .replace(/\s+/g, '')
      .toUpperCase();
    if (u) set.add(u);
  }
  return set;
}

/**
 * Dataset keys for a meta/nightly evolution row. Prefer explicit fields (variants, symbol+timeframe, byAsset).
 * @param {object|null|undefined} row
 * @returns {Set<string>} uppercase SYMBOL_TF
 */
function collectDatasetKeysFromEvolutionRow(row) {
  const keys = new Set();
  if (!row || typeof row !== 'object') return keys;
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : null;
  if (!raw) return keys;

  const symTop = raw.symbol != null ? String(raw.symbol).trim() : '';
  const tfTop = raw.timeframe != null ? String(raw.timeframe).trim() : '';
  if (symTop && tfTop) {
    keys.add(`${symTop}_${tfTop}`.replace(/\s+/g, '').toUpperCase());
  }

  const variants = raw.variants;
  if (Array.isArray(variants)) {
    for (const v of variants) {
      if (!v || typeof v !== 'object') continue;
      if (v.asset != null) {
        keys.add(String(v.asset).replace(/\s+/g, '').toUpperCase());
      } else if (v.symbol != null && v.timeframe != null) {
        keys.add(
          `${String(v.symbol).trim()}_${String(v.timeframe).trim()}`.replace(/\s+/g, '').toUpperCase()
        );
      }
    }
  }

  const byAsset = raw.byAsset;
  if (Array.isArray(byAsset)) {
    for (const a of byAsset) {
      const asset = a && a.asset != null ? String(a.asset).trim() : '';
      if (!asset) continue;
      keys.add(asset.replace(/\s+/g, '').toUpperCase());
    }
  }

  return keys;
}

/** @param {unknown} rows */
function collectDatasetKeysForSetupRows(rows) {
  const rowKeys = new Set();
  const arr = Array.isArray(rows) ? rows : [];
  for (const r of arr) {
    for (const k of collectDatasetKeysFromEvolutionRow(r)) {
      rowKeys.add(k);
    }
  }
  return rowKeys;
}

const EVOLUTION_GUARD_DEGRADED_SAMPLE_MAX = 8;

/** @param {Set<string>} degradedSet */
function sampleDegradedKeysForSnapshot(degradedSet) {
  if (!degradedSet || degradedSet.size === 0) return [];
  return [...degradedSet].sort().slice(0, EVOLUTION_GUARD_DEGRADED_SAMPLE_MAX);
}

/**
 * Drop setups that reference any entry in run_health.degradedCriticalDatasets.
 * Opt out: NEUROPILOT_EVOLUTION_GUARD=0. Unmapped setups are kept (fail open).
 *
 * @param {object} loaded - output of loadPreferredEvolutionInput()
 * @returns {{ loaded: object, stats: object }}
 */
function filterEvolutionInputByDegradedDatasets(loaded) {
  if (!loaded || typeof loaded !== 'object') {
    return {
      loaded,
      stats: {
        enabled: evolutionDegradedGuardEnabled(),
        skippedSetups: 0,
        totalSetups: 0,
        unmappedSetups: 0,
        filteredPct: null,
        degradedKeysSample: [],
      },
    };
  }

  const bySetupId =
    loaded.bySetupId && typeof loaded.bySetupId === 'object' ? loaded.bySetupId : {};
  const entries = Object.entries(bySetupId);
  const totalSetups = entries.length;
  let unmappedSetups = 0;
  for (const [, rows] of entries) {
    if (collectDatasetKeysForSetupRows(rows).size === 0) unmappedSetups += 1;
  }

  if (!evolutionDegradedGuardEnabled()) {
    return {
      loaded,
      stats: {
        enabled: false,
        skippedSetups: 0,
        totalSetups,
        unmappedSetups,
        filteredPct: null,
        degradedKeysSample: [],
      },
    };
  }

  const degraded = readDegradedCriticalDatasetKeysForEvolution();
  const degradedKeysSample = sampleDegradedKeysForSnapshot(degraded);

  if (!degraded || degraded.size === 0) {
    return {
      loaded,
      stats: {
        enabled: true,
        skippedSetups: 0,
        totalSetups,
        unmappedSetups,
        filteredPct: totalSetups > 0 ? 0 : null,
        degradedKeysSample,
      },
    };
  }

  const next = { ...loaded, bySetupId: {} };
  let skippedSetups = 0;

  for (const [setupId, rows] of entries) {
    const rowKeys = collectDatasetKeysForSetupRows(rows);
    if (rowKeys.size === 0) {
      next.bySetupId[setupId] = rows;
      continue;
    }
    let blockedKey = null;
    for (const dk of degraded) {
      const dku = String(dk).toUpperCase();
      if (rowKeys.has(dku)) {
        blockedKey = dku;
        break;
      }
    }
    if (blockedKey) {
      skippedSetups += 1;
      console.log(
        `[EVOLUTION_GUARD] SKIP_SETUP ${setupId} | degraded dataset ${blockedKey}`
      );
      continue;
    }
    next.bySetupId[setupId] = rows;
  }

  if (skippedSetups > 0) {
    console.log(
      `[EVOLUTION_GUARD] skipped ${skippedSetups} setup(s) due to degraded critical datasets`
    );
  }

  const filteredPct =
    totalSetups > 0
      ? Math.round((skippedSetups / totalSetups) * 10000) / 100
      : null;

  return {
    loaded: next,
    stats: {
      enabled: true,
      skippedSetups,
      totalSetups,
      unmappedSetups,
      filteredPct,
      degradedKeysSample,
    },
  };
}

async function runEvolution(opts = {}) {
  const hb = evolutionHeartbeat;
  hb('evolution_node_start', { force: true });
  try {
  const loadedRaw = await loadPreferredEvolutionInput();
  hb('evolution_node_load_inputs', {
    force: true,
    extra: { step: 'after_load_preferred' },
  });

  const { loaded, stats: evolutionGuardStats } =
    filterEvolutionInputByDegradedDatasets(loadedRaw);

  const setupKeys =
    loaded && loaded.bySetupId && typeof loaded.bySetupId === 'object'
      ? Object.keys(loaded.bySetupId)
      : [];
  hb('evolution_node_inputs_ready', {
    extra: {
      setups: setupKeys.length,
      guard_skipped: evolutionGuardStats && evolutionGuardStats.skippedSetups,
    },
  });

  const byLineageKey = buildByLineageKey(loaded.bySetupId);
  applyLineageHistoryToBySetupId(loaded.bySetupId, byLineageKey);

  const entriesRaw = buildRegistryEntries(loaded.bySetupId);
  hb('evolution_node_processing', {
    extra: { phase: 'registry_entries_built', count: entriesRaw.length },
  });
  const normalized = normalizeChampionPerGroup(entriesRaw);
  const stagnated = applyPostNormalizeStagnation(normalized);
  const afterExtinction = applyExtinctionStructural(stagnated);

  const capOpts = {
    maxPerParentFamily: Number(
      process.env.EVOLUTION_MAX_CHAMPIONS_PER_PARENT_FAMILY || 2
    ),
    maxPerFamilyKey: Number(
      process.env.EVOLUTION_MAX_CHAMPIONS_PER_FAMILY_KEY ||
        process.env.EVOLUTION_MAX_PER_FAMILY ||
        3
    ),
    maxMutationPerParentFamily: Number(
      process.env.EVOLUTION_MAX_MUTATION_CHAMPIONS_PER_PARENT_FAMILY || 1
    ),
    maxMutationPerFamilyKey: Number(
      process.env.EVOLUTION_MAX_MUTATION_CHAMPIONS_PER_FAMILY_KEY || 1
    ),
  };
  let entries = capChampionDiversity(afterExtinction, capOpts);

  const metricsHistory = loadMetricsHistoryFromLog(evolutionMetricsLogPath);
  const marketContext = loadMarketContext({ dataRoot });
  const stagnation = readStagnationSignals(metricsHistory);
  const baseMinDelta = Math.max(
    0,
    Number(process.env.EVOLUTION_WILDCARD_MIN_DELTA ?? 0.001)
  );
  const baseMaxPromotions = Math.max(
    0,
    Math.min(10, Number(process.env.EVOLUTION_WILDCARD_MAX_PROMOTIONS ?? 4))
  );
  const adaptive = deriveAdaptiveWildcardOpts({
    baseMinDelta,
    baseMaxPromotions,
    stagnation,
  });

  const { entries: entriesAfterWildcard, wildcardStats } = applyWildcardPromotionPass(entries, {
    maxPromotions: adaptive.maxPromotions,
    minNights: Number(process.env.EVOLUTION_WILDCARD_MIN_NIGHTS ?? 4),
    minDelta: adaptive.minDelta,
    wildcardMaxPerFamily: Number(process.env.EVOLUTION_WILDCARD_MAX_PER_FAMILY ?? 1),
    allowDiversityCapped: process.env.EVOLUTION_WILDCARD_ALLOW_DIVERSITY_CAPPED !== '0',
    requireValidatedStatus: process.env.EVOLUTION_WILDCARD_REQUIRE_VALIDATED_STATUS !== '0',
    maxPerFamilyKey: capOpts.maxPerFamilyKey,
  });
  entries = entriesAfterWildcard;
  hb('evolution_node_processing', {
    extra: { phase: 'after_wildcard', entries: entries.length },
  });

  const killedSet = loadKilledChampionIds();

  const championsRaw = entries.filter((e) => e.status === 'champion');
  const champions = championsRaw.filter((e) => !killedSet.has(e.setupId));

  const validated = entries.filter((e) => e.status === 'validated');
  const candidates = entries.filter((e) => e.status === 'candidate');

  const setups = entries.map((e) => ({
    ...e,
    liveStatus: killedSet.has(e.setupId)
      ? 'killed'
      : e.liveStatus === 'extinct'
        ? 'extinct'
        : 'active',
  }));

  const consistency = validateRegistryConsistency(entries, {
    strict: process.env.EVOLUTION_REGISTRY_STRICT === '1',
  });
  const metadata = buildEvolutionMetadata(entries, consistency, wildcardStats);
  const deltaMeta =
    metadata.avgChampionMomentum != null &&
    metadata.avgValidatedMomentum != null
      ? Math.round(
          (metadata.avgChampionMomentum - metadata.avgValidatedMomentum) * 1e6
        ) / 1e6
      : null;
  const lastMetrics = { ...metadata, delta: deltaMeta };
  const scores = computeLearningScores({
    lastMetrics,
    history: metricsHistory,
  });
  Object.assign(metadata, scores);
  if (marketContext) {
    metadata.marketRegime = marketContext.regime;
    metadata.marketVolatility = marketContext.volatilityScore;
    metadata.marketTrend = marketContext.trendStrength;
  }
  metadata.effectiveMinDelta = adaptive.minDelta;
  metadata.effectiveMaxPromotions = adaptive.maxPromotions;
  metadata.stagnationIsStagnating = stagnation.isStagnating;
  metadata.stagnationAvgDelta = stagnation.avgDelta;
  metadata.stagnationZeroPromotions = stagnation.zeroPromotions;

  hb('evolution_node_write_outputs', {
    extra: { step: 'before_write', setups: setups.length },
  });

  const registry = {
    generatedAt: new Date().toISOString(),
    experimentId: opts.experimentId || process.env.EXPERIMENT_ID || null,
    source: loaded.source,
    nightsAnalyzed: loaded.nights ? loaded.nights.length : 0,
    evolutionGuard: evolutionGuardStats,

    setupsCount: setups.length,
    candidatesCount: candidates.length,
    validatedCount: validated.length,
    championsCount: champions.length,

    metadata,
    setups,
    candidates,
    validated,
    champions,
  };

  const outPath = writeChampionRegistry(registry);

  hb('evolution_node_done', { force: true });

  return {
    registry,
    outPath,
  };
  } catch (err) {
    hb('evolution_node_error', {
      force: true,
      extra: {
        message: err && err.message ? String(err.message).slice(0, 120) : 'unknown',
      },
    });
    throw err;
  }
}

function main() {
  runEvolution()
    .then(({ registry, outPath }) => {
      console.log('Strategy Evolution done.');
      console.log('  Source:', registry.source);
      console.log('  Nights analyzed:', registry.nightsAnalyzed);
      console.log('  Setups scored:', registry.setupsCount);
      console.log('  Champions:', registry.championsCount);
      const m = registry.metadata || {};
      if (process.env.EVOLUTION_ADAPTIVE_ENABLE === '1') {
        console.log(
          '  Wildcard effective: minDelta',
          m.effectiveMinDelta,
          'maxPromotions',
          m.effectiveMaxPromotions,
          'stagnating',
          m.stagnationIsStagnating
        );
      }
      if (
        m.learningScore != null ||
        m.explorationScore != null ||
        m.adaptationScore != null
      ) {
        console.log(
          '  Scores: learning',
          m.learningScore,
          'exploration',
          m.explorationScore,
          'adaptation',
          m.adaptationScore
        );
      }
      console.log('  Registry:', outPath);
    })
    .catch((err) => {
      console.error(
        'Strategy Evolution failed:',
        err && err.message ? err.message : err
      );
      process.exit(1);
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  runEvolution,
  runStrategyEvolution: runEvolution,
  filterEvolutionInputByDegradedDatasets,
  readDegradedCriticalDatasetKeysForEvolution,
  collectDatasetKeysFromEvolutionRow,
  loadCurrentMetaRankingAsHistory,
  loadPreferredEvolutionInput,
  buildRegistryEntries,
  normalizeChampionPerGroup,
  capChampionDiversity,
  applyWildcardPromotion,
  applyWildcardPromotionPass,
  validateRegistryConsistency,
  buildEvolutionMetadata,
  compareGroupMembers,
  compareWildcardTieBreak,
  competitionGroupKey,
};
