'use strict';

/**
 * NeuroPilot Quant Engine v1 — Quality-Aware Adaptive Backtest Runner
 *
 * Replays historical OHLCV bar-by-bar using qualityAdaptivePipeline, then generates
 * journal records, performance analysis, ranking, and research report. Pure function;
 * no database writes, no broker interaction.
 *
 * Flow:
 *   1. First pass: signal-only backtest -> records -> analysis -> ranking (bootstrap).
 *   2. Second pass: qualityAdaptivePipeline per bar -> journal records (+ finalDecision, qualityDecision).
 *   3. Analyze quality-aware records -> ranking -> research report.
 */

const path = require('path');
const fs = require('fs');
const backtestRunner = require('./backtestRunner');
const qualityAdaptivePipeline = require('./qualityAdaptivePipeline');
const journal = require('./journal');
const performanceAnalyzer = require('./performanceAnalyzer');
const strategyRanking = require('./strategyRanking');
const researchReport = require('./researchReport');
const breakoutConfirmationFilter = require('./breakoutConfirmationFilter');
const breakoutStrengthFilter = require('./breakoutStrengthFilter');

/** Default path for debug export of allowed signals (when debugExportAllowedSignals is enabled). */
const DEFAULT_DEBUG_EXPORT_PATH = path.join(__dirname, '..', 'research', 'allowed_signals_debug.json');

/**
 * Count records where final decision is not blocked.
 *
 * @param {Array<object>} records - Journal records with finalDecision
 * @returns {number}
 */
function countAllowedSignals(records) {
  if (!Array.isArray(records)) return 0;
  return records.filter((r) => r.finalDecision != null && r.finalDecision !== 'block').length;
}

/**
 * Count records where final decision is blocked.
 *
 * @param {Array<object>} records - Journal records with finalDecision
 * @returns {number}
 */
function countBlockedSignals(records) {
  if (!Array.isArray(records)) return 0;
  return records.filter((r) => r.finalDecision === 'block').length;
}

/**
 * Build quality context for current bar.
 * Allows either:
 *   - static context object via options.qualityContext
 *   - dynamic function via options.qualityContextProvider({ index, candle, symbol, timeframe, priorSignals, staticContext })
 * Prior signals are provided as lightweight entries for cooldown checks.
 *
 * @param {object} params
 * @returns {object}
 */
function buildQualityContext(params) {
  const staticContext = params.qualityContext && typeof params.qualityContext === 'object'
    ? params.qualityContext
    : {};
  const provider = typeof params.qualityContextProvider === 'function' ? params.qualityContextProvider : null;

  if (!provider) {
    return {
      ...staticContext,
      symbol: params.symbol,
      nowMs: params.barTime,
      recentSignals: Array.isArray(params.priorSignals) ? params.priorSignals : [],
    };
  }

  const provided = provider({
    index: params.index,
    candle: params.candle,
    symbol: params.symbol,
    timeframe: params.timeframe,
    barTime: params.barTime,
    priorSignals: Array.isArray(params.priorSignals) ? params.priorSignals : [],
    staticContext,
  });
  const ctx = provided && typeof provided === 'object' ? provided : {};
  return {
    ...ctx,
    symbol: ctx.symbol != null ? ctx.symbol : params.symbol,
    nowMs: ctx.nowMs != null ? ctx.nowMs : params.barTime,
    recentSignals: Array.isArray(ctx.recentSignals) ? ctx.recentSignals : (Array.isArray(params.priorSignals) ? params.priorSignals : []),
  };
}

/**
 * Run quality-aware adaptive backtest.
 *
 * @param {Array<object>} candles - OHLCV bars (oldest first)
 * @param {object} account - Account state (not mutated)
 * @param {string} symbol - Instrument symbol (e.g. "QQQ")
 * @param {string} timeframe - Bar timeframe (e.g. "1m")
 * @param {object} [options] - { pipeline, adaptive, qualityGate, qualityContext, qualityContextProvider, startIndex, minBars, barTimestamp, reportMetadata, debugExportAllowedSignals, debugCollectOnly, includeStrategies }
 *   - debugExportAllowedSignals: true | string — if set (and not debugCollectOnly), write allowed-signal debug rows to path (true = research/allowed_signals_debug.json)
 *   - debugCollectOnly: true — when set by multiAssetRunner, build and attach result.allowedSignalsDebug but do not write (multi-asset path aggregates and writes once)
 *   - includeStrategies: string[] — if set, only signals whose strategy is in this array count as allowed (e.g. ['trend_breakout']); others are forced to block
 *   - includeRegimes: string[] — if set, only signals whose `regime` is in this array count as allowed (e.g. ['BREAKOUT']); others are forced to block
 *   - breakoutConfirmation: boolean — if true, trend_breakout signals require one-bar confirmation (previous bar in trend/breakout regime)
 *   - breakoutStrengthFilter: boolean — if true, trend_breakout signals require strong breakout candle (body >= 60%, closeStrength >= 0.7)
 *   - excludeSessionOpenMinutes: number — if > 0, block signals in the first N minutes of US session (9:30 ET = 14:30 UTC). e.g. 30 = no trades 09:30–10:00
 *   - allowSessionBuckets: string[] — if set (e.g. ['late']), only allow signals whose bar time falls in one of these session buckets (open/mid/late). US session 14:30–21:00 UTC; late = last 60 min. Use ['late'] for "late only" when late holds better than mid.
 * @returns {object} { totalBars, totalAdaptiveSignals, validAdaptiveSignals, allowedSignals, blockedSignals, records, analysis, ranking, report [, allowedSignalsDebug ] }
 */
