'use strict';

/**
 * OANDA v20 read-only pricing (mid from bid/ask).
 *
 * Env (aligns with OANDABrokerAdapter + optional OANDA_ENV):
 * - OANDA_API_KEY
 * - OANDA_ACCOUNT_ID
 * - OANDA_ENVIRONMENT | OANDA_ENV — practice | live (default practice)
 */

/**
 * Primary OANDA instrument per logical symbol.
 * US index CFDs vary by region/account — see INSTRUMENT_FALLBACKS for alternates.
 */
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
  LTCUSD: 'LTC_USD',
  SOLUSD: 'SOL_USD',
  /** Index CFDs — primary names; fetchMidPrice tries fallbacks on 4xx/empty quote. */
  NAS100USD: 'NAS100_USD',
  /** S&P 500: OANDA commonly exposes US500_USD (not always SPX500_USD). */
  SPX500USD: 'US500_USD',
});

/** Additional instrument codes to try in order after primary (same symbol key). */
const INSTRUMENT_FALLBACKS = Object.freeze({
  NAS100USD: ['US100_USD'],
  SPX500USD: ['SPX500_USD'],
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

/** Ordered OANDA instrument codes: primary + fallbacks (deduped). */
function listInstrumentCandidates(normalizedSymbol) {
  const n = normalizeSymbol(normalizedSymbol);
  const primary = SYMBOL_TO_INSTRUMENT[n];
  const extras = INSTRUMENT_FALLBACKS[n] || [];
  const out = [];
  if (primary) out.push(primary);
  for (const x of extras) {
    if (x && !out.includes(x)) out.push(x);
  }
  return out;
}

async function fetchPricingForInstrument(accountId, apiKey, baseUrl, instrument) {
  const url = `${baseUrl}/v3/accounts/${encodeURIComponent(accountId)}/pricing?instruments=${encodeURIComponent(
    instrument
  )}`;
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
    const err = new Error(`OANDA pricing parse error: ${e.message}`);
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    const msg = data.errorMessage || data.message || res.statusText;
    const err = new Error(`OANDA pricing ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  const price = data.prices && data.prices[0];
  if (!price || !price.bids?.[0] || !price.asks?.[0]) {
    const err = new Error('OANDA pricing: empty bids/asks');
    err.status = 0;
    throw err;
  }
  const bid = parseFloat(price.bids[0].price);
  const ask = parseFloat(price.asks[0].price);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    const err = new Error('OANDA pricing: invalid bid/ask');
    err.status = 0;
    throw err;
  }
  const mid = (bid + ask) / 2;
  return { mid, bid, ask, instrument };
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

  const n = normalizeSymbol(normalizedSymbol);
  const candidates = listInstrumentCandidates(n);
  if (!candidates.length) {
    throw new Error(`No OANDA instrument mapping for ${normalizedSymbol}`);
  }

  const baseUrl = getBaseUrl();
  const t0 = Date.now();
  const errors = [];

  for (let i = 0; i < candidates.length; i++) {
    const instrument = candidates[i];
    try {
      const row = await fetchPricingForInstrument(accountId, apiKey, baseUrl, instrument);
      const latencyMs = Date.now() - t0;
      if (i > 0) {
        console.log(`[OANDA] symbol=${n} ok instrument=${instrument} (attempt ${i + 1}/${candidates.length})`);
      }
      return { ...row, latencyMs };
    } catch (e) {
      errors.push(`${instrument}: ${e.message}`);
    }
  }

  throw new Error(`OANDA pricing failed for ${n}; tried [${candidates.join(', ')}] — ${errors.join(' | ')}`);
}

module.exports = {
  normalizeSymbol,
  mapToInstrument,
  listInstrumentCandidates,
  fetchMidPrice,
  SYMBOL_TO_INSTRUMENT,
  INSTRUMENT_FALLBACKS,
};
