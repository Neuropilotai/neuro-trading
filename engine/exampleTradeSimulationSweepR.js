#!/usr/bin/env node
'use strict';

/**
 * Example: R-multiple sweep for trade simulation (same signals, different targets).
 *
 * Prerequisite: run research with debug export, e.g.:
 *   node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout
 *
 * Usage (from repo root or neuropilot_trading_v2):
 *   node engine/exampleTradeSimulationSweepR.js <symbol> <timeframe> [strategy]
 *
 * Examples:
 *   node engine/exampleTradeSimulationSweepR.js SPY 5m              # all strategies for SPY 5m
 *   node engine/exampleTradeSimulationSweepR.js SPY 5m trend_breakout  # trend_breakout only (baseline)
 *
 * Runs simulation with rMultiple = 1.0, 1.25, 1.5, 2.0 and prints summary per R.
 */

const path = require('path');
const fs = require('fs');
const datasetLoader = require('./datasetLoader');
const tradeSimulation = require('./tradeSimulation');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEBUG_FILE = path.join(__dirname, '..', 'research', 'allowed_signals_debug.json');

async function main() {
  const symbol = (process.argv[2] || 'SPY').trim().toUpperCase();
  const timeframe = (process.argv[3] || '5m').trim().toLowerCase();
  const strategyFilter = (process.argv[4] || '').trim();

  const csvPath = path.join(DATA_DIR, `${symbol.toLowerCase()}_${timeframe}.csv`);

  let candles = [];
  try {
    const data = await datasetLoader.loadFromFile(csvPath, symbol, timeframe);
    candles = data.candles || [];
  } catch (err) {
    console.error('Load candles failed:', err.message);
    console.error('Usage: node engine/exampleTradeSimulationSweepR.js [symbol] [timeframe] [strategy]');
    console.error('Example: node engine/exampleTradeSimulationSweepR.js SPY 5m trend_breakout');
    process.exit(1);
  }

  let allSignals = [];
  try {
    const raw = fs.readFileSync(DEBUG_FILE, 'utf8');
    allSignals = JSON.parse(raw);
    if (!Array.isArray(allSignals)) allSignals = [];
  } catch (err) {
    console.error('Load allowed_signals_debug.json failed:', err.message);
    console.error('Run research first, e.g. node engine/exampleRunResearchFromConfig.js us_indices_core trend_breakout');
    process.exit(1);
  }

  const signals = allSignals.filter(
    (s) => s && String(s.symbol) === symbol && String(s.timeframe) === timeframe
  );

  if (signals.length === 0) {
    console.log(`No allowed signals for ${symbol} ${timeframe} in debug file. Run research first.`);
    return;
  }

  const baseOpts = {
    maxBarsHeld: 50,
    defaultDirection: 'long',
    rMultiples: [1, 1.25, 1.5, 2],
  };
  if (strategyFilter) {
    baseOpts.includeStrategies = [strategyFilter];
  }

  const { results } = tradeSimulation.runSweepRMultiple(candles, signals, baseOpts);

  console.log('=== R-Multiple Sweep ===');
  console.log('Dataset:', symbol, timeframe, '| Candles:', candles.length, '| Signals:', signals.length + (strategyFilter ? ` (${strategyFilter} only)` : ''));
  console.log('');

  console.log('rMultiple  totalTrades  wins  losses  timeouts  winRate%  avgR   expectancyR');
  console.log('---------  -----------  ----  ------  -------  --------  -----  -----------');
  for (const { rMultiple, summary } of results) {
    const winRate = summary.winRate != null ? summary.winRate : '—';
    const avgR = summary.avgR != null ? summary.avgR : '—';
    const expectancyR = summary.expectancyR != null ? summary.expectancyR : '—';
    console.log(
      `${String(rMultiple).padEnd(9)}  ${String(summary.totalTrades).padStart(11)}  ${String(summary.wins).padStart(4)}  ${String(summary.losses).padStart(6)}  ${String(summary.timeouts).padStart(7)}  ${String(winRate).padStart(8)}  ${String(avgR).padStart(5)}  ${expectancyR}`
    );
  }
  console.log('');
  console.log('Purpose: compare whether a smaller target (e.g. R=1) improves expectancy for this baseline.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
