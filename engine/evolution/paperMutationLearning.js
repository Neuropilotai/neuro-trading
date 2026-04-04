'use strict';

/**
 * Learning loop v1 — derive mutation-type multipliers from governance/paper_trades.jsonl
 * by resolving trade identity → mutationType via a deterministic multi-key index on
 * generated_strategies (setup_mut_*.json / setup_*.json with known mutationType only).
 *
 * Opt-in: NEUROPILOT_MUTATION_PAPER_LEARNING=1
 * Optional: NEUROPILOT_PAPER_LOSS_PATTERNS=1 → post-multiply by computePaperLossPatterns().globalPenalty (fail-soft).
 * Positive floor: NEUROPILOT_PAPER_LOSS_MIN_TRADES_CONFIDENCE (default 20) → multiplier ≥ 1.05 when expectancy > 0.
 * Does not change promotion guard, scoring contracts, or mutate* implementations.
 */

const fs = require('fs');
const path = require('path');
const { parsePaperTradesJsonlContent } = require('../governance/parsePaperTradesJsonl');

const KNOWN_MUTATION_TYPES = Object.freeze([
  'parameter_jitter',
  'session_flip',
  'regime_flip',
  'forced_family_shift',
]);

/** Trade fields tried in strict priority (strong → weak). */
const TRADE_IDENTITY_FIELDS = Object.freeze([
  'setupId',
  'strategyId',
  'strategy',
  'name',
]);

const SOURCE_TAG_ORDER = Object.freeze([
  'basename',
  'fileStem',
  'name',
  'setupId',
  'strategyId',
]);

/**
 * Conservative identity normalization (index + paper trades use the same function).
 * trim, lowercase, strip terminal .json, collapse internal whitespace.
 */
