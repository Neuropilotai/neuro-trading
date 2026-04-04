'use strict';

/**
 * Paper Broker — Simulates broker: open/close positions, track cash. No real orders.
 *
 * Used by paperExecution to open a position on champion signal and close on stop/target/exit.
 */

let _cash = 10000;
const _positions = [];
let _positionId = 0;

function nextId() {
  _positionId += 1;
  return `paper_${_positionId}_${Date.now()}`;
}

/**
 * Reset state (e.g. for new session).
 */
function reset(cash = 10000) {
  _cash = Number(cash) || 10000;
  _positions.length = 0;
  _positionId = 0;
}

/**
 * @param {number} amount
 */
function setCash(amount) {
  _cash = Number(amount);
  return _cash;
}

function getCash() {
  return _cash;
}

/**
 * @returns {Array<{ id: string, symbol: string, side: string, size: number, entryPrice: number, entryTime: number, setupId: string, stopLoss?: number, takeProfit?: number }>}
 */
function getPositions() {
  return _positions.map((p) => ({ ...p }));
}

/**
 * Open a position. Deducts size * entryPrice from cash (simplified; no leverage).
 *
 * @param {{ symbol: string, side: 'long'|'short', size: number, entryPrice: number, setupId?: string, stopLoss?: number, takeProfit?: number }}
 * @returns {{ id: string } | { error: string }}
 */
function openPosition(opts) {
  const symbol = String(opts.symbol || '').trim();
  const side = opts.side === 'short' ? 'short' : 'long';
  const size = Math.abs(Number(opts.size)) || 0;
  const entryPrice = Number(opts.entryPrice);
  if (!symbol || size <= 0 || !Number.isFinite(entryPrice)) {
    return { error: 'Invalid symbol, size, or entryPrice' };
  }
  const cost = size * entryPrice;
  if (cost > _cash) return { error: 'Insufficient cash' };

  _cash -= cost;
  const id = nextId();
  _positions.push({
    id,
    symbol,
    side,
    size,
    entryPrice,
    entryTime: opts.entryTime ?? Date.now(),
    setupId: opts.setupId ?? '',
    stopLoss: opts.stopLoss != null && Number.isFinite(opts.stopLoss) ? opts.stopLoss : undefined,
    takeProfit: opts.takeProfit != null && Number.isFinite(opts.takeProfit) ? opts.takeProfit : undefined,
  });
  return { id };
}

/**
 * Close a position. Returns PnL (gross) and adds cash back.
 *
 * @param {string} positionId
 * @param {number} exitPrice
 * @returns {{ pnl: number, closed: boolean } | { error: string }}
 */
function closePosition(positionId, exitPrice) {
  const idx = _positions.findIndex((p) => p.id === positionId);
  if (idx === -1) return { error: 'Position not found' };
  const p = _positions[idx];
  const exit = Number(exitPrice);
  if (!Number.isFinite(exit)) return { error: 'Invalid exitPrice' };

  let pnl;
  if (p.side === 'long') {
    pnl = (exit - p.entryPrice) * p.size;
  } else {
    pnl = (p.entryPrice - exit) * p.size;
  }
  _cash += p.size * exit;
  _positions.splice(idx, 1);
  return { pnl, closed: true };
}

/**
 * Full state for persistence.
 */
function getState() {
  return { cash: _cash, positions: getPositions() };
}

/**
 * Restore from persisted state (e.g. after load).
 */
function setState(state) {
  if (!state) return;
  if (Number.isFinite(state.cash)) _cash = state.cash;
  if (Array.isArray(state.positions)) {
    _positions.length = 0;
    _positions.push(...state.positions.map((p) => ({ ...p })));
  }
}

module.exports = {
  reset,
  setCash,
  getCash,
  getPositions,
  openPosition,
  closePosition,
  getState,
  setState,
};
