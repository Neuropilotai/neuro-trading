/**
 * Symbol Router
 * Classifies symbols and routes them to appropriate data sources
 * 
 * Environment Variables:
 * - ENABLE_TRADINGVIEW_ONLY_SYMBOLS (default: true)
 * - AUTOTRADER_DATA_SOURCE (default: 'binance')
 */

class SymbolRouter {
  constructor() {
    this.enableTradingViewOnly = process.env.ENABLE_TRADINGVIEW_ONLY_SYMBOLS !== 'false';
    this.autotraderDataSource = (process.env.AUTOTRADER_DATA_SOURCE || 'binance').toLowerCase();
    this.logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
    
    // Track warnings to prevent spam
    this.warnedSymbols = new Set();
  }

  /**
   * Classify symbol and determine data source
   * @param {string} symbol - Symbol to classify
   * @returns {{source: 'binance'|'tradingview_only'|'unknown', normalizedSymbol: string}}
   */
  classifySymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') {
      return { source: 'unknown', normalizedSymbol: symbol };
    }

    const normalizedSymbol = symbol.trim().toUpperCase();

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
   * Check if symbol should fetch market data from Binance
   * @param {string} symbol - Symbol to check
   * @returns {boolean} - True if Binance fetch is allowed
   */
  shouldFetchFromBinance(symbol) {
    const classification = this.classifySymbol(symbol);
    return classification.source === 'binance';
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
}

module.exports = new SymbolRouter();

