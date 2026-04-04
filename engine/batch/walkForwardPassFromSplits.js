'use strict';

/**
 * Derives a boolean walk-forward pass from paired train/validation backtest rows.
 * Scoring matches engine/meta/runMetaPipeline.js `computeValidationScore` + `WALKFORWARD_PASS_THRESHOLD`
 * so batch rows and meta portfolio logic stay aligned.
 */

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round6(value) {
  const n = safeNum(value, NaN);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

/** Same table as runMetaPipeline.getMinValidationTradesForTimeframe */
function getMinValidationTradesForTimeframe(timeframe, opts = {}) {
  const override = safeNum(opts.minValidationTrades, NaN);
  if (Number.isFinite(override)) return Math.max(1, override);

  const envVal = process.env.WALKFORWARD_MIN_VALIDATION_TRADES;
  if (envVal && /^\d+$/.test(String(envVal).trim())) {
    return Math.max(1, parseInt(envVal, 10));
  }

  const tf = String(timeframe || '').toLowerCase().replace(/\s/g, '');
  const byTf = {
    '1m': 30,
    '2m': 25,
    '5m': 15,
    '15m': 12,
    '30m': 10,
    '1h': 8,
    '4h': 5,
    '1d': 4,
  };
  return Math.max(1, byTf[tf] || 10);
}

/**
 * Same formula as runMetaPipeline.computeValidationScore (read-only copy).
 */
function computeValidationScore(metrics, opts = {}) {
  const {
    validationExpectancy,
    validationTrades,
    validationWinRate,
    trainExpectancy,
    trainTrades,
  } = metrics;

  const timeframe = opts.timeframe || null;
  const minTrades = getMinValidationTradesForTimeframe(timeframe, opts);

  const weightExpectancy = safeNum(opts.weightExpectancy, 0.35);
  const weightTrades = safeNum(opts.weightTrades, 0.25);
  const weightWinRate = safeNum(opts.weightWinRate, 0.2);
  const weightDegradation = safeNum(opts.weightDegradation, 0.2);

  const exp = Number.isFinite(validationExpectancy) ? validationExpectancy : 0;
  const trades = Math.max(0, safeNum(validationTrades, 0));
  const wr = Number.isFinite(validationWinRate) ? Math.max(0, Math.min(1, validationWinRate)) : 0.5;

  const expectancyComponent = Math.max(0, Math.min(1, 0.5 + exp * 5));

  const tradesConfidence =
    minTrades <= 0 ? 1 : Math.min(1, trades / Math.max(minTrades * 2, 1));

  const winRateComponent = wr;

  let degradationComponent = 0.5;
  if (Number.isFinite(trainExpectancy) && Number.isFinite(validationExpectancy)) {
    const trainAbs = Math.max(0.01, Math.abs(trainExpectancy));
    const degradation = (validationExpectancy - trainExpectancy) / trainAbs;
    degradationComponent = Math.max(0, Math.min(1, 0.5 - degradation * 0.5));
  }

  const rawScore =
    weightExpectancy * expectancyComponent +
    weightTrades * tradesConfidence +
    weightWinRate * winRateComponent +
    weightDegradation * degradationComponent;

  return round6(Math.max(0, Math.min(1, rawScore)));
}

/**
 * @param {object} trainResult - row after attachWalkforwardMetadata (walkforwardSplit train)
 * @param {object} validationResult - row after attachWalkforwardMetadata (validation)
 * @param {{ timeframe?: string|null }} [opts]
 * @returns {boolean|undefined} undefined if pair is not a usable WF pair
 */
function deriveWalkForwardPassBoolean(trainResult, validationResult, opts = {}) {
  if (!trainResult || !validationResult || typeof trainResult !== 'object' || typeof validationResult !== 'object') {
    return undefined;
  }
  const tSplit = String(trainResult.walkforwardSplit || trainResult.datasetSplit || '').toLowerCase();
  const vSplit = String(validationResult.walkforwardSplit || validationResult.datasetSplit || '').toLowerCase();
  if (tSplit !== 'train' || vSplit !== 'validation') {
    return undefined;
  }
  if (trainResult.backtestInvalid === true || validationResult.backtestInvalid === true) {
    return false;
  }

  const metrics = {
    validationExpectancy: safeNum(validationResult.expectancy, 0),
    validationTrades: safeNum(validationResult.trades, 0),
    validationWinRate:
      validationResult.winRate != null && Number.isFinite(Number(validationResult.winRate))
        ? Number(validationResult.winRate)
        : null,
    trainExpectancy: safeNum(trainResult.expectancy, 0),
    trainTrades: safeNum(trainResult.trades, 0),
  };

  const score = computeValidationScore(metrics, { timeframe: opts.timeframe || null });
  const passThreshold = Math.max(
    0.3,
    Math.min(0.6, safeNum(process.env.WALKFORWARD_PASS_THRESHOLD, 0.45))
  );
  return score >= passThreshold;
}

module.exports = {
  deriveWalkForwardPassBoolean,
  computeValidationScore,
  getMinValidationTradesForTimeframe,
};
