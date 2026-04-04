#!/usr/bin/env node
'use strict';

/**
 * Family Expansion Engine
 *
 * Goal:
 * - Start from clustered top setups / family leaders
 * - Expand into NEW families, not just tiny variants of the same family
 * - Write setup_familyexp_*.js files into generated_strategies/
 *
 * Inputs:
 * - discovery/meta_ranking.json
 * - discovery/strategy_families.json (preferred if present)
 *
 * Output:
 * - generated_strategies/setup_familyexp_000.js ...
 *
 * Strategy:
 * 1) Load family-clustered top setups
 * 2) Keep family leaders
 * 3) Generate family-level mutations:
 *    - session_phase flips
 *    - regime flips
 *    - body/close/volume bucket jumps
 *    - aggressiveness profiles
 * 4) Reject candidates that collapse back into same familyKey
 * 5) Write only novel family expansions
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataRoot = require('../dataRoot');
const { applyNextGenSignalRulePatches, numericSeed } = require('./nextGenSignalRulePatches');
const { isValidResult } = require('../contracts/researchResultContract');
const { clusterStrategyFamilies } = require('../clustering/clusterStrategyFamilies');

/** Global mutation performance stats (total, beats). Loaded from discovery/mutation_perf.json; updated after meta run. */
const MUTATION_PERF = {};

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    maxFamilies: 12,
    forceNewFamilies: false,
    mode: process.env.FAMILY_EXPANSION_MODE || 'normal',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (/^\d+$/.test(a)) {
      args.maxFamilies = Number(a);
      continue;
    }

    if (a === '--forceNewFamilies') {
      args.forceNewFamilies = true;
      continue;
    }

    if (a === '--mode' && argv[i + 1]) {
      args.mode = String(argv[i + 1]).trim().toLowerCase();
      i += 1;
      continue;
    }
  }

  if (!['normal', 'aggressive'].includes(args.mode)) {
    args.mode = 'normal';
  }

  return args;
}

function updateMutationPerformance(children) {
  for (const c of children) {
    const t = (c.mutationType && String(c.mutationType).trim()) || null;
    if (!t) continue; // ne jamais compter "unknown"

    if (!MUTATION_PERF[t]) {
      MUTATION_PERF[t] = {
        total: 0,
        beats: 0,
      };
    }

    MUTATION_PERF[t].total += 1;

    if (c.beats_parent === true) {
      MUTATION_PERF[t].beats += 1;
    }
  }
}

/** Canonical list for adaptive selection; order does not affect probabilities. */
const ALL_MUTATION_TYPES = [
  'forced_family_shift',
  'regime_flip',
  'hybrid_family_shift',
  'session_flip',
  'parameter_jitter',
];

/** Default shares when mutation_perf has no or insufficient data (exploit observed hierarchy). */
const DEFAULT_MUTATION_SHARES = {
  forced_family_shift: 0.35,
  regime_flip: 0.30,
  hybrid_family_shift: 0.20,
  session_flip: 0.10,
  parameter_jitter: 0.05,
};

/**
 * Default evolution budget allocation (target % per mutation type when generating children).
 * Used when discovery/evolution_budget.json is absent and no opts.evolutionBudget / EVOLUTION_BUDGET.
 * 0% = type never chosen.
 */
const EVOLUTION_BUDGET_DEFAULT = {
  parameter_jitter: 0.70,
  forced_family_shift: 0.20,
  session_flip: 0.07,
  regime_flip: 0.03,
  hybrid_family_shift: 0,
};

const ADAPTIVE_MIN_TRADES = 20;
const ADAPTIVE_FLOOR_SHARE = 0.05;

/**
 * Build probability distribution over mutation types from MUTATION_PERF (mutation_perf.json).
 * Types with higher beats_rate get higher share; floor 5% so no type is eliminated.
 */
function getAdaptiveMutationShares() {
  const weights = {};

  for (const type of ALL_MUTATION_TYPES) {
    const stats = MUTATION_PERF[type];
    const defaultShare = DEFAULT_MUTATION_SHARES[type] != null
      ? DEFAULT_MUTATION_SHARES[type]
      : 1 / ALL_MUTATION_TYPES.length;

    if (stats && stats.total >= ADAPTIVE_MIN_TRADES && stats.total > 0) {
      const beatsRate = stats.beats / stats.total;
      weights[type] = Math.max(ADAPTIVE_FLOOR_SHARE, beatsRate);
    } else {
      weights[type] = Math.max(ADAPTIVE_FLOOR_SHARE, defaultShare);
    }
  }

  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (!sum || !Number.isFinite(sum)) {
    return { ...DEFAULT_MUTATION_SHARES };
  }

  const shares = {};
  for (const type of ALL_MUTATION_TYPES) {
    shares[type] = weights[type] / sum;
  }
  return shares;
}

/**
 * Load evolution budget (target % per mutation type). Precedence: opts.evolutionBudget > discovery/evolution_budget.json > EVOLUTION_BUDGET env (JSON) > EVOLUTION_BUDGET_DEFAULT. Returns null to use adaptive (pickMutation) only.
 */
function loadEvolutionBudget(opts = {}) {
  if (opts.evolutionBudget && typeof opts.evolutionBudget === 'object') {
    return normalizeBudgetObject(opts.evolutionBudget);
  }
  const discoveryDir = dataRoot.getPath('discovery', false);
  const budgetPath = path.join(discoveryDir, 'evolution_budget.json');
  try {
    if (fs.existsSync(budgetPath)) {
      const raw = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
      if (raw && typeof raw === 'object') return normalizeBudgetObject(raw);
    }
  } catch {
    // ignore; fall back to env or default
  }
  const envBudget = process.env.EVOLUTION_BUDGET;
  if (typeof envBudget === 'string' && envBudget.trim()) {
    try {
      const raw = JSON.parse(envBudget);
      if (raw && typeof raw === 'object') return normalizeBudgetObject(raw);
    } catch {
      // invalid JSON; use default
    }
  }
  return normalizeBudgetObject(EVOLUTION_BUDGET_DEFAULT);
}

