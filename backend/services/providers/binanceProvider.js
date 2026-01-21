/**
 * Binance OHLCV Provider
 * Fetches crypto market data from Binance API
 */

const https = require('https');
const MarketDataProvider = require('../marketDataProvider');

class BinanceProvider extends MarketDataProvider {
  constructor() {
    super('binance');
    this.baseUrl = 'api.binance.com';
    this.rateLimitDelay = 200; // Binance rate limit: 1200 requests/min
  }

  /**
   * Fetch historical candles from Binance
   */
  async fetchCandles(symbol, timeframe, limit, endTime = null) {
    await this.rateLimit();

    const interval = this.convertTimeframe(timeframe);
    const params = new URLSearchParams({
      symbol: symbol,
      interval: interval,
      limit: Math.min(limit, 1000) // Binance max is 1000
    });

    if (endTime) {
      params.append('endTime', endTime);
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.baseUrl,
        path: `/api/v3/klines?${params.toString()}`,
        method: 'GET'
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error(`Binance API error: ${res.statusCode} - ${data}`));
            }

            const klines = JSON.parse(data);
            const candles = klines.map(k => this.normalizeCandle(k));
            resolve(candles);
          } catch (error) {
            reject(new Error(`Failed to parse Binance response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Binance request failed: ${error.message}`));
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Binance request timeout'));
      });

      req.end();
    });
  }

  /**
   * Fetch candles since timestamp
   */
  async fetchCandlesSince(symbol, timeframe, sinceTimestamp) {
    const now = Date.now();
    const interval = this.convertTimeframe(timeframe);
    const intervalMs = this.getIntervalMs(timeframe);
    
    // Estimate how many candles we need
    const estimatedCandles = Math.ceil((now - sinceTimestamp) / intervalMs);
    const limit = Math.min(estimatedCandles, 1000);

    return this.fetchCandles(symbol, timeframe, limit, now);
  }

  /**
   * Get interval duration in milliseconds
   */
  getIntervalMs(timeframe) {
    const mapping = {
      '1': 60 * 1000,
      '5': 5 * 60 * 1000,
      '15': 15 * 60 * 1000,
      '60': 60 * 60 * 1000,
      '240': 4 * 60 * 60 * 1000,
      'D': 24 * 60 * 60 * 1000
    };
    return mapping[timeframe] || 60 * 1000;
  }

  /**
   * Normalize Binance kline to standard format
   */
  normalizeCandle(kline) {
    return {
      ts: parseInt(kline[0]), // Open time
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5])
    };
  }
}

module.exports = BinanceProvider;


