/**
 * Provider Factory
 * Creates appropriate data provider based on symbol metadata
 */

const BinanceProvider = require('./providers/binanceProvider');
const LocalCsvProvider = require('./providers/localCsvProvider');
const YahooFinanceProvider = require('./providers/yahooFinanceProvider');

class ProviderFactory {
  constructor() {
    this.providers = new Map();
    this.defaultProvider = process.env.MARKET_DATA_PROVIDER_DEFAULT || 'binance';
  }

  /**
   * Get provider for symbol
   */
  getProvider(symbolMetadata) {
    const symbolRouter = require('./symbolRouter');
    // Extract symbol from metadata (could be symbol, symbolName, or passed directly)
    const symbol = symbolMetadata.symbol || symbolMetadata.symbolName || (typeof symbolMetadata === 'string' ? symbolMetadata : '');
    
    // Check if symbol should use Binance
    if (symbol && !symbolRouter.shouldFetchFromBinance(symbol)) {
      // Return a no-op provider for TradingView-only symbols
      // This prevents Binance API calls
      if (!this.providers.has('tradingview_only')) {
        const TradingViewOnlyProvider = require('./providers/tradingViewOnlyProvider');
        this.providers.set('tradingview_only', new TradingViewOnlyProvider());
      }
      return this.providers.get('tradingview_only');
    }
    
    const providerName = symbolMetadata.provider || this.defaultProvider;
    
    if (this.providers.has(providerName)) {
      return this.providers.get(providerName);
    }

    let provider;
    switch (providerName) {
      case 'binance':
        provider = new BinanceProvider();
        break;
      case 'local_csv':
        provider = new LocalCsvProvider();
        break;
      case 'yahoo_finance':
        provider = new YahooFinanceProvider();
        break;
      default:
        // For stocks, try local CSV first, then fallback
        if (symbolMetadata.assetClass === 'stocks') {
          console.warn(`⚠️  Unknown provider ${providerName} for stocks, trying local CSV`);
          provider = new LocalCsvProvider();
        } else {
          // For crypto, fallback to Binance
          console.warn(`⚠️  Unknown provider ${providerName}, using Binance`);
          provider = new BinanceProvider();
        }
    }

    this.providers.set(providerName, provider);
    return provider;
  }

  /**
   * Register custom provider
   */
  registerProvider(name, providerInstance) {
    this.providers.set(name, providerInstance);
  }
}

module.exports = new ProviderFactory();

