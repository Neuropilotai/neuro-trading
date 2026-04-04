'use strict';

/**
 * Signal Scorer — Score candidate signals (e.g. by expectancy, meta_score from registry) and return best for paper/live.
 *
 * Flow: champion registry → signal generator → signal scorer → route best to paper → live gate.
 */

const { loadChampionRegistrySync } = require('../champions/loadChampionRegistry');
const { getChampionsOnly } = require('../champions/filterChampionSetups');

/**
 * Score one signal using champion metadata (avgExpectancy, survivalScore). Higher is better.
 *
 * @param {object} signal - { setupId, symbol, timeframe, side, price }
 * @param {{ championDir?: string }} [opts]
 * @returns {number}
 */
function scoreSignal(signal, opts = {}) {
  if (!signal || !signal.setupId) return 0;
  const registry = loadChampionRegistrySync(opts.championDir);
  if (!registry) return 0.5;

  const champions = getChampionsOnly(registry);
  const entry = champions.find((c) => (c.setupId || c.setup_id) === signal.setupId);
  if (!entry) return 0.5;

  const expectancy = entry.avgExpectancy != null && Number.isFinite(entry.avgExpectancy) ? entry.avgExpectancy : 0;
  const survival = entry.survivalScore != null && Number.isFinite(entry.survivalScore) ? entry.survivalScore : 0;
  const nights = entry.nightsSurvived != null && Number.isFinite(entry.nightsSurvived) ? entry.nightsSurvived : 0;

  const eNorm = Math.max(0, Math.min(1, (expectancy + 0.005) / 0.01));
  const sNorm = Math.max(0, Math.min(1, survival / 10));
  const nNorm = Math.max(0, Math.min(1, nights / 5));
  return 0.5 * eNorm + 0.3 * sNorm + 0.2 * nNorm;
}

/**
 * Sort signals by score descending and optionally take top N.
 *
 * @param {Array<object>} signals
 * @param {{ topN?: number, championDir?: string }} [opts]
 * @returns {Array<{ signal: object, score: number }>}
 */
function scoreAndRank(signals, opts = {}) {
  const topN = opts.topN != null ? opts.topN : 50;
  const scored = (signals || []).map((s) => ({ signal: s, score: scoreSignal(s, opts) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

module.exports = {
  scoreSignal,
  scoreAndRank,
};
