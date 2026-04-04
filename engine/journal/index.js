'use strict';

/**
 * NeuroPilot Quant Engine v1 — Signal Journal (public API)
 *
 * Converts a pipeline signal into a flattened journal record for research and learning.
 * No database writes; pure function only.
 *
 * Usage:
 *   const { run } = require('./engine/signalPipeline');
 *   const { toRecord } = require('./engine/journal');
 *   const signal = run(candles, account);
 *   const record = toRecord(signal, 'XAUUSD', '2m', new Date());
 *   // e.g. { id: 'sig_20260306_120501_XAUUSD_2m', timestamp: '...', ... }
 */
const signalJournal = require('./signalJournal');

module.exports = {
  toRecord: signalJournal.toRecord,
  generateId: signalJournal.generateId,
  toISOTimestamp: signalJournal.toISOTimestamp,
  PREFIX: signalJournal.PREFIX,
};
