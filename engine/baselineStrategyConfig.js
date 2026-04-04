'use strict';

/**
 * NeuroPilot Quant Engine v1 — Baseline Strategy Configuration
 *
 * Documents and exposes the current best baseline strategy profile for research.
 * Modular and reversible: change these values to shift baseline without touching callers.
 *
 * Current best baseline (as of config):
 *   - Symbol: SPY, Timeframe: 5m
 *   - Strategy: trend_breakout only
 *   - No one-bar confirmation, no breakout strength filter
 *   - Target: 2R (trade simulation)
 */

/** Baseline symbol for trade simulation and reporting. */
const BASELINE_SYMBOL = 'SPY';

/** Baseline timeframe for trade simulation and reporting. */
const BASELINE_TIMEFRAME = '5m';

/**
 * Dataset group that includes the baseline symbol/timeframe.
 * spy_only = SPY 1m + 5m (use with trade sim on SPY 5m).
 */
const BASELINE_GROUP = 'spy_only';

/**
 * Multi-asset options for the baseline research run.
 * Explicitly set confirmation and strength filter off for reproducibility.
 */
const BASELINE_MULTI_ASSET = Object.freeze({
  includeStrategies: ['trend_breakout'],
  breakoutConfirmation: false,
  breakoutStrengthFilter: false,
  debugExportAllowedSignals: true,
});

/**
 * Return research run options for the baseline profile.
 * Merge with runResearchFromConfig.run(BASELINE_GROUP, getBaselineResearchOptions()).
 * Includes batchLoader.loader.synthesizeTimestampsFromIndex so SPY/QQQ bar-index-like
 * timestamps are synthesized for meaningful sessionPerformanceBreakdown (open/mid/late).
 *
 * @returns {{ research: { multiAsset: object }, batchLoader: { loader: object } }}
 */
function getBaselineResearchOptions() {
  return {
    research: {
      multiAsset: {
        ...BASELINE_MULTI_ASSET,
      },
    },
    batchLoader: {
      loader: {
        synthesizeTimestampsFromIndex: true,
      },
    },
  };
}

/**
 * Resolve group name: 'baseline' -> BASELINE_GROUP, otherwise return as-is.
 *
 * @param {string} [groupName] - Requested group (e.g. 'baseline', 'us_indices_core')
 * @returns {{ group: string, isBaseline: boolean }}
 */
function resolveBaselineGroup(groupName) {
  const name = groupName != null ? String(groupName).trim() : '';
  if (name.toLowerCase() === 'baseline') {
    return { group: BASELINE_GROUP, isBaseline: true };
  }
  return { group: name, isBaseline: false };
}

module.exports = {
  BASELINE_SYMBOL,
  BASELINE_TIMEFRAME,
  BASELINE_GROUP,
  BASELINE_MULTI_ASSET,
  getBaselineResearchOptions,
  resolveBaselineGroup,
};