function run(candles, account, symbol, timeframe, options = {}) {
  const opts = options || {};
  const minBars = typeof opts.minBars === 'number' && opts.minBars >= 0 ? opts.minBars : backtestRunner.DEFAULT_MIN_BARS;
  const startIndex = typeof opts.startIndex === 'number' && opts.startIndex >= 0 ? opts.startIndex : minBars;
  const pipelineOptions = opts.pipeline != null ? opts.pipeline : {};
  const adaptiveOptions = opts.adaptive != null ? opts.adaptive : {};
  const qualityGateOptions = opts.qualityGate != null ? opts.qualityGate : {};
  const barTs = opts.barTimestamp || {};
  const baseMs = barTs.baseMs != null ? barTs.baseMs : 0;
  const intervalMs = barTs.intervalMs != null ? barTs.intervalMs : 1;
  const reportMetadata = opts.reportMetadata != null ? opts.reportMetadata : {};

  const totalBars = Array.isArray(candles) ? candles.length : 0;
  const debugCollectOnly = opts.debugCollectOnly === true;
  const debugBuildList = Boolean(opts.debugExportAllowedSignals || debugCollectOnly);
  const debugWritePath = debugBuildList && !debugCollectOnly
    ? (opts.debugExportAllowedSignals === true ? DEFAULT_DEBUG_EXPORT_PATH : (typeof opts.debugExportAllowedSignals === 'string' ? opts.debugExportAllowedSignals : null))
    : null;

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

  // 1) First pass bootstrap: signal-only backtest -> ranking
  const firstPass = backtestRunner.run(candles, account, symbol, timeframe, {
    pipeline: pipelineOptions,
    startIndex,
    minBars,
    barTimestamp: opts.barTimestamp,
  });
  const bootstrapAnalysis = performanceAnalyzer.analyze(firstPass.records);
  const bootstrapRanking = strategyRanking.rank(bootstrapAnalysis);

  // 2) Second pass: quality-aware adaptive pipeline per bar
  const records = [];
  const priorSignals = [];
  const allowedSignalsDebug = [];
  // One signal per setup: block consecutive allowed signals unless regime or strategy changes.
  const lastAllowedKey = `${symbol}|${timeframe}`;
  const lastAllowedByKey = { [lastAllowedKey]: null }; // { barIndex, regime, strategy } or null

  for (let i = startIndex; i < totalBars; i++) {
    const fallbackMs = baseMs + (i - startIndex) * intervalMs;
    const barTime = backtestRunner.getBarTimestamp
      ? backtestRunner.getBarTimestamp(candles[i], i, fallbackMs)
      : (fallbackMs != null ? fallbackMs + i : null);

    const context = buildQualityContext({
      index: i,
      candle: candles[i],
      symbol,
      timeframe,
      barTime,
      priorSignals,
      qualityContext: opts.qualityContext,
      qualityContextProvider: opts.qualityContextProvider,
    });

    const adaptiveSignal = qualityAdaptivePipeline.run(
      candles,
      account,
      bootstrapRanking,
      context,
      {
        adaptivePipeline: {
          pipeline: pipelineOptions,
          adaptive: adaptiveOptions,
        },
        qualityGate: qualityGateOptions,
      },
      i
    );

    const record = journal.toRecord(adaptiveSignal, symbol, timeframe, barTime != null ? barTime : undefined);
    record.finalDecision = adaptiveSignal.finalDecision != null ? adaptiveSignal.finalDecision : 'block';
    record.qualityDecision = adaptiveSignal.qualityDecision || null;

    // Strategy allowlist: if includeStrategies is set, only those strategies can be allowed.
    if (record.finalDecision != null && record.finalDecision !== 'block' &&
        Array.isArray(opts.includeStrategies) && opts.includeStrategies.length > 0) {
      const set = new Set(opts.includeStrategies.map((s) => String(s)));
      if (!set.has(String(record.strategy))) {
        record.finalDecision = 'block';
      }
    }

    // Breakout confirmation: trend_breakout only allowed if previous bar was in trend/breakout regime.
    if (record.finalDecision != null && record.finalDecision !== 'block' && opts.breakoutConfirmation === true &&
        record.strategy === breakoutConfirmationFilter.TREND_BREAKOUT_STRATEGY) {
      const confirm = breakoutConfirmationFilter.evaluate(candles, i, record.strategy, {
        requireOneBarConfirmation: true,
        minBars,
      });
      if (!confirm.confirmed) {
        record.finalDecision = 'block';
      }
    }

    // Breakout strength: trend_breakout only allowed when breakout candle has strong momentum (body/range, close in extreme).
    if (record.finalDecision != null && record.finalDecision !== 'block' && opts.breakoutStrengthFilter === true &&
        record.strategy === breakoutStrengthFilter.TREND_BREAKOUT_STRATEGY && (record.direction === 'long' || record.direction === 'short')) {
      const strength = breakoutStrengthFilter.evaluate(candles, i, record.direction, {});
      if (!strength.passed) {
        record.finalDecision = 'block';
      }
    }

    // Regime allowlist: if includeRegimes is set, only those regimes can be allowed.
    if (
      record.finalDecision != null &&
      record.finalDecision !== 'block' &&
      Array.isArray(opts.includeRegimes) &&
      opts.includeRegimes.length > 0
    ) {
      const allowedRegimes = new Set(opts.includeRegimes.map((r) => String(r)));
      const regimeName = record.regime != null ? String(record.regime) : '';
      if (!allowedRegimes.has(regimeName)) {
        record.finalDecision = 'block';
      }
    }

    // Exclude session open: no trades in first N minutes of US session (14:30 UTC = 9:30 ET).
    const excludeOpenMin = typeof opts.excludeSessionOpenMinutes === 'number' && opts.excludeSessionOpenMinutes > 0
      ? opts.excludeSessionOpenMinutes
      : 0;
    if (record.finalDecision != null && record.finalDecision !== 'block' && excludeOpenMin > 0 && barTime != null && Number.isFinite(barTime)) {
      const d = new Date(barTime);
      const minutesFromMidnightUtc = d.getUTCHours() * 60 + d.getUTCMinutes();
      const sessionStartUtc = 14 * 60 + 30;
      if (minutesFromMidnightUtc >= sessionStartUtc && minutesFromMidnightUtc < sessionStartUtc + excludeOpenMin) {
        record.finalDecision = 'block';
      }
    }

    // Session bucket allowlist (e.g. late only): only allow signals in allowed buckets (open/mid/late). Aligns with tradeSimulation session breakdown.
    const allowBuckets = Array.isArray(opts.allowSessionBuckets) && opts.allowSessionBuckets.length > 0 ? opts.allowSessionBuckets : null;
    if (record.finalDecision != null && record.finalDecision !== 'block' && allowBuckets && barTime != null && Number.isFinite(barTime)) {
      const d = new Date(barTime);
      const minutesFromMidnightUtc = d.getUTCHours() * 60 + d.getUTCMinutes();
      const sessionStartUtc = 14 * 60 + 30;
      const sessionEndUtc = 21 * 60 + 0;
      const openLen = 60;
      const lateLen = 60;
      if (minutesFromMidnightUtc < sessionStartUtc || minutesFromMidnightUtc >= sessionEndUtc) {
        record.finalDecision = 'block';
      } else {
        const minutesIntoSession = minutesFromMidnightUtc - sessionStartUtc;
        const sessionLength = sessionEndUtc - sessionStartUtc;
        const bucket = minutesIntoSession < openLen ? 'open' : (minutesIntoSession >= sessionLength - lateLen ? 'late' : 'mid');
        if (!allowBuckets.includes(bucket)) {
          record.finalDecision = 'block';
        }
      }
    } else if (record.finalDecision != null && record.finalDecision !== 'block' && allowBuckets && (barTime == null || !Number.isFinite(barTime))) {
      record.finalDecision = 'block';
    }

    // Consecutive-signal guard: only one signal per setup; block if previous bar already allowed same regime/strategy.
    const lastAllowed = lastAllowedByKey[lastAllowedKey];
    if (record.finalDecision != null && record.finalDecision !== 'block') {
      const consecutiveSameSetup = lastAllowed != null &&
        lastAllowed.barIndex === i - 1 &&
        record.regime === lastAllowed.regime &&
        record.strategy === lastAllowed.strategy;
      if (consecutiveSameSetup) {
        record.finalDecision = 'block';
      } else {
        lastAllowedByKey[lastAllowedKey] = { barIndex: i, regime: record.regime, strategy: record.strategy };
      }
    }

    records.push(record);

    if (debugBuildList && record.finalDecision != null && record.finalDecision !== 'block') {
      const candle = candles[i];
      const rawBarTime = candle && (candle.time ?? candle.timestamp ?? candle.t);
      // Use only real candle timestamps (ms >= 1e12 or seconds >= 1e9). Do not use bar index as time.
      const ms = rawBarTime == null ? NaN : (typeof rawBarTime === 'number' ? rawBarTime : new Date(rawBarTime).getTime());
      const realTimeMs = Number.isFinite(ms) && (ms >= 1e12 || (ms >= 1e9 && ms < 1e12))
        ? (ms >= 1e12 ? ms : ms * 1000)
        : null;
      const debugTimestamp = realTimeMs != null ? new Date(realTimeMs).toISOString() : null;
      const entryPrice = adaptiveSignal.features && typeof adaptiveSignal.features.price === 'number'
        ? adaptiveSignal.features.price
        : (adaptiveSignal.tradeDecision && typeof adaptiveSignal.tradeDecision.entryPrice === 'number'
          ? adaptiveSignal.tradeDecision.entryPrice
          : null);
      allowedSignalsDebug.push({
        symbol: record.symbol,
        timeframe: record.timeframe,
        timestamp: debugTimestamp,
        barIndex: i,
        direction: record.direction != null ? record.direction : null,
        strategy: record.strategy != null ? record.strategy : null,
        regime: record.regime != null ? record.regime : null,
        finalConfidence: adaptiveSignal.finalConfidence != null ? adaptiveSignal.finalConfidence : null,
        regimeConfidence: record.regimeConfidence != null ? record.regimeConfidence : (adaptiveSignal.regime && adaptiveSignal.regime.confidence),
        strategyConfidence: record.strategyConfidence != null ? record.strategyConfidence : (adaptiveSignal.tradeDecision && adaptiveSignal.tradeDecision.confidence) ?? (adaptiveSignal.strategyDecision && adaptiveSignal.strategyDecision.confidence),
        entryPrice,
        stopDistance: record.stopDistance != null ? record.stopDistance : (adaptiveSignal.sizingDecision && adaptiveSignal.sizingDecision.stopDistance),
        reason: record.reason,
      });
    }

    // Keep only accepted signals in cooldown history.
    // This prevents over-aggressive "binary" behavior from counting blocked/no-trade bars.
    const qualityPassed = Boolean(record.qualityDecision && record.qualityDecision.shouldPass === true);
    const allowedFinalDecision = record.finalDecision != null && record.finalDecision !== 'block';
    if (qualityPassed || allowedFinalDecision) {
      priorSignals.push({
        symbol,
        timeMs: barTime != null ? barTime : undefined,
        finalDecision: record.finalDecision,
        qualityAction: record.qualityDecision && record.qualityDecision.qualityAction,
      });
    }
  }

  const totalAdaptiveSignals = records.length;
  const validAdaptiveSignals = records.filter((r) => r.valid === true).length;
  const allowedSignals = countAllowedSignals(records);
  const blockedSignals = countBlockedSignals(records);

  if (debugWritePath && allowedSignalsDebug.length > 0) {
    const dir = path.dirname(debugWritePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(debugWritePath, JSON.stringify(allowedSignalsDebug, null, 2), 'utf8');
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[qualityAdaptiveBacktestRunner] debugExportAllowedSignals write failed:', err && err.message);
      }
    }
  }

  // 3) Analyze quality-aware records and build report.
  const analysis = performanceAnalyzer.analyze(records);
  const ranking = strategyRanking.rank(analysis);
  const report = researchReport.generate(analysis, ranking, {
    ...reportMetadata,
    symbol,
    timeframe,
  });

  const out = {
    totalBars,
    totalAdaptiveSignals,
    validAdaptiveSignals,
    allowedSignals,
    blockedSignals,
    records,
    analysis,
    ranking,
    report,
  };
  if (debugBuildList) out.allowedSignalsDebug = allowedSignalsDebug;
  return out;
}

module.exports = {
  run,
  countAllowedSignals,
  countBlockedSignals,
  buildQualityContext,
  DEFAULT_DEBUG_EXPORT_PATH,
};
