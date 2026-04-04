#!/usr/bin/env node
'use strict';

/**
 * Resolve adaptive policy for a candidate from consolidated learning_state (Phase 1+).
 * Fail-soft: always returns a complete object (no undefined keys).
 *
 * @param {{ setupId?: string, strategyId?: string, familyKey?: string }} candidate
 * @param {object} learningState - output from loadLearningState / buildLearningState
 * @returns {{
 *   source: 'setup'|'family'|'global'|'none',
 *   generationWeightMultiplier: number,
 *   promotionWeightMultiplier: number,
 *   mutationRadiusMultiplier: number,
 *   isSoftBlocked: boolean,
 *   reasons: string[],
 * }}
 */
function resolveAdaptivePolicy(candidate, learningState) {
  const reasons = [];
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const setupId = String(c.setupId || '').trim();
  const strategyId = String(c.strategyId || '').trim();
  const setupKey = setupId || strategyId || '';
  const familyKey = String(c.familyKey || '').trim();

  const state = learningState && typeof learningState === 'object' ? learningState : {};
  const bySetup = state.bySetup && typeof state.bySetup === 'object' ? state.bySetup : {};
  const byFamily = state.byFamily && typeof state.byFamily === 'object' ? state.byFamily : {};

  const defaults = () => ({
    source: 'none',
    generationWeightMultiplier: 1,
    promotionWeightMultiplier: 1,
    mutationRadiusMultiplier: 1,
    isSoftBlocked: false,
    reasons: [],
  });

  if (setupKey && Object.prototype.hasOwnProperty.call(bySetup, setupKey)) {
    const row = bySetup[setupKey];
    const a = row && row.actions ? row.actions : {};
    reasons.push('learning_state:bySetup');
    return {
      source: 'setup',
      generationWeightMultiplier:
        typeof a.generationWeightMultiplier === 'number' && Number.isFinite(a.generationWeightMultiplier)
          ? a.generationWeightMultiplier
          : 1,
      promotionWeightMultiplier:
        typeof a.promotionWeightMultiplier === 'number' && Number.isFinite(a.promotionWeightMultiplier)
          ? a.promotionWeightMultiplier
          : 1,
      mutationRadiusMultiplier:
        typeof a.mutationRadiusMultiplier === 'number' && Number.isFinite(a.mutationRadiusMultiplier)
          ? a.mutationRadiusMultiplier
          : 1,
      isSoftBlocked: a.isSoftBlocked === true,
      reasons: Array.isArray(row.reasons) ? row.reasons.slice() : reasons,
    };
  }

  const fam =
    familyKey ||
    (setupKey ? inferFamilyBucket(setupKey) : '');
  if (fam && Object.prototype.hasOwnProperty.call(byFamily, fam)) {
    const row = byFamily[fam];
    const a = row && row.actions ? row.actions : {};
    reasons.push('learning_state:byFamily');
    return {
      source: 'family',
      generationWeightMultiplier:
        typeof a.generationBudgetMultiplier === 'number' && Number.isFinite(a.generationBudgetMultiplier)
          ? a.generationBudgetMultiplier
          : typeof a.generationWeightMultiplier === 'number' && Number.isFinite(a.generationWeightMultiplier)
            ? a.generationWeightMultiplier
            : 1,
      promotionWeightMultiplier:
        typeof a.promotionWeightMultiplier === 'number' && Number.isFinite(a.promotionWeightMultiplier)
          ? a.promotionWeightMultiplier
          : 1,
      mutationRadiusMultiplier:
        typeof a.mutationRadiusMultiplier === 'number' && Number.isFinite(a.mutationRadiusMultiplier)
          ? a.mutationRadiusMultiplier
          : 1,
      isSoftBlocked: false,
      reasons: Array.isArray(row.reasons) ? row.reasons.slice() : reasons,
    };
  }

  const gp = state.globalPolicies && typeof state.globalPolicies === 'object' ? state.globalPolicies : {};
  if (gp.actionBias && typeof gp.actionBias === 'string') {
    reasons.push(`global:${gp.actionBias}`);
    return {
      source: 'global',
      generationWeightMultiplier: 1,
      promotionWeightMultiplier: 1,
      mutationRadiusMultiplier: 1,
      isSoftBlocked: false,
      reasons,
    };
  }

  return defaults();
}

function inferFamilyBucket(setupKey) {
  const k = String(setupKey).toLowerCase();
  if (k.startsWith('mut_')) return 'mut_';
  if (k.startsWith('familyexp_')) return 'familyexp_';
  if (k.startsWith('example_')) return 'example_';
  return 'other';
}

module.exports = { resolveAdaptivePolicy, inferFamilyBucket };
