/**
 * Trading Learning Service
 * Learns from trade outcomes and adjusts strategy parameters
 * 
 * Feature Flag: ENABLE_TRADING_LEARNING (default: true)
 */

const fs = require('fs').promises;
const path = require('path');
const patternRecognitionService = require('./patternRecognitionService');
const patternLearningAgents = require('./patternLearningAgents');
const dailyPatternTracker = require('./dailyPatternTracker');

class TradingLearningService {
  constructor() {
    this.enabled = process.env.ENABLE_TRADING_LEARNING !== 'false';
    
    // Learning metrics
    this.metrics = {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalPnL: 0,
      winRate: 0,
      profitFactor: 0,
      averageWin: 0,
      averageLoss: 0,
      bestSymbol: null,
      bestSymbolPnL: 0,
      worstSymbol: null,
      worstSymbolPnL: 0,
      learningIterations: 0,
      lastUpdated: new Date().toISOString()
    };

    // Strategy performance tracking
    this.strategyPerformance = new Map(); // strategy -> {wins, losses, pnl, winRate}
    
    // Symbol performance tracking
    this.symbolPerformance = new Map(); // symbol -> {trades, wins, losses, pnl, winRate}
    
    // Learning insights
    this.insights = {
      bestTimeToTrade: null,
      bestAction: null, // BUY vs SELL performance
      confidenceThreshold: 0.7, // Adjust based on performance
      positionSizeMultiplier: 1.0, // Adjust based on win rate
      riskAdjustment: 1.0 // Adjust based on recent performance
    };

    // Load learning state
    this.loadLearningState();
    
    // Save periodically
    setInterval(() => this.saveLearningState(), 300000); // Every 5 minutes
  }

