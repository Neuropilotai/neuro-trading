/**
 * TradingView Universe Loader
 * Loads and merges universe configuration with watchlist
 */

const fs = require('fs').promises;
const path = require('path');

class UniverseLoader {
  constructor() {
    this.universePath = path.join(__dirname, '../../config/tradingview_universe.json');
    this.watchlistPath = path.join(__dirname, '../../config/tradingview_watchlist.txt');
    this.universe = null;
  }

  /**
   * Load universe configuration
   */
  async load() {
    try {
      // Load base universe
      const data = await fs.readFile(this.universePath, 'utf8');
      this.universe = JSON.parse(data);

      // Merge watchlist if exists
      try {
        const watchlistData = await fs.readFile(this.watchlistPath, 'utf8');
        const watchlistSymbols = watchlistData
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));

        // Merge symbols (dedupe)
        const existingSymbols = new Set(this.universe.symbols);
        for (const symbol of watchlistSymbols) {
          if (!existingSymbols.has(symbol)) {
            this.universe.symbols.push(symbol);
            
            // Add default metadata if missing
            if (!this.universe.symbolMetadata[symbol]) {
              this.universe.symbolMetadata[symbol] = {
                assetClass: this.detectAssetClass(symbol),
                provider: this.getDefaultProvider(symbol),
                exchange: "UNKNOWN"
              };
            }
          }
        }

        console.log(`✅ Merged ${watchlistSymbols.length} symbols from watchlist`);
      } catch (error) {
        // Watchlist doesn't exist, that's OK
        console.log('ℹ️  No watchlist file found, using universe config only');
      }

      return this.universe;
    } catch (error) {
      throw new Error(`Failed to load universe: ${error.message}`);
    }
  }

  /**
   * Detect asset class from symbol
   */
  detectAssetClass(symbol) {
    if (symbol.includes('USDT') || symbol.includes('BTC') || symbol.includes('ETH')) {
      return 'crypto';
    }
    if (symbol.length <= 4 && !symbol.includes('/')) {
      return 'stocks';
    }
    if (symbol.includes('/')) {
      return 'forex';
    }
    return 'crypto'; // default
  }

  /**
   * Get default provider for symbol
   */
  getDefaultProvider(symbol) {
    const assetClass = this.detectAssetClass(symbol);
    return this.universe.providerMapping[assetClass] || this.universe.providerMapping.default;
  }

  /**
   * Get all symbol/timeframe combinations
   */
  getSymbolTimeframePairs() {
    if (!this.universe) {
      throw new Error('Universe not loaded. Call load() first.');
    }

    const pairs = [];
    for (const symbol of this.universe.symbols) {
      for (const timeframe of this.universe.timeframes) {
        pairs.push({ symbol, timeframe });
      }
    }
    return pairs;
  }

  /**
   * Get max history bars for timeframe
   */
  getMaxHistoryBars(timeframe) {
    return this.universe.maxHistoryBars[timeframe] || 1000;
  }

  /**
   * Get symbol metadata
   */
  getSymbolMetadata(symbol) {
    return this.universe.symbolMetadata[symbol] || {
      assetClass: this.detectAssetClass(symbol),
      provider: this.getDefaultProvider(symbol)
    };
  }
}

module.exports = new UniverseLoader();


