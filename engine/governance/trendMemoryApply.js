'use strict';

/**
 * P7.1 — Apply trend memory suggestions to P5/P6 (opt-in, bounded).
 *
 * Env:
 *   TREND_MEMORY_APPLY=true|false
 *   TREND_MEMORY_APPLY_MODE=conservative|full
 *   TREND_MEMORY_APPLY_MUTATIONS=true|false  (default false; in conservative, mutations off unless this is true)
 *
 * conservative: portfolioAdjustments only (exposure / maxNewAlloc / admission delta).
 * full: portfolio + mutationTypeWeightDeltas (still clamped).
 */

const fs = require('fs');
const path = require('path');

const MUTATION_TYPES = [
  'parameter_jitter',
  'forced_family_shift',
  'session_flip',
  'regime_flip',
  'hybrid_family_shift',
];

const MAX_WEIGHT_DELTA = 0.2;
const MAX_ALLOC_DELTA = 5;
const MAX_ADMISSION_DELTA = 0.2;
const MIN_ADMISSION_MULT = 1;
const MAX_ADMISSION_MULT = 2;
const MIN_EXPOSURE_MULT = 0.8;
const MAX_EXPOSURE_MULT = 1.05;

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round6(v) {
  return Math.round(safeNum(v, 0) * 1e6) / 1e6;
}

function isApplyEnabled() {
  return String(process.env.TREND_MEMORY_APPLY || '').toLowerCase() === 'true';
}

function applyMode() {
  return String(process.env.TREND_MEMORY_APPLY_MODE || 'conservative').toLowerCase();
}

function mutationsAllowed() {
  const mode = applyMode();
  if (mode === 'full') return true;
  return String(process.env.TREND_MEMORY_APPLY_MUTATIONS || '').toLowerCase() === 'true';
}

function loadRunTrendMemory(discoveryDir) {
  const p = path.join(discoveryDir, 'run_trend_memory.json');
  return safeReadJson(p);
}

/**
 * Adjust governor numeric decision after P6 scenario rules.
 * Skips when promotionMode === 'blocked' (no widening admission / allocations from trend).
 */
function applyTrendMemoryToGovernorDecision(decision, discoveryDir, maxAllocCap) {
  if (!isApplyEnabled()) {
    return {
      appliedFromTrendMemory: false,
      appliedDeltas: null,
      decisionPatch: null,
      reasons: [],
    };
  }

  const tm = loadRunTrendMemory(discoveryDir);
  const pa =
    tm &&
    tm.suggestions &&
    tm.suggestions.portfolioAdjustments &&
    typeof tm.suggestions.portfolioAdjustments === 'object'
      ? tm.suggestions.portfolioAdjustments
      : null;

  if (!pa) {
    return {
      appliedFromTrendMemory: false,
      appliedDeltas: { reason: 'missing_run_trend_memory_or_portfolioAdjustments' },
      decisionPatch: null,
      reasons: ['trend_memory_apply:no_portfolio_adjustments_source'],
    };
  }

  if (decision.promotionMode === 'blocked') {
    return {
      appliedFromTrendMemory: false,
      appliedDeltas: { skipped: true, reason: 'blocked_mode' },
      decisionPatch: null,
      reasons: ['trend_memory_apply:skipped_blocked_promotionMode'],
    };
  }

  const cap = Math.max(0, safeNum(maxAllocCap, 24));
  const mult = clamp(safeNum(pa.exposureMultiplier, 1), MIN_EXPOSURE_MULT, MAX_EXPOSURE_MULT);
  const dAlloc = Math.trunc(clamp(safeNum(pa.maxNewAllocationsDelta, 0), -MAX_ALLOC_DELTA, MAX_ALLOC_DELTA));
  const dAdm = clamp(safeNum(pa.admissionThresholdDelta, 0), -MAX_ADMISSION_DELTA, MAX_ADMISSION_DELTA);

  const baseline = {
    targetExposure: decision.targetExposure,
    maxNewAllocations: decision.maxNewAllocations,
    admissionThresholdMultiplier: decision.admissionThresholdMultiplier,
  };

  const targetExposure = round6(clamp(safeNum(decision.targetExposure, 0) * mult, 0, 1));
  const maxNewAllocations = Math.floor(
    clamp(safeNum(decision.maxNewAllocations, 0) + dAlloc, 0, cap)
  );
  const admissionThresholdMultiplier = round6(
    clamp(safeNum(decision.admissionThresholdMultiplier, 1) + dAdm, MIN_ADMISSION_MULT, MAX_ADMISSION_MULT)
  );

  const reasons = [
    `trend_memory_p7_1:portfolio mult=${mult} dMaxAlloc=${dAlloc} dAdmission=${round6(dAdm)}`,
  ];

  return {
    appliedFromTrendMemory: true,
    appliedDeltas: {
      mode: applyMode(),
      exposureMultiplierApplied: mult,
      maxNewAllocationsDeltaApplied: dAlloc,
      admissionThresholdDeltaApplied: round6(dAdm),
      baseline,
      after: { targetExposure, maxNewAllocations, admissionThresholdMultiplier },
      trendMemoryGeneratedAt: tm.generatedAt || null,
      trendMemoryVersion: tm.trendMemoryVersion || null,
    },
    decisionPatch: {
      targetExposure,
      maxNewAllocations,
      admissionThresholdMultiplier,
    },
    reasons,
  };
}

