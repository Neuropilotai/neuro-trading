'use strict';

/**
 * OANDA v20 REST — read-only reconciliation (positions, trades, pending orders, transactions).
 * Reuses credentials from oandaExecution.js. Never logs tokens or secrets.
 *
 * Endpoints:
 * - GET /v3/accounts/{id}/summary
 * - GET /v3/accounts/{id}/positions
 * - GET /v3/accounts/{id}/openTrades
 * - GET /v3/accounts/{id}/pendingOrders
 * - GET /v3/accounts/{id}/transactions/sinceid?id={transactionId}
 */

const https = require('https');
const { URL } = require('url');

const { getBaseUrl, requireCredentials } = require('./oandaExecution');

const REQUEST_TIMEOUT_MS = 120000;
const MAX_TX_PAGES = 25;

/**
 * @param {string} urlString
 * @param {Record<string, string>} headers
 * @returns {Promise<{ statusCode: number, headers: object, body: string }>}
 */
function httpsGet(urlString, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      urlString,
      { headers: { ...headers } },
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
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('OANDA reconciliation: request timeout'));
    });
  });
}

function authHeaders(creds) {
  return {
    Authorization: `Bearer ${creds.token}`,
    Accept: 'application/json',
  };
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function httpErrorMessage(statusCode, body) {
  let msg = `HTTP ${statusCode}`;
  const j = parseJsonSafe(body);
  if (j && typeof j === 'object' && j.errorMessage) msg += ` — ${j.errorMessage}`;
  return msg;
}

async function getJson(url, creds) {
  const { statusCode, body } = await httpsGet(url, authHeaders(creds));
  const parsed = parseJsonSafe(body);
  if (statusCode >= 200 && statusCode < 300) {
    if (parsed && typeof parsed === 'object' && parsed.errorMessage) {
      return { ok: false, error: String(parsed.errorMessage), statusCode, parsed: null };
    }
    return { ok: true, statusCode, parsed };
  }
  return { ok: false, error: httpErrorMessage(statusCode, body), statusCode, parsed };
}

/**
 * @returns {Promise<{ ok: boolean, summary?: object, lastTransactionID?: string, error?: string }>}
 */
async function fetchAccountSummary(creds) {
  const base = getBaseUrl();
  const url = `${base}/v3/accounts/${creds.accountId}/summary`;
  const r = await getJson(url, creds);
  if (!r.ok || !r.parsed) return { ok: false, error: r.error || 'summary_failed' };
  const lt = r.parsed.lastTransactionID != null ? String(r.parsed.lastTransactionID) : null;
  return { ok: true, summary: r.parsed, lastTransactionID: lt };
}

/**
 * @returns {Promise<{ ok: boolean, positions?: object[], error?: string }>}
 */
async function fetchPositions(creds) {
  const base = getBaseUrl();
  const url = `${base}/v3/accounts/${creds.accountId}/positions`;
  const r = await getJson(url, creds);
  if (!r.ok || !r.parsed) return { ok: false, error: r.error || 'positions_failed' };
  const list = Array.isArray(r.parsed.positions) ? r.parsed.positions : [];
  return { ok: true, positions: list };
}

/**
 * @returns {Promise<{ ok: boolean, trades?: object[], error?: string }>}
 */
async function fetchOpenTrades(creds) {
  const base = getBaseUrl();
  const url = `${base}/v3/accounts/${creds.accountId}/openTrades`;
  const r = await getJson(url, creds);
  if (!r.ok || !r.parsed) return { ok: false, error: r.error || 'openTrades_failed' };
  const list = Array.isArray(r.parsed.trades) ? r.parsed.trades : [];
  return { ok: true, trades: list };
}

/**
 * @returns {Promise<{ ok: boolean, orders?: object[], error?: string }>}
 */
async function fetchPendingOrders(creds) {
  const base = getBaseUrl();
  const url = `${base}/v3/accounts/${creds.accountId}/pendingOrders`;
  const r = await getJson(url, creds);
  if (!r.ok || !r.parsed) return { ok: false, error: r.error || 'pendingOrders_failed' };
  const list = Array.isArray(r.parsed.orders) ? r.parsed.orders : [];
  return { ok: true, orders: list };
}

/**
 * Transactions strictly after `fromTransactionId` (OANDA sinceid). Paginates via re-query with updated id.
 * @param {string} fromTransactionId — required (use account lastTransactionID for empty delta)
 * @returns {Promise<{ ok: boolean, transactions?: object[], lastTransactionID?: string, error?: string }>}
 */
async function fetchTransactionsSince(creds, fromTransactionId) {
  const id = fromTransactionId != null ? String(fromTransactionId).trim() : '';
  if (!id) {
    return { ok: false, error: 'fetchTransactionsSince: fromTransactionId required' };
  }
  const base = getBaseUrl();
  const all = [];
  let cursor = id;
  let lastSeen = id;

  for (let page = 0; page < MAX_TX_PAGES; page++) {
    const url = `${base}/v3/accounts/${creds.accountId}/transactions/sinceid?id=${encodeURIComponent(cursor)}`;
    const r = await getJson(url, creds);
    if (!r.ok || !r.parsed) return { ok: false, error: r.error || 'transactions_sinceid_failed' };

    const batch = Array.isArray(r.parsed.transactions) ? r.parsed.transactions : [];
    const lastTx = r.parsed.lastTransactionID != null ? String(r.parsed.lastTransactionID) : cursor;

    for (const t of batch) all.push(t);

    lastSeen = lastTx;

    if (batch.length === 0) {
      break;
    }

    if (lastTx === cursor) {
      break;
    }

    cursor = lastTx;
  }

  return { ok: true, transactions: all, lastTransactionID: lastSeen };
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSummaryAccount(account) {
  if (!account || typeof account !== 'object') return null;
  return {
    currency: account.currency != null ? String(account.currency) : null,
    balance: num(account.balance),
    NAV: num(account.NAV),
    unrealizedPL: num(account.unrealizedPL),
    pl: num(account.pl),
    resettablePL: num(account.resettablePL),
    marginUsed: num(account.marginUsed),
    marginAvailable: num(account.marginAvailable),
    openPositionCount: Number(account.openPositionCount) || 0,
    openTradeCount: Number(account.openTradeCount) || 0,
    pendingOrderCount: Number(account.pendingOrderCount) || 0,
  };
}

function normalizePosition(p) {
  if (!p || typeof p !== 'object') return null;
  const long = p.long && typeof p.long === 'object' ? p.long : null;
  const short = p.short && typeof p.short === 'object' ? p.short : null;
  const lu = long && long.units != null ? num(long.units) : 0;
  const su = short && short.units != null ? num(short.units) : 0;
  return {
    instrument: p.instrument != null ? String(p.instrument) : null,
    longUnits: lu,
    shortUnits: su,
    netUnits: lu + su,
    unrealizedPL: num(long?.unrealizedPL) + num(short?.unrealizedPL),
    averageLongPrice: long?.averagePrice != null ? num(long.averagePrice) : null,
    averageShortPrice: short?.averagePrice != null ? num(short.averagePrice) : null,
  };
}

function normalizeTrade(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    id: t.id != null ? String(t.id) : null,
    instrument: t.instrument != null ? String(t.instrument) : null,
    currentUnits: t.currentUnits != null ? num(t.currentUnits) : 0,
    price: t.price != null ? num(t.price) : null,
    unrealizedPL: t.unrealizedPL != null ? num(t.unrealizedPL) : null,
    openTime: t.openTime != null ? String(t.openTime) : null,
  };
}

function normalizePendingOrder(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    id: o.id != null ? String(o.id) : null,
    instrument: o.instrument != null ? String(o.instrument) : null,
    type: o.type != null ? String(o.type) : null,
    state: o.state != null ? String(o.state) : null,
    units: o.units != null ? String(o.units) : null,
  };
}

