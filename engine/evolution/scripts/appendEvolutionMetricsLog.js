#!/usr/bin/env node
'use strict';

/**
 * Append one NDJSON line to evolution_metrics.log for temporal tracking.
 * Run after strategyEvolution.js (e.g. from runEvolutionBaseline.sh).
 * Enables: trend delta, wildcard activation, diversity pressure over time.
 */

const path = require('path');
const fs = require('fs');

const dataRoot = require('../../dataRoot');
const regPath = path.join(dataRoot.getPath('champion_setups'), 'champion_registry.json');
const logDir = path.join(__dirname, '..', 'logs');
const logPath = path.join(logDir, 'evolution_metrics.log');

if (!fs.existsSync(regPath)) {
  console.error('appendEvolutionMetricsLog: registry not found:', regPath);
  process.exit(1);
}

const r = JSON.parse(fs.readFileSync(regPath, 'utf8'));
const setups = r.setups || [];
const champs = setups.filter((s) => s.status === 'champion');
const validated = setups.filter((s) => s.status === 'validated');

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const champMom = champs.map((s) => Number(s.momentumMetaScore)).filter(Number.isFinite);
const valMom = validated.map((s) => Number(s.momentumMetaScore)).filter(Number.isFinite);
const delta = avg(champMom) - avg(valMom);

const byFamily = {};
for (const s of champs) {
  const k = s.familyKey || 'unknown';
  byFamily[k] = (byFamily[k] || 0) + 1;
}
const maxChampionsInOneFamily = Object.keys(byFamily).length
  ? Math.max(...Object.values(byFamily))
  : 0;

const m = r.metadata || {};
const line = {
  ts: new Date().toISOString(),
  champions: champs.length,
  validated: validated.length,
  delta: Math.round(delta * 1e6) / 1e6,
  wildcardPromotions: m.wildcardPromotions ?? 0,
  blockedGroupStronger: m.wildcardBlockedGroupStrongerChampion ?? 0,
  diversityCapped: m.championsDemotedByDiversity ?? 0,
  protectedByDiversity: m.championsProtectedByDiversity ?? 0,
  wildcardCandidatesSeen: m.wildcardCandidatesSeen ?? 0,
  maxChampionsInOneFamily,
  consistencyOk: m.consistencyOk ?? null,
  learningScore: m.learningScore ?? null,
  explorationScore: m.explorationScore ?? null,
  adaptationScore: m.adaptationScore ?? null,
  marketRegime: m.marketRegime ?? null,
  marketVolatility: m.marketVolatility ?? null,
  marketTrend: m.marketTrend ?? null,
  effectiveMinDelta: m.effectiveMinDelta ?? null,
  effectiveMaxPromotions: m.effectiveMaxPromotions ?? null,
  stagnationIsStagnating: m.stagnationIsStagnating ?? null,
  stagnationAvgDelta: m.stagnationAvgDelta ?? null,
  stagnationZeroPromotions: m.stagnationZeroPromotions ?? null,
  evolutionGuard: r.evolutionGuard ?? null,
};

fs.mkdirSync(logDir, { recursive: true });
fs.appendFileSync(logPath, JSON.stringify(line) + '\n', 'utf8');
