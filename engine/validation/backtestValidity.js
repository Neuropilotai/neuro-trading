'use strict';

const {
  DEFAULT_COVERAGE_THRESHOLD,
  computeCoverageRatio
} = require('../contracts/researchResultContract');

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampMin(value, minValue = 0) {
  return Math.max(minValue, safeNum(value, minValue));
}

function computeBacktestValidity(input = {}, opts = {}) {
  const requiredCandles = clampMin(
    input.requiredCandles != null ? input.requiredCandles : opts.requiredCandles,
    0
  );

  const loadedCandles = clampMin(
    input.loadedCandles != null ? input.loadedCandles : opts.loadedCandles,
    0
  );

  const threshold = safeNum(
    opts.coverageThreshold,
    DEFAULT_COVERAGE_THRESHOLD
  );

  const coverageRatio = computeCoverageRatio(loadedCandles, requiredCandles);

  let invalidReason = null;

  if (requiredCandles <= 0) {
    invalidReason = 'required_candles_missing';
  } else if (loadedCandles <= 0) {
    invalidReason = 'no_candles_loaded';
  } else if (coverageRatio < threshold) {
    invalidReason = 'coverage_below_threshold';
  }

  return {
    requiredCandles,
    loadedCandles,
    coverageRatio,
    coverageThreshold: threshold,
    backtestInvalid: invalidReason !== null,
    invalidReason
  };
}

function isBacktestValid(input = {}, opts = {}) {
  return !computeBacktestValidity(input, opts).backtestInvalid;
}

function assertBacktestValid(input = {}, opts = {}) {
  const validity = computeBacktestValidity(input, opts);

  if (validity.backtestInvalid) {
    const err = new Error(
      `Invalid backtest: ${validity.invalidReason} ` +
      `(loadedCandles=${validity.loadedCandles}, requiredCandles=${validity.requiredCandles}, coverageRatio=${validity.coverageRatio})`
    );
    err.code = 'INVALID_BACKTEST';
    err.details = validity;
    throw err;
  }

  return validity;
}

module.exports = {
  computeBacktestValidity,
  isBacktestValid,
  assertBacktestValid
};
