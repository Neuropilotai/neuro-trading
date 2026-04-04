'use strict';

/**
 * NeuroPilot Quant Engine v1 — Strategy Ranking Engine
 *
 * Ranks strategies and regimes using the output of the Performance Analyzer.
 * Pure function: no side effects, no database writes. Designed to be extended
 * later with PnL, expectancy, or Sharpe-based scoring.
 *
 * Input: performance analysis object (from performanceAnalyzer.analyze)
 * Output: { topStrategies, topRegimes, recommendations }
 */

/** Keys to exclude from strategy/regime ranking (noise, not actionable). */
const NULL_KEYS = new Set(['null', '']);

/**
 * Normalize count to a score in [0, 1] using total. Safe division: returns 0 when total <= 0.
 *
 * @param {number} count - Raw count
 * @param {number} total - Denominator (e.g. totalRecords, validSignals)
 * @returns {number} Score in [0, 1]
 */
function normalizeScore(count, total) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return 0;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, count / total));
}

/**
 * Rank a count object: return array of { key, count, score } sorted by count descending.
 * Optionally exclude null-like keys and use a custom total for scoring.
 *
 * @param {object} countObj - Map of key -> count (e.g. byStrategy, byRegime)
 * @param {number} total - Total for score = count / total (e.g. totalRecords)
 * @param {object} [options] - { excludeNull: boolean (default true), keyLabel: string } for output shape
 * @returns {Array<{ key: string, count: number, score: number }>}
 */
function rankCounts(countObj, total, options = {}) {
  if (!countObj || typeof countObj !== 'object') return [];
  const excludeNull = options.excludeNull !== false;
  const keyLabel = options.keyLabel || 'key';

  const entries = [];
  for (const [key, count] of Object.entries(countObj)) {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 0) continue;
    if (excludeNull && NULL_KEYS.has(String(key))) continue;
    const score = normalizeScore(n, total);
    const label = keyLabel === 'strategy' ? 'strategy' : keyLabel === 'regime' ? 'regime' : 'key';
    entries.push({ [label]: key, count: n, score: Math.round(score * 100) / 100 });
  }

  entries.sort((a, b) => b.count - a.count);
  return entries;
}

/**
 * Build human-readable recommendations from ranked strategies and regimes.
 * Simple rules: favor top strategy in top regime; suggest caution for low-count strategies.
 *
 * @param {object} params - { topStrategies: array, topRegimes: array, totals: object }
 * @param {object} [options] - { minCountForFavor: number, minCountWarning: number }
 * @returns {string[]} Array of recommendation strings
 */
function buildRecommendations(params, options = {}) {
  if (!params) return [];
  const { topStrategies = [], topRegimes = [], totals = {} } = params;
  const minCountForFavor = options.minCountForFavor != null ? options.minCountForFavor : 10;
  const minCountWarning = options.minCountWarning != null ? options.minCountWarning : 5;

  const recommendations = [];
  const topRegime = topRegimes[0];
  const topStrategy = topStrategies[0];

  if (topStrategy && topRegime) {
    recommendations.push(`Favor ${topStrategy.strategy || topStrategy.key} in ${topRegime.regime || topRegime.key}`);
  } else if (topStrategy) {
    recommendations.push(`Favor ${topStrategy.strategy || topStrategy.key}`);
  } else if (topRegime) {
    recommendations.push(`Dominant regime: ${topRegime.regime || topRegime.key}`);
  }

  for (const s of topStrategies.slice(1)) {
    const name = s.strategy || s.key;
    const count = s.count;
    if (count < minCountWarning) {
      recommendations.push(`Reduce ${name} usage until more data`);
    } else if (count < minCountForFavor) {
      recommendations.push(`Use ${name} with caution (low sample: ${count})`);
    }
  }

  const totalRecords = totals.totalRecords || 0;
  if (totalRecords > 0 && totalRecords < minCountForFavor) {
    recommendations.push('Insufficient data for strong recommendations; collect more bars');
  }

  return recommendations;
}

/**
 * Rank strategies and regimes from a performance analysis object. Safe for empty input.
 *
 * @param {object} analysis - Output of performanceAnalyzer.analyze(records)
 * @param {object} [options] - { strategyTotal: 'totalRecords'|'tradeableSignals', regimeTotal: 'totalRecords'|'validSignals', minCountWarning, minCountForFavor }
 * @returns {object} { topStrategies, topRegimes, recommendations }
 */
function rank(analysis, options = {}) {
  if (!analysis || typeof analysis !== 'object') {
    return {
      topStrategies: [],
      topRegimes: [],
      recommendations: ['Insufficient analysis data'],
    };
  }

  const totals = analysis.totals || {};
  const totalRecords = Math.max(0, Number(totals.totalRecords) || 0);
  const tradeableSignals = Math.max(0, Number(totals.tradeableSignals) || 0);
  const validSignals = Math.max(0, Number(totals.validSignals) || 0);

  const strategyDenom = options.strategyTotal === 'tradeableSignals' && tradeableSignals > 0
    ? tradeableSignals
    : totalRecords;
  const regimeDenom = options.regimeTotal === 'validSignals' && validSignals > 0
    ? validSignals
    : totalRecords;

  const byStrategy = analysis.byStrategy || {};
  const byRegime = analysis.byRegime || {};

  const topStrategies = rankCounts(byStrategy, strategyDenom, { keyLabel: 'strategy' });
  const topRegimes = rankCounts(byRegime, regimeDenom, { keyLabel: 'regime' });

  const params = {
    topStrategies,
    topRegimes,
    totals,
  };
  const recommendations = buildRecommendations(params, {
    minCountForFavor: options.minCountForFavor,
    minCountWarning: options.minCountWarning,
  });

  return {
    topStrategies,
    topRegimes,
    recommendations: recommendations.length > 0 ? recommendations : ['No recommendations from current data'],
  };
}

module.exports = {
  rank,
  rankCounts,
  normalizeScore,
  buildRecommendations,
  NULL_KEYS,
};
