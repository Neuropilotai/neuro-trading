'use strict';

/**
 * Signal Router — Route scored signals to paper trading or live execution.
 *
 * Flow: champion signal → score → route to paper (default) or live if enabled and risk gate passes.
 */

const { isChampionAllowed } = require('../champions/executionGate');
const paperExecution = require('../paper/paperExecution');

const DEFAULT_MODE = 'paper'; // 'paper' | 'live' | 'both'

/**
 * Route a single signal: if champion, send to paper (and optionally live).
 *
 * @param {object} signal - { setupId, symbol, side, price, size, stopLoss?, takeProfit? }
 * @param {{ mode?: 'paper'|'live'|'both' }} [opts]
 * @returns {{ routed: boolean, toPaper?: boolean, toLive?: boolean, reason?: string }}
 */
function route(signal, opts = {}) {
  const mode = opts.mode || DEFAULT_MODE;
  if (!signal || !signal.setupId) {
    return { routed: false, reason: 'Invalid signal' };
  }
  if (!isChampionAllowed(signal.setupId)) {
    return { routed: false, reason: 'Not a champion' };
  }

  let toPaper = false;
  let toLive = false;

  if (mode === 'paper' || mode === 'both') {
    const result = paperExecution.executeSignal(signal);
    if (result.opened) toPaper = true;
  }

  if (mode === 'live' || mode === 'both') {
    // Live execution would go here (liveExecutionEngine.execute(signal))
    // For now we do not call live to avoid accidental real orders.
    toLive = false;
  }

  return { routed: toPaper || toLive, toPaper, toLive };
}

/**
 * Route multiple signals; returns array of route results.
 */
function routeAll(signals, opts = {}) {
  return (signals || []).map((s) => route(s, opts));
}

module.exports = {
  route,
  routeAll,
  DEFAULT_MODE,
};
