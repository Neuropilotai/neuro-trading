/**
 * Market Data Provider Interface
 * Abstract base class for OHLCV data providers
 */

class MarketDataProvider {
  constructor(name) {
    this.name = name;
    this.rateLimitDelay = 100; // ms between requests
    this.lastRequestTime = 0;
  }

  /**
   * Get provider name
   */
  getName() {
    return this.name;
  }

  /**
   * Rate limiting helper
   */
  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Fetch historical candles
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe (1, 5, 15, 60, 240, D)
   * @param {number} limit - Number of candles to fetch
   * @param {number} endTime - Optional end timestamp (ms)
   * @returns {Promise<Array>} Array of candles [{ts, open, high, low, close, volume}]
   */
  async fetchCandles(symbol, timeframe, limit, endTime = null) {
    throw new Error('fetchCandles must be implemented by subclass');
  }

  /**
   * Fetch candles since timestamp
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - Timeframe
   * @param {number} sinceTimestamp - Fetch candles after this timestamp (ms)
   * @returns {Promise<Array>} Array of candles
   */
  async fetchCandlesSince(symbol, timeframe, sinceTimestamp) {
    throw new Error('fetchCandlesSince must be implemented by subclass');
  }

  /**
   * Normalize candle to standard format
   * @param {object} rawCandle - Raw candle from provider
   * @returns {object} Normalized candle {ts, open, high, low, close, volume}
   */
  normalizeCandle(rawCandle) {
    throw new Error('normalizeCandle must be implemented by subclass');
  }

  /**
   * Convert TradingView timeframe to provider format
   * @param {string} tvTimeframe - TradingView timeframe (1, 5, 15, 60, 240, D)
   * @returns {string} Provider-specific timeframe format
   */
  convertTimeframe(tvTimeframe) {
    const mapping = {
      '1': '1m',
      '5': '5m',
      '15': '15m',
      '60': '1h',
      '240': '4h',
      'D': '1d'
    };
    return mapping[tvTimeframe] || tvTimeframe;
  }
}

module.exports = MarketDataProvider;


