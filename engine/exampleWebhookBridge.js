#!/usr/bin/env node
'use strict';

/**
 * Example: convert execution payload to webhook request via Webhook Bridge.
 * Run from repo root: node neuropilot_trading_v2/engine/exampleWebhookBridge.js
 */
const signalAdapter = require('./signalAdapter');
const webhookBridge = require('./webhookBridge');

// Minimal valid payload (as from signalAdapter.toPayload)
const payload = {
  valid: true,
  symbol: 'XAUUSD',
  action: 'BUY',
  price: 2677,
  quantity: 1.11,
  strategy: 'trend_breakout',
  confidence: 0.82,
  regime: 'TREND_UP',
  riskAmount: 5,
  stopDistance: 4.5,
  riskReward: 2.0,
  mode: 'paper',
  source: 'neuropilot_quant_v1',
};

const request = webhookBridge.toWebhookRequest(payload, {
  baseUrl: 'http://localhost:3014',
  secret: 'optional-secret',
  includeTimestamp: true,
  includeAlertId: true,
});

console.log('Webhook request:');
console.log('  valid:', request.valid);
console.log('  url:', request.url);
console.log('  headers:', request.headers);
console.log('  body:', JSON.stringify(request.body, null, 2));

if (request.valid) {
  console.log('\nReady to POST:', request.url);
  // In production: fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) });
}