function normalizeWeights(weights) {
  const out = {};
  let sum = 0;
  for (const t of MUTATION_TYPES) {
    const v = Number(weights[t] || 0);
    out[t] = Number.isFinite(v) ? Math.max(0, v) : 0;
    sum += out[t];
  }
  if (sum <= 0) return null;
  for (const t of MUTATION_TYPES) out[t] = out[t] / sum;
  return out;
}

function boundedWeights(weights) {
  const bounded = {};
  for (const t of MUTATION_TYPES) {
    bounded[t] = clamp(Number(weights[t] || 0), 0.03, 0.7);
  }
  const n = normalizeWeights(bounded);
  return n || bounded;
}

/**
 * Merge mutation weight deltas from run_trend_memory into P5 weights.
 * conservative mode: no-op unless TREND_MEMORY_APPLY_MUTATIONS=true or mode=full.
 */
function applyTrendMemoryToMutationWeights(byMutationType, discoveryDir, opts = {}) {
  if (!isApplyEnabled()) {
    return {
      byMutationType,
      appliedFromTrendMemory: false,
      appliedDeltas: null,
      reasons: [],
    };
  }

  if (!mutationsAllowed()) {
    return {
      byMutationType,
      appliedFromTrendMemory: false,
      appliedDeltas: { skipped: true, reason: 'conservative_mutations_disabled' },
      reasons: ['trend_memory_apply_mutations:skipped_mode_conservative'],
    };
  }

  const tm = loadRunTrendMemory(discoveryDir);
  const raw =
    tm &&
    tm.suggestions &&
    tm.suggestions.policyAdjustments &&
    tm.suggestions.policyAdjustments.mutationTypeWeightDeltas
      ? tm.suggestions.policyAdjustments.mutationTypeWeightDeltas
      : {};

  const deltaMultiplier = clamp(safeNum(opts.deltaMultiplier, 1), 0, 1);
  const adjusted = { ...byMutationType };
  const appliedDeltas = {};
  for (const t of MUTATION_TYPES) {
    const d = clamp(safeNum(raw[t], 0), -MAX_WEIGHT_DELTA, MAX_WEIGHT_DELTA) * deltaMultiplier;
    if (Math.abs(d) < 1e-12) continue;
    adjusted[t] = safeNum(adjusted[t], 0) + d;
    appliedDeltas[t] = round6(d);
  }

  const next = boundedWeights(adjusted);

  return {
    byMutationType: next,
    appliedFromTrendMemory: Object.keys(appliedDeltas).length > 0,
    appliedDeltas:
      Object.keys(appliedDeltas).length > 0
        ? {
            mode: applyMode(),
            deltaMultiplierApplied: round6(deltaMultiplier),
            mutationTypeWeightDeltas: appliedDeltas,
            trendMemoryGeneratedAt: tm.generatedAt || null,
            trendMemoryVersion: tm.trendMemoryVersion || null,
          }
        : { skipped: true, reason: 'no_nonzero_deltas' },
    reasons:
      Object.keys(appliedDeltas).length > 0
        ? [`trend_memory_p7_1:mutation_deltas_applied_${Object.keys(appliedDeltas).join(',')}`]
        : ['trend_memory_apply_mutations:no_deltas'],
  };
}

module.exports = {
  isApplyEnabled,
  applyMode,
  loadRunTrendMemory,
  applyTrendMemoryToGovernorDecision,
  applyTrendMemoryToMutationWeights,
  MUTATION_TYPES,
  MAX_WEIGHT_DELTA,
};
