#!/usr/bin/env node
'use strict';

/**
 * Smoke: computeEvolutionSummary from registry + next gen fixtures.
 * Run: node engine/governance/smokeEvolutionSummary.js
 */

const assert = require('assert');
const { computeEvolutionSummary } = require('./computeEvolutionSummary');

{
  const s = computeEvolutionSummary({ championRegistry: null });
  assert.strictEqual(s.elite, 'unknown');
  assert.ok(s.evolutionSummaryLine.includes('unknown'));
}

{
  const registry = {
    setupsCount: 1000,
    championsCount: 20,
    validatedCount: 50,
    metadata: {
      mutationsPromoted: 8,
      extinctionCount: 25,
      championsProtectedByDiversity: 2,
      mutationChampionRatio: 0.65,
    },
    setups: [],
  };
  const next = { childrenGenerated: 5 };
  const s = computeEvolutionSummary({
    championRegistry: registry,
    nextGenerationReport: next,
    paths: { a: '/x', b: '/y' },
  });
  assert.strictEqual(s.elite, 'strong');
  assert.strictEqual(s.mutation, 'high');
  assert.strictEqual(s.promotion, 'active');
  assert.strictEqual(s.diversity, 'present');
  assert.strictEqual(s.pruning, 'active');
  assert.strictEqual(s.exploration, 'on');
  assert.strictEqual(s.labOnly, true);
  assert.ok(s.evolutionSummaryLine.includes('elite:strong'));
}

{
  const registry = {
    setupsCount: 100,
    championsCount: 30,
    validatedCount: 40,
    metadata: {
      mutationsPromoted: 0,
      extinctionCount: 0,
      championsProtectedByDiversity: 0,
      mutationChampionRatio: 0.1,
    },
    setups: [],
  };
  const s = computeEvolutionSummary({
    championRegistry: registry,
    nextGenerationReport: { childrenGenerated: 0 },
  });
  assert.strictEqual(s.elite, 'weak');
  assert.strictEqual(s.mutation, 'low');
  assert.strictEqual(s.promotion, 'dormant');
  assert.strictEqual(s.diversity, 'absent');
  assert.strictEqual(s.exploration, 'off');
}

console.log('smokeEvolutionSummary: all passed');
