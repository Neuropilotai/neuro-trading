/**
 * Symbol Router
 * Classifies symbols and routes them to appropriate data sources
 * 
 * Environment Variables:
 * - ENABLE_TRADINGVIEW_ONLY_SYMBOLS (default: true)
 * - AUTOTRADER_DATA_SOURCE (default: 'binance')
 */

const path = require('path');
const fs = require('fs');

class SymbolRouter {
  constructor() {
    this.enableTradingViewOnly = process.env.ENABLE_TRADINGVIEW_ONLY_SYMBOLS !== 'false';
    this.autotraderDataSource = (process.env.AUTOTRADER_DATA_SOURCE || 'binance').toLowerCase();
    this.logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
    
    // Track warnings to prevent spam
    this.warnedSymbols = new Set();
    
    // OANDA symbol mapping: TradingView format -> OANDA API format
    this.OANDA_SYMBOL_MAP = {
      XAUUSD: 'XAU_USD',
      NAS100: 'NAS100_USD'
    };
    
    // Cache for universe config
    this.universe = null;
  }

  /**
   * Load tradingview_universe.json (cached)
   * @returns {Object} - Universe configuration
   */
  loadUniverse() {
    if (this.universe) return this.universe;
    const p = path.join(__dirname, '../../config/tradingview_universe.json');
    this.universe = JSON.parse(fs.readFileSync(p, 'utf8'));
    return this.universe;
  }

  /**
   * Classify symbol and determine data source
   * @param {string} symbol - Symbol to classify
   * @returns {{source: 'binance'|'oanda'|'local_csv'|'tradingview_only'|'unknown', normalizedSymbol: string, assetClass?: string, provider?: string}}
   */
  classifySymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') {
      return { source: 'unknown', normalizedSymbol: symbol };
    }

    const normalizedSymbol = symbol.trim().toUpperCase();

    // 1) If universe metadata explicitly defines provider/assetClass, trust it (PROD truth)
    const u = this.loadUniverse();
    const meta = u.symbolMetadata?.[normalizedSymbol];
    if (meta?.provider) {
      // Source is the provider unless you explicitly want to force tradingview_only
      return {
        source: meta.provider, // <- THIS is the critical line (XAUUSD => "oanda")
        normalizedSymbol,
        assetClass: meta.assetClass || 'unknown',
        provider: meta.provider
      };
    }

    // 2) Fallbacks (if not in universe)
    // TradingView-only symbols: contain : or ! or start with known prefixes
    if (this.enableTradingViewOnly) {
      if (normalizedSymbol.includes(':') || 
          normalizedSymbol.includes('!') ||
          normalizedSymbol.startsWith('OANDA:') ||
          normalizedSymbol.startsWith('FX:') ||
          normalizedSymbol.startsWith('COMEX:') ||
          normalizedSymbol.startsWith('TVC:')) {
        return { source: 'tradingview_only', normalizedSymbol };
      }
    }

    // Binance symbols: match pattern /^[A-Z0-9]{5,15}$/ and end with USDT
    const binancePattern = /^[A-Z0-9]{5,15}$/;
    if (binancePattern.test(normalizedSymbol) && normalizedSymbol.endsWith('USDT')) {
      return { source: 'binance', normalizedSymbol };
    }

    // Default to unknown (will need manual routing)
    return { source: 'unknown', normalizedSymbol };
  }

  /**
   * Check if symbol should be scanned by autotrader
   * @param {string} symbol - Symbol to check
   * @returns {boolean} - True if symbol should be scanned
   */
  shouldScanSymbol(symbol) {
    const classification = this.classifySymbol(symbol);
    
    // Only scan Binance symbols if autotrader data source is binance
    if (this.autotraderDataSource === 'binance') {
      if (classification.source === 'binance') {
        return true;
      }
      
      // Log warning once per symbol to prevent spam (use normalized symbol for Set)
      if (classification.source === 'tradingview_only' && !this.warnedSymbols.has(classification.normalizedSymbol)) {
        if (this.logLevel === 'debug' || this.logLevel === 'info') {
          console.log(`ℹ️  Skipping ${classification.normalizedSymbol} - TradingView-only symbol (not scanning)`);
        }
        this.warnedSymbols.add(classification.normalizedSymbol);
      }
      
      return false;
    }
    
    // For other data sources, allow scanning (future extensibility)
    return classification.source !== 'tradingview_only';
  }

  /**
   * Normalize symbol by removing exchange prefixes (e.g., "BINANCE:BTCUSDT" -> "BTCUSDT")
   * @param {string} symbol - Symbol to normalize
   * @returns {string} - Normalized symbol
   */
  normalizeSymbol(symbol) {
    const s = String(symbol || '').trim().toUpperCase();
    // ex: "BINANCE:BTCUSDT" -> "BTCUSDT"
    if (s.includes(':')) return s.split(':').pop();
    return s;
  }

  /**
   * Check if symbol should fetch market data from Binance
   * @param {string} symbol - Symbol to check
   * @returns {boolean} - True if Binance fetch is allowed
   */
  shouldFetchFromBinance(symbol) {
    const s = this.normalizeSymbol(symbol);
    
    // Empty symbol
    if (!s) return false;
    
    // Crypto Binance typical patterns
    if (s.endsWith('USDT')) return true;
    if (s.endsWith('BUSD')) return true;
    if (s.endsWith('USDC')) return true;
    
    // Otherwise, false
    return false;
  }

  /**
   * Filter symbols for autotrader scanning
   * @param {string[]} symbols - Array of symbols
   * @returns {string[]} - Filtered symbols that should be scanned
   */
  filterScannableSymbols(symbols) {
    return symbols.filter(symbol => this.shouldScanSymbol(symbol));
  }

  /**
   * Get all TradingView-only symbols (for webhook ingestion)
   * @param {string[]} symbols - Array of symbols
   * @returns {string[]} - TradingView-only symbols
   */
  getTradingViewOnlySymbols(symbols) {
    return symbols.filter(symbol => {
      const classification = this.classifySymbol(symbol);
      return classification.source === 'tradingview_only';
    });
  }

  /**
   * Convert symbol to OANDA API format
   * @param {string} symbol - Symbol to convert (e.g., "XAUUSD" or "OANDA:XAUUSD")
   * @returns {string} - OANDA API format symbol (e.g., "XAU_USD")
   */
  toOANDAFormat(symbol) {
    if (!symbol || typeof symbol !== 'string') {
      return symbol;
    }

    // Remove OANDA: prefix if present
    const normalized = this.normalizeSymbol(symbol);
    
    // Check if we have a mapping for this symbol
    if (this.OANDA_SYMBOL_MAP[normalized]) {
      return this.OANDA_SYMBOL_MAP[normalized];
    }
    
    // Return normalized symbol if no mapping exists
    return normalized;
  }
}

module.exports = new SymbolRouter();