/** Normalize budget: only ALL_MUTATION_TYPES, values in [0,1], sum = 1. Types with 0 are kept as 0. */
function normalizeBudgetObject(budget) {
  const out = {};
  let sum = 0;
  for (const type of ALL_MUTATION_TYPES) {
    const v = budget[type];
    const p = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    out[type] = p;
    sum += p;
  }
  if (sum <= 0) return null;
  for (const type of ALL_MUTATION_TYPES) {
    out[type] = out[type] / sum;
  }
  return out;
}

/**
 * Build a pre-allocated list of mutation types of length totalSlots from budget (shares per type). Shuffled so order is not deterministic by type. Types with 0 share get 0 slots.
 */
function buildBudgetAllocation(budget, totalSlots) {
  if (!budget || totalSlots <= 0) return [];
  const slots = [];
  const types = ALL_MUTATION_TYPES.filter((t) => (budget[t] || 0) > 0);
  if (!types.length) return [];

  const counts = {};
  let allocated = 0;
  for (const type of types) {
    const n = Math.max(0, Math.round(budget[type] * totalSlots));
    counts[type] = n;
    allocated += n;
    for (let i = 0; i < n; i += 1) slots.push(type);
  }
  // Rounding may leave us short or over; adjust largest type
  while (slots.length < totalSlots) {
    const byShare = [...types].sort((a, b) => (budget[b] || 0) - (budget[a] || 0));
    const t = byShare[0];
    slots.push(t);
  }
  while (slots.length > totalSlots) {
    const byShare = [...types].sort((a, b) => (budget[b] || 0) - (budget[a] || 0));
    const t = byShare[0];
    const idx = slots.lastIndexOf(t);
    if (idx >= 0) slots.splice(idx, 1);
    else break;
  }

  // Fisher–Yates shuffle (in-place)
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots;
}

function mutationWeight(type) {
  const stats = MUTATION_PERF[type];
  if (!stats || stats.total < 30) return 1;
  const beatsRate = stats.total > 0 ? stats.beats / stats.total : 0;
  return 1 + beatsRate * 3;
}

/**
 * Pool of mutation types for pickMutation(), driven by getAdaptiveMutationShares()
 * so that types that beat parents more often are drawn more often.
 */
function weightedMutationTypes() {
  const shares = getAdaptiveMutationShares();
  const poolSize = 100;
  const base = [];

  for (const type of ALL_MUTATION_TYPES) {
    const p = shares[type];
    const count = Math.max(0, Math.round(p * poolSize));
    for (let i = 0; i < count; i += 1) base.push(type);
  }

  return base.length ? base : ['parameter_jitter'];
}

function pickMutation() {
  loadMutationPerf();

  const baseTypes = [
    'parameter_jitter',
    'forced_family_shift',
    'regime_flip',
    'session_flip',
    'hybrid_family_shift',
  ];

  const weighted = [];

  for (const type of baseTypes) {
    const stats = MUTATION_PERF[type] || null;
    const total = Number(stats && stats.total) || 0;
    const beats = Number(stats && stats.beats) || 0;
    const beatsRate = total > 0 ? beats / total : 0;

    // exploration floor: chaque type garde au moins un petit poids
    let weight = 2;

    // si on a assez d'historique, on laisse les gagnants dominer (mutationWeight = beatsRate)
    if (total >= 20) {
      weight = Math.max(1, Math.round(2 + beatsRate * 18));
    }

    // local-first: on garde toujours un léger biais vers parameter_jitter
    if (type === 'parameter_jitter') {
      weight += 2;
    }

    // Adaptive type multiplier: favor parameter_jitter + forced_family_shift, reduce hybrid
    let typeMultiplier = 1.0;
    if (type === 'parameter_jitter' || type === 'forced_family_shift') typeMultiplier = 1.3;
    else if (type === 'hybrid_family_shift') typeMultiplier = 0.5;
    weight = Math.max(1, Math.round(weight * typeMultiplier));

    for (let i = 0; i < weight; i += 1) {
      weighted.push(type);
    }
  }

  if (!weighted.length) return 'parameter_jitter';

  const idx = Math.floor(Math.random() * weighted.length);
  return weighted[idx] || 'parameter_jitter';
}