function normalizeTradeLink(x) {
  if (x == null) return null;
  if (Array.isArray(x)) {
    const arr = x.map((t) => normalizeTradeLink(t)).filter(Boolean);
    return arr.length ? arr : null;
  }
  if (typeof x !== 'object') return null;
  const o = {
    tradeID: x.tradeID != null ? String(x.tradeID) : null,
    units: x.units != null ? num(x.units) : null,
  };
  if (x.realizedPL != null) o.realizedPL = num(x.realizedPL);
  return o;
}

function normalizeOrderFill(tx) {
  if (!tx || tx.type !== 'ORDER_FILL' || tx.id == null) return null;
  const ce = tx.clientExtensions && typeof tx.clientExtensions === 'object' ? tx.clientExtensions : null;
  const extId = ce && ce.id != null ? String(ce.id).trim() : '';
  const extTag = ce && ce.tag != null ? String(ce.tag).trim() : '';
  const extComment = ce && ce.comment != null ? String(ce.comment).trim() : '';
  return {
    id: String(tx.id),
    type: 'ORDER_FILL',
    time: tx.time != null ? String(tx.time) : null,
    instrument: tx.instrument != null ? String(tx.instrument) : null,
    units: tx.units != null ? num(tx.units) : 0,
    pl: num(tx.pl),
    orderID: tx.orderID != null ? String(tx.orderID) : null,
    financing: num(tx.financing),
    clientExtensions: extId || extTag || extComment
      ? {
          id: extId || null,
          tag: extTag || null,
          comment: extComment || null,
        }
      : null,
    signalExecutionKey: extId || null,
    strategyIdHint: extTag || null,
    brokerClientComment: extComment || null,
    tradeOpened: normalizeTradeLink(tx.tradeOpened),
    tradeReduced: normalizeTradeLink(tx.tradeReduced),
    tradeClosed: normalizeTradeLink(tx.tradeClosed),
    matchedLocalExecution: false,
  };
}

