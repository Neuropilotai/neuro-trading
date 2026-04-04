'use strict';

/**
 * Append-only journals for execution pipeline V1 (no secrets in payloads).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dataRoot = require('../dataRoot');

function governanceDir(opts = {}) {
  if (opts.dataRoot) {
    const g = path.join(path.resolve(opts.dataRoot), 'governance');
    fs.mkdirSync(g, { recursive: true });
    return g;
  }
  return dataRoot.getPath('governance', true);
}

function intentsPath(opts) {
  return path.join(governanceDir(opts), 'execution_intents.jsonl');
}

function ordersPath(opts) {
  return path.join(governanceDir(opts), 'execution_orders.jsonl');
}

function metricsPath(opts) {
  return path.join(governanceDir(opts), 'execution_pipeline_metrics.json');
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function hash8(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

/**
 * Deterministic client order id (auditable prefix + entropy suffix).
 */
function createClientOrderId({ strategyId, symbol, ts }) {
  const sid = strategyId ? String(strategyId) : 'na';
  const sym = symbol ? String(symbol).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) : 'na';
  const t = ts || Date.now();
  const h = hash8(`${sid}|${sym}|${t}`);
  return `NP_${t}_${h}_${sym}`;
}

function summarizeOrderIntent(oi) {
  if (!oi || typeof oi !== 'object') return null;
  return {
    symbol: oi.symbol,
    action: oi.action,
    quantity: oi.quantity,
    price: oi.price,
    hasStop: oi.stopLoss != null,
    hasTp: oi.takeProfit != null,
    setupId: oi.setupId != null ? oi.setupId : null,
  };
}

function summarizeBrokerPayload(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    tradeId: result.tradeId != null ? String(result.tradeId) : null,
    success: result.success,
    hasExecutionResult: Boolean(result.executionResult),
  };
}

function defaultMetrics() {
  return {
    updatedAt: null,
    accepted: 0,
    blocked: 0,
    failed: 0,
    blockedByRisk: 0,
    blockedByPolicy: 0,
    brokerErrors: 0,
    lastOrderAttemptAt: null,
    lastAcceptedOrderAt: null,
    lastBlockedReason: null,
  };
}

function readMetrics(opts) {
  const p = metricsPath(opts);
  try {
    if (!fs.existsSync(p)) return defaultMetrics();
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...defaultMetrics(), ...j };
  } catch (_) {
    return defaultMetrics();
  }
}

function writeMetrics(opts, m) {
  const p = metricsPath(opts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(m, null, 2), 'utf8');
}

function bumpMetrics(opts, patch) {
  const m = readMetrics(opts);
  Object.assign(m, patch);
  m.updatedAt = new Date().toISOString();
  writeMetrics(opts, m);
}

/**
 * @param {object} deltas - numeric increments (e.g. { blocked: 1, blockedByRisk: 1 })
 */
function incrementMetrics(opts, deltas = {}) {
  const m = readMetrics(opts);
  for (const [k, v] of Object.entries(deltas)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      m[k] = (Number(m[k]) || 0) + v;
    }
  }
  m.updatedAt = new Date().toISOString();
  writeMetrics(opts, m);
}

/**
 * Record full intent line (accepted or rejected).
 */
function appendExecutionIntent(record, opts = {}) {
  appendJsonl(intentsPath(opts), record);
}

/**
 * Record order sent to broker / execution core.
 */
function appendExecutionOrder(record, opts = {}) {
  appendJsonl(ordersPath(opts), record);
}

module.exports = {
  governanceDir,
  intentsPath,
  ordersPath,
  metricsPath,
  appendJsonl,
  appendExecutionIntent,
  appendExecutionOrder,
  createClientOrderId,
  summarizeOrderIntent,
  summarizeBrokerPayload,
  readMetrics,
  bumpMetrics,
  incrementMetrics,
};
