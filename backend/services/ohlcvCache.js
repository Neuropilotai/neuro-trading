/**
 * OHLCV Cache Manager
 * Stores and retrieves candles locally (JSONL format)
 */

const fs = require('fs').promises;
const path = require('path');
const { createWriteStream } = require('fs');

class OHLCVCache {
  constructor() {
    this.cacheDir = path.join(__dirname, '../../data/ohlcv');
  }

  /**
   * Get cache file path
   */
  getCachePath(symbol, timeframe) {
    const symbolDir = path.join(this.cacheDir, symbol);
    return path.join(symbolDir, `${timeframe}.jsonl`);
  }

  /**
   * Ensure cache directory exists
   */
  async ensureCacheDir(symbol) {
    const symbolDir = path.join(this.cacheDir, symbol);
    await fs.mkdir(symbolDir, { recursive: true });
  }

  /**
   * Append candles to cache (JSONL format)
   */
  async appendCandles(symbol, timeframe, candles) {
    await this.ensureCacheDir(symbol);
    const cachePath = this.getCachePath(symbol, timeframe);

    const lines = candles.map(c => JSON.stringify(c)).join('\n') + '\n';
    await fs.appendFile(cachePath, lines, 'utf8');
  }

  /**
   * Read all candles from cache
   */
  async readCandles(symbol, timeframe) {
    const cachePath = this.getCachePath(symbol, timeframe);
    
    try {
      const data = await fs.readFile(cachePath, 'utf8');
      const lines = data.trim().split('\n').filter(line => line);
      return lines.map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get last candle timestamp
   */
  async getLastTimestamp(symbol, timeframe) {
    const candles = await this.readCandles(symbol, timeframe);
    if (candles.length === 0) return null;
    
    const lastCandle = candles[candles.length - 1];
    return lastCandle.ts;
  }

  /**
   * Merge and dedupe candles (keep latest)
   */
  mergeCandles(existing, newCandles) {
    const candleMap = new Map();
    
    // Add existing candles
    for (const candle of existing) {
      candleMap.set(candle.ts, candle);
    }
    
    // Add/update with new candles
    for (const candle of newCandles) {
      candleMap.set(candle.ts, candle);
    }
    
    // Sort by timestamp
    return Array.from(candleMap.values()).sort((a, b) => a.ts - b.ts);
  }

  /**
   * Replace entire cache (atomic write)
   */
  async replaceCache(symbol, timeframe, candles) {
    await this.ensureCacheDir(symbol);
    const cachePath = this.getCachePath(symbol, timeframe);
    const tempPath = `${cachePath}.tmp`;

    // Write to temp file
    const lines = candles.map(c => JSON.stringify(c)).join('\n') + '\n';
    await fs.writeFile(tempPath, lines, 'utf8');

    // Atomic rename
    await fs.rename(tempPath, cachePath);
  }

  /**
   * Get cache size (number of candles)
   */
  async getCacheSize(symbol, timeframe) {
    const candles = await this.readCandles(symbol, timeframe);
    return candles.length;
  }
}

module.exports = new OHLCVCache();


