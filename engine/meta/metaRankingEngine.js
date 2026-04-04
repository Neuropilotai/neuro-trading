'use strict';

/**
 * Meta-Ranking Engine — Intelligent ranking after Fast Scan, Backtest, Evolution.
 *
 * Final score: meta_score = expectancy + stability + cross_asset + timeframe + trade_count - drawdown
 * (components normalized and weighted). Ranks strategies for Champion Portfolio and live selection.
 *
 * Usage:
 *   const { computeMetaRanking } = require('./engine/meta/metaRankingEngine');
 *   const ranked = computeMetaRanking(strategies, { weights: { ... } });
 */

/** Default component weights for meta_score. Sum used for normalization. */
const DEFAULT_WEIGHTS = Object.freeze({
  expectancy: 0.25,
  stability: 0.15,
  cross_asset: 0.2,
  timeframe: 0.15,
  trade_count: 0.1,
  drawdown: -0.15,
});

/**
 * Normalize a value to 0–1 given optional min/max (or use heuristics).
 */
function normalize(value, min, max) {
  if (value == null || !Number.isFinite(value)) return 0;
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 1;
  if (hi <= lo) return 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

/**
 * Compute meta_score for each strategy and sort by rank.
 *
 * @param {Array<{ setupId: string, expectancy?: number, trades?: number, winRate?: number, drawdown?: number, cross_asset_score?: number, timeframe_stability_score?: number, stability?: number }>} strategies
 * @param {{ weights?: object, expectancyRange?: [number, number], tradeCountCap?: number }} [opts]
 * @returns {Array<{ ...strategy, meta_score: number, rank: number }>}
 */
function computeMetaRanking(strategies, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const expectancyRange = opts.expectancyRange || [-0.005, 0.005];
  const tradeCountCap = Number.isFinite(opts.tradeCountCap) ? opts.tradeCountCap : 500;

  const scored = strategies.map((s) => {
    const ex = normalize(s.expectancy, expectancyRange[0], expectancyRange[1]);
    const stability = normalize(s.stability ?? s.timeframe_stability_score ?? 0, 0, 1);
    const crossAsset = normalize(s.cross_asset_score ?? 0, 0, 1);
    const timeframe = normalize(s.timeframe_stability_score ?? s.timeframeScore ?? 0, 0, 1);
    const tradeCount = normalize(s.trades ?? 0, 0, tradeCountCap);
    const drawdown = normalize(s.drawdown ?? 0, 0, 0.5);

    const meta_score =
      weights.expectancy * ex +
      weights.stability * stability +
      weights.cross_asset * crossAsset +
      weights.timeframe * timeframe +
      weights.trade_count * tradeCount +
      weights.drawdown * drawdown;

    return { ...s, meta_score };
  });

  scored.sort((a, b) => (b.meta_score !== a.meta_score ? b.meta_score - a.meta_score : (b.trades ?? 0) - (a.trades ?? 0)));
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

module.exports = {
  computeMetaRanking,
  normalize,
  DEFAULT_WEIGHTS,
};