/**
 * Full read-only broker snapshot. Fails atomically if any required fetch fails.
 *
 * @param {{ lastTransactionId?: string|null }} options
 * @returns {Promise<{ ok: boolean, error?: string, step?: string, snapshot?: object }>}
 */
async function buildBrokerSnapshot(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  let creds;
  try {
    creds = requireCredentials();
  } catch (e) {
    return {
      ok: false,
      step: 'credentials',
      error: e && e.message ? String(e.message) : 'credentials',
    };
  }

  const sum = await fetchAccountSummary(creds);
  if (!sum.ok || !sum.summary) {
    return { ok: false, step: 'summary', error: sum.error || 'summary' };
  }

  const account = sum.summary.account;
  const summaryLastTx =
    sum.summary.lastTransactionID != null ? String(sum.summary.lastTransactionID) : sum.lastTransactionID;

  if (!summaryLastTx) {
    return { ok: false, step: 'summary', error: 'missing_lastTransactionID' };
  }

  const [pos, tr, pend] = await Promise.all([
    fetchPositions(creds),
    fetchOpenTrades(creds),
    fetchPendingOrders(creds),
  ]);

  if (!pos.ok) return { ok: false, step: 'positions', error: pos.error };
  if (!tr.ok) return { ok: false, step: 'openTrades', error: tr.error };
  if (!pend.ok) return { ok: false, step: 'pendingOrders', error: pend.error };

  const sinceFrom =
    opts.lastTransactionId != null && String(opts.lastTransactionId).trim()
      ? String(opts.lastTransactionId).trim()
      : summaryLastTx;

  const txs = await fetchTransactionsSince(creds, sinceFrom);
  if (!txs.ok) return { ok: false, step: 'transactions', error: txs.error };

  const fetchedAt = new Date().toISOString();
  const normSummary = normalizeSummaryAccount(account);
  const positions = (pos.positions || []).map(normalizePosition).filter(Boolean);
  const openTrades = (tr.trades || []).map(normalizeTrade).filter(Boolean);
  const pendingOrders = (pend.orders || []).map(normalizePendingOrder).filter(Boolean);

  const newTransactions = txs.transactions || [];
  const apiLastTx = txs.lastTransactionID || summaryLastTx;

  const snapshot = {
    fetchedAt,
    accountIdSuffix: creds.accountId.length >= 4 ? creds.accountId.slice(-4) : '****',
    summary: normSummary,
    positions,
    openTrades,
    pendingOrders,
    newTransactionCount: newTransactions.length,
    lastTransactionID: apiLastTx,
  };

  return { ok: true, snapshot, rawTransactions: newTransactions };
}

module.exports = {
  fetchAccountSummary,
  fetchPositions,
  fetchOpenTrades,
  fetchPendingOrders,
  fetchTransactionsSince,
  buildBrokerSnapshot,
  normalizeOrderFill,
  normalizeTradeLink,
};
