'use strict';

/**
 * Optional integration point: call from your pipeline only after validation,
 * when a signal is promotable. Does not import dataset / research modules.
 *
 * @example
 * const { executeSignal } = require('./engine/execution/afterValidatedSignal');
 * await executeSignal(
 *   { strategyId: 'ORB_breakout_v1', symbol: 'XAUUSD', side: 'buy', signalTimeMs: barCloseMs },
 *   { isPromotable: true, balance: 100000 }
 * );
 */

const { executeSignal, computeSignalExecutionKey } = require('./executionEngine');

module.exports = { executeSignal, computeSignalExecutionKey };
