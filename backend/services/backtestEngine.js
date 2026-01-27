/**
 * Backtest Engine
 * Deterministic historical replay backtester
 * 
 * Assumptions:
 * - Fill model: Signal on candle close → fill at next candle open
 * - Spread: 0.1% for crypto, 0.05% for stocks (configurable)
 * - Slippage: 0.05% for market orders (configurable)
 * - No lookahead: Only uses data up to current candle
 */

const ohlcvCache = require('./ohlcvCache');
const evaluationDb = require('../db/evaluationDb');
const patternAttributionService = require('./patternAttributionService');
const crypto = require('crypto');

class BacktestEngine {
  constructor() {
    this.config = {
      spreadPct: {
        crypto: 0.001, // 0.1%
        stocks: 0.0005, // 0.05%
        default: 0.001
      },
      slippagePct: 0.0005, // 0.05%
      commissionPct: 0.001 // 0.1% (Binance-like)
    };
  }

  /**
   * Generate deterministic ID from inputs
   */
  _generateDeterministicId(prefix, ...parts) {
    const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
    return `${prefix}_${hash.substring(0, 16)}`;
  }

  /**
   * Run backtest
   * @param {object} params - Backtest parameters
   * @returns {Promise<object>} - Backtest results
   */
  async runBacktest(params) {
    const {
      strategy,
      symbol,
      timeframe,
      startDate,
      endDate,
      initialCapital = 10000,
      config = {}
    } = params;

    // Validate inputs
    if (!strategy || !symbol || !timeframe || !startDate || !endDate) {
      throw new Error('Missing required parameters: strategy, symbol, timeframe, startDate, endDate');
    }

    // Load candles from cache
    const allCandles = await ohlcvCache.readCandles(symbol, timeframe);
    if (allCandles.length === 0) {
      throw new Error(`No candles found for ${symbol}/${timeframe}. Run learning daemon to populate cache.`);
    }

    // Filter candles by date range
    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();
    
    let candles = allCandles.filter(c => c.ts >= startTs && c.ts <= endTs);
    
    if (candles.length === 0) {
      throw new Error(`No candles in date range ${startDate} to ${endDate}`);
    }

    // Sort by timestamp (ascending) - critical for no lookahead
    candles = candles.sort((a, b) => a.ts - b.ts);

    // Check for large gaps
    this._warnAboutGaps(candles, timeframe);

    // Reset strategy
    strategy.reset();
    const strategyState = strategy.getState();

    // Initialize account
    let account = {
      balance: initialCapital,
      initialBalance: initialCapital,
      positions: new Map(), // symbol -> {action, quantity, entryPrice, entryTime, stopLoss, takeProfit}
      equity: initialCapital,
      trades: [],
      tradeCounter: 0 // Deterministic trade counter
    };

    // Track metrics
    const equityCurve = [initialCapital];
    let peakEquity = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;

    // Determine asset class for spread
    const assetClass = this._getAssetClass(symbol);
    const spreadPct = config.spreadPct || this.config.spreadPct[assetClass] || this.config.spreadPct.default;
    const slippagePct = config.slippagePct || this.config.slippagePct;
    const commissionPct = config.commissionPct || this.config.commissionPct;

    // Replay candles (NO LOOKAHEAD - process one at a time)
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const nextCandle = i < candles.length - 1 ? candles[i + 1] : null;

      // Generate signal from current candle (no future data)
      const signal = strategy.generateSignal(candle, strategyState);

      if (signal && strategy.validateSignal(signal)) {
        // Execute signal at next candle open (fill model)
        if (nextCandle) {
          await this._executeSignal(
            signal,
            nextCandle,
            account,
            spreadPct,
            slippagePct,
            commissionPct,
            symbol
          );
        }
      }

      // Check stop loss / take profit on current candle
      await this._checkExits(candle, account, spreadPct, slippagePct, commissionPct, symbol);

      // Update equity
      account.equity = this._calculateEquity(account, candle.close);
      equityCurve.push(account.equity);

      // Update drawdown
      if (account.equity > peakEquity) {
        peakEquity = account.equity;
      }
      const drawdown = peakEquity - account.equity;
      const drawdownPct = (drawdown / peakEquity) * 100;
      if (drawdownPct > maxDrawdownPct) {
        maxDrawdown = drawdown;
        maxDrawdownPct = drawdownPct;
      }
    }

    // Close all positions at end
    const lastCandle = candles[candles.length - 1];
    for (const [sym, position] of account.positions.entries()) {
      await this._closePosition(
        position,
        lastCandle,
        account,
        spreadPct,
        slippagePct,
        commissionPct,
        sym,
        'Backtest end'
      );
      account.tradeCounter++;
    }

    // Calculate final metrics
    const results = this._calculateMetrics(account, equityCurve, maxDrawdown, maxDrawdownPct);

