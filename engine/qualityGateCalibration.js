'use strict';

/**
 * NeuroPilot Quant Engine v1 — Quality Gate Calibration
 *
 * Runs repeated quality-aware backtests for multiple Signal Quality Gate threshold
 * configurations and returns comparable aggregate metrics.
 * Pure orchestration; no database writes, no broker interaction.
 */

const qualityAdaptiveBacktestRunner = require('./qualityAdaptiveBacktestRunner');

const CALIBRATION_KEYS = Object.freeze([
  'minFinalConfidence',
  'minRegimeConfidence',
  'minStrategyConfidence',
  'cooldownMs',
  'minStopDistancePct',
  'maxStopDistancePct',
]);

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

/**
 * Keep only known calibration keys and numeric values.
 *
 * @param {object} config - Candidate quality gate config
 * @returns {object}
 */
function normalizeCalibrationConfig(config) {
  const src = config && typeof config === 'object' ? config : {};
  const out = {};
  for (const key of CALIBRATION_KEYS) {
    if (isFiniteNumber(src[key])) out[key] = Number(src[key]);
  }
  return out;
}

/**
 * Build Cartesian grid from arrays of candidate values.
 *
 * @param {object} space - { minFinalConfidence: [..], cooldownMs: [..], ... }
 * @returns {Array<object>} List of configs
 */
function buildConfigGrid(space = {}) {
  const axes = [];
  for (const key of CALIBRATION_KEYS) {
    const vals = Array.isArray(space[key]) ? space[key].filter(isFiniteNumber).map(Number) : [];
    if (vals.length > 0) {
      axes.push({ key, values: vals });
    }
  }
  if (axes.length === 0) return [];

  const out = [{}];
  for (const axis of axes) {
    const next = [];
    for (const base of out) {
      for (const val of axis.values) {
        next.push({ ...base, [axis.key]: val });
      }
    }
    out.splice(0, out.length, ...next);
  }
  return out;
}

/**
 * Aggregate core metrics from quality-aware backtest runs.
 *
 * @param {Array<object>} runs - [{ symbol, timeframe, result }]
 * @returns {{ totalAdaptiveSignals: number, validAdaptiveSignals: number, allowedSignals: number, blockedSignals: number }}
 */
function aggregateRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  return list.reduce((acc, run) => {
    const r = run && run.result && typeof run.result === 'object' ? run.result : {};
    acc.totalAdaptiveSignals += isFiniteNumber(r.totalAdaptiveSignals) ? Number(r.totalAdaptiveSignals) : 0;
    acc.validAdaptiveSignals += isFiniteNumber(r.validAdaptiveSignals) ? Number(r.validAdaptiveSignals) : 0;
    acc.allowedSignals += isFiniteNumber(r.allowedSignals) ? Number(r.allowedSignals) : 0;
    acc.blockedSignals += isFiniteNumber(r.blockedSignals) ? Number(r.blockedSignals) : 0;
    return acc;
  }, { totalAdaptiveSignals: 0, validAdaptiveSignals: 0, allowedSignals: 0, blockedSignals: 0 });
}

/**
 * Run calibration for each threshold config across all datasets.
 *
 * @param {Array<{ symbol: string, timeframe: string, candles: Array }>} datasets - Research datasets
 * @param {object} account - Account state for risk sizing
 * @param {Array<object>} configs - Quality gate threshold configurations to compare
 * @param {object} [options] - { backtest?: object, sortByAllowedRateDesc?: boolean, includeRuns?: boolean }
 * @returns {Array<object>} Comparable calibration results
 */
function runCalibration(datasets, account, configs, options = {}) {
  const list = Array.isArray(datasets) ? datasets : [];
  const cfgs = Array.isArray(configs) ? configs : [];
  const opts = options && typeof options === 'object' ? options : {};
  const includeRuns = opts.includeRuns === true;
  const sortByAllowedRateDesc = opts.sortByAllowedRateDesc !== false;
  const backtestBase = opts.backtest && typeof opts.backtest === 'object' ? opts.backtest : {};
  const baseQualityGate = backtestBase.qualityGate && typeof backtestBase.qualityGate === 'object'
    ? backtestBase.qualityGate
    : {};

  const out = [];
  for (const rawConfig of cfgs) {
    const config = normalizeCalibrationConfig(rawConfig);
    const qualityGate = { ...baseQualityGate, ...config };
    const runs = [];

    for (const ds of list) {
      const symbol = ds && ds.symbol != null ? String(ds.symbol) : 'UNKNOWN';
      const timeframe = ds && ds.timeframe != null ? String(ds.timeframe) : 'unknown';
      const candles = ds && Array.isArray(ds.candles) ? ds.candles : [];
      const result = qualityAdaptiveBacktestRunner.run(candles, account, symbol, timeframe, {
        ...backtestBase,
        qualityGate,
      });
      runs.push({ symbol, timeframe, result });
    }

    const agg = aggregateRuns(runs);
    const allowedRate = agg.totalAdaptiveSignals > 0
      ? agg.allowedSignals / agg.totalAdaptiveSignals
      : 0;

    out.push({
      config,
      totalAdaptiveSignals: agg.totalAdaptiveSignals,
      validAdaptiveSignals: agg.validAdaptiveSignals,
      allowedSignals: agg.allowedSignals,
      blockedSignals: agg.blockedSignals,
      allowedRate: Number(allowedRate.toFixed(6)),
      ...(includeRuns ? { runs } : {}),
    });
  }

  if (sortByAllowedRateDesc) {
    out.sort((a, b) => {
      if (b.allowedRate !== a.allowedRate) return b.allowedRate - a.allowedRate;
      return b.allowedSignals - a.allowedSignals;
    });
  }

  return out;
}

module.exports = {
  runCalibration,
  buildConfigGrid,
  normalizeCalibrationConfig,
  aggregateRuns,
  CALIBRATION_KEYS,
};
