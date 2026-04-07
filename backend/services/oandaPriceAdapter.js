'use strict';

/**
 * OANDA v20 read-only pricing (mid from bid/ask).
 *
 * Env (aligns with OANDABrokerAdapter + optional OANDA_ENV):
 * - OANDA_API_KEY
 * - OANDA_ACCOUNT_ID
 * - OANDA_ENVIRONMENT | OANDA_ENV — practice | live (default practice)
 */

/** @type {Record<string, string>} normalized symbol -> OANDA instrument */
const SYMBOL_TO_INSTRUMENT = Object.freeze({
  XAUUSD: 'XAU_USD',
  EURUSD: 'EUR_USD',
  GBPUSD: 'GBP_USD',
  USDJPY: 'USD_JPY',
  AUDUSD: 'AUD_USD',
  USDCAD: 'USD_CAD',
  NZDUSD: 'NZD_USD',
  USDCHF: 'USD_CHF',
  BTCUSD: 'BTC_USD',
  ETHUSD: 'ETH_USD',
});

function normalizeSymbol(symbol) {
  return String(symbol || '').toUpperCase().trim();
}

function getBaseUrl() {
  const env = String(
    process.env.OANDA_ENVIRONMENT || process.env.OANDA_ENV || 'practice'
  ).toLowerCase();
  return env === 'live'
    ? 'https://api-fxtrade.oanda.com'
    : 'https://api-fxpractice.oanda.com';
}

function mapToInstrument(normalizedSymbol) {
  const n = normalizeSymbol(normalizedSymbol);
  return SYMBOL_TO_INSTRUMENT[n] || null;
}

/**
 * @param {string} normalizedSymbol e.g. XAUUSD
 * @returns {Promise<{ mid: number, latencyMs: number, instrument: string, bid: number, ask: number }>}
 */
async function fetchMidPrice(normalizedSymbol) {
  const apiKey = process.env.OANDA_API_KEY;
  const accountId = process.env.OANDA_ACCOUNT_ID;
  if (!apiKey || !accountId) {
    throw new Error('OANDA_API_KEY and OANDA_ACCOUNT_ID required for live pricing');
  }

  const instrument = mapToInstrument(normalizedSymbol);
  if (!instrument) {
    throw new Error(`No OANDA instrument mapping for ${normalizedSymbol}`);
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/v3/accounts/${encodeURIComponent(
    accountId
  )}/pricing?instruments=${encodeURIComponent(instrument)}`;

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`OANDA pricing parse error: ${e.message}`);
  }

  if (!res.ok) {
    const msg = data.errorMessage || data.message || res.statusText;
    throw new Error(`OANDA pricing ${res.status}: ${msg}`);
  }

  const price = data.prices && data.prices[0];
  if (!price || !price.bids?.[0] || !price.asks?.[0]) {
    throw new Error('OANDA pricing: empty bids/asks');
  }

  const bid = parseFloat(price.bids[0].price);
  const ask = parseFloat(price.asks[0].price);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    throw new Error('OANDA pricing: invalid bid/ask');
  }

  const mid = (bid + ask) / 2;
  const latencyMs = Date.now() - t0;

  return { mid, bid, ask, latencyMs, instrument };
}

module.exports = {
  normalizeSymbol,
  mapToInstrument,
  fetchMidPrice,
  SYMBOL_TO_INSTRUMENT,
};
