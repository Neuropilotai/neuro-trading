/**
 * Yahoo Finance Provider (Fallback for Stocks)
 * Uses yahoo-finance2 npm package or public API
 * 
 * Note: This is a fallback provider. For production, consider:
 * - Alpha Vantage API (free tier available)
 * - Polygon.io (paid but reliable)
 * - IEX Cloud (free tier available)
 */

const https = require('https');
const MarketDataProvider = require('../marketDataProvider');

class YahooFinanceProvider extends MarketDataProvider {
  constructor() {
    super('yahoo_finance');
    this.rateLimitDelay = 1000; // 1 second between requests (Yahoo is rate-limited)
  }

  /**
   * Fetch historical candles from Yahoo Finance
   * Note: Yahoo Finance public API is unreliable. This is a placeholder.
   * For production, use a proper stock data provider.
   */
  async fetchCandles(symbol, timeframe, limit, endTime = null) {
    await this.rateLimit();

    // Yahoo Finance public API is not reliable for programmatic access
    // This is a placeholder that returns empty array
    // In production, use Alpha Vantage, Polygon.io, or IEX Cloud
    
    console.warn(`⚠️  Yahoo Finance provider not fully implemented for ${symbol}. Use local CSV or a paid stock data provider.`);
    return [];
  }

  /**
   * Fetch candles since timestamp
   */
  async fetchCandlesSince(symbol, timeframe, sinceTimestamp) {
    return this.fetchCandles(symbol, timeframe, 1000, Date.now());
  }

  /**
   * Normalize candle (placeholder)
   */
  normalizeCandle(rawCandle) {
    return {
      ts: rawCandle.timestamp || rawCandle.date || Date.now(),
      open: parseFloat(rawCandle.open),
      high: parseFloat(rawCandle.high),
      low: parseFloat(rawCandle.low),
      close: parseFloat(rawCandle.close),
      volume: parseFloat(rawCandle.volume || 0)
    };
  }
}

module.exports = YahooFinanceProvider;