    // Save to database (deterministic ID based on inputs)
    const backtestId = this._generateDeterministicId(
      'bt',
      strategy.id,
      symbol,
      timeframe,
      startTs.toString(),
      endTs.toString(),
      initialCapital.toString()
    );
    await evaluationDb.saveBacktestRun({
      id: backtestId,
      strategyId: strategy.id,
      symbol,
      timeframe,
      startDate: new Date(startTs).toISOString(),
      endDate: new Date(endTs).toISOString(),
      initialCapital,
      finalCapital: account.equity,
      totalTrades: results.totalTrades,
      winningTrades: results.winningTrades,
      losingTrades: results.losingTrades,
      winRate: results.winRate,
      netProfit: results.netProfit,
      netProfitPct: results.netProfitPct,
      maxDrawdown,
      maxDrawdownPct,
      sharpeRatio: results.sharpeRatio,
      profitFactor: results.profitFactor,
      avgTradeDurationSeconds: results.avgTradeDurationSeconds,
      configJson: { spreadPct, slippagePct, commissionPct, ...strategy.getConfig() },
      notes: null
    });

    return {
      id: backtestId,
      strategy: strategy.id,
      symbol,
      timeframe,
      startDate: new Date(startTs).toISOString(),
      endDate: new Date(endTs).toISOString(),
      ...results,
      trades: account.trades,
      equityCurve
    };
  }

  /**
   * Execute signal (fill at next candle open)
   */
  async _executeSignal(signal, nextCandle, account, spreadPct, slippagePct, commissionPct, symbol) {
    const fillPrice = nextCandle.open;
    
    // Apply spread (buy higher, sell lower)
    let adjustedPrice = fillPrice;
    if (signal.action === 'BUY') {
      adjustedPrice = fillPrice * (1 + spreadPct);
    } else if (signal.action === 'SELL') {
      adjustedPrice = fillPrice * (1 - spreadPct);
    }

    // Apply slippage
    adjustedPrice = adjustedPrice * (1 + (signal.action === 'BUY' ? slippagePct : -slippagePct));

    if (signal.action === 'CLOSE') {
      // Close existing position
      const position = account.positions.get(symbol);
      if (position) {
        await this._closePosition(
          position,
          nextCandle,
          account,
          spreadPct,
          slippagePct,
          commissionPct,
          symbol,
          signal.reason || 'Signal close'
        );
        account.tradeCounter++;
      }
    } else if (signal.action === 'BUY') {
      // Close existing position if any
      if (account.positions.has(symbol)) {
        const existing = account.positions.get(symbol);
        await this._closePosition(
          existing,
          nextCandle,
          account,
          spreadPct,
          slippagePct,
          commissionPct,
          symbol,
          'Reversing position'
        );
        account.tradeCounter++;
      }

      // Calculate position size (use 10% of equity)
      const positionSize = account.equity * 0.1;
      const quantity = positionSize / adjustedPrice;
      const commission = positionSize * commissionPct;
      const totalCost = positionSize + commission;

      if (totalCost <= account.balance) {
        account.balance -= totalCost;
      account.positions.set(symbol, {
        action: 'BUY',
        quantity,
        entryPrice: adjustedPrice,
        entryTime: nextCandle.ts,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        patternId: signal.meta?.patternId || null,
        patternType: signal.meta?.patternType || null,
        patternConfidence: signal.meta?.patternConfidence || null
      });
      }
    } else if (signal.action === 'SELL') {
      // Short selling not implemented in this version
      // Would require margin account simulation
      console.warn('⚠️  Short selling not implemented');
    }
  }

  /**
   * Check stop loss / take profit
   * If both hit same candle, assume worst-case (stop loss for long, stop loss for short)
   */
  async _checkExits(candle, account, spreadPct, slippagePct, commissionPct, symbol) {
    const position = account.positions.get(symbol);
    if (!position) return;

    // Check if both stop loss and take profit hit (worst-case: exit at stop loss)
    const stopLossHit = position.stopLoss && candle.low <= position.stopLoss;
    const takeProfitHit = position.takeProfit && candle.high >= position.takeProfit;
    
    if (stopLossHit && takeProfitHit) {
      // Both hit: assume worst-case (stop loss for long positions)
      await this._closePosition(
        position,
        candle,
        account,
        spreadPct,
        slippagePct,
        commissionPct,
        symbol,
        'Stop loss (both hit)'
      );
      account.tradeCounter++;
      return;
    }

    // Check stop loss
    if (stopLossHit) {
      await this._closePosition(
        position,
        candle,
        account,
        spreadPct,
        slippagePct,
        commissionPct,
        symbol,
        'Stop loss'
      );
      account.tradeCounter++;
      return;
    }

    // Check take profit
    if (takeProfitHit) {
      await this._closePosition(
        position,
        candle,
        account,
        spreadPct,
        slippagePct,
        commissionPct,
        symbol,
        'Take profit'
      );
      account.tradeCounter++;
      return;
    }
  }

  /**
   * Close position
   */
  async _closePosition(position, candle, account, spreadPct, slippagePct, commissionPct, symbol, reason) {
    // Use stop loss/take profit price if hit, otherwise use candle close
    let exitPrice = candle.close;
    if (reason === 'Stop loss' && position.stopLoss) {
      exitPrice = position.stopLoss;
    } else if (reason === 'Take profit' && position.takeProfit) {
      exitPrice = position.takeProfit;
    }

    // Apply spread (sell lower)
    exitPrice = exitPrice * (1 - spreadPct);
    exitPrice = exitPrice * (1 - slippagePct);

    // Calculate P&L
    const grossProceeds = position.quantity * exitPrice;
    const commission = grossProceeds * commissionPct;
    const netProceeds = grossProceeds - commission;
    const pnl = netProceeds - (position.quantity * position.entryPrice * (1 + commissionPct));
    const pnlPct = (pnl / (position.quantity * position.entryPrice)) * 100;

    // Update account
    account.balance += netProceeds;
    account.positions.delete(symbol);

    // Record trade (deterministic ID)
    const trade = {
      id: `trade_${symbol}_${candle.ts}_${account.tradeCounter}`,
      symbol,
      action: position.action,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      entryTime: position.entryTime,
      exitTime: candle.ts,
      pnl,
      pnlPct,
      duration: candle.ts - position.entryTime,
      reason,
      patternId: position.patternId || null,
      patternType: position.patternType || null,
      patternConfidence: position.patternConfidence || null
    };

    account.trades.push(trade);

    // Attribute to pattern if exists
    if (position.patternId) {
      await patternAttributionService.attributeTrade(
        trade.id,
        [{
          patternId: position.patternId,
          confidence: position.patternConfidence || 0,
          patternType: position.patternType || 'unknown'
        }],
        { pnl, pnlPct }
      );
    }
  }

  /**
   * Calculate equity (balance + open positions value)
   */
  _calculateEquity(account, currentPrice) {
    let equity = account.balance;
    for (const [symbol, position] of account.positions.entries()) {
      const positionValue = position.quantity * currentPrice;
      equity += positionValue;
    }
    return equity;
  }

  /**
   * Calculate performance metrics
   */
  _calculateMetrics(account, equityCurve, maxDrawdown, maxDrawdownPct) {
    const trades = account.trades;
    const totalTrades = trades.length;
    const winningTrades = trades.filter(t => t.pnl > 0).length;
    const losingTrades = trades.filter(t => t.pnl < 0).length;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

    const netProfit = account.equity - account.initialBalance;
    const netProfitPct = (netProfit / account.initialBalance) * 100;

    // Calculate Sharpe ratio (simplified - annualized)
    let sharpeRatio = null;
    if (equityCurve.length > 1) {
      const returns = [];
      for (let i = 1; i < equityCurve.length; i++) {
        const ret = (equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1];
        returns.push(ret);
      }
      const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        // Annualize (assuming daily returns - adjust for timeframe)
        sharpeRatio = (avgReturn / stdDev) * Math.sqrt(252);
      }
    }

    // Profit factor
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

    // Average trade duration
    const avgDuration = totalTrades > 0
      ? trades.reduce((sum, t) => sum + t.duration, 0) / totalTrades / 1000 // Convert to seconds
      : 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      netProfit,
      netProfitPct,
      maxDrawdown,
      maxDrawdownPct,
      sharpeRatio,
      profitFactor,
      avgTradeDurationSeconds: Math.round(avgDuration)
    };
  }

  /**
   * Get asset class from symbol
   */
  _getAssetClass(symbol) {
    if (symbol.includes('USDT') || symbol.includes('BTC') || symbol.includes('ETH')) {
      return 'crypto';
    }
    return 'stocks';
  }

  /**
   * Warn about large gaps in data
   */
  _warnAboutGaps(candles, timeframe) {
    const timeframeMs = this._timeframeToMs(timeframe);
    const maxGap = timeframeMs * 3; // 3x timeframe

    for (let i = 1; i < candles.length; i++) {
      const gap = candles[i].ts - candles[i - 1].ts;
      if (gap > maxGap) {
        console.warn(`⚠️  Large gap detected: ${gap / 1000 / 60} minutes between candles (expected ~${timeframeMs / 1000 / 60} minutes)`);
      }
    }
  }

  /**
   * Convert timeframe string to milliseconds
   */
  _timeframeToMs(timeframe) {
    const match = timeframe.match(/^(\d+)([mhd])$/);
    if (!match) return 60000; // Default 1 minute

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return 60000;
    }
  }
}

module.exports = new BacktestEngine();

