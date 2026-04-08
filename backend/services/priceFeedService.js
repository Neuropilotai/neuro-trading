'use strict';

/**
 * Multi-provider price feed with TTL cache.
 * Priority for quotes: fresh live (OANDA) → stale live → last-seen (webhook) → null (caller uses avg).
 *
 * Env:
 * - ENABLE_LIVE_PRICING=true|false
 * - PRICE_FEED_PROVIDER=oanda
 * - PRICE_TTL_MS=2000
 * - PRICE_WATCH_SYMBOLS=XAUUSD,EURUSD (optional refresh targets)
 */

const oandaPriceAdapter = require('./oandaPriceAdapter');

class PriceFeedService {
  constructor() {
    /** @type {Map<string, number>} */
    this.lastSeenBySymbol = new Map();
    /** @type {Map<string, { mid: number, fetchedAt: number, latencyMs: number, instrument?: string }>} */
    this.liveBySymbol = new Map();
    /** @type {Map<string, Promise<object>>} */
    this._inFlight = new Map();
    this.lastGlobalLatencyMs = null;
  }

  normalizeSymbol(symbol) {
    return String(symbol || '').toUpperCase().trim();
  }

  isLiveEnabled() {
    return ['1', 'true', 'yes', 'on'].includes(
      String(process.env.ENABLE_LIVE_PRICING || '').trim().toLowerCase()
    );
  }

  getTtlMs() {
    const n = parseInt(process.env.PRICE_TTL_MS || '2000', 10);
    return Number.isFinite(n) && n > 0 ? n : 2000;
  }

  getProvider() {
    return String(process.env.PRICE_FEED_PROVIDER || 'oanda').toLowerCase();
  }

  /**
   * Webhook / execution path: last trade price seen (normalized key).
   */
  updatePrice(symbol, price) {
    const n = this.normalizeSymbol(symbol);
    const p = Number(price);
    if (!n || !Number.isFinite(p) || p <= 0) return;
    this.lastSeenBySymbol.set(n, p);
    try {
      const tradeLifecycleService = require('./tradeLifecycleService');
      tradeLifecycleService.notifyPriceTick(n, p);
    } catch (e) {
      /* never break pricing path */
    }
  }

  /**
   * @returns {number|null}
   */
  getPrice(symbol) {
    const q = this.getQuoteSync(symbol);
    return q && Number.isFinite(Number(q.price)) ? Number(q.price) : null;
  }

  /**
   * @returns {Record<string, ReturnType<PriceFeedService['getQuoteSync']>>}
   */
  getSnapshot() {
    const keys = new Set([
      ...this.lastSeenBySymbol.keys(),
      ...this.liveBySymbol.keys(),
    ]);
    const out = {};
    for (const k of keys) {
      out[k] = this.getQuoteSync(k);
    }
    return out;
  }

  _isLiveFresh(n) {
    const row = this.liveBySymbol.get(n);
    if (!row) return false;
    return Date.now() - row.fetchedAt <= this.getTtlMs();
  }

  /**
   * Synchronous read only (no network). Safe for getAccountSummary().
   * @returns {{ price: number|null, source: 'live'|'cached'|'fallback', markTimestamp: string|null, latencyMs: number|null }}
   */
  getQuoteSync(symbol) {
    const n = this.normalizeSymbol(symbol);
    const now = Date.now();
    const live = this.liveBySymbol.get(n);
    const ttl = this.getTtlMs();

    if (this.isLiveEnabled() && live && now - live.fetchedAt <= ttl) {
      return {
        price: live.mid,
        source: 'live',
        markTimestamp: new Date(live.fetchedAt).toISOString(),
        latencyMs: live.latencyMs ?? null,
      };
    }

    if (this.isLiveEnabled() && live) {
      return {
        price: live.mid,
        source: 'cached',
        markTimestamp: new Date(live.fetchedAt).toISOString(),
        latencyMs: live.latencyMs ?? null,
      };
    }

    const seen = this.lastSeenBySymbol.get(n);
    if (Number.isFinite(seen) && seen > 0) {
      return {
        price: seen,
        source: 'cached',
        markTimestamp: null,
        latencyMs: null,
      };
    }

    return {
      price: null,
      source: 'fallback',
      markTimestamp: null,
      latencyMs: null,
    };
  }

  /**
   * @param {string[]} positionSymbols normalized symbols for open positions
   */
  getAccountPricingMeta(positionSymbols = []) {
    if (!this.isLiveEnabled()) {
      return {
        /** Mark-to-market quote path — not TRADING_MODE / not broker live execution */
        pricingMode: 'mark_feed_off',
        priceLatency: this.lastGlobalLatencyMs,
      };
    }
    const list =
      positionSymbols.length > 0
        ? positionSymbols.map((s) => this.normalizeSymbol(s))
        : [...this.lastSeenBySymbol.keys()];
    const fresh = list.some((s) => this._isLiveFresh(s));
    return {
      /** Fresh external quote within TTL — avoid calling this "live" (confuses with live trading) */
      pricingMode: fresh ? 'mark_quote_fresh' : 'mark_quote_stale',
      priceLatency: this.lastGlobalLatencyMs,
    };
  }

  async _fetchAndStoreLive(n) {
    if (this.getProvider() !== 'oanda') {
      return;
    }
    const { mid, latencyMs, instrument } = await oandaPriceAdapter.fetchMidPrice(n);
    this.liveBySymbol.set(n, {
      mid,
      fetchedAt: Date.now(),
      latencyMs,
      instrument,
    });
    this.lastGlobalLatencyMs = latencyMs;
    console.log(
      `[PRICE_FEED] symbol=${n} price=${mid} source=OANDA latency=${latencyMs}ms inst=${instrument}`
    );
    try {
      const tradeLifecycleService = require('./tradeLifecycleService');
      tradeLifecycleService.notifyPriceTick(n, mid);
    } catch (e) {
      /* never break fetch path */
    }
  }

  /**
   * Network refresh if live enabled and cache stale. Returns latest quote object (same shape as getQuoteSync).
   */
  async ensureFreshQuote(symbol) {
    const n = this.normalizeSymbol(symbol);
    if (!this.isLiveEnabled()) {
      return this.getQuoteSync(n);
    }
    if (this._isLiveFresh(n)) {
      return this.getQuoteSync(n);
    }

    if (this._inFlight.has(n)) {
      await this._inFlight.get(n);
      return this.getQuoteSync(n);
    }

    const task = (async () => {
      try {
        await this._fetchAndStoreLive(n);
      } catch (e) {
        console.warn(`[PRICE_FEED] fetch failed symbol=${n}: ${e.message}`);
      }
    })();

    this._inFlight.set(n, task);
    try {
      await task;
    } finally {
      this._inFlight.delete(n);
    }
    return this.getQuoteSync(n);
  }

  /**
   * Refresh all last-seen symbols plus PRICE_WATCH_SYMBOLS (background / startup).
   */
  async refreshWatchlist() {
    if (!this.isLiveEnabled()) return;
    const symbols = new Set([...this.lastSeenBySymbol.keys()]);
    const extra = String(process.env.PRICE_WATCH_SYMBOLS || '')
      .split(',')
      .map((s) => this.normalizeSymbol(s))
      .filter(Boolean);
    extra.forEach((s) => symbols.add(s));
    await Promise.all([...symbols].map((s) => this.ensureFreshQuote(s)));
  }
}

module.exports = new PriceFeedService();
