'use strict';

/**
 * Paper Portfolio — Load/save paper trading state (cash, positions) and equity curve.
 *
 * Files: paper_trading_state.json, paper_equity_curve.json
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const paperBroker = require('./paperBroker');

function getPaperDir() {
  return dataRoot.getPath('paper');
}

const STATE_FILENAME = 'paper_trading_state.json';
const EQUITY_CURVE_FILENAME = 'paper_equity_curve.json';

/**
 * Load state from disk and apply to broker. Returns state object.
 */
function loadState() {
  const filePath = path.join(getPaperDir(), STATE_FILENAME);
  if (!fs.existsSync(filePath)) return { cash: 10000, positions: [], equityCurve: [] };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const state = JSON.parse(raw);
    if (state.cash != null && state.positions != null) {
      paperBroker.setState(state);
    }
    return state;
  } catch (e) {
    return { cash: 10000, positions: [], equityCurve: [] };
  }
}

/**
 * Save current broker state to disk.
 */
function saveState() {
  const state = paperBroker.getState();
  const filePath = path.join(getPaperDir(), STATE_FILENAME);
  const data = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}

/**
 * Load equity curve (array of { time, equity }).
 */
function loadEquityCurve() {
  const filePath = path.join(getPaperDir(), EQUITY_CURVE_FILENAME);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : (data.points || []);
  } catch (e) {
    return [];
  }
}

/**
 * Append one point and save.
 */
function appendEquityPoint(time, equity) {
  const curve = loadEquityCurve();
  curve.push({ time: time ?? Date.now(), equity: Number(equity) });
  const filePath = path.join(getPaperDir(), EQUITY_CURVE_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(curve, null, 2), 'utf8');
  return filePath;
}

/**
 * Compute current equity: cash + sum of position value at given prices (or last known).
 * If no prices given, equity = cash (positions marked to close at 0 for simplicity).
 */
function computeEquity(markPrices = {}) {
  const state = paperBroker.getState();
  let equity = state.cash;
  for (const p of state.positions) {
    const mark = markPrices[p.symbol];
    if (mark != null && Number.isFinite(mark)) {
      const value = p.size * mark;
      const pnl = p.side === 'long' ? (mark - p.entryPrice) * p.size : (p.entryPrice - mark) * p.size;
      equity += pnl;
    }
  }
  return equity;
}

module.exports = {
  loadState,
  saveState,
  loadEquityCurve,
  appendEquityPoint,
  computeEquity,
  getPaperDir,
  STATE_FILENAME,
  EQUITY_CURVE_FILENAME,
};