function cycleSeed() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}`;
}

function stableJitter(seed, min, max, decimals = 2) {
  const h = crypto.createHash('sha1').update(String(seed)).digest('hex');
  const n = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  const v = min + (max - min) * n;
  const p = Math.pow(10, decimals);
  return Math.round(v * p) / p;
}

function applyAggressiveVariation(baseRules, context = {}) {
  const seed = [
    context.parentSetupId || '',
    context.parentFamilyId || '',
    context.mutationType || '',
    context.mode || 'aggressive',
    context.seed || cycleSeed(),
  ].join('|');

  const bodyDelta = stableJitter(seed + '|body', -0.18, 0.18, 2);
  const closeDelta = stableJitter(seed + '|close', -0.15, 0.15, 2);
  const volumeDelta = stableJitter(seed + '|volume', -0.5, 0.7, 2);

  const sessionOptions = ['open', 'mid', 'close'];
  const regimeOptions = ['breakout', 'reversal', 'trend', 'range', 'open_bias', 'mid_bias', 'close_bias'];

  const sessionPick = sessionOptions[Math.floor(stableJitter(seed + '|sp', 0, 2.99, 2))];
  const regimePick = regimeOptions[Math.floor(stableJitter(seed + '|rg', 0, 6.99, 2))];

  const out = {
    ...baseRules,
    body_pct_min: clamp(round2(baseRules.body_pct_min + bodyDelta), 0.1, 0.95),
    close_strength_min: clamp(round2(baseRules.close_strength_min + closeDelta), 0.1, 0.95),
    volume_ratio: clamp(round2(baseRules.volume_ratio + volumeDelta), 0.2, 5.0),
  };

  if (stableJitter(seed + '|flip_sp', 0, 1, 2) > 0.55) {
    out.session_phase = sessionPick;
  }

  if (stableJitter(seed + '|flip_rg', 0, 1, 2) > 0.45) {
    out.regime = regimePick;
  }

  return normalizeRules(out);
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slug(v) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function shortHash(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 8);
}

function num(v, fallback = null) {
  return Number.isFinite(v) ? v : fallback;
}

function uniqBy(arr, getKey) {
  const seen = new Set();
  const out = [];
  for (const item of arr || []) {
    const k = getKey(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function pickRandomDifferent(arr, currentValue) {
  const values = (arr || []).filter((x) => x !== currentValue);
  if (!values.length) return currentValue;
  return values[Math.floor(Math.random() * values.length)];
}

function parseSetupId(setupId) {
  const s = String(setupId || '');
  const m = s.match(/^pattern_(\d+)_([a-z0-9]+)_([a-f0-9]+)$/i);
  if (!m) {
    return {
      raw: s,
      patternIndex: null,
      sessionPhaseFromId: null,
      idHash: null,
    };
  }
  return {
    raw: s,
    patternIndex: Number(m[1]),
    sessionPhaseFromId: slug(m[2]),
    idHash: slug(m[3]),
  };
}

/**
 * Try to reconstruct minimal rules from setupId + family stats + metrics.
 * This is heuristic by design.
 */
function inferRulesFromStrategy(strategy) {
  const setupId = String(strategy.setupId || '');
  const parsed = parseSetupId(setupId);

  const session_phase =
    slug(strategy.session_phase) ||
    slug(strategy.sessionPhase) ||
    parsed.sessionPhaseFromId ||
    (setupId.includes('_open_') ? 'open' :
      setupId.includes('_mid_') ? 'mid' :
      setupId.includes('_close_') ? 'close' :
      'open');

  let regime = 'breakout';
  const sid = setupId.toLowerCase();
  if (sid.includes('reversal')) regime = 'reversal';
  else if (sid.includes('trend')) regime = 'trend';
  else if (sid.includes('range')) regime = 'range';
  else if (sid.includes('close')) regime = 'close_bias';
  else if (sid.includes('open')) regime = 'open_bias';
  else if (sid.includes('mid')) regime = 'mid_bias';

  // Coarse defaults from expectancy/trades profile
  const trades = num(strategy.trades, 0);
  const expectancy = num(strategy.expectancy, 0);

  let body_pct_min = 0.5;
  let close_strength_min = 0.7;
  let volume_ratio = 1.2;

  if (trades >= 1500) {
    body_pct_min = 0.4;
    close_strength_min = 0.6;
    volume_ratio = 1.0;
  } else if (trades >= 700) {
    body_pct_min = 0.5;
    close_strength_min = 0.7;
    volume_ratio = 1.2;
  } else {
    body_pct_min = 0.6;
    close_strength_min = 0.8;
    volume_ratio = 1.5;
  }

  if (expectancy >= 0.001) {
    body_pct_min += 0.05;
    close_strength_min += 0.05;
  }

  return {
    session_phase,
    regime,
    body_pct_min: round2(body_pct_min),
    close_strength_min: round2(close_strength_min),
    volume_ratio: round2(volume_ratio),
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function jitter(value, pct = 0.1) {
  if (!Number.isFinite(value)) return value;
  const delta = value * pct * (Math.random() * 2 - 1);
  return value + delta;
}

function jitterRules(parentRules) {
  if (!parentRules || typeof parentRules !== 'object') return null;

  const r = { ...parentRules };

  if (Number.isFinite(r.body_pct_min)) {
    r.body_pct_min = clamp(jitter(r.body_pct_min, 0.15), 0.05, 1);
  }
  if (Number.isFinite(r.close_strength_min)) {
    r.close_strength_min = clamp(jitter(r.close_strength_min, 0.15), 0.05, 1);
  }
  if (Number.isFinite(r.volume_ratio)) {
    r.volume_ratio = clamp(jitter(r.volume_ratio, 0.25), 0.5, 5);
  }
  if (Number.isFinite(r.range_expansion)) {
    r.range_expansion = clamp(jitter(r.range_expansion, 0.2), 0.1, 5);
  }

  return r;
}

function withResolvedRules(parent, fallbackRules) {
  return {
    ...(parent || {}),
    rules: normalizeRules(
      (parent && parent.rules) || fallbackRules || {}
    ),
  };
}

function createParameterJitterChild(parent) {
  const parentRules = parent && parent.rules;
  if (!parentRules || typeof parentRules !== 'object') return null;

  const newRules = normalizeRules(jitterRules(parentRules));

  const rand = Math.random().toString(16).slice(2, 8);
  const generation = num(parent.generation, 0) + 1;

  return {
    setupId: `familyexp_${parent.setupId}_paramjit_${rand}`,
    name: `familyexp_${parent.setupId}_parameter_jitter`,
    rules: newRules,
    parentSetupId: parent.setupId || null,
    parentFamilyId: parent.parentFamilyId || parent.familyId || parent.setupId || null,
    mutationType: 'parameter_jitter',
    generation,
    source: 'familyexp',
  };
}

const SESSION_PHASES = ['open', 'mid', 'close'];
const REGIMES = ['breakout', 'reversal', 'trend', 'range', 'open_bias', 'mid_bias', 'close_bias'];
const REGIMES_HYBRID = ['breakout', 'reversal', 'trend', 'range'];

function createRegimeFlipChild(parent) {
  const parentRules = parent && parent.rules;
  if (!parentRules || typeof parentRules !== 'object') return null;

  const current = String(parentRules.regime || 'trend');
  const next = pickRandomDifferent(REGIMES, current);

  const rand = Math.random().toString(16).slice(2, 8);
  const generation = num(parent.generation, 0) + 1;

  return {
    setupId: `familyexp_${parent.setupId}_regflip_${rand}`,
    name: `familyexp_${parent.setupId}_regime_flip`,
    rules: normalizeRules({
      ...parentRules,
      regime: next,
    }),
    parentSetupId: parent.setupId || null,
    parentFamilyId: parent.parentFamilyId || parent.familyId || parent.setupId || null,
    mutationType: 'regime_flip',
    generation,
    source: 'familyexp',
  };
}

function createSessionFlipChild(parent) {
  const parentRules = parent && parent.rules;
  if (!parentRules || typeof parentRules !== 'object') return null;

  const current = String(parentRules.session_phase || 'mid');
  const next = pickRandomDifferent(SESSION_PHASES, current);

  const rand = Math.random().toString(16).slice(2, 8);
  const generation = num(parent.generation, 0) + 1;

  return {
    setupId: `familyexp_${parent.setupId}_sessflip_${rand}`,
    name: `familyexp_${parent.setupId}_session_flip`,
    rules: normalizeRules({
      ...parentRules,
      session_phase: next,
    }),
    parentSetupId: parent.setupId || null,
    parentFamilyId: parent.parentFamilyId || parent.familyId || parent.setupId || null,
    mutationType: 'session_flip',
    generation,
    source: 'familyexp',
  };
}

function createHybridFamilyChild(parent) {
  const parentRules = parent && parent.rules;
  if (!parentRules || typeof parentRules !== 'object') return null;

  const currentSession = String(parentRules.session_phase || 'mid');
  const currentRegime = String(parentRules.regime || 'trend');

  const nextSession = pickRandomDifferent(SESSION_PHASES, currentSession);
  const nextRegime = pickRandomDifferent(REGIMES, currentRegime);

  const rand = Math.random().toString(16).slice(2, 8);
  const generation = num(parent.generation, 0) + 1;

  return {
    setupId: `familyexp_${parent.setupId}_hybrid_${rand}`,
    name: `familyexp_${parent.setupId}_hybrid_family_shift`,
    rules: normalizeRules({
      ...parentRules,
      session_phase: nextSession,
      regime: nextRegime,
    }),
    parentSetupId: parent.setupId || null,
    parentFamilyId: parent.parentFamilyId || parent.familyId || parent.setupId || null,
    mutationType: 'hybrid_family_shift',
    generation,
    source: 'familyexp',
  };
}

function createForcedFamilyChild(parent) {
  const parentRules = parent && parent.rules;
  if (!parentRules || typeof parentRules !== 'object') return null;

  const varied = normalizeRules(applyAggressiveVariation(parentRules, {
    seed: Math.random().toString(16).slice(2, 12),
  }));

  const rand = Math.random().toString(16).slice(2, 8);
  const generation = num(parent.generation, 0) + 1;

  return {
    setupId: `familyexp_${parent.setupId}_forced_${rand}`,
    name: `familyexp_${parent.setupId}_forced_family_shift`,
    rules: varied,
    parentSetupId: parent.setupId || null,
    parentFamilyId: parent.parentFamilyId || parent.familyId || parent.setupId || null,
    mutationType: 'forced_family_shift',
    generation,
    source: 'familyexp',
  };
}

function normalizeRules(rules) {
  const raw = rules && typeof rules === 'object' ? rules : {};
  const seed = numericSeed(JSON.stringify(raw));
  const patched = applyNextGenSignalRulePatches(raw, seed);
  return {
    session_phase: slug(patched.session_phase || 'open'),
    regime: slug(patched.regime || 'breakout'),
    body_pct_min: round2(clamp(num(patched.body_pct_min, 0.5), 0.1, 0.95)),
    close_strength_min: round2(clamp(num(patched.close_strength_min, 0.7), 0.1, 0.95)),
    volume_ratio: round2(clamp(num(patched.volume_ratio, 1.2), 0.2, 5.0)),
    rMultiple: round2(clamp(num(patched.rMultiple, 1.35), 1.05, 2.5)),
  };
}

function buildRuleKey(rules) {
  return JSON.stringify(normalizeRules(rules || {}));
}

function rulesToFamilySignature(rules) {
  const r = normalizeRules(rules);

  const tradeBucket = 'familyexp';
  const expectancyBucket = 'familyexp';

  const familyKey = [
    slug(r.regime),
    slug(r.session_phase),
    bucketPatternStyle(r),
    tradeBucket,
    expectancyBucket,
    bucketVolume(r.volume_ratio),
    bucketStrength(r.close_strength_min),
  ].join('|');

  return familyKey;
}

function bucketPatternStyle(rules) {
  const b = num(rules.body_pct_min, 0.5);
  if (b >= 0.75) return 'body_ultra';
  if (b >= 0.6) return 'body_high';
  if (b >= 0.45) return 'body_mid';
  return 'body_low';
}

function bucketVolume(v) {
  if (v >= 1.8) return 'vol_high';
  if (v >= 1.3) return 'vol_mid';
  return 'vol_low';
}

function bucketStrength(v) {
  if (v >= 0.85) return 'cs_high';
  if (v >= 0.7) return 'cs_mid';
  return 'cs_low';
}

function computeCanonicalName(baseName, rules) {
  const r = normalizeRules(rules);
  return slug([
    baseName || 'familyexp',
    r.regime,
    r.session_phase,
    `b${String(r.body_pct_min).replace('.', '')}`,
    `c${String(r.close_strength_min).replace('.', '')}`,
    `v${String(r.volume_ratio).replace('.', '')}`,
  ].join('_'));
}

function makeSetupModuleContent(name, rules, meta = {}) {
  return `'use strict';

