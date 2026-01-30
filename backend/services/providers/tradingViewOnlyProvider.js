/**
 * TradingView-Only Provider
 * No-op provider for symbols that should only receive TradingView alerts
 * Prevents market data fetches for non-Binance symbols
 */

const MarketDataProvider = require('../marketDataProvider');

class TradingViewOnlyProvider extends MarketDataProvider {
  constructor() {
    super('tradingview_only');
  }

  /**
   * Fetch candles - returns empty array (no market data fetch)
   */
  async fetchCandles(symbol, timeframe, limit, endTime = null) {
    // Return empty array - this symbol should only receive TradingView alerts
    return [];
  }

  /**
   * Fetch candles since timestamp - returns empty array
   */
  async fetchCandlesSince(symbol, timeframe, sinceTimestamp) {
    return [];
  }

  /**
   * Normalize candle (placeholder - never called)
   */
  normalizeCandle(rawCandle) {
    return {
      ts: Date.now(),
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume: 0
    };
  }
}

module.exports = TradingViewOnlyProvider;

