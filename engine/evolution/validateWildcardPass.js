#!/usr/bin/env node
'use strict';

/**
 * Validation script for Wildcard Promotion Pass (PART 6).
 * Run after strategyEvolution.js; prints wildcard metadata, delta, maxChampionsInOneFamily, and runs audit.
 */

const path = require('path');
const dataRoot = require('../dataRoot');
const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
const fs = require('fs');

if (!fs.existsSync(regPath)) {
  console.error('Registry not found:', regPath);
  process.exit(1);
}

const r = JSON.parse(fs.readFileSync(regPath, 'utf8'));
const m = r.metadata || {};
const cm = m.avgChampionMomentum;
const vm = m.avgValidatedMomentum;
const delta = cm != null && vm != null ? cm - vm : null;

console.log('--- Wildcard Pass Validation ---');
console.log('champions:', r.championsCount, 'validated:', r.validatedCount);
console.log('wildcardPromotions:', m.wildcardPromotions, 'wildcardPromotionsOverChampion:', m.wildcardPromotionsOverChampion);
console.log('wildcardCandidatesSeen:', m.wildcardCandidatesSeen);
console.log('wildcardBlocked FamilyLimit:', m.wildcardBlockedFamilyLimit, 'GroupStronger:', m.wildcardBlockedGroupStrongerChampion, 'LowDelta:', m.wildcardBlockedLowDelta, 'TotalLimit:', m.wildcardBlockedTotalLimit);
console.log('avgChampionMomentum:', cm, 'avgValidatedMomentum:', vm, 'delta:', delta);
console.log('avgWildcardPromotedMomentum:', m.avgWildcardPromotedMomentum);

const byF = Object.create(null);
for (const e of (r.setups || []).filter((x) => x.status === 'champion')) {
  const fk = e.familyKey || 'unknown';
  byF[fk] = (byF[fk] || 0) + 1;
}
const maxInFamily = Object.keys(byF).length ? Math.max(...Object.values(byF)) : 0;
console.log('maxChampionsInOneFamily:', maxInFamily);

const { validateRegistryConsistency } = require('./strategyEvolution');
const result = validateRegistryConsistency(r.setups || [], { strict: false });
if (!result.ok) {
  console.error('Audit FAIL:', result.errors);
  process.exit(1);
}
console.log('Audit: OK');
process.exit(0);