module.exports = {
  name: ${JSON.stringify(name)},
  familyExpansion: true,
  parentSetupId: ${JSON.stringify(meta.parentSetupId || null)},
  parentFamilyId: ${JSON.stringify(meta.parentFamilyId || null)},
  mutationType: ${JSON.stringify(meta.mutationType || null)},
  rules: ${JSON.stringify(rules, null, 2)}
};
`;
}

function generateFamilyExpansions(baseStrategy, opts = {}) {
  const baseRules = normalizeRules(
    (baseStrategy && baseStrategy.rules) || inferRulesFromStrategy(baseStrategy)
  );

  if (!baseRules || typeof baseRules !== 'object' || !Object.keys(baseRules).length) {
    return [];
  }

  const resolvedParent = withResolvedRules(baseStrategy, baseRules);

  const mode = opts.mode || 'normal';
  const forceNewFamilies = !!opts.forceNewFamilies;
  const seed = opts.seed || cycleSeed();

  const variants = [];
  const desiredChildren = 12;

  const evolutionBudget = opts.useAdaptiveMutationOnly ? null : loadEvolutionBudget(opts);
  const allocation =
    evolutionBudget && Object.values(evolutionBudget).some((p) => p > 0)
      ? buildBudgetAllocation(evolutionBudget, desiredChildren)
      : null;

  for (let i = 0; i < desiredChildren; i += 1) {
    const picked = allocation && allocation[i] != null ? allocation[i] : pickMutation();
    let child = null;

    if (picked === 'parameter_jitter') {
      child = createParameterJitterChild(resolvedParent);
    } else if (picked === 'forced_family_shift') {
      child = createForcedFamilyChild(resolvedParent);
    } else if (picked === 'regime_flip') {
      child = createRegimeFlipChild(resolvedParent);
    } else if (picked === 'session_flip') {
      child = createSessionFlipChild(resolvedParent);
    } else if (picked === 'hybrid_family_shift') {
      child = createHybridFamilyChild(resolvedParent);
    } else {
      child = createParameterJitterChild(resolvedParent);
    }

    if (child && child.rules) {
      variants.push({
        mutationType: child.mutationType,
        rules: normalizeRules(child.rules),
      });
    }
  }

  const filteredVariants = variants.filter((v) => {
    if (!v || !v.rules) return false;

    // On réduit encore les hybrides trop agressifs / trop cassants
    if (v.mutationType === 'hybrid_family_shift') {
      const body = num(v.rules.body_pct_min, 0);
      const close = num(v.rules.close_strength_min, 0);
      if (body < 0.2 || close < 0.2) return false;
    }

    return true;
  });

  const seenRuleKeys = new Set();
  const seenFamilyKeys = new Set();
  const accepted = [];

  for (const variant of uniqBy(filteredVariants, (v) => JSON.stringify(v.rules))) {
    const rules = normalizeRules(variant.rules || {});
    const familyKey = rulesToFamilySignature(rules);
    const ruleKey = buildRuleKey(rules);
    const mutationType = String(variant.mutationType || 'unknown');

    // Pour parameter_jitter: on autorise plusieurs variantes locales tant que les rules sont vraiment différentes
    if (mutationType === 'parameter_jitter') {
      if (seenRuleKeys.has(ruleKey)) continue;
      seenRuleKeys.add(ruleKey);
      accepted.push({
        ...variant,
        familyKey,
        ruleKey,
      });
      continue;
    }

    // Pour les mutations structurelles: garde le filtre par famille
    if (seenFamilyKeys.has(familyKey)) continue;
    seenFamilyKeys.add(familyKey);

    if (seenRuleKeys.has(ruleKey)) continue;
    seenRuleKeys.add(ruleKey);

    accepted.push({
      ...variant,
      familyKey,
      ruleKey,
    });
  }

  const parameterJitterAccepted = accepted.filter(
    (v) => String(v.mutationType || '') === 'parameter_jitter'
  );
  const structuralAccepted = accepted.filter(
    (v) => String(v.mutationType || '') !== 'parameter_jitter'
  );

  const finalAccepted = [
    ...parameterJitterAccepted.slice(0, 6),
    ...structuralAccepted.slice(0, 6),
  ];

  if (opts.debugExpansion) {
    const mutationMix = finalAccepted.reduce((acc, v) => {
      const t = String(v.mutationType || 'unknown');
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});
    console.log('[familyExpansion][debug]', {
      setupId: resolvedParent.setupId,
      evolutionBudget: evolutionBudget || 'adaptive',
      adaptiveShares: getAdaptiveMutationShares(),
      hasBaseRules: !!baseRules,
      baseRules,
      variantsGenerated: variants.length,
      filteredVariants: filteredVariants.length,
      accepted: accepted.length,
      finalAccepted: finalAccepted.length,
      mutationMix,
    });
  }

  return finalAccepted;
}

function loadInputUniverse() {
  const discoveryDir = dataRoot.getPath('discovery');
  const famPath = path.join(discoveryDir, 'strategy_families.json');
  const metaPath = path.join(discoveryDir, 'meta_ranking.json');

  const fam = safeReadJson(famPath);
  if (fam && Array.isArray(fam.strategies) && fam.strategies.length) {
    return {
      source: 'strategy_families',
      sourcePath: famPath,
      clustered: fam,
    };
  }

  const meta = safeReadJson(metaPath);
  if (meta && Array.isArray(meta.strategies) && meta.strategies.length) {
    return {
      source: 'meta_ranking',
      sourcePath: metaPath,
      clustered: clusterStrategyFamilies(meta),
    };
  }

  throw new Error('No strategy_families.json or meta_ranking.json found with strategies.');
}

const EVOLUTION_CYCLE_FILENAME = 'evolution_cycle.json';

/**
 * Read, increment and persist evolution cycle. Used for periodic exploration reset
 * (inject more base patterns every X cycles so evolution doesn't converge too early).
 */
function getAndIncrementEvolutionCycle(opts = {}) {
  const discoveryDir = dataRoot.getPath('discovery', false);
  if (!discoveryDir) return 0;
  ensureDir(discoveryDir);
  const cyclePath = path.join(discoveryDir, EVOLUTION_CYCLE_FILENAME);
  const existing = safeReadJson(cyclePath);
  const cycle = Math.max(0, num(existing && existing.cycle, 0)) + 1;
  try {
    fs.writeFileSync(
      cyclePath,
      JSON.stringify({ cycle, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    // ignore write errors
  }
  return cycle;
}

function loadPromotedChildren() {
  const discoveryDir = dataRoot.getPath('discovery');
  const promotedPath = path.join(discoveryDir, 'promoted_children.json');
  const promoted = safeReadJson(promotedPath);

  if (!promoted || !Array.isArray(promoted.strategies) || !promoted.strategies.length) {
    return [];
  }

  return promoted.strategies
    .filter((s) => s && s.setupId && s.rules)
    .map((s) => ({
      ...s,
      familyLeader: true,
      promotedLeader: true,
      meta_score: Number.isFinite(Number(s.parent_vs_child_score))
        ? Number(s.parent_vs_child_score)
        : Number(s.expectancy || 0),
      familyKey: rulesToFamilySignature(s.rules),
    }));
}

function selectFamilyLeaders(clustered, opts = {}) {
  const maxFamilies = Number.isFinite(opts.maxFamilies) ? opts.maxFamilies : 12;
  let promotedLimit = Math.max(0, Number(opts.promotedLeaderLimit || 4));

  // Exploration reset: every X cycles inject more base patterns so evolution doesn't converge too early
  const cycle = Math.max(0, Number(opts.explorationResetCycle || 0));
  const interval = Math.max(1, Number(opts.explorationResetInterval || 5));
  if (cycle > 0 && cycle % interval === 0) {
    promotedLimit = Math.min(promotedLimit, 2);
  }

  const promotedChildren = loadPromotedChildren()
    .slice()
    .sort((a, b) => {
      return (
        num(b.parent_vs_child_score, -Infinity) - num(a.parent_vs_child_score, -Infinity) ||
        num(b.expectancy, -Infinity) - num(a.expectancy, -Infinity) ||
        num(b.trades, -Infinity) - num(a.trades, -Infinity)
      );
    })
    .slice(0, promotedLimit);

  const baseLeaders = (clustered.strategies || []).filter((s) => s.familyLeader);

  const sortedBaseLeaders = baseLeaders
    .slice()
    .sort((a, b) => {
      const ma = num(a.meta_score, -Infinity);
      const mb = num(b.meta_score, -Infinity);
      if (mb !== ma) return mb - ma;
      const ea = num(a.expectancy, -Infinity);
      const eb = num(b.expectancy, -Infinity);
      return eb - ea;
    });

  const selected = [];
  const used = new Set();

  for (const s of promotedChildren) {
    const id = String(s.setupId || '');
    if (!id || used.has(id)) continue;
    selected.push(s);
    used.add(id);
    if (selected.length >= maxFamilies) return selected;
  }

  for (const s of sortedBaseLeaders) {
    const id = String(s.setupId || '');
    if (!id || used.has(id)) continue;
    selected.push(s);
    used.add(id);
    if (selected.length >= maxFamilies) break;
  }

  return selected;
}

function loadExistingGeneratedFamilyKeys(outDir) {
  if (!fs.existsSync(outDir)) return new Set();

  const files = fs.readdirSync(outDir).filter((f) => /^setup_.*\.js$/i.test(f));
  const keys = new Set();

  for (const file of files) {
    const full = path.join(outDir, file);
    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      if (mod && mod.rules) {
        keys.add(rulesToFamilySignature(mod.rules));
      }
    } catch {
      // ignore broken or unrelated generated files
    }
  }

  return keys;
}

function getNextFamilyExpIndex(outDir) {
  if (!fs.existsSync(outDir)) return 1;

  const nums = fs.readdirSync(outDir)
    .map((f) => {
      const m = /^setup_familyexp_(\d+)\.js$/i.exec(f);
      return m ? Number(m[1]) : null;
    })
    .filter((n) => Number.isFinite(n));

  if (!nums.length) return 1;
  return Math.max(...nums) + 1;
}

function loadMutationPolicy() {
  const discoveryDir = dataRoot.getPath('discovery');
  const policyPath = path.join(discoveryDir, 'mutation_policy.json');
  const raw = safeReadJson(policyPath);
  return raw && typeof raw === 'object' ? raw : null;
}

function loadSupervisorConfig() {
  const discoveryDir = dataRoot.getPath('discovery');
  const cfgPath = path.join(discoveryDir, 'supervisor_config.json');
  const raw = safeReadJson(cfgPath);
  return raw && typeof raw === 'object' ? raw : null;
}

function writeSupervisorConfigPatch(patch) {
  const discoveryDir = dataRoot.getPath('discovery');
  const cfgPath = path.join(discoveryDir, 'supervisor_config.json');
  const current = safeReadJson(cfgPath) || {};
  const next = { ...current, ...patch, generatedAt: current.generatedAt || new Date().toISOString() };
  fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2), 'utf8');
  return cfgPath;
}

const MUTATION_PERF_FILENAME = 'mutation_perf.json';

function loadMutationPerf() {
  const discoveryDir = dataRoot.getPath('discovery', false);
  const filePath = path.join(discoveryDir, 'mutation_perf.json');

  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const byMutationType = json && json.byMutationType ? json.byMutationType : json;

    for (const key of Object.keys(MUTATION_PERF)) {
      delete MUTATION_PERF[key];
    }

    for (const [k, v] of Object.entries(byMutationType || {})) {
      MUTATION_PERF[k] = {
        total: Number(v.total || 0),
        beats: Number(v.beats || 0),
      };
    }

    return MUTATION_PERF;
  } catch {
    return MUTATION_PERF;
  }
}

function saveMutationPerf() {
  const discoveryDir = dataRoot.getPath('discovery', false);
  const filePath = path.join(discoveryDir, 'mutation_perf.json');

  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'familyExpansionEngine_runtime',
        byMutationType: MUTATION_PERF,
      },
      null,
      2
    ),
    'utf8'
  );
}

/**
 * Alimenter MUTATION_PERF depuis tous les batch results valides (enfants avec mutationType + parentSetupId),
 * pas depuis le meta top 30. Applique un filtre min-trades avant de compter.
 *
 * @param {string} batchDir - répertoire des strategy_batch_results_*.json
 * @param {{ minTradesAbsolute?: number, minTradesRatio?: number }} opts
 */
function learnMutationPerfFromBatchResults(batchDir, opts = {}) {
  const minTradesAbsolute = Math.max(0, Number(opts.minTradesAbsolute) || 20);
  const minTradesRatio = Math.max(0, Math.min(1, Number(opts.minTradesRatio) || 0.25));

  if (!batchDir || !fs.existsSync(batchDir)) return;

  const files = fs.readdirSync(batchDir)
    .filter((f) => /^strategy_batch_results_.*\.json$/i.test(f))
    .map((f) => path.join(batchDir, f));

  const children = [];

  for (const file of files) {
    const json = safeReadJson(file);
    if (!json || !Array.isArray(json.results)) continue;

    const validBySetupId = new Map();
    for (const r of json.results) {
      if (!r || !r.setupId || !isValidResult(r)) continue;
      validBySetupId.set(String(r.setupId), r);
    }

    for (const r of json.results) {
      if (!r || !r.setupId || !isValidResult(r)) continue;
      const parentId = (r.parentSetupId && String(r.parentSetupId).trim()) || null;
      const mutationType = (r.mutationType && String(r.mutationType).trim()) || null;
      if (!parentId || !mutationType) continue;

      const parent = validBySetupId.get(parentId);
      if (!parent) continue;

      const childTrades = Math.max(0, Number(r.trades) || 0);
      const parentTrades = Math.max(0, Number(parent.trades) || 0);
      const minTrades = parentTrades > 0
        ? Math.max(minTradesAbsolute, Math.floor(parentTrades * minTradesRatio))
        : minTradesAbsolute;
      if (childTrades < minTrades) continue;

      const childExpectancy = Number(r.expectancy);
      const parentExpectancy = Number(parent.expectancy);
      const beats_parent = Number.isFinite(childExpectancy) && Number.isFinite(parentExpectancy)
        ? childExpectancy > parentExpectancy
        : false;

      children.push({
        mutationType,
        beats_parent,
        trades: childTrades,
        expectancy: childExpectancy,
      });
    }
  }

  if (children.length) {
    updateMutationPerformance(children);
    saveMutationPerf();
  }
}

function writeExpandedFamilies(leaders, opts = {}) {
  const outDir = opts.outDir || dataRoot.getPath('generated_strategies');
  ensureDir(outDir);

  const mutationPolicy = loadMutationPolicy();
  const getMutationWeight = (mutationType) => {
    if (!mutationPolicy || !mutationPolicy.byMutationType || typeof mutationPolicy.byMutationType !== 'object') {
      return 0.1;
    }
    const w = mutationPolicy.byMutationType[mutationType];
    return typeof w === 'number' && Number.isFinite(w) ? w : 0.1;
  };

  const existingFamilyKeys = loadExistingGeneratedFamilyKeys(outDir);
  const seenRuleKeys = new Set();
  const created = [];
  const byMutationType = {};
  const mode = opts.mode || 'normal';
  const mutationBudget = Math.max(0, Number(opts.mutationBudget || 0));
  const forceNewFamilies = !!opts.forceNewFamilies;
  const seed = opts.seed || cycleSeed();

  let nextIdx = getNextFamilyExpIndex(outDir);

  for (const leader of leaders) {
    const expansions = generateFamilyExpansions(leader, {
      ...opts,
      mode,
      forceNewFamilies,
      seed,
      debugExpansion: !!opts.debugExpansion,
    });

    const expansionsWithWeight = expansions.map((exp) => ({ exp, weight: getMutationWeight(exp.mutationType) }));
    expansionsWithWeight.sort((a, b) => b.weight - a.weight);

    for (const { exp } of expansionsWithWeight) {
      if (mutationBudget > 0 && created.length >= mutationBudget) break;
      const mutationType = String(exp.mutationType || 'unknown');
      const familyKey = exp.familyKey || rulesToFamilySignature(exp.rules);
      const ruleKey = exp.ruleKey || buildRuleKey(exp.rules);

      // 1) Ne jamais écrire deux fois exactement les mêmes règles dans le même run
      if (seenRuleKeys.has(ruleKey)) continue;

      // 2) Parameter jitter: on ignore les collisions coarse familyKey
      //    car sinon toute l'exploration locale est tuée
      let resolvedFamilyKey = familyKey;
      if (mutationType !== 'parameter_jitter') {
        if (!forceNewFamilies) {
          if (familyKey === leader.familyKey) continue;
          if (existingFamilyKeys.has(familyKey)) continue;
        } else {
          resolvedFamilyKey = `${familyKey}|forced|${shortHash([
            leader.setupId,
            exp.mutationType,
            JSON.stringify(exp.rules),
            seed,
            mode,
          ].join('|'))}`;
        }
      }

      seenRuleKeys.add(ruleKey);

      if (mutationType !== 'parameter_jitter') {
        existingFamilyKeys.add(resolvedFamilyKey);
      }

      const idx = String(nextIdx).padStart(3, '0');
      nextIdx += 1;
      const file = `setup_familyexp_${idx}.js`;
      const filePath = path.join(outDir, file);

      const setupId = exp.setupId || `familyexp_${leader.setupId}_${mutationType}_${Math.random().toString(16).slice(2, 8)}`;
      const setupName = exp.name || setupId;

      const payload = `'use strict';

