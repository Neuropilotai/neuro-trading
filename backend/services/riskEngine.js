/**
 * Risk Management Engine
 * Enforces risk limits before order execution
 * 
 * Feature Flag: ENABLE_RISK_ENGINE (default: true)
 */

class RiskEngine {
  constructor() {
    this.enabled = process.env.ENABLE_RISK_ENGINE !== 'false';
    this.tradingEnabled = process.env.TRADING_ENABLED !== 'false';
    
    // Risk limits (from env vars with defaults)
    this.maxDailyLossPercent = parseFloat(process.env.MAX_DAILY_LOSS_PERCENT || '2.0');
    this.maxPositionSizePercent = parseFloat(process.env.MAX_POSITION_SIZE_PERCENT || '25.0');
    this.maxOpenPositions = parseInt(process.env.MAX_OPEN_POSITIONS || '5', 10);
    this.requireStopLoss = process.env.REQUIRE_STOP_LOSS !== 'false';
    this.requireTakeProfit = process.env.REQUIRE_TAKE_PROFIT === 'true'; // Optional by default

    // Daily tracking (persisted to database)
    this.dailyStats = {
      date: this.getToday(),
      totalPnL: 0,
      tradeCount: 0,
      openPositions: new Map() // symbol -> {quantity, avgPrice}
    };
    
    // Load today's stats from database if available
    this.loadDailyStats();

    // Reset daily stats at midnight
    this.scheduleDailyReset();
  }

  /**
   * Get today's date string (YYYY-MM-DD)
   */
  getToday() {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Reset daily stats if it's a new day
   */
  async checkDailyReset() {
    const today = this.getToday();
    if (this.dailyStats.date !== today) {
      // Save yesterday's stats before resetting
      await this.saveDailyStats();
      
      console.log(`📅 New trading day: ${today}. Resetting daily stats.`);
      this.dailyStats = {
        date: today,
        totalPnL: 0,
        tradeCount: 0,
        openPositions: new Map()
      };
    }
  }

  /**
   * Load daily stats from database
   */
  async loadDailyStats() {
    try {
      const evaluationDb = require('../db/evaluationDb');
      await evaluationDb.initialize();
      
      const today = this.getToday();
      return new Promise((resolve, reject) => {
        evaluationDb.db.get(
          'SELECT * FROM daily_risk_stats WHERE date = ?',
          [today],
          (err, stats) => {
            if (err) {
              console.warn('⚠️  Could not load daily stats from database:', err.message);
              resolve();
              return;
            }
            
            if (stats) {
              this.dailyStats = {
                date: stats.date,
                totalPnL: stats.daily_pnl,
                tradeCount: stats.trade_count,
                openPositions: new Map() // Positions not persisted (reconstructed from trades)
              };
            }
            resolve();
          }
        );
      });
    } catch (error) {
      // Database not available or table doesn't exist yet - use defaults
      console.warn('⚠️  Could not load daily stats from database:', error.message);
    }
  }

  /**
   * Save daily stats to database
   */
  async saveDailyStats() {
    try {
      const evaluationDb = require('../db/evaluationDb');
      await evaluationDb.initialize();
      
      const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '500');
      const dailyPnLPct = accountBalance > 0 ? (this.dailyStats.totalPnL / accountBalance) * 100 : 0;
      
      await evaluationDb.saveDailyRiskStats({
        date: this.dailyStats.date,
        accountBalance: accountBalance + this.dailyStats.totalPnL,
        dailyPnL: this.dailyStats.totalPnL,
        dailyPnLPct,
        tradeCount: this.dailyStats.tradeCount,
        openPositionsCount: this.dailyStats.openPositions.size,
        maxDrawdownPct: 0, // TODO: Calculate from equity curve
        riskLimitBreaches: 0 // TODO: Track breaches
      });
    } catch (error) {
      console.warn('⚠️  Could not save daily stats to database:', error.message);
    }
  }

  /**
   * Schedule daily reset at midnight
   */
  scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow - now;
    
