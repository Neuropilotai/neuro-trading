/**
 * Local CSV Provider
 * Reads OHLCV data from local CSV files
 * Format: timestamp,open,high,low,close,volume (one per line)
 */

const fs = require('fs').promises;
const path = require('path');
const MarketDataProvider = require('../marketDataProvider');

class LocalCsvProvider extends MarketDataProvider {
  constructor() {
    super('local_csv');
    this.csvDir = path.join(__dirname, '../../../data/csv');
  }

  /**
   * Fetch candles from local CSV file
   */
  async fetchCandles(symbol, timeframe, limit, endTime = null) {
    const csvPath = path.join(this.csvDir, `${symbol}_${timeframe}.csv`);
    
    try {
      const data = await fs.readFile(csvPath, 'utf8');
      const lines = data.trim().split('\n');
      
      // Skip header if present
      const startIdx = lines[0].includes('timestamp') ? 1 : 0;
      
      let candles = [];
      for (let i = startIdx; i < lines.length && candles.length < limit; i++) {
        const candle = this.parseCsvLine(lines[i]);
        if (candle) {
          if (!endTime || candle.ts <= endTime) {
            candles.push(candle);
          }
        }
      }

      // Sort by timestamp (oldest first)
      candles.sort((a, b) => a.ts - b.ts);
      
      // Return last N candles
      return candles.slice(-limit);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // CSV file not found - return empty array (graceful degradation)
        // This allows the system to continue processing other symbols
        return [];
      }
      throw error;
    }
  }

  /**
   * Fetch candles since timestamp
   */
  async fetchCandlesSince(symbol, timeframe, sinceTimestamp) {
    const csvPath = path.join(this.csvDir, `${symbol}_${timeframe}.csv`);
    
    try {
      const data = await fs.readFile(csvPath, 'utf8');
      const lines = data.trim().split('\n');
      const startIdx = lines[0].includes('timestamp') ? 1 : 0;
      
      const candles = [];
      for (let i = startIdx; i < lines.length; i++) {
        const candle = this.parseCsvLine(lines[i]);
        if (candle && candle.ts > sinceTimestamp) {
          candles.push(candle);
        }
      }

      candles.sort((a, b) => a.ts - b.ts);
      return candles;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Parse CSV line
   */
  parseCsvLine(line) {
    const parts = line.split(',');
    if (parts.length < 6) return null;

    return {
      ts: parseInt(parts[0]),
      open: parseFloat(parts[1]),
      high: parseFloat(parts[2]),
      low: parseFloat(parts[3]),
      close: parseFloat(parts[4]),
      volume: parseFloat(parts[5])
    };
  }

  /**
   * Normalize candle (already normalized from CSV)
   */
  normalizeCandle(candle) {
    return candle;
  }
}

module.exports = LocalCsvProvider;