module.exports = {
  setupId: ${JSON.stringify(setupId)},
  name: ${JSON.stringify(setupName)},
  source: 'familyexp',
  generation: ${Number(exp.generation || 1)},
  parentSetupId: ${JSON.stringify(exp.parentSetupId || leader.setupId || null)},
  parentFamilyId: ${JSON.stringify(exp.parentFamilyId || leader.parentFamilyId || leader.setupId || null)},
  mutationType: ${JSON.stringify(mutationType)},
  rules: ${JSON.stringify(normalizeRules(exp.rules || {}), null, 2)}
};
`;

      fs.writeFileSync(filePath, payload, 'utf8');

      created.push({
        file,
        filePath,
        name: setupName,
        setupId,
        familyKey: resolvedFamilyKey,
        parentSetupId: exp.parentSetupId || leader.setupId || null,
        parentFamilyId: exp.parentFamilyId || leader.parentFamilyId || leader.setupId || null,
        mutationType,
        rules: normalizeRules(exp.rules || {}),
        forced: !!exp.forced,
        mode: mode || null,
      });

      byMutationType[mutationType] = (byMutationType[mutationType] || 0) + 1;
    }
    if (mutationBudget > 0 && created.length >= mutationBudget) break;
  }

  return {
    created,
    byMutationType,
  };
}

async function runFamilyExpansion(opts = {}) {
  loadMutationPerf();

  const cycle = getAndIncrementEvolutionCycle(opts);
  const expansionOpts = {
    ...opts,
    explorationResetCycle: opts.explorationResetCycle != null ? opts.explorationResetCycle : cycle,
    explorationResetInterval: opts.explorationResetInterval != null ? opts.explorationResetInterval : 5,
  };

  const input = loadInputUniverse();
  const clustered = input.clustered;
  const supervisorConfig = loadSupervisorConfig();
  const budgetFromSupervisor =
    supervisorConfig && Number.isFinite(Number(supervisorConfig.mutationBudget))
      ? Number(supervisorConfig.mutationBudget)
      : null;
  const leaders = selectFamilyLeaders(clustered, expansionOpts);
  const originalFamiliesToExpand =
    supervisorConfig &&
    Array.isArray(supervisorConfig.familiesToExpand) &&
    supervisorConfig.familiesToExpand.length
      ? supervisorConfig.familiesToExpand.slice()
      : 'all';
  const familiesToExpand =
    supervisorConfig &&
    Array.isArray(supervisorConfig.familiesToExpand) &&
    supervisorConfig.familiesToExpand.length
      ? new Set(supervisorConfig.familiesToExpand.map((x) => String(x)))
      : null;
  const filteredLeaders = familiesToExpand
    ? leaders.filter((l) => l && familiesToExpand.has(String(l.familyKey || '')))
    : leaders;
  let effectiveLeaders = filteredLeaders;
  let fallbackApplied = false;
  let fallbackReason = null;

  // One-cycle continuity fallback:
  // if cycle is valid but family filter produced no leaders, run with all leaders this cycle only.
  if (
    supervisorConfig &&
    supervisorConfig.cycle_valid === true &&
    familiesToExpand &&
    filteredLeaders.length === 0 &&
    leaders.length > 0
  ) {
    effectiveLeaders = leaders;
    fallbackApplied = true;
    fallbackReason = 'no_leaders_after_family_filter';
  }

  const mode = opts.mode || 'normal';
  const forceNewFamilies = !!opts.forceNewFamilies;
  const seed = opts.seed || cycleSeed();

  const writeResult = writeExpandedFamilies(effectiveLeaders, {
    ...opts,
    mutationBudget:
      opts.mutationBudget != null ? Number(opts.mutationBudget) : budgetFromSupervisor,
    mode,
    forceNewFamilies,
    seed,
    debugExpansion: true,
  });
  const created = Array.isArray(writeResult) ? writeResult : (writeResult.created || []);
  const byMutationType = writeResult && writeResult.byMutationType ? writeResult.byMutationType : {};

  const out = {
    generatedAt: new Date().toISOString(),
    source: input.source,
    sourcePath: input.sourcePath,
    evolution_cycle: cycle,
    leaders_selected: effectiveLeaders.length,
    files_written: created.length,
    fallbackApplied,
    fallbackReason,
    originalFamiliesToExpand,
    effectiveFamiliesToExpand: fallbackApplied ? 'all' : originalFamiliesToExpand,
    mode,
    force_new_families: !!forceNewFamilies,
    seed,
    byMutationType,
    created,
  };

  const reportPath = path.join(
    dataRoot.getPath('discovery'),
    'family_expansion_report.json'
  );
  ensureDir(path.dirname(reportPath));
  fs.writeFileSync(reportPath, JSON.stringify(out, null, 2), 'utf8');

  if (supervisorConfig) {
    writeSupervisorConfigPatch({
      fallbackApplied,
      fallbackReason,
      originalFamiliesToExpand,
      effectiveFamiliesToExpand: fallbackApplied ? 'all' : originalFamiliesToExpand,
    });
  }

  return { out, reportPath };
}

async function main() {
  try {
    const args = parseArgs();
    const { out, reportPath } = await runFamilyExpansion({
      maxFamilies: args.maxFamilies,
      mode: args.mode,
      forceNewFamilies: args.forceNewFamilies,
    });

    console.log('Family Expansion Engine done.');
    console.log('  Source:', out.source);
    console.log('  Leaders selected:', out.leaders_selected);
    console.log('  Files written:', out.files_written);
    console.log('  Mode:', out.mode);
    console.log('  Force new families:', out.force_new_families);
    console.log('  Seed:', out.seed);
    console.log('  Report:', reportPath);
  } catch (err) {
    console.error('Family Expansion Engine failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MUTATION_PERF,
  ALL_MUTATION_TYPES,
  DEFAULT_MUTATION_SHARES,
  EVOLUTION_BUDGET_DEFAULT,
  getAdaptiveMutationShares,
  loadEvolutionBudget,
  buildBudgetAllocation,
  updateMutationPerformance,
  mutationWeight,
  weightedMutationTypes,
  pickMutation,
  loadMutationPerf,
  saveMutationPerf,
  learnMutationPerfFromBatchResults,
  inferRulesFromStrategy,
  createParameterJitterChild,
  createRegimeFlipChild,
  createSessionFlipChild,
  createHybridFamilyChild,
  createForcedFamilyChild,
  generateFamilyExpansions,
  loadInputUniverse,
  loadPromotedChildren,
  loadMutationPolicy,
  selectFamilyLeaders,
  runFamilyExpansion,
  buildRuleKey,
  rulesToFamilySignature,
};
