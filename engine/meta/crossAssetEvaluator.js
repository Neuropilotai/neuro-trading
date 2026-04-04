'use strict';

/**
 * Cross-Asset Learning Engine — A strategy is not good only on one market.
 *
 * A strategy discovered on e.g. SPY 5m is evaluated across multiple assets (QQQ, IWM, BTCUSDT, ETHUSDT).
 * The engine computes a cross_asset_score (weighted by asset) to eliminate overfitted strategies.
 *
 * Input: per-asset backtest results (from runTopKBacktests or batch per asset).
 * Output: cross_asset_score, byAsset breakdown.
 *
 * Usage:
 *   const { evaluateCrossAssetScore } = require('./engine/meta/crossAssetEvaluator');
 *   const { cross_asset_score, byAsset } = evaluateCrossAssetScore(perAssetResults, weights);
 */

/** Default asset weights: equities + crypto. Sum should be 1. */
const DEFAULT_ASSET_WEIGHTS = Object.freeze({
  SPY_5m: 0.4,
  QQQ_5m: 0.2,
  IWM_5m: 0.1,
  BTCUSDT_5m: 0.15,
  ETHUSDT_5m: 0.15,
});

/**
 * Normalize expectancy to a 0–1 score for weighting (handles negative; scale by sigmoid or clamp).
 */
function expectancyToScore(expectancy) {
  if (expectancy == null || !Number.isFinite(expectancy)) return 0;
  const clamped = Math.max(-0.01, Math.min(0.01, expectancy));
  return (clamped + 0.01) / 0.02;
}

/**
 * Evaluate cross-asset score from per-asset results.
 *
 * @param {Array<{ asset: string, expectancy?: number, trades?: number, winRate?: number }>} perAssetResults - One entry per asset (e.g. SPY_5m, QQQ_5m)
 * @param {{ [assetKey: string]: number }} [weights] - Asset weights (default DEFAULT_ASSET_WEIGHTS). Keys must match asset in results.
 * @returns {{ cross_asset_score: number, byAsset: Array<{ asset: string, expectancy: number|null, weight: number, contribution: number }> }}
 */
function evaluateCrossAssetScore(perAssetResults, weights = {}) {
  const w = Object.keys(weights).length > 0 ? weights : DEFAULT_ASSET_WEIGHTS;
  const byAsset = [];
  let weightedSum = 0;
  let weightSum = 0;

  for (const r of perAssetResults || []) {
    const asset = (r.asset || r.dataGroup || r.symbol || '').toString().trim();
    if (!asset) continue;
    const weight = Number(w[asset]);
    if (weight == null || !Number.isFinite(weight) || weight <= 0) continue;

    const expectancy = r.expectancy != null && Number.isFinite(r.expectancy) ? r.expectancy : null;
    const score = expectancyToScore(expectancy);
    const contribution = weight * score;

    weightedSum += contribution;
    weightSum += weight;
    byAsset.push({
      asset,
      expectancy,
      trades: r.trades != null ? r.trades : null,
      winRate: r.winRate != null ? r.winRate : null,
      weight,
      contribution,
    });
  }

  const cross_asset_score = weightSum > 0 ? weightedSum / weightSum : 0;
  return { cross_asset_score, byAsset };
}

/**
 * Build per-asset result key from dataGroup or symbol+timeframe.
 */
function assetKey(symbol, timeframe) {
  return [String(symbol || '').toUpperCase(), String(timeframe || '5m').toLowerCase()].filter(Boolean).join('_');
}

module.exports = {
  evaluateCrossAssetScore,
  expectancyToScore,
  assetKey,
  DEFAULT_ASSET_WEIGHTS,
};
