'use strict';

/**
 * NeuroPilot Quant Engine v1 — Webhook Bridge
 *
 * Converts a normalized execution payload into a webhook request object compatible
 * with neuropilot_trading_v2 POST /webhook/tradingview. Pure function; no HTTP call.
 *
 * Inputs:
 *   - payload: from signalAdapter.toPayload() (valid, symbol, action, price, quantity, ...)
 *   - config: optional { baseUrl, secret, includeTimestamp, includeAlertId, path }
 *
 * Output:
 *   - { valid, url, headers, body } for use with fetch/axios; valid false when payload invalid.
 */

const DEFAULT_PATH = '/webhook/tradingview';

/**
 * Default config. path can be overridden; baseUrl has no default (relative path used when omitted).
 */
const DEFAULT_CONFIG = Object.freeze({
  path: DEFAULT_PATH,
  includeTimestamp: true,
  includeAlertId: true,
});

/**
 * Build full URL from baseUrl and path. Normalizes trailing slash on baseUrl.
 */
function buildUrl(baseUrl, path) {
  const p = (path || DEFAULT_PATH).startsWith('/') ? path : `/${path}`;
  if (!baseUrl || typeof baseUrl !== 'string') return p;
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base ? `${base}${p}` : p;
}

/**
 * Build webhook body from payload and config. Omits payload.valid; adds optional timestamp, alert_id, secret.
 */
function buildBody(payload, config) {
  const body = {
    symbol: payload.symbol,
    action: payload.action,
    price: payload.price,
    quantity: payload.quantity,
    strategy: payload.strategy,
    confidence: payload.confidence,
    regime: payload.regime,
    riskAmount: payload.riskAmount,
    stopDistance: payload.stopDistance,
    riskReward: payload.riskReward,
    mode: payload.mode,
    source: payload.source,
  };

  if (config.includeTimestamp !== false) {
    body.timestamp = typeof config.timestamp === 'number' && config.timestamp > 0
      ? config.timestamp
      : Math.floor(Date.now() / 1000);
  }

  if (config.includeAlertId !== false) {
    const ts = body.timestamp != null ? body.timestamp : Math.floor(Date.now() / 1000);
    const sym = (payload.symbol || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
    body.alert_id = typeof config.alertIdPrefix === 'string'
      ? `${config.alertIdPrefix}${sym}_${ts}`
      : `quant_${sym}_${ts}`;
  }

  if (config.secret != null && String(config.secret).length > 0) {
    body.secret = config.secret;
  }

  return body;
}

/**
 * Convert execution payload to webhook request object. Pure function; no HTTP call.
 *
 * @param {object} payload - Normalized payload from signalAdapter.toPayload()
 * @param {object} [config] - { baseUrl, secret, includeTimestamp, includeAlertId, includeSecret, path, alertIdPrefix, timestamp }
 * @returns {object} { valid: boolean, url: string, headers: object, body: object|null }
 */
function toWebhookRequest(payload, config = {}) {
  const opts = { ...DEFAULT_CONFIG, ...config };

  const invalidResponse = {
    valid: false,
    url: buildUrl(opts.baseUrl, opts.path),
    headers: { 'Content-Type': 'application/json' },
    body: null,
  };

  if (!payload || typeof payload !== 'object') {
    return invalidResponse;
  }
  if (payload.valid !== true) {
    return invalidResponse;
  }

  const body = buildBody(payload, opts);

  return {
    valid: true,
    url: buildUrl(opts.baseUrl, opts.path),
    headers: { 'Content-Type': 'application/json' },
    body,
  };
}

module.exports = {
  toWebhookRequest,
  buildUrl,
  buildBody,
  DEFAULT_PATH,
  DEFAULT_CONFIG,
};
