#!/usr/bin/env node
'use strict';

/**
 * Paper Session — Run paper trading: load champions, state; accept signals (file or replay); persist state, log, equity curve.
 *
 * Usage:
 *   node engine/paper/runPaperSession.js                    # load state, ready for signals
 *   node engine/paper/runPaperSession.js --replay <path>     # replay candles and run checks
 *   node engine/paper/runPaperSession.js --reset             # reset state to initial cash
 *
 * Outputs (in data root paper/):
 *   paper_trading_state.json
 *   paper_trade_log.json
 *   paper_equity_curve.json
 */

const path = require('path');
const fs = require('fs');
const paperBroker = require('./paperBroker');
const paperPortfolio = require('./paperPortfolio');
const paperExecution = require('./paperExecution');
const dataRoot = require('../dataRoot');
const datasetLoader = require('../datasetLoader');
const { clearCache: clearChampionCache } = require('../champions/executionGate');

const INITIAL_CASH = 10000;

function runReset() {
  paperBroker.reset(INITIAL_CASH);
  paperPortfolio.saveState();
  console.log('Paper state reset. Cash:', INITIAL_CASH);
}

function runReplay(candlesPath) {
  const resolved = path.isAbsolute(candlesPath) ? candlesPath : path.resolve(process.cwd(), candlesPath);
  if (!fs.existsSync(resolved)) {
    console.error('File not found:', resolved);
    process.exit(1);
  }
  const content = fs.readFileSync(resolved, 'utf8');
  const ext = path.extname(resolved).toLowerCase();
  let candles = [];
  if (ext === '.json') {
    const data = JSON.parse(content);
    candles = Array.isArray(data) ? data : (data.candles || []);
  } else {
    const parsed = datasetLoader.parseCSV(content);
    candles = parsed.candles || [];
  }
  if (candles.length === 0) {
    console.log('No candles to replay.');
    return;
  }

  paperPortfolio.loadState();
  const curve = paperPortfolio.loadEquityCurve();
  const symbol = candles[0]?.symbol || path.basename(resolved, path.extname(resolved)).split('_')[0]?.toUpperCase() || 'UNKNOWN';

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const o = bar.open ?? bar.o;
    const h = bar.high ?? bar.h;
    const l = bar.low ?? bar.l;
    const c = bar.close ?? bar.c;
    const t = bar.time ?? bar.t ?? bar.timestamp;
    paperExecution.checkStopsTargets({ symbol, high: h, low: l, close: c, time: t });
    const equity = paperPortfolio.computeEquity({ [symbol]: c });
    paperPortfolio.appendEquityPoint(t, equity);
  }
  paperPortfolio.saveState();
  console.log('Replay done. Candles:', candles.length, 'Equity points:', curve.length + candles.length);
}

function runStatus() {
  if (process.argv.includes('--reload-champions')) {
    clearChampionCache();
    console.log('Champion allowlist cache cleared (next signal load will use fresh registry).');
  }
  paperPortfolio.loadState();
  const state = paperBroker.getState();
  const equity = paperPortfolio.computeEquity({});
  console.log('Paper state:');
  console.log('  Cash:', state.cash);
  console.log('  Positions:', state.positions.length);
  console.log('  Equity (cash only):', equity);
  const log = paperExecution.loadTradeLog();
  console.log('  Trades logged:', log.length);
  console.log('  Output dir:', paperPortfolio.getPaperDir());
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--reset')) {
    runReset();
    return;
  }
  const replayIdx = args.indexOf('--replay');
  if (replayIdx !== -1 && args[replayIdx + 1]) {
    runReplay(args[replayIdx + 1]);
    return;
  }
  runStatus();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { runReset, runReplay, runStatus };
