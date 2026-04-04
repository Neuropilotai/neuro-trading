'use strict';

/**
 * Meta Engine — Cross-asset, multi-timeframe, meta-ranking, champion portfolio.
 */

const crossAssetEvaluator = require('./crossAssetEvaluator');
const timeframeRobustness = require('./timeframeRobustness');
const metaRankingEngine = require('./metaRankingEngine');
const championPortfolioBuilder = require('./championPortfolioBuilder');

module.exports = {
  ...crossAssetEvaluator,
  ...timeframeRobustness,
  ...metaRankingEngine,
  ...championPortfolioBuilder,
};
