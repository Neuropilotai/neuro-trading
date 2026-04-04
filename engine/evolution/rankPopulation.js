'use strict';

/**
 * Genetic Strategy Evolution — Rank population by fitness.
 *
 * Combines discovered_setups.json (batch results) and champion_registry.json (survival)
 * into a single ranked list. Fitness = expectancy first, then bootstrap_risk, then trades.
 *
 * Usage:
 *   const { rankPopulation } = require('./rankPopulation');
 *   const ranked = rankPopulation(discoveryDir, championDir);
 */

const path = require('path');
const fs = require('fs');

/**
 * Compute a single fitness score for sorting (higher = better).
 * Prefer: high expectancy, low bootstrap_risk, enough trades.
 */
function fitnessScore(row) {
  const e = row.expectancy != null ? row.expectancy : -1e9;
  const b = row.bootstrap_risk != null ? row.bootstrap_risk : 1;
  const t = row.trades != null ? row.trades : 0;
  const tradeBonus = t >= 20 ? 0.1 : t >= 10 ? 0.05 : 0;
  return e - b * 0.5 + tradeBonus;
}

/**
 * Load discovered_setups.json and champion_registry.json, merge by setupId, rank by fitness.
 *
 * @param {string} [discoveryDir] - Path to discovery/ (discovered_setups.json)
 * @param {string} [championDir] - Path to champion_setups/ (champion_registry.json)
 * @returns {Array<{ setupId: string, name?: string, rules?: object, expectancy?: number, trades?: number, bootstrap_risk?: number, status?: string, survivalScore?: number }>}
 */
function rankPopulation(discoveryDir, championDir) {
  const dataRoot = require('../dataRoot');
  const discovery = discoveryDir || dataRoot.getPath('discovery', false);
  const champion = championDir || dataRoot.getPath('champion_setups', false);

  const byId = new Map();

  const discoveredPath = path.join(discovery, 'discovered_setups.json');
  if (fs.existsSync(discoveredPath)) {
    const data = JSON.parse(fs.readFileSync(discoveredPath, 'utf8'));
    const results = data.results || [];
    for (const r of results) {
      const id = r.setupId || r.setup_id;
      if (!id) continue;
      byId.set(id, { ...r, setupId: id });
    }
  }

  const registryPath = path.join(champion, 'champion_registry.json');
  if (fs.existsSync(registryPath)) {
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const champions = reg.champions || [];
    for (const c of champions) {
      const id = c.setupId;
      if (!id) continue;
      const existing = byId.get(id);
      byId.set(id, {
        ...existing,
        setupId: id,
        status: c.status,
        survivalScore: c.survivalScore,
        nightsSurvived: c.nightsSurvived,
        avgExpectancy: c.avgExpectancy,
        avgBootstrapRisk: c.avgBootstrapRisk,
        ...(existing || {}),
      });
    }
  }

  const list = Array.from(byId.values());
  list.sort((a, b) => fitnessScore(b) - fitnessScore(a));
  return list;
}

module.exports = { rankPopulation, fitnessScore };
