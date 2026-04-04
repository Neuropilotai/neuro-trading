'use strict';

/**
 * Canonical research result contract for all backtest-producing modules.
 *
 * Every result row written to batch_results/ must be normalized through this file
 * so downstream modules (meta, evolution, correlation, portfolio) can rely on:
 * - stable identity / lineage fields
 * - stable metric fields
 * - stable coverage / validity fields
 * - stable provenance fields
 */

const DEFAULT_COVERAGE_THRESHOLD = 0.8;
const DEFAULT_REQUIRED_CANDLES = 0;

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value, fallback = null) {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s.length ? s : fallback;
}

function safeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function round6(value) {
  const n = safeNum(value, NaN);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

function computeCoverageRatio(loadedCandles, requiredCandles) {
  const loaded = Math.max(0, safeNum(loadedCandles, 0));
  const required = Math.max(0, safeNum(requiredCandles, 0));

  if (required <= 0) return 0;
  return round6(loaded / required);
}

function getInvalidReason(row, threshold = DEFAULT_COVERAGE_THRESHOLD) {
  const requiredCandles = Math.max(0, safeNum(row?.requiredCandles, 0));
  const loadedCandles = Math.max(0, safeNum(row?.loadedCandles, 0));
  const coverageRatio = computeCoverageRatio(loadedCandles, requiredCandles);

  if (safeBool(row?._stub, false)) {
    return 'stub_no_data';
  }

  if (requiredCandles <= 0) {
    return 'required_candles_missing';
  }

  if (loadedCandles <= 0) {
    return 'no_candles_loaded';
  }

  if (coverageRatio < safeNum(threshold, DEFAULT_COVERAGE_THRESHOLD)) {
    return 'coverage_below_threshold';
  }

  return null;
}

function isValidResult(row, threshold = DEFAULT_COVERAGE_THRESHOLD) {
  const explicitInvalid = safeBool(row?.backtestInvalid, false);
  if (explicitInvalid) return false;
  return getInvalidReason(row, threshold) === null;
}

function shapeResearchResultRow(row = {}, ctx = {}) {
  const input = safeObject(row, {});
  const context = safeObject(ctx, {});

  const requiredCandles = Math.max(
    0,
    safeNum(
      input.requiredCandles,
      safeNum(context.requiredCandles, DEFAULT_REQUIRED_CANDLES)
    )
  );

  const loadedCandles = Math.max(
    0,
    safeNum(
      input.loadedCandles,
      safeNum(context.loadedCandles, 0)
    )
  );

  const coverageRatio = computeCoverageRatio(loadedCandles, requiredCandles);

  const generatedAt =
    safeString(input.generatedAt) ||
    safeString(context.generatedAt) ||
    new Date().toISOString();

  const shaped = {
    setupId: safeString(input.setupId, 'unknown_setup'),
    name: safeString(input.name, null),

    rules: safeObject(input.rules, {}),

    source: safeString(input.source, safeString(context.source, 'grid')),
    generation: Math.max(0, safeNum(input.generation, safeNum(context.generation, 0))),
    parentSetupId: safeString(input.parentSetupId, null),
    parentFamilyId: safeString(input.parentFamilyId, null),
    mutationType: safeString(input.mutationType, null),

    expectancy:
      input.expectancy == null ? null : safeNum(input.expectancy, 0),
    trades: Math.max(0, safeNum(input.trades, 0)),
    winRate:
      input.winRate == null ? null : safeNum(input.winRate, 0),
    tradeReturns: safeArray(input.tradeReturns).map((x) => safeNum(x, 0)),

    drawdown:
      input.drawdown == null ? null : safeNum(input.drawdown, 0),

    requiredCandles,
    loadedCandles,
    coverageRatio,

    backtestInvalid: false,
    invalidReason: null,

    symbol: safeString(input.symbol, safeString(context.symbol, null)),
    timeframe: safeString(input.timeframe, safeString(context.timeframe, null)),
    dataGroup: safeString(input.dataGroup, safeString(context.dataGroup, null)),
    datasetVersionId: safeString(
      input.datasetVersionId,
      safeString(context.datasetVersionId, null)
    ),

    generatedAt,

    _fromTopK: safeBool(input._fromTopK, false),
    _stub: safeBool(input._stub, false),

    provenance: {
      producer: safeString(
        input?.provenance?.producer,
        safeString(context.producer, null)
      ),
      runId: safeString(
        input?.provenance?.runId,
        safeString(context.runId, null)
      ),
      experimentId: safeString(
        input?.provenance?.experimentId,
        safeString(context.experimentId, null)
      ),
      script: safeString(
        input?.provenance?.script,
        safeString(context.script, null)
      )
    }
  };

  const explicitInvalid = safeBool(input.backtestInvalid, false);
  const inferredInvalidReason =
    safeString(input.invalidReason, null) ||
    getInvalidReason(shaped, safeNum(context.coverageThreshold, DEFAULT_COVERAGE_THRESHOLD));

  shaped.invalidReason = inferredInvalidReason;
  shaped.backtestInvalid = explicitInvalid || inferredInvalidReason !== null;

  const walkForwardPassFields =
    input.walkForwardPass === true || input.walkForwardPass === false
      ? { walkForwardPass: input.walkForwardPass }
      : input.walk_forward_pass === true || input.walk_forward_pass === false
        ? { walkForwardPass: input.walk_forward_pass === true }
        : {};

  return {
    ...shaped,
    ...walkForwardPassFields,
    walkforwardSplit:
      row && typeof row.walkforwardSplit === 'string' ? row.walkforwardSplit : null,
    datasetSplit:
      row && typeof row.datasetSplit === 'string' ? row.datasetSplit : null,
    isValidation: row && row.isValidation === true ? true : false,
    splitTrainRatio: Number.isFinite(Number(row && row.splitTrainRatio))
      ? Number(row.splitTrainRatio)
      : null,
    splitCandles: Number.isFinite(Number(row && row.splitCandles))
      ? Number(row.splitCandles)
      : 0,
    totalCandles: Number.isFinite(Number(row && row.totalCandles))
      ? Number(row.totalCandles)
      : Number.isFinite(Number(context && context.loadedCandles))
        ? Number(context.loadedCandles)
        : 0,
  };
}

module.exports = {
  DEFAULT_COVERAGE_THRESHOLD,
  DEFAULT_REQUIRED_CANDLES,
  computeCoverageRatio,
  getInvalidReason,
  isValidResult,
  shapeResearchResultRow
};
