'use strict';

/**
 * OANDA v20 REST — isolated market order placement (execution layer only).
 *
 * Uses the same env contract as historical data (`engine/data/providers/oanda.js`):
 * - NEUROPILOT_OANDA_API_KEY — Bearer token (required to place orders)
 * - NEUROPILOT_OANDA_ACCOUNT_ID — account id
 * - NEUROPILOT_OANDA_ENV — "practice" | "live" (default practice)
 *
 * Never logs tokens, secrets, or full Authorization headers.
 */

const https = require('https');
const { URL } = require('url');

const BASE_BY_ENV = {
  practice: 'https://api-fxpractice.oanda.com',
  live: 'https://api-fxtrade.oanda.com',
};

function getBaseUrl() {
  const env = String(process.env.NEUROPILOT_OANDA_ENV || 'practice').toLowerCase();
  const base = BASE_BY_ENV[env];
  if (!base) {
    throw new Error(
      `OANDA execution: invalid NEUROPILOT_OANDA_ENV (use practice or live)`
    );
  }
  return base;
}

function requireCredentials() {
  const token = process.env.NEUROPILOT_OANDA_API_KEY;
  const accountId = process.env.NEUROPILOT_OANDA_ACCOUNT_ID;
  if (!token || !String(token).trim()) {
    throw new Error('OANDA execution: NEUROPILOT_OANDA_API_KEY is missing or empty');
  }
  if (!accountId || !String(accountId).trim()) {
    throw new Error('OANDA execution: NEUROPILOT_OANDA_ACCOUNT_ID is missing or empty');
  }
  return { token: String(token).trim(), accountId: String(accountId).trim() };
}

/**
 * @param {string} urlString
 * @param {Record<string, string>} headers
 * @param {string} body
 * @returns {Promise<{ statusCode: number, headers: object, body: string }>}
 */
function httpsPostJson(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: raw,
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('OANDA execution: request timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Prefer broker order id (matches ORDER_FILL.orderID on the ledger). Fallback to fill tx id.
 */
function extractOrderId(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const fill = parsed.orderFillTransaction;
  if (fill) {
    if (fill.orderID != null) return String(fill.orderID);
    if (fill.id != null) return String(fill.id);
  }
  const create = parsed.orderCreateTransaction;
  if (create && create.id) return String(create.id);
  const lc = parsed.lastTransactionID;
  if (lc) return String(lc);
  return null;
}

/** OANDA ClientExtensions max lengths (v20). */
const CLIENT_EXT_MAX_ID = 128;
const CLIENT_EXT_MAX_TAG = 128;
const CLIENT_EXT_MAX_COMMENT = 128;

function clipClientExt(value, maxLen) {
  const s = value == null ? '' : String(value);
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/**
 * Build clientExtensions + tradeClientExtensions for traceability (signalExecutionKey → id).
 * @param {{ signalExecutionKey: string, strategyId?: string, symbol?: string, side?: string }} corr
 * @returns {{ clientExtensions: object, tradeClientExtensions: object } | null}
 */
function buildClientExtensions(corr) {
  if (!corr || typeof corr !== 'object') return null;
  const rawId = corr.signalExecutionKey != null ? String(corr.signalExecutionKey).trim() : '';
  if (!rawId) return null;
  const id = clipClientExt(rawId, CLIENT_EXT_MAX_ID);
  const tag = clipClientExt(corr.strategyId != null ? String(corr.strategyId) : '', CLIENT_EXT_MAX_TAG);
  const sym = corr.symbol != null ? String(corr.symbol) : '';
  const side = corr.side != null ? String(corr.side) : '';
  const comment = clipClientExt(`${sym}|${side}`.replace(/\s+/g, ''), CLIENT_EXT_MAX_COMMENT);
  const clientExtensions = { id };
  if (tag) clientExtensions.tag = tag;
  if (comment) clientExtensions.comment = comment;
  const tradeClientExtensions = { ...clientExtensions };
  return { clientExtensions, tradeClientExtensions };
}

/**
 * Place a MARKET order on OANDA.
 *
 * @param {{ instrument: string, units: number, side: 'buy'|'sell' }} order
 * @param {{ signalExecutionKey: string, strategyId?: string, symbol?: string, side?: string }|null} [correlation] — Phase A: tags only; omit if no key
 * @returns {Promise<{ ok: boolean, statusCode: number, orderId: string|null, body: object|string, errorMessage?: string }>}
 */
async function placeMarketOrder(order, correlation = null) {
  const creds = requireCredentials();
  const base = getBaseUrl();
  const url = `${base}/v3/accounts/${creds.accountId}/orders`;
  const u = Math.abs(Math.floor(Number(order.units)));
  if (!Number.isFinite(u) || u <= 0) {
    return {
      ok: false,
      statusCode: 0,
      orderId: null,
      body: null,
      errorMessage: 'invalid_units',
    };
  }
  const side = String(order.side || '').toLowerCase();
  const signed = side === 'sell' ? -u : u;
  const payload = {
    order: {
      instrument: String(order.instrument),
      units: String(signed),
      type: 'MARKET',
      positionFill: 'DEFAULT',
    },
  };
  const ext = buildClientExtensions(correlation);
  if (ext) {
    payload.order.clientExtensions = ext.clientExtensions;
    payload.order.tradeClientExtensions = ext.tradeClientExtensions;
  }
  const bodyStr = JSON.stringify(payload);
  const headers = {
    Authorization: `Bearer ${creds.token}`,
    Accept: 'application/json',
  };

  const { statusCode, body } = await httpsPostJson(url, headers, bodyStr);
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    parsed = body;
  }

  if (statusCode >= 200 && statusCode < 300) {
    const orderId = extractOrderId(parsed);
    return { ok: true, statusCode, orderId, body: parsed };
  }

  let errorMessage = `HTTP ${statusCode}`;
  if (parsed && typeof parsed === 'object' && parsed.errorMessage) {
    errorMessage = String(parsed.errorMessage);
  }
  return { ok: false, statusCode, orderId: null, body: parsed, errorMessage };
}

module.exports = {
  getBaseUrl,
  requireCredentials,
  placeMarketOrder,
  buildClientExtensions,
  extractOrderId,
};
