#!/usr/bin/env node
'use strict';

/**
 * Example: trade simulation from candles + allowed signals.
 *
 * Run from repo root:
 *   node neuropilot_trading_v2/engine/exampleTradeSimulation.js
 *
 * Uses synthetic candles and signals with barIndex when no research data is present.
 * To run on real allowed signals, load candles + allowed_signals_debug.json and ensure
 * signals have barIndex (or timestamp resolvable from candle times).
 */

const path = require('path');
const tradeSimulation = require('./tradeSimulation');

function buildSyntheticCandles(nBars, basePrice = 100, volatility = 0.5) {
  const candles = [];
  let close = basePrice;
  for (let i = 0; i < nBars; i++) {
    const open = close;
    const change = (Math.random() - 0.48) * volatility;
    close = Math.max(open * 0.99, Math.min(open * 1.01, open + change));
    const high = Math.max(open, close) + Math.random() * volatility * 0.3;
    const low = Math.min(open, close) - Math.random() * volatility * 0.3;
    candles.push({
      open,
      high,
      low,
      close,
      volume: 1000 + Math.floor(Math.random() * 500),
      time: 1700000000000 + i * 60000,
    });
  }
  return candles;
}

function main() {
  const nBars = 500;
  const candles = buildSyntheticCandles(nBars, 100, 0.6);

  // Synthetic allowed signals at specific bar indices (entry at that bar).
  const allowedSignals = [
    { symbol: 'SYM', timeframe: '5m', entryPrice: 100, stopDistance: 1.2, direction: 'long', barIndex: 60 },
    { symbol: 'SYM', timeframe: '5m', entryPrice: 99.5, stopDistance: 1.0, direction: 'long', barIndex: 120 },
    { symbol: 'SYM', timeframe: '5m', entryPrice: 101, stopDistance: 1.5, direction: 'short', barIndex: 180 },
    { symbol: 'SYM', timeframe: '5m', entryPrice: 98.8, stopDistance: 0.9, direction: 'long', barIndex: 250 },
    { symbol: 'SYM', timeframe: '5m', entryPrice: 100.2, stopDistance: 1.1, direction: 'long', barIndex: 320 },
  ];

  const opts = { rMultiple: 2, maxBarsHeld: 30, defaultDirection: 'long' };
  const { trades, summary } = tradeSimulation.run(candles, allowedSignals, opts);

  console.log('=== Trade Simulation ===');
  console.log('Candles:', candles.length, 'Signals:', allowedSignals.length);
  console.log('');
  console.log('Trades:');
  trades.forEach((t, i) => {
    console.log(
      `  ${i + 1}. ${t.symbol} ${t.timeframe} ${t.direction} @ ${t.entryPrice} -> ${t.outcome} R=${t.rMultiple} bars=${t.barsHeld}`
    );
  });
  console.log('');
  console.log('Summary:', JSON.stringify(summary, null, 2));
}

main();
