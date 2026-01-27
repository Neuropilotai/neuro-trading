/**
 * Walk-Forward Validator
 * Implements rolling window walk-forward validation
 * 
 * Process:
 * 1. Train on window 1, test on window 2
 * 2. Roll forward by step_days
 * 3. Repeat until end of data
 * 4. Detect performance degradation
 */

const backtestEngine = require('./backtestEngine');
const evaluationDb = require('../db/evaluationDb');

const crypto = require('crypto');

class WalkForwardValidator {
  constructor() {
    this.degradationThreshold = 0.2; // 20% drop in Sharpe ratio
  }

  /**
   * Generate deterministic ID from inputs
   */
  _generateDeterministicId(prefix, ...parts) {
    const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
    return `${prefix}_${hash.substring(0, 16)}`;
  }

  /**
   * Run walk-forward validation
   * @param {object} params - Walk-forward parameters
   * @returns {Promise<object>} - Walk-forward results
   */
  async runWalkForward(params) {
    const {
      strategy,
      symbol,
      timeframe,
      trainDays,
      testDays,
      stepDays,
      startDate,
      endDate,
      initialCapital = 10000
    } = params;

    // Validate
    if (!strategy || !symbol || !timeframe || !trainDays || !testDays || !stepDays) {
      throw new Error('Missing required parameters');
    }

    // Convert dates to timestamps
    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();
    const trainMs = trainDays * 24 * 60 * 60 * 1000;
    const testMs = testDays * 24 * 60 * 60 * 1000;
    const stepMs = stepDays * 24 * 60 * 60 * 1000;

    const folds = [];
    let currentStart = startTs;
    let foldNumber = 0;
    let consecutiveDegradation = 0; // Track consecutive degradation

    // Generate folds
    while (currentStart + trainMs + testMs <= endTs) {
      const trainStart = new Date(currentStart).toISOString();
      const trainEnd = new Date(currentStart + trainMs).toISOString();
      const testStart = new Date(currentStart + trainMs).toISOString();
      const testEnd = new Date(currentStart + trainMs + testMs).toISOString();

      // Run train backtest (for reference, not used for optimization)
      const trainResult = await backtestEngine.runBacktest({
        strategy: this._cloneStrategy(strategy),
        symbol,
        timeframe,
        startDate: trainStart,
        endDate: trainEnd,
        initialCapital
      });

      // Run test backtest (out-of-sample)
      const testResult = await backtestEngine.runBacktest({
        strategy: this._cloneStrategy(strategy),
        symbol,
        timeframe,
        startDate: testStart,
        endDate: testEnd,
        initialCapital
      });

      // Check for degradation
      const degradation = this._detectDegradation(trainResult, testResult);
      
      // Track consecutive degradation
      if (degradation) {
        consecutiveDegradation++;
      } else {
        consecutiveDegradation = 0;
      }
      
      // Degradation detected if 2+ consecutive folds show negative performance
      const degradationDetected = consecutiveDegradation >= 2;

      // Save fold (deterministic ID)
      const foldId = this._generateDeterministicId(
        'wf',
        strategy.id,
        symbol,
        timeframe,
        foldNumber.toString()
      );
      await evaluationDb.saveWalkForwardRun({
        id: foldId,
        strategyId: strategy.id,
        symbol,
        timeframe,
        trainStartDate: trainStart,
        trainEndDate: trainEnd,
        testStartDate: testStart,
        testEndDate: testEnd,
        stepDays,
        foldNumber,
        trainPerformance: {
          netProfitPct: trainResult.netProfitPct,
          sharpeRatio: trainResult.sharpeRatio,
          winRate: trainResult.winRate,
          maxDrawdownPct: trainResult.maxDrawdownPct
        },
        testPerformance: {
          netProfitPct: testResult.netProfitPct,
          sharpeRatio: testResult.sharpeRatio,
          winRate: testResult.winRate,
          maxDrawdownPct: testResult.maxDrawdownPct
        },
        degradationDetected: degradationDetected
      });

      folds.push({
        foldNumber,
        trainStart,
        trainEnd,
        testStart,
        testEnd,
        trainPerformance: trainResult,
        testPerformance: testResult,
        degradation
      });

      // Roll forward
      currentStart += stepMs;
      foldNumber++;
    }

    // Aggregate results
    const aggregate = this._aggregateResults(folds);

    return {
      strategy: strategy.id,
      symbol,
      timeframe,
      trainDays,
      testDays,
      stepDays,
      totalFolds: folds.length,
      folds,
      aggregate,
      degradationDetected: aggregate.degradationCount > 0
    };
  }

  /**
   * Detect performance degradation
   * Degradation if: test sharpe < 0 OR test net_profit_pct < 0 for 2 consecutive folds
   */
  _detectDegradation(trainResult, testResult) {
    // Check if test performance is negative
    const testSharpeNegative = testResult.sharpeRatio !== null && testResult.sharpeRatio < 0;
    const testProfitNegative = testResult.netProfitPct < 0;
    
    return testSharpeNegative || testProfitNegative;
  }

  /**
   * Aggregate fold results
   */
  _aggregateResults(folds) {
    const testSharpeRatios = folds
      .map(f => f.testPerformance.sharpeRatio)
      .filter(r => r !== null && !isNaN(r));
    const testWinRates = folds
      .map(f => f.testPerformance.winRate)
      .filter(r => r !== null && !isNaN(r));
    const testReturns = folds
      .map(f => f.testPerformance.netProfitPct)
      .filter(r => r !== null && !isNaN(r));

    const avgSharpe = testSharpeRatios.length > 0
      ? testSharpeRatios.reduce((sum, r) => sum + r, 0) / testSharpeRatios.length
      : null;
    const avgWinRate = testWinRates.length > 0
      ? testWinRates.reduce((sum, r) => sum + r, 0) / testWinRates.length
      : null;
    const avgReturn = testReturns.length > 0
      ? testReturns.reduce((sum, r) => sum + r, 0) / testReturns.length
      : null;

    const degradationCount = folds.filter(f => f.degradation).length;

    return {
      avgSharpeRatio: avgSharpe,
      avgWinRate,
      avgReturnPct: avgReturn,
      degradationCount,
      degradationRate: folds.length > 0 ? degradationCount / folds.length : 0
    };
  }

  /**
   * Clone strategy (reset state)
   */
  _cloneStrategy(strategy) {
    const StrategyClass = strategy.constructor;
    const cloned = new StrategyClass(strategy.getConfig());
    return cloned;
  }
}

module.exports = new WalkForwardValidator();

