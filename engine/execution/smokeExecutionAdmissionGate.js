#!/usr/bin/env node
'use strict';

/**
 * Smoke: execution admission gate — disabled / paper / live fail-closed.
 */

const assert = require('assert');
const { evaluateExecutionAdmissionGate } = require('./executionAdmissionGate');

const mockBrokerOk = {
  healthCheck: async () => ({ connected: true, ok: true, broker: 'Mock' }),
};

const mockBrokerBad = {
  healthCheck: async () => ({ connected: false, ok: false, broker: 'Mock' }),
};

async function run() {
  const g1 = await evaluateExecutionAdmissionGate({
    orderIntent: { symbol: 'EURUSD', action: 'BUY', setupId: 's1' },
    getBrokerAdapter: () => mockBrokerOk,
    env: {
      NEUROPILOT_EXECUTION_MODE: 'disabled',
      TRADING_MODE: 'paper',
      BROKER: 'paper',
    },
  });
  assert.strictEqual(g1.allowed, false);
  assert.strictEqual(g1.mode, 'blocked');
  console.log('[smokeExecutionAdmissionGate] disabled → blocked OK');

  const g2 = await evaluateExecutionAdmissionGate({
    orderIntent: { symbol: 'BTCUSDT', action: 'BUY', setupId: 's1' },
    getBrokerAdapter: () => mockBrokerOk,
    env: {
      TRADING_MODE: 'paper',
      BROKER: 'paper',
    },
  });
  assert.strictEqual(g2.allowed, true);
  assert.strictEqual(g2.mode, 'paper');
  console.log('[smokeExecutionAdmissionGate] paper → allowed OK');

  const g3 = await evaluateExecutionAdmissionGate({
    orderIntent: { symbol: 'EURUSD', action: 'BUY', setupId: 's1' },
    getBrokerAdapter: () => mockBrokerOk,
    env: {
      TRADING_MODE: 'live',
      BROKER: 'paper',
    },
  });
  assert.strictEqual(g3.allowed, false);
  console.log('[smokeExecutionAdmissionGate] live + paper broker → blocked OK');

  const g4 = await evaluateExecutionAdmissionGate({
    orderIntent: { symbol: 'EURUSD', action: 'BUY', setupId: 's1' },
    getBrokerAdapter: () => mockBrokerOk,
    env: {
      NEUROPILOT_EXECUTION_MODE: 'live',
      ENABLE_LIVE_TRADING: '1',
      TRADING_ENABLED: 'true',
      TRADING_MODE: 'live',
      BROKER: 'oanda',
      OANDA_API_KEY: 'x',
      OANDA_ACCOUNT_ID: 'y',
    },
  });
  assert.strictEqual(g4.allowed, true);
  console.log('[smokeExecutionAdmissionGate] live armed + oanda creds + health → allowed OK');

  const g5 = await evaluateExecutionAdmissionGate({
    orderIntent: { symbol: 'EURUSD', action: 'BUY', setupId: 's1' },
    getBrokerAdapter: () => mockBrokerBad,
    env: {
      NEUROPILOT_EXECUTION_MODE: 'live',
      ENABLE_LIVE_TRADING: '1',
      TRADING_ENABLED: 'true',
      TRADING_MODE: 'live',
      BROKER: 'oanda',
      OANDA_API_KEY: 'x',
      OANDA_ACCOUNT_ID: 'y',
    },
  });
  assert.strictEqual(g5.allowed, false);
  console.log('[smokeExecutionAdmissionGate] live + broker health KO → blocked OK');

  const g6 = await evaluateExecutionAdmissionGate({
    orderIntent: { symbol: 'EURUSD', action: 'BUY', setupId: 's1' },
    getBrokerAdapter: () => mockBrokerOk,
    env: {
      NEUROPILOT_EXECUTION_MODE: 'live',
      TRADING_MODE: 'live',
      BROKER: 'oanda',
      OANDA_API_KEY: 'x',
      OANDA_ACCOUNT_ID: 'y',
    },
  });
  assert.strictEqual(g6.allowed, false);
  console.log('[smokeExecutionAdmissionGate] live without ENABLE_LIVE_TRADING → blocked OK');

  console.log('[smokeExecutionAdmissionGate] ALL OK');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
