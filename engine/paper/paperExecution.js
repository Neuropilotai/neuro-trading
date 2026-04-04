'use strict';

/**
 * Paper Execution — On champion signal open position; on bar check stop/target; record to trade log.
 *
 * One signal → paper broker opens position. Each bar/tick → check stop/target for each position, close if hit.
 * All trades logged to paper_trade_log.json.
 */

const fs = require('fs');
const path = require('path');
const dataRoot = require('../dataRoot');
const paperBroker = require('./paperBroker');
const paperPortfolio = require('./paperPortfolio');
const { isChampionAllowed } = require('../champions/executionGate');

const LOG_FILENAME = 'paper_trade_log.json';

function getPaperDir() {
  return dataRoot.getPath('paper');
}

function loadTradeLog() {
  const filePath = path.join(getPaperDir(), LOG_FILENAME);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : (data.trades || []);
  } catch (e) {
    return [];
  }
}

function appendTradeLog(entry) {
  const log = loadTradeLog();
  log.push({ ...entry, at: new Date().toISOString() });
  const filePath = path.join(getPaperDir(), LOG_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2), 'utf8');
  return filePath;
}

/**
 * Execute a signal if setupId is champion. Opens position and returns { opened, id } or { opened: false, reason }.
 *
 * @param {{ setupId: string, symbol: string, side: 'long'|'short', price: number, size?: number, stopLoss?: number, takeProfit?: number }}
 */
function executeSignal(signal) {
  const setupId = (signal.setupId || signal.setup_id || '').toString().trim();
  if (!isChampionAllowed(setupId)) {
    return { opened: false, reason: 'Not a champion setup' };
  }
  const symbol = String(signal.symbol || '').trim();
  const price = Number(signal.price ?? signal.close);
  const size = Number(signal.size ?? signal.quantity ?? 1);
  if (!symbol || !Number.isFinite(price) || size <= 0) {
    return { opened: false, reason: 'Invalid symbol, price, or size' };
  }

  const result = paperBroker.openPosition({
    symbol,
    side: signal.side === 'short' ? 'short' : 'long',
    size,
    entryPrice: price,
    setupId,
    stopLoss: signal.stopLoss ?? signal.stop_loss,
    takeProfit: signal.takeProfit ?? signal.take_profit,
    entryTime: Date.now(),
  });

  if (result.error) {
    return { opened: false, reason: result.error };
  }

  appendTradeLog({
    type: 'open',
    positionId: result.id,
    setupId,
    symbol,
    side: signal.side || 'long',
    size,
    entryPrice: price,
    stopLoss: signal.stopLoss ?? signal.stop_loss,
    takeProfit: signal.takeProfit ?? signal.take_profit,
  });
  paperPortfolio.saveState();
  return { opened: true, id: result.id };
}

/**
 * Check all open positions against current bar (high, low, close). Close if stop or target hit.
 *
 * @param {{ symbol: string, high: number, low: number, close: number, time?: number }} bar
 */
function checkStopsTargets(bar) {
  const symbol = String(bar?.symbol || '').trim();
  const high = Number(bar?.high);
  const low = Number(bar?.low);
  const close = Number(bar?.close ?? bar?.c);
  if (!symbol || !Number.isFinite(close)) return [];

  const positions = paperBroker.getPositions().filter((p) => p.symbol === symbol);
  const closed = [];

  for (const p of positions) {
    let exitPrice = null;
    if (p.side === 'long') {
      if (p.stopLoss != null && low <= p.stopLoss) exitPrice = p.stopLoss;
      else if (p.takeProfit != null && high >= p.takeProfit) exitPrice = p.takeProfit;
    } else {
      if (p.stopLoss != null && high >= p.stopLoss) exitPrice = p.stopLoss;
      else if (p.takeProfit != null && low <= p.takeProfit) exitPrice = p.takeProfit;
    }
    if (exitPrice == null) continue;

    const result = paperBroker.closePosition(p.id, exitPrice);
    if (result.closed) {
      appendTradeLog({
        type: 'close',
        positionId: p.id,
        setupId: p.setupId,
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        exitPrice,
        pnl: result.pnl,
      });
      closed.push({ positionId: p.id, exitPrice, pnl: result.pnl });
    }
  }

  if (closed.length) paperPortfolio.saveState();
  return closed;
}

/**
 * Close a position at market (e.g. end of session or manual).
 */
function closeAtMarket(positionId, price) {
  const positions = paperBroker.getPositions();
  const p = positions.find((x) => x.id === positionId);
  const result = paperBroker.closePosition(positionId, price);
  if (result.closed && p) {
    appendTradeLog({
      type: 'close_market',
      positionId,
      setupId: p.setupId || '',
      symbol: p.symbol || '',
      side: p.side || 'long',
      size: p.size || 0,
      entryPrice: p.entryPrice,
      exitPrice: price,
      pnl: result.pnl,
    });
    paperPortfolio.saveState();
  }
  return result;
}

module.exports = {
  executeSignal,
  checkStopsTargets,
  closeAtMarket,
  loadTradeLog,
  appendTradeLog,
  getPaperDir,
  LOG_FILENAME,
};
