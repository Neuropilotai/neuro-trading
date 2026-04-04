'use strict';

/**
 * NeuroPilot Quant Engine v1 — Policy-Aware Backtest Runner
 *
 * Replays historical OHLCV bar-by-bar using the adaptive pipeline; then generates
 * journal records, performance analysis, ranking, and research report. Pure function;
 * no database writes, no broker interaction.
 *
 * Flow:
 *   1. First pass: signal-only backtest → records → analysis → ranking (for policy input).
 *   2. Second pass: at each bar run adaptivePipeline(candles, account, ranking) → adaptive signal → journal record (+ finalDecision).
 *   3. Analyze adaptive records → ranking → research report.
 *
 * Inputs:
 *   - candles, account, symbol, timeframe
 *   - options: optional { pipeline, adaptive, startIndex, minBars, barTimestamp, reportMetadata }
 *
 * Output:
 *   - { totalBars, totalAdaptiveSignals, validAdaptiveSignals, allowedSignals, blockedSignals, records, analysis, ranking, report }
 */

const backtestRunner = require('./backtestRunner');
const adaptivePipeline = require('./adaptivePipeline');
const journal = require('./journal');
const performanceAnalyzer = require('./performanceAnalyzer');
const strategyRanking = require('./strategyRanking');
const researchReport = require('./researchReport');

/**
 * Count records where policy allowed the signal (finalDecision !== 'block').
 * Records must have finalDecision set (e.g. from adaptive backtest).
 *
 * @param {Array<object>} records - Journal records with finalDecision
 * @returns {number}
 */
function countAllowedSignals(records) {
  if (!Array.isArray(records)) return 0;
  return records.filter((r) => r.finalDecision != null && r.finalDecision !== 'block').length;
}

/**
 * Count records where policy blocked the signal (finalDecision === 'block').
 *
 * @param {Array<object>} records - Journal records with finalDecision
 * @returns {number}
 */
function countBlockedSignals(records) {
  if (!Array.isArray(records)) return 0;
  return records.filter((r) => r.finalDecision === 'block').length;
}

/**
 * Run policy-aware backtest: two-pass replay with adaptive pipeline, then analysis + ranking + report. Pure function.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {object} account - Account state (not mutated)
 * @param {string} symbol - Instrument symbol (e.g. "XAUUSD")
 * @param {string} timeframe - Bar timeframe (e.g. "2m")
 * @param {object} [options] - { pipeline, adaptive, startIndex, minBars, barTimestamp, reportMetadata }
 * @returns {object} { totalBars, totalAdaptiveSignals, validAdaptiveSignals, allowedSignals, blockedSignals, records, analysis, ranking, report }
 */
function run(candles, account, symbol, timeframe, options = {}) {
  const opts = options || {};
  const minBars = typeof opts.minBars === 'number' && opts.minBars >= 0 ? opts.minBars : backtestRunner.DEFAULT_MIN_BARS;
  const startIndex = typeof opts.startIndex === 'number' && opts.startIndex >= 0 ? opts.startIndex : minBars;
  const pipelineOptions = opts.pipeline != null ? opts.pipeline : {};
  const adaptiveOptions = opts.adaptive != null ? opts.adaptive : {};
  const barTs = opts.barTimestamp || {};
  const baseMs = barTs.baseMs != null ? barTs.baseMs : 0;
  const intervalMs = barTs.intervalMs != null ? barTs.intervalMs : 1;
  const reportMetadata = opts.reportMetadata != null ? opts.reportMetadata : {};

  const totalBars = Array.isArray(candles) ? candles.length : 0;

  const emptyResult = {
    totalBars,
    totalAdaptiveSignals: 0,
    validAdaptiveSignals: 0,
    allowedSignals: 0,
    blockedSignals: 0,
    records: [],
    analysis: performanceAnalyzer.analyze([]),
    ranking: strategyRanking.rank(null),
    report: researchReport.generate(null, null, { ...reportMetadata, symbol, timeframe }),
  };

  if (totalBars === 0 || startIndex >= totalBars) {
    return emptyResult;
  }

  // 1. First pass: signal-only backtest to get ranking
  const backtestOpts = {
    pipeline: pipelineOptions,
    startIndex,
    minBars,
    barTimestamp: opts.barTimestamp,
  };
  const firstPass = backtestRunner.run(candles, account, symbol, timeframe, backtestOpts);
  const analysisForRanking = performanceAnalyzer.analyze(firstPass.records);
  const ranking = strategyRanking.rank(analysisForRanking);

  // 2. Second pass: adaptive pipeline at each bar → records with finalDecision
  const adaptiveRecords = [];
  for (let i = startIndex; i < totalBars; i++) {
    const adaptiveSignal = adaptivePipeline.run(candles, account, ranking, {
      pipeline: pipelineOptions,
      adaptive: adaptiveOptions,
    }, i);
    const fallbackMs = baseMs + (i - startIndex) * intervalMs;
    const barTime = backtestRunner.getBarTimestamp
      ? backtestRunner.getBarTimestamp(candles[i], i, fallbackMs)
      : (fallbackMs != null ? fallbackMs + i : null);
    const record = journal.toRecord(adaptiveSignal, symbol, timeframe, barTime != null ? barTime : undefined);
    record.finalDecision = adaptiveSignal.finalDecision != null ? adaptiveSignal.finalDecision : 'block';
    adaptiveRecords.push(record);
  }

  const totalAdaptiveSignals = adaptiveRecords.length;
  const validAdaptiveSignals = adaptiveRecords.filter((r) => r.valid === true).length;
  const allowedSignals = countAllowedSignals(adaptiveRecords);
  const blockedSignals = countBlockedSignals(adaptiveRecords);

  // 3. Analyze adaptive records, re-rank, generate report
  const analysis = performanceAnalyzer.analyze(adaptiveRecords);
  const rankingOut = strategyRanking.rank(analysis);
  const report = researchReport.generate(analysis, rankingOut, {
    ...reportMetadata,
    symbol,
    timeframe,
  });

  return {
    totalBars,
    totalAdaptiveSignals,
    validAdaptiveSignals,
    allowedSignals,
    blockedSignals,
    records: adaptiveRecords,
    analysis,
    ranking: rankingOut,
    report,
  };
}

module.exports = {
  run,
  countAllowedSignals,
  countBlockedSignals,
};
