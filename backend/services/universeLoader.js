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
    
    // Cache watchlist to prevent spam
    this.watchlistCache = {
      symbols: null,
      lastLoadTime: 0
    };
    this.cacheTtl = parseInt(process.env.WATCHLIST_CACHE_TTL_MS || '60000', 10); // Default 60s
    
    // Cache for load() itself to prevent repeated universe merges
    this._loadCache = {
      lastLoadTime: 0,
      promise: null
    };
    this._universeLoaded = false;
    this.universeCacheTtl = parseInt(process.env.UNIVERSE_CACHE_TTL_MS || '60000', 10); // Default 60s
  }

  /**
   * Load universe configuration (idempotent with caching)
   */
  async load() {
    const now = Date.now();
    
    // If we already loaded recently, return cached universe immediately
    if (this._universeLoaded && (now - this._loadCache.lastLoadTime) < this.universeCacheTtl) {
      return this.universe;
    }

    // If a load is already in progress, reuse that promise
    if (this._loadCache.promise) {
      return this._loadCache.promise;
    }

    // Start new load operation
    this._loadCache.promise = (async () => {
      try {
        // Load base universe
        const data = await fs.readFile(this.universePath, 'utf8');
        this.universe = JSON.parse(data);

        // Merge watchlist if exists (with caching to prevent spam)
        try {
          const watchlistSymbols = await this._loadWatchlist();
          
          if (watchlistSymbols && watchlistSymbols.length > 0) {
            // Merge symbols (dedupe)
            const existingSymbols = new Set(this.universe.symbols);
            let mergedCount = 0;
            for (const symbol of watchlistSymbols) {
              if (!existingSymbols.has(symbol)) {
                this.universe.symbols.push(symbol);
                mergedCount++;
                
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
            
            // Only log if symbols were actually merged (watchlist was re-read)
            if (mergedCount > 0) {
              console.log(`✅ Merged ${mergedCount} symbols from watchlist`);
            }
          }
        } catch (error) {
          // Watchlist doesn't exist, that's OK
          if (this.watchlistCache.lastLoadTime === 0) {
            console.log('ℹ️  No watchlist file found, using universe config only');
          }
        }

        // Mark as loaded and update cache timestamp
        this._universeLoaded = true;
        this._loadCache.lastLoadTime = Date.now();
        
        return this.universe;
      } catch (error) {
        throw new Error(`Failed to load universe: ${error.message}`);
      }
    })().finally(() => {
      // Clear in-flight promise when done
      this._loadCache.promise = null;
    });

    return this._loadCache.promise;
  }

  /**
   * Load watchlist with caching (only logs on actual file read)
   * @returns {Promise<Array<string>>} - Array of watchlist symbols
   */
  async _loadWatchlist() {
    const now = Date.now();
    const ttl = this.cacheTtl;

    // If cache is valid, return cached symbols with NO log
    if (this.watchlistCache?.symbols && (now - this.watchlistCache.lastLoadTime) < ttl) {
      return this.watchlistCache.symbols;
    }

    // Only here we actually read the file - this is when we should log
    try {
      const watchlistData = await fs.readFile(this.watchlistPath, 'utf8');
      const watchlistSymbols = watchlistData
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      // Update cache
      this.watchlistCache.symbols = watchlistSymbols;
      this.watchlistCache.lastLoadTime = now;

      return watchlistSymbols;
    } catch (error) {
      // File doesn't exist or can't be read
      if (error.code === 'ENOENT') {
        // Mark that we tried to load (so we don't log "not found" repeatedly)
        if (this.watchlistCache.lastLoadTime === 0) {
          this.watchlistCache.lastLoadTime = now;
        }
        return null;
      }
      throw error;
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


