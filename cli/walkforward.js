#!/usr/bin/env node

/**
 * Walk-Forward Validation CLI
 * Usage: node cli/walkforward.js --strategy <id> --symbol <sym> --tf <tf> --trainDays 180 --testDays 30 --stepDays 30
 */

require('dotenv').config();
const path = require('path');

// Add backend to path
const backendPath = path.join(__dirname, '../backend');
require('module')._resolveFilename = ((originalResolveFilename) => {
  return function(request, parent) {
    if (request.startsWith('./') || request.startsWith('../')) {
      return originalResolveFilename(request, parent);
    }
    try {
      return originalResolveFilename(request, parent);
    } catch (e) {
      const backendRequest = path.join(backendPath, request);
      try {
        return originalResolveFilename(backendRequest, parent);
      } catch (e2) {
        throw e;
      }
    }
  };
})(require('module')._resolveFilename);

const walkForwardValidator = require('../backend/services/walkForwardValidator');
const evaluationDb = require('../backend/db/evaluationDb');
const SimpleMovingAverageStrategy = require('../backend/strategies/SimpleMovingAverageStrategy');

// Strategy registry
const strategies = {
  'sma_crossover': (config) => new SimpleMovingAverageStrategy(config)
};

// Parse arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.substring(2);
      const value = args[i + 1];
      params[key] = value;
      i++;
    }
  }

  return params;
}

async function main() {
  try {
    // Initialize database
    await evaluationDb.initialize();

    // Parse arguments
    const params = parseArgs();
    const {
      strategy: strategyId,
      symbol,
      tf: timeframe,
      trainDays,
      testDays,
      stepDays,
      start: startDate,
      end: endDate,
      capital = '10000'
    } = params;

    // Validate
    if (!strategyId || !symbol || !timeframe || !trainDays || !testDays || !stepDays || !startDate || !endDate) {
      console.error('❌ Missing required parameters');
      console.error('');
      console.error('Usage: node cli/walkforward.js --strategy <id> --symbol <sym> --tf <tf> --trainDays <days> --testDays <days> --stepDays <days> --start <date> --end <date>');
      console.error('');
      console.error('Example:');
      console.error('  node cli/walkforward.js --strategy sma_crossover --symbol BTCUSDT --tf 5 --trainDays 180 --testDays 30 --stepDays 30 --start 2024-01-01 --end 2025-01-31');
      console.error('');
      console.error('Available strategies:');
      Object.keys(strategies).forEach(id => console.error(`  - ${id}`));
      process.exit(1);
    }

    // Get strategy
    const strategyFactory = strategies[strategyId];
    if (!strategyFactory) {
      console.error(`❌ Unknown strategy: ${strategyId}`);
      console.error('Available strategies:', Object.keys(strategies).join(', '));
      process.exit(1);
    }

    const strategy = strategyFactory();

    console.log('🚀 Starting walk-forward validation...');
    console.log(`   Strategy: ${strategy.name} (${strategyId})`);
    console.log(`   Symbol: ${symbol}`);
    console.log(`   Timeframe: ${timeframe}`);
    console.log(`   Train Window: ${trainDays} days`);
    console.log(`   Test Window: ${testDays} days`);
    console.log(`   Step Size: ${stepDays} days`);
    console.log(`   Period: ${startDate} to ${endDate}`);
    console.log('');

    // Run walk-forward
    const result = await walkForwardValidator.runWalkForward({
      strategy,
      symbol,
      timeframe,
      trainDays: parseInt(trainDays),
      testDays: parseInt(testDays),
      stepDays: parseInt(stepDays),
      startDate,
      endDate,
      initialCapital: parseFloat(capital)
    });

    // Print results
    console.log('✅ Walk-Forward Validation Complete');
    console.log('');
    console.log(`📊 Total Folds: ${result.totalFolds}`);
    console.log('');
    console.log('📈 Aggregate Test Performance:');
    if (result.aggregate.avgSharpeRatio !== null) {
      console.log(`   Avg Sharpe Ratio: ${result.aggregate.avgSharpeRatio.toFixed(2)}`);
    }
    console.log(`   Avg Win Rate: ${(result.aggregate.avgWinRate * 100).toFixed(2)}%`);
    console.log(`   Avg Return: ${result.aggregate.avgReturnPct.toFixed(2)}%`);
    console.log(`   Degradation Detected: ${result.aggregate.degradationCount} / ${result.totalFolds} folds (${(result.aggregate.degradationRate * 100).toFixed(1)}%)`);
    console.log('');

    if (result.degradationDetected) {
      console.log('⚠️  WARNING: Performance degradation detected in out-of-sample tests');
      console.log('   Strategy may be overfitted. Review parameters.');
    } else {
      console.log('✅ No significant degradation detected');
    }

    console.log('');

    // Close database
    await evaluationDb.close();

    process.exit(0);
  } catch (error) {
    console.error('❌ Walk-forward validation failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