  /**
   * Learn from a completed trade
   * @param {object} trade - Trade execution result
   * @param {object} orderIntent - Original order intent
   * @param {object} marketData - Market data at trade time (optional, for pattern learning)
   */
  async learnFromTrade(trade, orderIntent, marketData = null) {
    if (!this.enabled) {
      return;
    }

    const { symbol, action, pnl, fillPrice, filledQuantity } = trade;
    const { confidence, regime, risk_mode } = orderIntent;

    // Pattern recognition learning (if market data available)
    if (marketData && patternRecognitionService.enabled) {
      try {
        // Detect patterns that occurred before this trade
        const detectedPatterns = await patternRecognitionService.detectPatterns(
          symbol,
          marketData,
          marketData.timeframe || '5min'
        );

        // Learn from trade outcome
        await patternRecognitionService.learnFromTrade(trade, marketData, detectedPatterns);
        
        // Agent-based learning
        await patternLearningAgents.learnFromTrade(trade, marketData, detectedPatterns);
      } catch (error) {
        console.error('❌ Pattern learning error:', error.message);
      }
    }

    // Track daily patterns (opening trends, hourly performance, etc.)
    if (dailyPatternTracker.enabled) {
      try {
        dailyPatternTracker.trackTrade({
          symbol,
          action,
          pnl: pnl || 0,
          fillPrice,
          filledQuantity,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.warn('⚠️  Daily pattern tracking error:', error.message);
      }
    }

    // Update metrics
    this.metrics.totalTrades++;
    this.metrics.totalPnL += pnl || 0;

    if (pnl > 0) {
      this.metrics.winningTrades++;
    } else if (pnl < 0) {
      this.metrics.losingTrades++;
    }

    // Calculate win rate
    this.metrics.winRate = this.metrics.winningTrades / this.metrics.totalTrades;

    // Calculate profit factor
    const totalWins = Array.from(this.symbolPerformance.values())
      .reduce((sum, perf) => sum + perf.winPnL, 0);
    const totalLosses = Math.abs(Array.from(this.symbolPerformance.values())
      .reduce((sum, perf) => sum + perf.lossPnL, 0));
    
    this.metrics.profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

    // Update symbol performance
    if (!this.symbolPerformance.has(symbol)) {
      this.symbolPerformance.set(symbol, {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        winPnL: 0,
        lossPnL: 0,
        winRate: 0
      });
    }

    const symbolPerf = this.symbolPerformance.get(symbol);
    symbolPerf.trades++;
    symbolPerf.pnl += pnl || 0;

    if (pnl > 0) {
      symbolPerf.wins++;
      symbolPerf.winPnL += pnl;
    } else if (pnl < 0) {
      symbolPerf.losses++;
      symbolPerf.lossPnL += pnl;
    }

    symbolPerf.winRate = symbolPerf.wins / symbolPerf.trades;

    // Update best/worst symbols
    if (symbolPerf.pnl > this.metrics.bestSymbolPnL) {
      this.metrics.bestSymbol = symbol;
      this.metrics.bestSymbolPnL = symbolPerf.pnl;
    }
    if (symbolPerf.pnl < this.metrics.worstSymbolPnL) {
      this.metrics.worstSymbol = symbol;
      this.metrics.worstSymbolPnL = symbolPerf.pnl;
    }

    // Update strategy performance (if regime/risk_mode available)
    const strategyKey = `${regime || 'UNKNOWN'}_${risk_mode || 'UNKNOWN'}`;
    if (!this.strategyPerformance.has(strategyKey)) {
      this.strategyPerformance.set(strategyKey, {
        wins: 0,
        losses: 0,
        pnl: 0,
        winRate: 0
      });
    }

    const strategyPerf = this.strategyPerformance.get(strategyKey);
    if (pnl > 0) {
      strategyPerf.wins++;
    } else if (pnl < 0) {
      strategyPerf.losses++;
    }
    strategyPerf.pnl += pnl || 0;
    const totalStrategyTrades = strategyPerf.wins + strategyPerf.losses;
    strategyPerf.winRate = totalStrategyTrades > 0 ? strategyPerf.wins / totalStrategyTrades : 0;

    // Calculate averages
    const wins = Array.from(this.symbolPerformance.values())
      .filter(p => p.wins > 0)
      .map(p => p.winPnL / p.wins);
    const losses = Array.from(this.symbolPerformance.values())
      .filter(p => p.losses > 0)
      .map(p => Math.abs(p.lossPnL / p.losses));

    this.metrics.averageWin = wins.length > 0 
      ? wins.reduce((a, b) => a + b, 0) / wins.length 
      : 0;
    this.metrics.averageLoss = losses.length > 0
      ? losses.reduce((a, b) => a + b, 0) / losses.length
      : 0;

    // Learning insights
    this.updateInsights();

    this.metrics.learningIterations++;
    this.metrics.lastUpdated = new Date().toISOString();

    // Log learning update
    console.log(`🧠 Learning Update:`);
    console.log(`   Total Trades: ${this.metrics.totalTrades}`);
    console.log(`   Win Rate: ${(this.metrics.winRate * 100).toFixed(1)}%`);
    console.log(`   Profit Factor: ${this.metrics.profitFactor.toFixed(2)}`);
    console.log(`   Best Symbol: ${this.metrics.bestSymbol || 'N/A'} (+$${this.metrics.bestSymbolPnL.toFixed(2)})`);
    console.log(`   Confidence Threshold: ${this.insights.confidenceThreshold.toFixed(2)}`);
    console.log(`   Position Size Multiplier: ${this.insights.positionSizeMultiplier.toFixed(2)}x`);

    // Save state
    await this.saveLearningState();
  }

  /**
   * Update learning insights based on performance
   */
  updateInsights() {
    // Adjust confidence threshold based on win rate
    if (this.metrics.winRate > 0.6) {
      // High win rate - can be more aggressive
      this.insights.confidenceThreshold = Math.max(0.6, this.insights.confidenceThreshold - 0.01);
    } else if (this.metrics.winRate < 0.4) {
      // Low win rate - be more conservative
      this.insights.confidenceThreshold = Math.min(0.9, this.insights.confidenceThreshold + 0.01);
    }

    // Adjust position size multiplier based on profit factor
    if (this.metrics.profitFactor > 2.0) {
      // Excellent performance - can increase position size
      this.insights.positionSizeMultiplier = Math.min(1.5, this.insights.positionSizeMultiplier + 0.05);
    } else if (this.metrics.profitFactor < 1.0) {
      // Poor performance - reduce position size
      this.insights.positionSizeMultiplier = Math.max(0.5, this.insights.positionSizeMultiplier - 0.05);
    }

    // Risk adjustment based on recent performance
    const recentTrades = Math.min(10, this.metrics.totalTrades);
    if (recentTrades >= 5) {
      const recentWinRate = this.metrics.winRate;
      if (recentWinRate > 0.7) {
        this.insights.riskAdjustment = Math.min(1.2, this.insights.riskAdjustment + 0.02);
      } else if (recentWinRate < 0.3) {
        this.insights.riskAdjustment = Math.max(0.7, this.insights.riskAdjustment - 0.02);
      }
    }
  }

  /**
   * Get learning metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      insights: this.insights,
      topSymbols: Array.from(this.symbolPerformance.entries())
        .sort((a, b) => b[1].pnl - a[1].pnl)
        .slice(0, 5)
        .map(([symbol, perf]) => ({
          symbol,
          trades: perf.trades,
          winRate: perf.winRate,
          pnl: perf.pnl
        })),
      topStrategies: Array.from(this.strategyPerformance.entries())
        .sort((a, b) => b[1].pnl - a[1].pnl)
        .slice(0, 3)
        .map(([strategy, perf]) => ({
          strategy,
          wins: perf.wins,
          losses: perf.losses,
          winRate: perf.winRate,
          pnl: perf.pnl
        }))
    };
  }

  /**
   * Get recommended confidence threshold for next trade
   */
  getRecommendedConfidenceThreshold() {
    return this.insights.confidenceThreshold;
  }

  /**
   * Get recommended position size multiplier
   */
  getRecommendedPositionSizeMultiplier() {
    return this.insights.positionSizeMultiplier;
  }

  /**
   * Check if symbol is performing well
   */
  isSymbolPerformingWell(symbol) {
    const perf = this.symbolPerformance.get(symbol);
    if (!perf || perf.trades < 3) {
      return null; // Not enough data
    }
    return perf.winRate > 0.5 && perf.pnl > 0;
  }

  /**
   * Load learning state from file
   */
  async loadLearningState() {
    const stateFile = path.join(process.cwd(), 'data', 'trading_learning_state.json');

    try {
      const data = await fs.readFile(stateFile, 'utf8');
      const state = JSON.parse(data);
      
      this.metrics = { ...this.metrics, ...state.metrics };
      
      if (state.symbolPerformance) {
        this.symbolPerformance = new Map(Object.entries(state.symbolPerformance));
      }
      
      if (state.strategyPerformance) {
        this.strategyPerformance = new Map(Object.entries(state.strategyPerformance));
      }
      
      if (state.insights) {
        this.insights = { ...this.insights, ...state.insights };
      }

      console.log(`✅ Loaded trading learning state: ${this.metrics.totalTrades} trades analyzed`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('⚠️  Error loading learning state:', error.message);
      }
      // File doesn't exist yet, that's okay
    }
  }

  /**
   * Save learning state to file
   */
  async saveLearningState() {
    const stateFile = path.join(process.cwd(), 'data', 'trading_learning_state.json');

    try {
      const state = {
        metrics: this.metrics,
        symbolPerformance: Object.fromEntries(this.symbolPerformance),
        strategyPerformance: Object.fromEntries(this.strategyPerformance),
        insights: this.insights,
        lastSaved: new Date().toISOString()
      };

      // Ensure directory exists
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('❌ Error saving learning state:', error);
    }
  }

  /**
   * Reset learning metrics (for testing)
   */
  reset() {
    this.metrics = {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalPnL: 0,
      winRate: 0,
      profitFactor: 0,
      averageWin: 0,
      averageLoss: 0,
      bestSymbol: null,
      bestSymbolPnL: 0,
      worstSymbol: null,
      worstSymbolPnL: 0,
      learningIterations: 0,
      lastUpdated: new Date().toISOString()
    };
    this.symbolPerformance.clear();
    this.strategyPerformance.clear();
    this.insights = {
      confidenceThreshold: 0.7,
      positionSizeMultiplier: 1.0,
      riskAdjustment: 1.0
    };
  }
}

module.exports = new TradingLearningService();

