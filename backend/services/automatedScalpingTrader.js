/**
 * Automated Scalping Trader
 * Automatically executes trades based on scalping indicators
 * Maintains 80%+ accuracy by adjusting confidence thresholds
 */

const EventEmitter = require('events');
const indicatorGenerator = require('./indicatorGenerator');
const { getBrokerAdapter } = require('../adapters/brokerAdapterFactory');
const tradingLearningService = require('./tradingLearningService');
const dailyPatternTracker = require('./dailyPatternTracker');
const patternLearningEngine = require('./patternLearningEngine');
const whaleDetectionAgent = require('./whaleDetectionAgent');

class AutomatedScalpingTrader extends EventEmitter {
  constructor() {
    super();
    this.enabled = process.env.ENABLE_AUTOMATED_TRADING !== 'false';
    this.isRunning = false;
    this.intervalId = null;
    
    // Trading configuration
    this.config = {
      minConfidence: parseFloat(process.env.AUTO_TRADE_MIN_CONFIDENCE || '0.80'), // Start at 80%
      targetAccuracy: parseFloat(process.env.TARGET_ACCURACY || '0.80'), // 80% target
      checkIntervalSeconds: parseInt(process.env.AUTO_TRADE_CHECK_INTERVAL || '30', 10), // Check every 30 seconds
      maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || '50', 10),
      minTimeBetweenTrades: parseInt(process.env.MIN_TIME_BETWEEN_TRADES || '60', 10), // 60 seconds
      positionSizePercent: parseFloat(process.env.AUTO_POSITION_SIZE_PERCENT || '2.0'), // 2% per trade
    };
    
    // Performance tracking
    this.performance = {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      currentAccuracy: 0,
      currentWinRate: 0,
      dailyTrades: 0,
      lastTradeTime: null,
      recentTrades: [] // Last 20 trades for accuracy calculation
    };
    
    // Active positions
    this.activePositions = new Map(); // symbol -> {entryPrice, quantity, stopLoss, takeProfit, indicatorId}
    
    // Confidence adjustment
    this.confidenceAdjustment = {
      baseConfidence: this.config.minConfidence,
      adjustmentFactor: 0.01, // Adjust by 1% per accuracy deviation
      minConfidence: 0.70, // Never go below 70%
      maxConfidence: 0.95 // Never go above 95%
    };
    
    // Load performance data
    this.loadPerformance();
    
