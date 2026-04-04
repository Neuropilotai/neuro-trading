'use strict';

/**
 * Multi-Timeframe Robustness — A real strategy should survive on several timeframes.
 *
 * A strategy (e.g. SPY) is tested on 5m, 15m, 1h. The engine computes timeframe_stability_score
 * so that strategies that work on one timeframe only are penalized.
 *
 * Input: per-timeframe backtest results.
 * Output: timeframe_stability_score, byTimeframe breakdown.
 *
 * Usage:
 *   const { evaluateTimeframeRobustness } = require('./engine/meta/timeframeRobustness');
 *   const { timeframe_stability_score, byTimeframe } = evaluateTimeframeRobustness(perTimeframeResults);
 */

/** Default timeframe weights (5m, 15m, 1h). Sum 1. */
const DEFAULT_TIMEFRAME_WEIGHTS = Object.freeze({
  '5m': 0.5,
  '15m': 0.3,
  '1h': 0.2,
});

/**
 * Expectancy to 0–1 score (same as cross-asset).
 */
function expectancyToScore(expectancy) {
  if (expectancy == null || !Number.isFinite(expectancy)) return 0;
  const clamped = Math.max(-0.01, Math.min(0.01, expectancy));
  return (clamped + 0.01) / 0.02;
}

/**
 * Evaluate timeframe stability from per-timeframe results.
 *
 * @param {Array<{ timeframe: string, expectancy?: number, trades?: number, winRate?: number }>} perTimeframeResults
 * @param {{ [tf: string]: number }} [weights] - Timeframe weights (default 5m/15m/1h)
 * @returns {{ timeframe_stability_score: number, byTimeframe: Array<{ timeframe: string, expectancy: number|null, weight: number, contribution: number }> }}
 */
function evaluateTimeframeRobustness(perTimeframeResults, weights = {}) {
  const w = Object.keys(weights).length > 0 ? weights : DEFAULT_TIMEFRAME_WEIGHTS;
  const byTimeframe = [];
  let weightedSum = 0;
  let weightSum = 0;

  for (const r of perTimeframeResults || []) {
    const tf = (r.timeframe || r.tf || '').toString().trim().toLowerCase();
    if (!tf) continue;
    const weight = Number(w[tf]);
    if (weight == null || !Number.isFinite(weight) || weight <= 0) continue;

    const expectancy = r.expectancy != null && Number.isFinite(r.expectancy) ? r.expectancy : null;
    const score = expectancyToScore(expectancy);
    const contribution = weight * score;

    weightedSum += contribution;
    weightSum += weight;
    byTimeframe.push({
      timeframe: tf,
      expectancy,
      trades: r.trades != null ? r.trades : null,
      winRate: r.winRate != null ? r.winRate : null,
      weight,
      contribution,
    });
  }

  const timeframe_stability_score = weightSum > 0 ? weightedSum / weightSum : 0;
  return { timeframe_stability_score, byTimeframe };
}

module.exports = {
  evaluateTimeframeRobustness,
  expectancyToScore,
  DEFAULT_TIMEFRAME_WEIGHTS,
};
