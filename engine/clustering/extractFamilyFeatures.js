'use strict';

/**
 * Extract Family Features — Derive the feature buckets used for strategy family clustering.
 *
 * Used by clusterStrategyFamilies; can be called standalone for inspection or debugging.
 * Returns the same buckets that form familyKey: regime, sessionPhase, patternBucket, etc.
 */

const { parseSetupId, inferRegime, buildFamilySignature } = require('./clusterStrategyFamilies');

/**
 * Extract family feature buckets from a single strategy (no familyId assignment).
 *
 * @param {object} strategy - One entry from meta ranking (setupId, expectancy, trades, cross_asset_score, etc.)
 * @returns {{ familySignature: object, parsedId: object, regime: string }}
 */
function extractFamilyFeatures(strategy) {
  const parsedId = parseSetupId(strategy && strategy.setupId);
  const regime = inferRegime(strategy || {});
  const { familyKey, familySignature } = buildFamilySignature(strategy || {});

  return {
    familyKey,
    familySignature,
    parsedId,
    regime,
  };
}

/**
 * Extract features for many strategies (e.g. for debugging or external clustering).
 *
 * @param {Array<object>|{ strategies: Array }} input - Strategies array or object with .strategies
 * @returns {Array<{ setupId: string, familyKey: string, familySignature: object, parsedId: object, regime: string }>}
 */
function extractAll(input) {
  const list = Array.isArray(input) ? input : (input && input.strategies) || [];
  return list.map((s) => ({
    setupId: s.setupId,
    ...extractFamilyFeatures(s),
  }));
}

module.exports = {
  extractFamilyFeatures,
  extractAll,
  parseSetupId,
  inferRegime,
  buildFamilySignature,
};