    // Save periodically
    setInterval(() => this.savePerformance(), 300000); // Every 5 minutes
  }

  /**
   * Start automated trading
   */
  async start() {
    if (!this.enabled) {
      console.log('⚠️  Automated trading is DISABLED');
      return;
    }

    if (this.isRunning) {
      console.log('⚠️  Automated trading is already running');
      return;
    }

    // Ensure indicators are loaded
    if (indicatorGenerator.enabled) {
      await indicatorGenerator.initialize();
      console.log(`✅ Loaded ${indicatorGenerator.indicators.size} scalping indicators`);
    }

    // Initialize whale detection agent
    if (whaleDetectionAgent.enabled) {
      await whaleDetectionAgent.initialize();
      console.log(`🐋 Whale detection agent initialized`);
    }

    this.isRunning = true;
    console.log(`🚀 Automated scalping trader started`);
    console.log(`   Target Accuracy: ${(this.config.targetAccuracy * 100).toFixed(1)}%`);
    console.log(`   Current Confidence Threshold: ${(this.config.minConfidence * 100).toFixed(1)}%`);
    console.log(`   Check Interval: ${this.config.checkIntervalSeconds}s`);
    console.log(`   Max Trades/Day: ${this.config.maxTradesPerDay}`);
    
    // Run immediately
    this.lastScanTime = Date.now();
    await this.tradingCycle();
    
    // Then run on interval
    this.intervalId = setInterval(async () => {
      this.lastScanTime = Date.now();
      await this.tradingCycle();
    }, this.config.checkIntervalSeconds * 1000);
  }

  /**
   * Stop automated trading
   */
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    console.log('🛑 Automated scalping trader stopped');
  }

  /**
   * Main trading cycle - scans all symbols in parallel and selects best opportunity
   */
  async tradingCycle() {
    if (!this.isRunning) return;

    try {
      // Check if we can trade (daily limit, time between trades)
      if (!this.canTrade()) {
        return;
      }

      // Get all symbols to monitor (from universe config)
      const symbols = await this.getSymbolsToMonitor();
      
      // Scan ALL symbols in parallel for opportunities
      console.log(`🔍 Scanning ${symbols.length} symbols for scalping opportunities...`);
      const opportunities = await this.scanAllSymbols(symbols);
      
      if (opportunities.length === 0) {
        console.log('   No trading opportunities found');
        return;
      }

      // Rank opportunities by confidence, profit potential, and risk
      const rankedOpportunities = this.rankOpportunities(opportunities);
      
      // Select the best opportunity
      const bestOpportunity = rankedOpportunities[0];
      
      if (bestOpportunity && bestOpportunity.confidence >= this.config.minConfidence) {
        console.log(`🎯 Best opportunity: ${bestOpportunity.symbol} (confidence: ${(bestOpportunity.confidence * 100).toFixed(1)}%, expected profit: ${(bestOpportunity.expectedProfitPercent * 100).toFixed(2)}%)`);
        await this.executeTrade(bestOpportunity);
      } else {
        console.log(`   No opportunities meet confidence threshold (${(this.config.minConfidence * 100).toFixed(1)}%)`);
      }
      
      // Check existing positions for exit signals
      await this.checkPositionsForExit();
      
    } catch (error) {
      console.error('❌ Trading cycle error:', error.message);
    }
  }

  /**
   * Scan all symbols in parallel for trading opportunities
   */
  async scanAllSymbols(symbols) {
    const opportunities = [];
    
    // Filter out symbols we already have positions in
    const availableSymbols = symbols.filter(s => !this.activePositions.has(s));
    
    // Scan all symbols in parallel
    const scanPromises = availableSymbols.map(async (symbol) => {
      try {
        return await this.evaluateSymbol(symbol);
      } catch (error) {
        console.warn(`⚠️  Error evaluating ${symbol}:`, error.message);
        return null;
      }
    });
    
    const results = await Promise.all(scanPromises);
    
    // Filter out null results and flatten
    for (const result of results) {
      if (result && Array.isArray(result)) {
        opportunities.push(...result);
      } else if (result) {
        opportunities.push(result);
      }
    }
    
    return opportunities;
  }

  /**
   * Evaluate a symbol for trading opportunities (multi-timeframe analysis)
   */
  async evaluateSymbol(symbol) {
    const opportunities = [];
    
    // Get market data for both 1min and 5min timeframes
    const timeframes = ['1', '5']; // Scalping timeframes
    
    for (const timeframe of timeframes) {
      try {
        // Get current market data
        const marketData = await this.getMarketData(symbol, timeframe);
        if (!marketData) continue;

        // Analyze whale activity for this symbol
        const whaleSignal = whaleDetectionAgent.analyzeWhaleActivity(
          symbol,
          marketData,
          timeframe
        );

        // Evaluate indicators for this symbol/timeframe
        const evaluations = indicatorGenerator.evaluateMarketConditions(
          symbol,
          timeframe,
          marketData
        );

        // Find all matching indicators with sufficient confidence
        const matches = evaluations.filter(e => 
          e.match && 
          e.confidence >= (this.config.minConfidence * 0.9) // Slightly lower threshold for consideration
        );

        for (const match of matches) {
          const signals = match.signals;
          
          // Check for buy signals
          if (signals.buy && signals.buy.length > 0) {
            for (const signal of signals.buy) {
              opportunities.push({
                symbol,
                timeframe,
                action: 'BUY',
                signal,
                indicatorId: match.indicatorId,
                indicatorName: match.indicatorName,
                confidence: match.confidence,
                marketData,
                stopLoss: match.stopLoss || '0.005',
                takeProfit: match.takeProfit || '0.01',
                expectedProfitPercent: parseFloat(match.takeProfit || '0.01'),
                riskRewardRatio: parseFloat(match.takeProfit || '0.01') / parseFloat(match.stopLoss || '0.005'),
                whaleSignal: whaleSignal.signal,
                whalePatterns: whaleSignal.patterns,
                timestamp: Date.now()
              });
            }
          }
          
          // Check for sell signals (shorting for scalping)
          if (signals.sell && signals.sell.length > 0) {
            for (const signal of signals.sell) {
              opportunities.push({
                symbol,
                timeframe,
                action: 'SELL',
                signal,
                indicatorId: match.indicatorId,
                indicatorName: match.indicatorName,
                confidence: match.confidence,
                marketData,
                stopLoss: match.stopLoss || '0.005',
                takeProfit: match.takeProfit || '0.01',
                expectedProfitPercent: parseFloat(match.takeProfit || '0.01'),
                riskRewardRatio: parseFloat(match.takeProfit || '0.01') / parseFloat(match.stopLoss || '0.005'),
                whaleSignal: whaleSignal.signal,
                whalePatterns: whaleSignal.patterns,
                timestamp: Date.now()
              });
            }
          }
        }
      } catch (error) {
        console.warn(`⚠️  Error evaluating ${symbol}/${timeframe}:`, error.message);
      }
    }
    
    return opportunities;
  }

  /**
   * Rank opportunities by multiple factors (including whale signals)
   */
  rankOpportunities(opportunities) {
    return opportunities
      .map(opp => {
        // Calculate composite score
        let score = 0;
        
        // Confidence weight: 35% (reduced from 40% to make room for whale signal)
        score += opp.confidence * 0.35;
        
        // Expected profit weight: 20% (reduced from 25%)
        score += Math.min(opp.expectedProfitPercent * 10, 1.0) * 0.20; // Cap at 10% profit
        
        // Risk-reward ratio weight: 15% (reduced from 20%)
        score += Math.min(opp.riskRewardRatio / 3, 1.0) * 0.15; // Prefer 3:1 or better
        
        // Market conditions weight: 10% (reduced from 15%)
        // Higher volume and volatility = better for scalping
        const volumeScore = Math.min(opp.marketData.volumeRatio || 1.0, 3.0) / 3.0;
        const volatilityScore = Math.min((opp.marketData.volatility || 0) * 50, 1.0);
        score += ((volumeScore + volatilityScore) / 2) * 0.10;
        
        // Whale signal weight: 15% (NEW - prioritizes whale activity)
        const whaleBoost = whaleDetectionAgent.boostOpportunityScore(opp, {
          signal: opp.whaleSignal || 0,
          patterns: opp.whalePatterns || {}
        });
        const whaleScore = (opp.whaleSignal || 0) * 0.15;
        score += whaleScore;
        
        // Prefer 1min timeframe for scalping (faster entries)
        if (opp.timeframe === '1') {
          score += 0.05;
        }
        
        // Apply whale boost multiplier to final score
        const finalScore = score * whaleBoost;
        
        return {
          ...opp,
          compositeScore: finalScore,
          baseScore: score,
          whaleBoost: whaleBoost
        };
      })
      .sort((a, b) => b.compositeScore - a.compositeScore); // Sort by score descending
  }

  /**
   * Check if we can trade
   */
  canTrade() {
    // Check daily limit
    if (this.performance.dailyTrades >= this.config.maxTradesPerDay) {
      return false;
    }

    // Check time between trades
    if (this.performance.lastTradeTime) {
      const timeSinceLastTrade = (Date.now() - this.performance.lastTradeTime) / 1000;
      if (timeSinceLastTrade < this.config.minTimeBetweenTrades) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get symbols to monitor - ALL symbols from universe config
   */
  async getSymbolsToMonitor() {
    const symbolRouter = require('./symbolRouter');
    const enableAutotrader = process.env.ENABLE_AUTOTRADER !== 'false';
    
    if (!enableAutotrader) {
      return [];
    }
    
    // Get ALL symbols from universe config, then filter to only Binance symbols
    try {
      const universeLoader = require('./universeLoader');
      await universeLoader.load();
      const allPairs = universeLoader.getSymbolTimeframePairs();
      const allSymbols = [...new Set(allPairs.map(p => p.symbol))];
      
      // Filter to only scannable (Binance) symbols
      const scannableSymbols = symbolRouter.filterScannableSymbols(allSymbols);
      
      // Log summary
      const tradingViewOnlyCount = allSymbols.length - scannableSymbols.length;
      if (tradingViewOnlyCount > 0) {
        console.log(`📊 Monitoring ${scannableSymbols.length} scannable symbols (${tradingViewOnlyCount} TradingView-only excluded)`);
      } else {
        console.log(`📊 Monitoring ${scannableSymbols.length} symbols: ${scannableSymbols.join(', ')}`);
      }
      
      return scannableSymbols;
    } catch (error) {
      console.warn('⚠️  Error loading universe, using default symbols:', error.message);
      // Fallback to default scalping symbols (Binance only)
      const fallbackSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      return symbolRouter.filterScannableSymbols(fallbackSymbols);
    }
  }

  /**
   * Execute trade from opportunity
   */
  async executeTrade(opportunity) {
    const { symbol, action, marketData, stopLoss, takeProfit, confidence, indicatorName, expectedProfitPercent, riskRewardRatio } = opportunity;

    // Calculate position size
    const brokerAdapter = getBrokerAdapter();
    const accountSummary = await brokerAdapter.getAccountSummary();
    const balance = accountSummary.balance || accountSummary.equity || 500;
    const positionSize = balance * (this.config.positionSizePercent / 100);
    const quantity = positionSize / marketData.price;

    // Calculate stop loss and take profit prices
    const stopLossPercent = parseFloat(stopLoss);
    const takeProfitPercent = parseFloat(takeProfit);

    const stopLossPrice = action === 'BUY' 
      ? marketData.price * (1 - stopLossPercent)
      : marketData.price * (1 + stopLossPercent);
    
    const takeProfitPrice = action === 'BUY'
      ? marketData.price * (1 + takeProfitPercent)
      : marketData.price * (1 - takeProfitPercent);

    // Execute trade
    console.log(`\n🎯 Executing trade: ${symbol} ${action} @ $${marketData.price.toFixed(2)}`);
    console.log(`   Timeframe: ${opportunity.timeframe}min`);
    console.log(`   Indicator: ${indicatorName}`);
    console.log(`   Confidence: ${(confidence * 100).toFixed(1)}%`);
    console.log(`   Expected Profit: ${(expectedProfitPercent * 100).toFixed(2)}%`);
    console.log(`   Risk/Reward: ${riskRewardRatio.toFixed(2)}:1`);
    console.log(`   Stop Loss: $${stopLossPrice.toFixed(2)}`);
    console.log(`   Take Profit: $${takeProfitPrice.toFixed(2)}`);

    const orderIntent = {
      symbol,
      action,
      quantity,
      price: marketData.price,
      stopLoss: stopLossPrice,
      takeProfit: takeProfitPrice,
      confidence,
      source: 'automated_scalping',
      indicatorId: opportunity.indicatorId,
      indicatorName,
      timeframe: opportunity.timeframe,
      expectedProfitPercent,
      riskRewardRatio
    };

    try {
      const result = await brokerAdapter.placeOrder(orderIntent);
      
      if (result && result.executionResult) {
        // Track position
        this.activePositions.set(symbol, {
          entryPrice: result.executionResult.fillPrice,
          quantity: result.executionResult.filledQuantity,
          stopLoss: stopLossPrice,
          takeProfit: takeProfitPrice,
          indicatorId: opportunity.indicatorId,
          indicatorName,
          timeframe: opportunity.timeframe,
          entryTime: Date.now(),
          tradeId: result.tradeId,
          expectedProfitPercent,
          riskRewardRatio
        });

        // Update performance
        this.performance.totalTrades++;
        this.performance.dailyTrades++;
        this.performance.lastTradeTime = Date.now();

        console.log(`✅ Trade executed successfully: ${symbol} ${action}`);
        this.emit('tradeExecuted', { symbol, action, orderIntent, result, opportunity });
      }
    } catch (error) {
      console.error(`❌ Trade execution failed for ${symbol}:`, error.message);
      this.emit('tradeFailed', { symbol, action, error: error.message, opportunity });
    }
  }

  /**
   * Check existing positions for exit signals
   */
  async checkPositionsForExit() {
    for (const [symbol, position] of this.activePositions.entries()) {
      try {
        // Get current market price
        const marketData = await this.getMarketData(symbol);
        if (!marketData) continue;

        const currentPrice = marketData.price;
        const entryPrice = position.entryPrice;
        const priceChange = (currentPrice - entryPrice) / entryPrice;

        // Check stop loss
        if (currentPrice <= position.stopLoss || currentPrice >= position.stopLoss) {
          // Close position
          await this.closePosition(symbol, position, 'stop_loss');
          continue;
        }

        // Check take profit
        if (currentPrice >= position.takeProfit || currentPrice <= position.takeProfit) {
          // Close position
          await this.closePosition(symbol, position, 'take_profit');
          continue;
        }

        // Check time-based exit (scalping: max 15 minutes)
        const holdTime = (Date.now() - position.entryTime) / 1000 / 60; // minutes
        if (holdTime > 15) {
          // Close position after 15 minutes
          await this.closePosition(symbol, position, 'time_limit');
          continue;
        }

      } catch (error) {
        console.error(`❌ Error checking position ${symbol}:`, error.message);
      }
    }
  }

  /**
   * Close a position
   */
  async closePosition(symbol, position, reason) {
    try {
      const brokerAdapter = getBrokerAdapter();
      const marketData = await this.getMarketData(symbol);
      
      const orderIntent = {
        symbol,
        action: 'CLOSE',
        quantity: position.quantity,
        price: marketData.price,
        source: 'automated_scalping',
        closeReason: reason
      };

      const result = await brokerAdapter.placeOrder(orderIntent);
      
      if (result && result.executionResult) {
        const pnl = result.executionResult.pnl || 0;
        const isWin = pnl > 0;

        // Update performance
        if (isWin) {
          this.performance.winningTrades++;
        } else {
          this.performance.losingTrades++;
        }

        // Add to recent trades
        this.performance.recentTrades.push({
          symbol,
          pnl,
          isWin,
          timestamp: Date.now()
        });

        // Keep only last 20 trades
        if (this.performance.recentTrades.length > 20) {
          this.performance.recentTrades.shift();
        }

        // Recalculate accuracy
        this.updateAccuracy();

        // Adjust confidence threshold based on accuracy
        this.adjustConfidenceThreshold();

        // Remove position
        this.activePositions.delete(symbol);

        console.log(`✅ Position closed: ${symbol} (${reason}) - PnL: $${pnl.toFixed(2)}`);
        console.log(`   Current Accuracy: ${(this.performance.currentAccuracy * 100).toFixed(1)}%`);
        console.log(`   Confidence Threshold: ${(this.config.minConfidence * 100).toFixed(1)}%`);

        this.emit('positionClosed', { symbol, pnl, reason, position });
      }
    } catch (error) {
      console.error(`❌ Error closing position ${symbol}:`, error.message);
    }
  }

  /**
   * Update accuracy metrics
   */
  updateAccuracy() {
    if (this.performance.recentTrades.length === 0) {
      this.performance.currentAccuracy = 0;
      this.performance.currentWinRate = 0;
      return;
    }

    const wins = this.performance.recentTrades.filter(t => t.isWin).length;
    this.performance.currentWinRate = wins / this.performance.recentTrades.length;
    
    // Accuracy is win rate (for now)
    this.performance.currentAccuracy = this.performance.currentWinRate;
  }

  /**
   * Adjust confidence threshold to maintain target accuracy
   */
  adjustConfidenceThreshold() {
    if (this.performance.recentTrades.length < 10) {
      return; // Need at least 10 trades to adjust
    }

    const accuracy = this.performance.currentAccuracy;
    const target = this.config.targetAccuracy;
    const deviation = accuracy - target;

    // Adjust confidence threshold
    if (deviation < -0.05) {
      // Accuracy is below target by more than 5%, increase threshold
      this.config.minConfidence = Math.min(
        this.confidenceAdjustment.maxConfidence,
        this.config.minConfidence + this.confidenceAdjustment.adjustmentFactor
      );
      console.log(`📈 Increased confidence threshold to ${(this.config.minConfidence * 100).toFixed(1)}% (accuracy: ${(accuracy * 100).toFixed(1)}%)`);
    } else if (deviation > 0.05) {
      // Accuracy is above target by more than 5%, can lower threshold slightly
      this.config.minConfidence = Math.max(
        this.confidenceAdjustment.minConfidence,
        this.config.minConfidence - (this.confidenceAdjustment.adjustmentFactor * 0.5)
      );
      console.log(`📉 Decreased confidence threshold to ${(this.config.minConfidence * 100).toFixed(1)}% (accuracy: ${(accuracy * 100).toFixed(1)}%)`);
    }
  }

  /**
   * Get market data for symbol and timeframe
   */
  async getMarketData(symbol, timeframe = '1') {
    try {
      const symbolRouter = require('./symbolRouter');
      
      // Skip market data fetch for TradingView-only symbols
      if (!symbolRouter.shouldFetchFromBinance(symbol)) {
        // Use normalized symbol for Set consistency (same as shouldScanSymbol)
        const classification = symbolRouter.classifySymbol(symbol);
        if (!symbolRouter.warnedSymbols.has(classification.normalizedSymbol)) {
          console.log(`ℹ️  Skipping market data fetch for ${classification.normalizedSymbol} - TradingView-only symbol`);
          symbolRouter.warnedSymbols.add(classification.normalizedSymbol);
        }
        return null;
      }
      
      // Try to get from pattern learning engine cache
      const providerFactory = require('./providerFactory');
      const universeLoader = require('./universeLoader');
      
      await universeLoader.load();
      const metadata = universeLoader.getSymbolMetadata(symbol);
      const provider = providerFactory.getProvider(metadata);
      
      // Get latest candles (more for better analysis)
      const candleCount = timeframe === '1' ? 20 : 15; // More candles for 1min
      const candles = await provider.fetchCandles(symbol, timeframe, candleCount);
      
      if (!candles || candles.length === 0) {
        return null;
      }

      const latest = candles[candles.length - 1];
      const previous = candles[candles.length - 2] || latest;
      
      const priceChange = (latest.close - previous.close) / previous.close;
      const volume = latest.volume || 0;
      
      // Calculate average volume over last 20 candles (or available)
      const volumeWindow = Math.min(20, candles.length);
      const avgVolume = candles.slice(-volumeWindow).reduce((sum, c) => sum + (c.volume || 0), 0) / volumeWindow;
      const volumeRatio = avgVolume > 0 ? volume / avgVolume : 1.0;
      
      // Calculate volatility (ATR-like)
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const volatility = (Math.max(...highs) - Math.min(...lows)) / latest.close;
      
      // Calculate trend (simple moving average slope)
      const closes = candles.map(c => c.close);
      const sma = closes.reduce((sum, c) => sum + c, 0) / closes.length;
      const trendSlope = (latest.close - sma) / sma;
      
      // Calculate momentum (rate of change)
      const momentum = (latest.close - closes[0]) / closes[0];

      return {
        price: latest.close,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        volume,
        volatility,
        priceChange: Math.abs(priceChange),
        priceChangeDirection: priceChange >= 0 ? 'up' : 'down',
        volumeRatio,
        trendSlope,
        momentum,
        candles: candles.slice(-10) // Last 10 candles for indicator evaluation
      };
    } catch (error) {
      console.warn(`⚠️  Error fetching market data for ${symbol}/${timeframe}:`, error.message);
      return null;
    }
  }

  /**
   * Get performance statistics
   */
  getPerformance() {
    return {
      ...this.performance,
      activePositions: this.activePositions.size,
      confidenceThreshold: this.config.minConfidence,
      targetAccuracy: this.config.targetAccuracy,
      activeSymbols: Array.from(this.activePositions.keys())
    };
  }

  /**
   * Get status including scanning activity
   */
  getStatus() {
    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      config: this.config,
      performance: this.performance,
      activePositions: Array.from(this.activePositions.entries()).map(([symbol, pos]) => ({
        symbol,
        ...pos
      })),
      lastScanTime: this.lastScanTime || null
    };
  }

  /**
   * Load performance data
   */
  async loadPerformance() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const filePath = path.join(process.cwd(), 'data', 'automated_trading_performance.json');
      
      const data = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(data);
      
      this.performance = { ...this.performance, ...parsed.performance };
      this.config.minConfidence = parsed.config?.minConfidence || this.config.minConfidence;
      
      // Reset daily trades (new day)
      const lastSave = parsed.lastSave ? new Date(parsed.lastSave) : null;
      const now = new Date();
      if (!lastSave || lastSave.toDateString() !== now.toDateString()) {
        this.performance.dailyTrades = 0;
      }
    } catch (error) {
      // File doesn't exist yet, use defaults
    }
  }

  /**
   * Save performance data
   */
  async savePerformance() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const filePath = path.join(process.cwd(), 'data', 'automated_trading_performance.json');
      
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      
      const data = {
        performance: this.performance,
        config: {
          minConfidence: this.config.minConfidence
        },
        lastSave: new Date().toISOString()
      };
      
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('❌ Error saving performance:', error.message);
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new AutomatedScalpingTrader();


