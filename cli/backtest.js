#!/usr/bin/env node

/**
 * Backtest CLI
 * Usage: node cli/backtest.js --strategy <id> --symbol <sym> --tf <tf> --start <date> --end <date>
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

const backtestEngine = require('../backend/services/backtestEngine');
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
      start: startDate,
      end: endDate,
      capital = '10000'
    } = params;

    // Validate
    if (!strategyId || !symbol || !timeframe || !startDate || !endDate) {
      console.error('❌ Missing required parameters');
      console.error('');
      console.error('Usage: node cli/backtest.js --strategy <id> --symbol <sym> --tf <tf> --start <date> --end <date> [--capital <amount>]');
      console.error('');
      console.error('Example:');
      console.error('  node cli/backtest.js --strategy sma_crossover --symbol BTCUSDT --tf 5 --start 2025-01-01 --end 2025-01-31');
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

    console.log('🚀 Starting backtest...');
    console.log(`   Strategy: ${strategy.name} (${strategyId})`);
    console.log(`   Symbol: ${symbol}`);
    console.log(`   Timeframe: ${timeframe}`);
    console.log(`   Period: ${startDate} to ${endDate}`);
    console.log(`   Initial Capital: $${parseFloat(capital).toLocaleString()}`);
    console.log('');

    // Run backtest
    const result = await backtestEngine.runBacktest({
      strategy,
      symbol,
      timeframe,
      startDate,
      endDate,
      initialCapital: parseFloat(capital)
    });

    // Print results
    console.log('✅ Backtest Complete');
    console.log('');
    console.log('📊 Results:');
    console.log(`   Total Trades: ${result.totalTrades}`);
    console.log(`   Winning Trades: ${result.winningTrades}`);
    console.log(`   Losing Trades: ${result.losingTrades}`);
    console.log(`   Win Rate: ${(result.winRate * 100).toFixed(2)}%`);
    console.log(`   Net Profit: $${result.netProfit.toFixed(2)} (${result.netProfitPct.toFixed(2)}%)`);
    console.log(`   Final Capital: $${(parseFloat(capital) + result.netProfit).toFixed(2)}`);
    console.log(`   Max Drawdown: $${result.maxDrawdown.toFixed(2)} (${result.maxDrawdownPct.toFixed(2)}%)`);
    if (result.sharpeRatio !== null) {
      console.log(`   Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
    }
    if (result.profitFactor !== null) {
      console.log(`   Profit Factor: ${result.profitFactor.toFixed(2)}`);
    }
    console.log(`   Backtest ID: ${result.id}`);
    console.log('');

    // Close database
    await evaluationDb.close();

    process.exit(0);
  } catch (error) {
    console.error('❌ Backtest failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