    setTimeout(async () => {
      await this.checkDailyReset();
      // Schedule next reset (24 hours)
      setInterval(async () => await this.checkDailyReset(), 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  /**
   * Check if trading is enabled (kill switch)
   */
  isTradingEnabled() {
    return this.tradingEnabled;
  }

  /**
   * Validate order against risk limits
   * @param {object} orderIntent - Order intent (symbol, action, quantity, price, stopLoss, takeProfit)
   * @param {number} accountBalance - Current account balance
   * @returns {{allowed: boolean, reason: string|null}} - Risk check result
   */
  async validateOrder(orderIntent, accountBalance = 100000) {
    // Check if risk engine is enabled
    if (!this.enabled) {
      return { allowed: true, reason: null };
    }

    // Check kill switch
    if (!this.isTradingEnabled()) {
      return {
        allowed: false,
        reason: 'Trading is disabled (kill switch active). Set TRADING_ENABLED=true to enable.'
      };
    }

    // Reset daily stats if needed
    await this.checkDailyReset();

    // Check daily loss limit
    const dailyLossPercent = (Math.abs(this.dailyStats.totalPnL) / accountBalance) * 100;
    if (this.dailyStats.totalPnL < 0 && dailyLossPercent >= this.maxDailyLossPercent) {
      return {
        allowed: false,
        reason: `Daily loss limit exceeded: ${dailyLossPercent.toFixed(2)}% >= ${this.maxDailyLossPercent}%`
      };
    }

    // Check position size limit
    // Calculate notional value: abs(quantity) * price
    const notional = Math.abs(orderIntent.quantity) * orderIntent.price;
    // Use accountBalance as equity (prefer totalValue if available, but accountBalance is the balance)
    const equity = accountBalance;
    // Calculate position size as percentage: (notional / equity) * 100
    const positionSizePercent = (notional / equity) * 100;
    
    if (positionSizePercent > this.maxPositionSizePercent) {
      return {
        allowed: false,
        reason: `Position size too large: ${positionSizePercent.toFixed(2)}% > ${this.maxPositionSizePercent}%`
      };
    }

    // Check max open positions
    if (orderIntent.action === 'BUY' && this.dailyStats.openPositions.size >= this.maxOpenPositions) {
      // Check if we already have a position in this symbol
      if (!this.dailyStats.openPositions.has(orderIntent.symbol)) {
        return {
          allowed: false,
          reason: `Max open positions reached: ${this.dailyStats.openPositions.size} >= ${this.maxOpenPositions}`
        };
      }
    }

    // Check stop loss requirement
    if (this.requireStopLoss && !orderIntent.stopLoss) {
      return {
        allowed: false,
        reason: 'Stop loss is required but not provided'
      };
    }

    // Check take profit requirement (if enabled)
    if (this.requireTakeProfit && !orderIntent.takeProfit) {
      return {
        allowed: false,
        reason: 'Take profit is required but not provided'
      };
    }

    // Validate stop loss is reasonable (within 10% for now)
    if (orderIntent.stopLoss) {
      const stopLossPercent = Math.abs((orderIntent.stopLoss - orderIntent.price) / orderIntent.price) * 100;
      if (stopLossPercent > 10) {
        return {
          allowed: false,
          reason: `Stop loss too wide: ${stopLossPercent.toFixed(2)}% > 10%`
        };
      }
    }

    // All checks passed
    return { allowed: true, reason: null };
  }

  /**
   * Record trade execution (for daily tracking)
   * @param {object} trade - Executed trade
   */
  async recordTrade(trade) {
    await this.checkDailyReset();

    this.dailyStats.tradeCount++;
    
    if (trade.pnl !== undefined) {
      this.dailyStats.totalPnL += trade.pnl;
    }

    // Update open positions
    if (trade.action === 'BUY') {
      const existing = this.dailyStats.openPositions.get(trade.symbol) || { quantity: 0, avgPrice: 0 };
      const newQuantity = existing.quantity + trade.quantity;
      const newAvgPrice = existing.quantity > 0
        ? ((existing.quantity * existing.avgPrice) + (trade.quantity * trade.price)) / newQuantity
        : trade.price;
      this.dailyStats.openPositions.set(trade.symbol, { quantity: newQuantity, avgPrice: newAvgPrice });
    } else if (trade.action === 'SELL' || trade.action === 'CLOSE') {
      const existing = this.dailyStats.openPositions.get(trade.symbol);
      if (existing) {
        const newQuantity = existing.quantity - trade.quantity;
        if (newQuantity <= 0) {
          this.dailyStats.openPositions.delete(trade.symbol);
        } else {
          this.dailyStats.openPositions.set(trade.symbol, { quantity: newQuantity, avgPrice: existing.avgPrice });
        }
      }
    }

    // Save stats periodically (every 10 trades)
    if (this.dailyStats.tradeCount % 10 === 0) {
      await this.saveDailyStats();
    }
  }

  /**
   * Get current risk stats
   */
  getStats() {
    this.checkDailyReset();
    return {
      enabled: this.enabled,
      tradingEnabled: this.tradingEnabled,
      dailyStats: {
        date: this.dailyStats.date,
        totalPnL: this.dailyStats.totalPnL,
        tradeCount: this.dailyStats.tradeCount,
        openPositions: this.dailyStats.openPositions.size
      },
      limits: {
        maxDailyLossPercent: this.maxDailyLossPercent,
        maxPositionSizePercent: this.maxPositionSizePercent,
        maxOpenPositions: this.maxOpenPositions,
        requireStopLoss: this.requireStopLoss,
        requireTakeProfit: this.requireTakeProfit
      }
    };
  }
}

// Singleton instance
const riskEngine = new RiskEngine();

module.exports = riskEngine;


