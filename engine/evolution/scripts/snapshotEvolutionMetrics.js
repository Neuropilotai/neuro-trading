#!/usr/bin/env node
'use strict';

/**
 * Snapshot of evolution metrics from champion_registry.json.
 * Run after strategyEvolution.js to inspect champions, validated, wildcard, diversity, delta.
 */

const path = require('path');
const dataRoot = require('../../dataRoot');
const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
const fs = require('fs');

if (!fs.existsSync(regPath)) {
  console.error('Registry not found:', regPath);
  process.exit(1);
}

const r = JSON.parse(fs.readFileSync(regPath, 'utf8'));
const setups = r.setups || [];
const champs = setups.filter((s) => s.status === 'champion');
const validated = setups.filter((s) => s.status === 'validated');
const muts = setups.filter((s) => s.parentSetupId);

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

const champMom = champs.map((s) => Number(s.momentumMetaScore)).filter(Number.isFinite);
const valMom = validated.map((s) => Number(s.momentumMetaScore)).filter(Number.isFinite);

const byFamily = {};
for (const s of champs) {
  const k = s.familyKey || 'unknown';
  byFamily[k] = (byFamily[k] || 0) + 1;
}
const maxFam = Math.max(0, ...Object.values(byFamily));

const out = {
  champions: champs.length,
  validated: validated.length,
  totalMutations: muts.length,
  mutationChampions: muts.filter((s) => s.status === 'champion').length,
  mutationValidated: muts.filter((s) => s.status === 'validated').length,
  avgChampionMomentum: avg(champMom),
  avgValidatedMomentum: avg(valMom),
  deltaChampionVsValidated: avg(champMom) - avg(valMom),
  wildcardCandidatesSeen: r.metadata?.wildcardCandidatesSeen ?? null,
  wildcardPromotions: r.metadata?.wildcardPromotions ?? null,
  wildcardBlockedGroupStrongerChampion: r.metadata?.wildcardBlockedGroupStrongerChampion ?? null,
  championsDemotedByDiversity: r.metadata?.championsDemotedByDiversity ?? null,
  championsProtectedByDiversity: r.metadata?.championsProtectedByDiversity ?? null,
  championsDemotedByGlobalCap: r.metadata?.championsDemotedByGlobalCap ?? null,
  maxChampionsInOneFamily: maxFam,
  consistencyOk: r.metadata?.consistencyOk ?? null,
  consistencyErrorCount: r.metadata?.consistencyErrorCount ?? null,
};

console.log(JSON.stringify(out, null, 2));
