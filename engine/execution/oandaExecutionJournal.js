'use strict';

/**
 * OANDA V2 intent lines → DATA_ROOT/governance/execution_intents.jsonl
 * Schema: ts, mode, strategyId, symbol, decision, reason, risk, broker (+ pipeline tag)
 */

const { intentsPath, appendJsonl } = require('./executionPipelineJournals');

/**
 * @param {object} record
 * @param {'accepted'|'rejected'} record.decision
 * @param {object} [journalOpts] - { dataRoot }
 */
function appendOandaV2Intent(record, journalOpts = {}) {
  appendJsonl(intentsPath(journalOpts), {
    ...record,
    pipeline: 'oanda_v2',
  });
}

module.exports = {
  appendOandaV2Intent,
};