function normalizeStrategyIdentityKey(value) {
  if (value == null) return '';
  let s = String(value).trim();
  if (!s) return '';
  if (s.toLowerCase().endsWith('.json')) {
    s = s.slice(0, -5).trim();
  }
  s = s.toLowerCase();
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Per-trade mapping attribution buckets (stats.matchedBy).
 *
 * These are NOT paper_trade field names only: they classify the winning index alias
 * (how the normalized key was registered on generated_strategies). A trade always
 * matches via one of setupId|strategyId|strategy|name on the line; the bucket records
 * which index sourceTag won (deterministic pick when several tags share the same key).
 *
 * - setupId / strategyId / name: index key came from that field on the setup JSON.
 * - basename: key came from file basename or full file stem (setup_mut_… / setup_…).
 * - other: fallback.
 */
function emptyMappingStats() {
  return {
    mappedTrades: 0,
    unmappedTrades: 0,
    ambiguousTrades: 0,
    conflictingIdentityTrades: 0,
    matchedBy: {
      setupId: 0,
      strategyId: 0,
      basename: 0,
      name: 0,
      other: 0,
    },
  };
}

function matchedByBucketFromSourceTag(sourceTag) {
  if (sourceTag === 'fileStem' || sourceTag === 'basename') return 'basename';
  if (sourceTag === 'setupId') return 'setupId';
  if (sourceTag === 'strategyId') return 'strategyId';
  if (sourceTag === 'name') return 'name';
  return 'other';
}

/**
 * Two-phase deterministic index: key → resolved (one entryId) or ambiguous (≥2 entryIds).
 * Same entryId may register multiple sourceTags for one key without ambiguity.
 */
function buildGeneratedStrategyAliasIndex(generatedDir) {
  /** @type Map<string, Map<string, { mutationType: string, sourceTags: Set<string>, typeConflict: boolean }>> */
  const keyToEntries = new Map();

  function addAlias(rawKey, entryId, mutationType, sourceTag) {
    const key = normalizeStrategyIdentityKey(rawKey);
    if (!key || !entryId || !mutationType) return;
    if (!keyToEntries.has(key)) keyToEntries.set(key, new Map());
    const byEntry = keyToEntries.get(key);
    if (!byEntry.has(entryId)) {
      byEntry.set(entryId, {
        mutationType,
        sourceTags: new Set([sourceTag]),
        typeConflict: false,
      });
      return;
    }
    const row = byEntry.get(entryId);
    if (row.mutationType !== mutationType) row.typeConflict = true;
    row.sourceTags.add(sourceTag);
  }

  if (!generatedDir || !fs.existsSync(generatedDir)) {
    return new Map();
  }
  let names;
  try {
    names = fs.readdirSync(generatedDir);
  } catch (_) {
    return new Map();
  }

  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    if (!f.startsWith('setup_mut_') && !f.startsWith('setup_')) continue;
    const full = path.join(generatedDir, f);
    let j;
    try {
      j = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (_) {
      continue;
    }
    const rawMt =
      j && j.mutationType != null ? String(j.mutationType).trim() : '';
    if (!rawMt || !KNOWN_MUTATION_TYPES.includes(rawMt)) continue;

    const baseId = f
      .replace(/^setup_mut_/, '')
      .replace(/^setup_/, '')
      .replace(/\.json$/, '');
    const fileStem = f.replace(/\.json$/, '');
    const entryId = String(j.setupId || '').trim() || baseId;

    if (j.setupId) addAlias(j.setupId, entryId, rawMt, 'setupId');
    const sidN = normalizeStrategyIdentityKey(j.setupId);
    if (j.strategyId) {
      const stratN = normalizeStrategyIdentityKey(j.strategyId);
      if (stratN && stratN !== sidN) {
        addAlias(j.strategyId, entryId, rawMt, 'strategyId');
      }
    }
    if (baseId) addAlias(baseId, entryId, rawMt, 'basename');
    addAlias(fileStem, entryId, rawMt, 'fileStem');
    if (j.name) addAlias(j.name, entryId, rawMt, 'name');
  }

  const byAlias = new Map();
  const sortedTags = (set) =>
    [...set].sort((a, b) => {
      const ia = SOURCE_TAG_ORDER.indexOf(a);
      const ib = SOURCE_TAG_ORDER.indexOf(b);
      if (ia < 0 && ib < 0) return String(a).localeCompare(String(b));
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });

  for (const [key, byEntry] of keyToEntries) {
    if (byEntry.size > 1) {
      byAlias.set(key, { status: 'ambiguous' });
      continue;
    }
    const [entryId, row] = [...byEntry.entries()][0];
    if (row.typeConflict) {
      byAlias.set(key, { status: 'ambiguous' });
      continue;
    }
    const sourceTag = sortedTags(row.sourceTags)[0];
    byAlias.set(key, {
      status: 'resolved',
      entryId,
      mutationType: row.mutationType,
      sourceTag,
    });
  }

  return byAlias;
}

/**
 * Resolve one paper trade line against the alias index.
 * Multiple trade fields may hit the index; conflicting entryIds → no match.
 */
function resolvePaperTradeToGeneratedStrategy(trade, byAlias) {
  const resolutions = [];
  let sawAmbiguous = false;

  for (const field of TRADE_IDENTITY_FIELDS) {
    const raw = trade[field];
    if (raw == null || String(raw).trim() === '') continue;
    const key = normalizeStrategyIdentityKey(raw);
    if (!key) continue;
    const slot = byAlias.get(key);
    if (!slot) continue;
    if (slot.status === 'ambiguous') {
      sawAmbiguous = true;
      continue;
    }
    resolutions.push({
      field,
      entryId: slot.entryId,
      mutationType: slot.mutationType,
      sourceTag: slot.sourceTag,
    });
  }

  if (resolutions.length === 0) {
    return {
      mutationType: null,
      conflict: false,
      sawAmbiguous,
      matchedByBucket: null,
    };
  }

  const entryIds = new Set(resolutions.map((r) => r.entryId));
  if (entryIds.size > 1) {
    return {
      mutationType: null,
      conflict: true,
      sawAmbiguous,
      matchedByBucket: null,
    };
  }

  const targetId = [...entryIds][0];
  const best = TRADE_IDENTITY_FIELDS.map((f) =>
    resolutions.find((r) => r.field === f && r.entryId === targetId)
  ).find(Boolean);

  return {
    mutationType: best.mutationType,
    conflict: false,
    sawAmbiguous,
    matchedByBucket: matchedByBucketFromSourceTag(best.sourceTag),
  };
}

function emptyMultipliersObject() {
  return {};
}

function attachMappingStats(baseStats, ms, extras = {}) {
  return {
    ...baseStats,
    mappedTrades: ms.mappedTrades,
    unmappedTrades: ms.unmappedTrades,
    ambiguousTrades: ms.ambiguousTrades,
    conflictingIdentityTrades: ms.conflictingIdentityTrades,
    matchedBy: { ...ms.matchedBy },
    ...extras,
  };
}

/**
 * @param {{ dataRoot?: string, governanceDir?: string, generatedDir?: string }} opts
 */
function computePaperMutationLearning(opts = {}) {
  const minTotal = Math.max(
    5,
    Math.floor(Number(process.env.MUTATION_PAPER_LEARNING_MIN_TRADES || 20))
  );
  const minPerType = Math.max(
    2,
    Math.floor(Number(process.env.MUTATION_PAPER_LEARNING_MIN_PER_TYPE || 3))
  );
  const maxMul = Number.isFinite(Number(process.env.MUTATION_PAPER_LEARNING_MAX_MUL))
    ? Number(process.env.MUTATION_PAPER_LEARNING_MAX_MUL)
    : 1.35;
  const minMul = Number.isFinite(Number(process.env.MUTATION_PAPER_LEARNING_MIN_MUL))
    ? Number(process.env.MUTATION_PAPER_LEARNING_MIN_MUL)
    : 0.8;
  const minTradesConfidence = Math.max(
    5,
    Math.floor(Number(process.env.NEUROPILOT_PAPER_LOSS_MIN_TRADES_CONFIDENCE || 20))
  );

  const root = opts.dataRoot;
  if (!root || typeof root !== 'string') {
    const generatedAt = new Date().toISOString();
    const ms = emptyMappingStats();
    return {
      skipped: true,
      reason: 'no_data_root',
      generatedAt,
      tradeCount: 0,
      minTotal,
      minPerType,
      minMul,
      maxMul,
      multipliers: emptyMultipliersObject(),
      stats: attachMappingStats({ mappedTrades: 0 }, ms),
    };
  }
  const governanceDir = opts.governanceDir || path.join(root, 'governance');
  const generatedDir = opts.generatedDir || path.join(root, 'generated_strategies');

  const jsonlPath = path.join(governanceDir, 'paper_trades.jsonl');
  if (!fs.existsSync(jsonlPath)) {
    const generatedAt = new Date().toISOString();
    const ms = emptyMappingStats();
    return {
      skipped: true,
      reason: 'no_paper_trades_file',
      generatedAt,
      tradeCount: 0,
      minTotal,
      minPerType,
      minMul,
      maxMul,
      multipliers: emptyMultipliersObject(),
      stats: attachMappingStats({ mappedTrades: 0 }, ms),
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (e) {
    const generatedAt = new Date().toISOString();
    const ms = emptyMappingStats();
    return {
      skipped: true,
      reason: 'paper_trades_read_error',
      message: String(e && e.message ? e.message : e),
      generatedAt,
      tradeCount: 0,
      minTotal,
      minPerType,
      minMul,
      maxMul,
      multipliers: emptyMultipliersObject(),
      stats: attachMappingStats({ mappedTrades: 0 }, ms),
    };
  }

  const { trades } = parsePaperTradesJsonlContent(raw);
  if (!Array.isArray(trades) || trades.length < minTotal) {
    const generatedAt = new Date().toISOString();
    const ms = emptyMappingStats();
    return {
      skipped: true,
      reason: 'insufficient_trades',
      generatedAt,
      tradeCount: trades ? trades.length : 0,
      minTotal,
      minPerType,
      minMul,
      maxMul,
      multipliers: emptyMultipliersObject(),
      stats: attachMappingStats({ mappedTrades: 0 }, ms),
    };
  }

  const byAlias = buildGeneratedStrategyAliasIndex(generatedDir);
  const agg = Object.create(null);
  const ms = emptyMappingStats();
  const unmappedSamples = [];

  for (const t of trades) {
    const r = resolvePaperTradeToGeneratedStrategy(t, byAlias);
    if (r.mutationType != null) {
      ms.mappedTrades += 1;
      const b = r.matchedByBucket;
      if (b && ms.matchedBy[b] != null) ms.matchedBy[b] += 1;
      else ms.matchedBy.other += 1;

      const mt = r.mutationType;
      if (!agg[mt]) agg[mt] = { n: 0, wins: 0, pnlSum: 0 };
      agg[mt].n += 1;
      if (Number(t.pnl) > 0) agg[mt].wins += 1;
      agg[mt].pnlSum += Number(t.pnl) || 0;
    } else {
      ms.unmappedTrades += 1;
      if (r.conflict) ms.conflictingIdentityTrades += 1;
      else if (r.sawAmbiguous) ms.ambiguousTrades += 1;
      if (unmappedSamples.length < 5) {
        const hint = normalizeStrategyIdentityKey(
          t.setupId || t.strategyId || t.strategy || t.name || ''
        );
        if (hint && !unmappedSamples.includes(hint)) unmappedSamples.push(hint);
      }
    }
  }

  const mappedTrades = ms.mappedTrades;
  if (mappedTrades < minTotal) {
    const generatedAt = new Date().toISOString();
    const mappedN = Number.isFinite(Number(mappedTrades)) ? Number(mappedTrades) : 0;
    return {
      skipped: true,
      reason: 'insufficient_mapped_trades',
      generatedAt,
      tradeCount: trades.length,
      minTotal,
      minPerType,
      minMul,
      maxMul,
      multipliers: emptyMultipliersObject(),
      stats: attachMappingStats({ mappedTrades: mappedN }, ms, {
        unmappedIdentitySamples: unmappedSamples,
      }),
    };
  }

  const entries = [];
  for (const mt of KNOWN_MUTATION_TYPES) {
    const a = agg[mt];
    if (!a || a.n < minPerType) continue;
    entries.push({
      mt,
      n: a.n,
      expectancy: a.pnlSum / a.n,
      winRate: a.wins / a.n,
    });
  }

  if (entries.length < 2) {
    const generatedAt = new Date().toISOString();
    const mappedN = Number.isFinite(Number(mappedTrades)) ? Number(mappedTrades) : 0;
    return {
      skipped: true,
      reason: 'insufficient_mutation_type_coverage',
      generatedAt,
      tradeCount: trades.length,
      minTotal,
      minPerType,
      minMul,
      maxMul,
      multipliers: emptyMultipliersObject(),
      stats: attachMappingStats({ mappedTrades: mappedN, agg }, ms, {
        unmappedIdentitySamples: unmappedSamples,
      }),
    };
  }

  const expectancies = entries.map((e) => e.expectancy);
  const maxExp = Math.max(...expectancies);
  const minExp = Math.min(...expectancies);
  const span = maxExp - minExp || 1;

  const multipliers = {};
  for (const mt of KNOWN_MUTATION_TYPES) {
    const e = entries.find((x) => x.mt === mt);
    if (!e) {
      multipliers[mt] = 1;
      continue;
    }
    const t = (e.expectancy - minExp) / span;
    const m = minMul + t * (maxMul - minMul);
    let mRounded = Math.round(Math.max(minMul, Math.min(maxMul, m)) * 1000) / 1000;
    // v1.1: never amplify a mutation type with non-positive paper expectancy (ranking still picks "least bad" among negatives).
    if (Number.isFinite(e.expectancy) && e.expectancy <= 0) {
      mRounded = Math.min(mRounded, 1);
      mRounded = Math.round(mRounded * 1000) / 1000;
    }
    if (
      Number.isFinite(e.expectancy) &&
      e.expectancy > 0 &&
      Number.isFinite(Number(e.n)) &&
      e.n >= minTradesConfidence
    ) {
      mRounded = Math.max(mRounded, 1.05);
      mRounded = Math.round(mRounded * 1000) / 1000;
    }
    mRounded = Math.max(minMul, Math.min(maxMul, mRounded));
    multipliers[mt] = mRounded;
  }

  let paperLossPatternsStats = { applied: false };
  if (String(process.env.NEUROPILOT_PAPER_LOSS_PATTERNS || '').trim() === '1') {
    try {
      const { computePaperLossPatterns } = require('./paperLossPatterns');
      const res = computePaperLossPatterns({ dataRoot: root });
      if (res && Number.isFinite(Number(res.globalPenalty))) {
        const gp = Number(res.globalPenalty);
        for (const mt of KNOWN_MUTATION_TYPES) {
          if (!Object.prototype.hasOwnProperty.call(multipliers, mt)) continue;
          let x = multipliers[mt] * gp;
          x = Math.round(x * 1000) / 1000;
          multipliers[mt] = Math.max(minMul, Math.min(1, x));
        }
        paperLossPatternsStats = {
          applied: true,
          penaltiesByContext: { ...res.penaltiesByContext },
          globalPenalty: res.globalPenalty,
          meta: res.meta ? { ...res.meta } : {},
        };
      }
    } catch {
      /* fail-soft */
    }
  }

  const mappedN = Number.isFinite(Number(mappedTrades)) ? Number(mappedTrades) : 0;
  return {
    skipped: false,
    reason: null,
    multipliers,
    stats: attachMappingStats(
      {
        entries,
        agg,
        mappedTrades: mappedN,
        paperLossPatterns: paperLossPatternsStats,
        minTradesConfidence,
      },
      ms
    ),
    tradeCount: trades.length,
    generatedAt: new Date().toISOString(),
    minTotal,
    minPerType,
    minMul,
    maxMul,
  };
}

/**
 * Canonical JSON for discovery/mutation_paper_learning.json (apply or skip).
 * stats.mappedTrades is canonical; extended mapping counters live alongside when present.
 */
function buildMutationPaperLearningArtifactDoc(result) {
  const generatedAt = new Date().toISOString();
  if (!result || typeof result !== 'object') {
    return {
      generatedAt,
      applied: false,
      skipped: true,
      reason: 'empty_result',
      tradeCount: 0,
      minTotal: null,
      minPerType: null,
      minMul: null,
      maxMul: null,
      multipliers: emptyMultipliersObject(),
      stats: attachMappingStats({ mappedTrades: 0 }, emptyMappingStats()),
    };
  }

  const mappedTrades =
    result.stats && Number.isFinite(Number(result.stats.mappedTrades))
      ? Number(result.stats.mappedTrades)
      : 0;

  if (result.skipped) {
    const slice = result.stats && typeof result.stats === 'object' ? { ...result.stats } : {};
    slice.mappedTrades = mappedTrades;
    const doc = {
      generatedAt: result.generatedAt || generatedAt,
      applied: false,
      skipped: true,
      reason: result.reason,
      tradeCount:
        result.tradeCount != null && Number.isFinite(Number(result.tradeCount))
          ? Number(result.tradeCount)
          : 0,
      minTotal: result.minTotal,
      minPerType: result.minPerType,
      minMul: result.minMul,
      maxMul: result.maxMul,
      multipliers:
        result.multipliers && typeof result.multipliers === 'object'
          ? result.multipliers
          : emptyMultipliersObject(),
      stats: slice,
    };
    return doc;
  }

  return {
    generatedAt: result.generatedAt || generatedAt,
    applied: true,
    skipped: false,
    reason: null,
    tradeCount: result.tradeCount,
    minTotal: result.minTotal,
    minPerType: result.minPerType,
    minMul: result.minMul,
    maxMul: result.maxMul,
    multipliers:
      result.multipliers && typeof result.multipliers === 'object'
        ? result.multipliers
        : emptyMultipliersObject(),
    stats: result.stats,
  };
}

/** Apply paper-derived multipliers to adaptive profile knobs only (no mutate* changes). */
function applyPaperMutationProfileAdjust(profile, adjust) {
  if (!profile || typeof profile !== 'object') return profile;
  if (
    !adjust ||
    adjust.skipped ||
    !adjust.multipliers ||
    typeof adjust.multipliers !== 'object'
  ) {
    return profile;
  }
  const m = adjust.multipliers;
  const clampW = (w) => Math.max(1, Math.min(4, Math.round(Number(w))));
  const clampJ = (j) => Math.max(0.6, Math.min(2.8, Number(j)));

  return {
    ...profile,
    jitterScale: clampJ(profile.jitterScale * (m.parameter_jitter ?? 1)),
    sessionFlipWeight: clampW(profile.sessionFlipWeight * (m.session_flip ?? 1)),
    regimeFlipWeight: clampW(profile.regimeFlipWeight * (m.regime_flip ?? 1)),
    forcedFamilyShiftWeight: clampW(
      profile.forcedFamilyShiftWeight * (m.forced_family_shift ?? 1)
    ),
  };
}

module.exports = {
  computePaperMutationLearning,
  applyPaperMutationProfileAdjust,
  buildMutationPaperLearningArtifactDoc,
  KNOWN_MUTATION_TYPES,
  normalizeStrategyIdentityKey,
  buildGeneratedStrategyAliasIndex,
  resolvePaperTradeToGeneratedStrategy,
};
