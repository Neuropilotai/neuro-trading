'use strict';

/**
 * Family Portfolio Filter — Limit the number of setups per family in the portfolio.
 *
 * After clustering, apply a cap per family (e.g. max 1 or 2 per family) so the final
 * portfolio is diverse: one or few representatives per family instead of 10x "close breakout".
 *
 * Input: clustered strategies (with familyId, familyRank, familyLeader, familySize).
 * Output: filtered list ready for buildChampionPortfolio.
 */

const { clusterStrategyFamilies } = require('./clusterStrategyFamilies');

function safeNum(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Filter clustered strategies so at most maxPerFamily setups per family are kept.
 * Keeps family leaders first, then by familyRank (best in family first).
 *
 * @param {Array<object>} clusteredStrategies - Strategies with familyId, familyRank, familyLeader
 * @param {{ maxPerFamily?: number, maxStrategies?: number }} [opts]
 * @returns {Array<object>} Filtered strategies (order: diversity-first, then meta_score)
 */
function filterByFamily(clusteredStrategies, opts = {}) {
  const maxPerFamily = Math.max(1, opts.maxPerFamily ?? 1);
  const maxStrategies = opts.maxStrategies != null ? Math.max(1, opts.maxStrategies) : null;

  const byFamily = new Map();
  for (const s of clusteredStrategies || []) {
    const fid = s.familyId || 'unknown';
    if (!byFamily.has(fid)) byFamily.set(fid, []);
    byFamily.get(fid).push(s);
  }

  const out = [];
  for (const [, members] of byFamily.entries()) {
    const sorted = members.slice().sort((a, b) => {
      const leaderA = a.familyLeader ? 1 : 0;
      const leaderB = b.familyLeader ? 1 : 0;
      if (leaderB !== leaderA) return leaderB - leaderA;
      const rankA = safeNum(a.familyRank, 999);
      const rankB = safeNum(b.familyRank, 999);
      if (rankA !== rankB) return rankA - rankB;
      const metaA = safeNum(a.meta_score, -Infinity);
      const metaB = safeNum(b.meta_score, -Infinity);
      return metaB - metaA;
    });
    const take = sorted.slice(0, maxPerFamily);
    out.push(...take);
  }

  out.sort((a, b) => {
    const metaA = safeNum(a.meta_score, -Infinity);
    const metaB = safeNum(b.meta_score, -Infinity);
    if (metaB !== metaA) return metaB - metaA;
    const expA = safeNum(a.expectancy, -Infinity);
    const expB = safeNum(b.expectancy, -Infinity);
    return expB - expA;
  });

  if (maxStrategies != null && out.length > maxStrategies) {
    return out.slice(0, maxStrategies);
  }
  return out;
}

/**
 * Run clustering then apply family filter. Convenience for pipeline: meta ranking → cluster → filter → portfolio.
 *
 * @param {Array<object>|{ strategies: Array }} metaRankingInput - meta_ranking.json or strategies array
 * @param {{ maxPerFamily?: number, maxStrategies?: number, includeFamilyStats?: boolean }} [opts]
 * @returns {{ filtered: Array<object>, clustered: object, familiesCount: number }}
 */
function clusterAndFilter(metaRankingInput, opts = {}) {
  const clustered = clusterStrategyFamilies(metaRankingInput, {
    includeFamilyStats: opts.includeFamilyStats !== false,
  });
  const filtered = filterByFamily(clustered.strategies, {
    maxPerFamily: opts.maxPerFamily ?? 1,
    maxStrategies: opts.maxStrategies,
  });

  return {
    filtered,
    clustered,
    familiesCount: clustered.familiesCount,
  };
}

module.exports = {
  filterByFamily,
  clusterAndFilter,
};
