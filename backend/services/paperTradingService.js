/**
 * Paper Trading Service
 * Executes orders in a simulated paper trading environment
 * 
 * Feature Flag: ENABLE_PAPER_TRADING (default: true)
 */

const EventEmitter = require('events');
const tradeLedger = require('../db/tradeLedger');
const riskEngine = require('./riskEngine');
const tradingLearningService = require('./tradingLearningService');
const priceFeedService = require('./priceFeedService');
const closedTradeAnalyticsService = require('./closedTradeAnalyticsService');

class PaperTradingService extends EventEmitter {
  constructor() {
    super();
    this.enabled = process.env.ENABLE_PAPER_TRADING !== 'false';
    
    // Paper trading account (default $500 for scalping)
    this.account = {
      balance: parseFloat(process.env.ACCOUNT_BALANCE || '500'),
      initialBalance: parseFloat(process.env.ACCOUNT_BALANCE || '500'),
      positions: new Map(), // symbol -> {quantity, avgPrice, entryTime}
      lastPriceBySymbol: new Map(), // symbol -> last seen market price (webhook / execution)
      dailyPnL: 0,
      totalPnL: 0,
      totalTrades: 0 // Count of executed trades (from ledger - source of truth)
    };

    // Environment flags
    this.rebuildOnBoot = process.env.PAPER_STATE_REBUILD_ON_BOOT !== 'false';
    this.resetOnBoot = process.env.PAPER_STATE_RESET_ON_BOOT === 'true';
    
    // Initialization flag (set to true after async init completes)
    this.initialized = false;

    // Save account state periodically
    setInterval(() => this.saveAccountState(), 60000); // Every minute
  }

  normalizeSymbol(symbol) {
    return String(symbol || '').toUpperCase().trim();
  }

  updateLastPrice(symbol, price) {
    const normalized = this.normalizeSymbol(symbol);
    const parsed = Number(price);

    if (!normalized) return;
    if (!Number.isFinite(parsed) || parsed <= 0) return;

    this.account.lastPriceBySymbol.set(normalized, parsed);
  }

  getLastPrice(symbol) {
    const normalized = this.normalizeSymbol(symbol);
    const price = this.account.lastPriceBySymbol.get(normalized);
    return Number.isFinite(Number(price)) ? Number(price) : null;
  }

  /** Push persisted last prices into the global price feed (after load / rebuild). */
  syncPriceFeedLastSeenFromAccount() {
    const m = this.account.lastPriceBySymbol;
    if (!m || typeof m.forEach !== 'function') return;
    m.forEach((px, sym) => {
      priceFeedService.updatePrice(sym, px);
    });
  }

  /**
   * Execute a paper trade order
   * @param {object} orderIntent - Validated order intent
   * @returns {Promise<object>} - Execution result
   */
  async executeOrder(orderIntent) {
    if (!this.enabled) {
      throw new Error('Paper trading is disabled (ENABLE_PAPER_TRADING=false)');
    }
    
    // Respect global trading kill switch (defense-in-depth)
    // SAFETY: case-insensitive opt-in — Railway sets "FALSE" uppercase
    const tradingEnabled = ['1','true','yes','on'].includes(
      (process.env.TRADING_ENABLED || '').trim().toLowerCase()
    );
    if (!tradingEnabled) {
      throw new Error('Trading is disabled (TRADING_ENABLED=false). Paper trading requires TRADING_ENABLED=true.');
    }

    const { symbol, action, quantity, price, stopLoss, takeProfit } = orderIntent;
    this.updateLastPrice(symbol, price);
    priceFeedService.updatePrice(symbol, price);
    const tradeId = `TRADE_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
      // Execute based on action
      let executionResult;
      
      if (action === 'BUY') {
        executionResult = await this.executeBuy(symbol, quantity, price, stopLoss, takeProfit, tradeId);
      } else if (action === 'SELL') {
        executionResult = await this.executeSell(symbol, quantity, price, tradeId, orderIntent);
      } else if (action === 'CLOSE') {
        executionResult = await this.executeClose(symbol, price, tradeId, orderIntent);
        orderIntent.quantity = executionResult.filledQuantity;
      } else {
        throw new Error(`Invalid action: ${action}`);
      }

      // Update trade ledger
      await this.updateTradeLedger(tradeId, orderIntent, executionResult);

      // Champion performance tracker: record closed trade (SELL/CLOSE) for allowlist kill logic
      if (action === 'SELL' || action === 'CLOSE') {
        if (!orderIntent || !orderIntent.setupId) {
          // skip recording when no setupId (non-champion or legacy alert)
        } else if (executionResult.pnl != null) {
          try {
            const championPerformance = require('./championPerformance');
            const pnl = Number(executionResult.pnl);
            const riskDollars = executionResult.riskDollars;
            const pnlR =
              Number.isFinite(pnl) && Number.isFinite(riskDollars) && riskDollars > 0
                ? pnl / riskDollars
                : null;
            championPerformance.recordChampionTradeResult({
              setupId: orderIntent.setupId,
              pnl,
              pnlR,
              riskDollars,
              won: pnl > 0,
              closedAt: executionResult.executedAt || new Date().toISOString(),
            });
          } catch (e) {
            console.error('championPerformance.recordChampionTradeResult failed:', e && e.message);
          }
        }
      }

      // Record in risk engine
      await riskEngine.recordTrade({
        action,
        symbol,
        quantity: executionResult.filledQuantity,
        price: executionResult.fillPrice,
        pnl: executionResult.pnl || 0
      });

      // Learn from trade (if learning enabled)
      if (tradingLearningService.enabled) {
        await tradingLearningService.learnFromTrade(executionResult, orderIntent);
      }

      // Emit event
      this.emit('tradeExecuted', {
        tradeId,
        orderIntent,
        executionResult
      });

      try {
        const shadowAllocationService = require('./shadowAllocationService');
        await shadowAllocationService.logShadowAfterPaperExecution({
          tradeId,
          orderIntent,
          executionResult,
          action,
        });
      } catch (e) {
        console.warn(`[shadow-allocation] ${e && e.message}`);
      }

      return {
        success: true,
        tradeId,
        executionResult
      };

    } catch (error) {
      console.error(`❌ Paper trade execution error: ${error.message}`);
      
      // Update trade ledger with rejection
      await tradeLedger.updateTradeStatus(tradeId, 'REJECTED', {
        rejection_reason: error.message
      });

      throw error;
    }
  }

  /**
   * Execute a BUY order
   */
  async executeBuy(symbol, quantity, price, stopLoss, takeProfit, tradeId) {
    const cost = quantity * price;

    // Check if we have enough balance
    if (cost > this.account.balance) {
      throw new Error(`Insufficient balance: need $${cost.toFixed(2)}, have $${this.account.balance.toFixed(2)}`);
    }

    // Get or create position
    const existingPosition = this.account.positions.get(symbol) || {
      quantity: 0,
      avgPrice: 0,
      entryTime: null
    };

    // Calculate new average price
    const newQuantity = existingPosition.quantity + quantity;
    const newAvgPrice = existingPosition.quantity > 0
      ? ((existingPosition.quantity * existingPosition.avgPrice) + cost) / newQuantity
      : price;

    let tradeGroupId = existingPosition.tradeGroupId;
    if (!existingPosition.quantity || existingPosition.quantity <= 0) {
      tradeGroupId = `tg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    // Update position
    this.account.positions.set(symbol, {
      quantity: newQuantity,
      avgPrice: newAvgPrice,
      entryTime: existingPosition.entryTime || new Date().toISOString(),
      stopLoss,
      takeProfit,
      tradeGroupId,
      closeSequence: existingPosition.closeSequence || 0,
    });

    try {
      const tradeLifecycleService = require('./tradeLifecycleService');
      tradeLifecycleService.notifyBuyFilled({
        tradeGroupId,
        symbol: this.normalizeSymbol(symbol),
        fillPrice: price,
        avgPrice: newAvgPrice,
        quantity: newQuantity,
      });
    } catch (err) {
      console.warn(`[lifecycle] notifyBuyFilled failed: ${err && err.message}`);
    }

    // Deduct from balance
    this.account.balance -= cost;

      // Create execution result
      const executionResult = {
        action: 'BUY',
        symbol,
        filledQuantity: quantity,
        fillPrice: price,
        cost,
        position: {
          quantity: newQuantity,
          avgPrice: newAvgPrice
        },
        stopLoss,
        takeProfit,
        executedAt: new Date().toISOString()
      };

      // Increment trade count (ledger is source of truth, this is just a counter)
      this.account.totalTrades++;

      console.log(`✅ BUY executed: ${quantity} ${symbol} @ $${price.toFixed(2)} | Balance: $${this.account.balance.toFixed(2)}`);

    return executionResult;
  }

  /**
   * Close entire long position (ignores request quantity).
   */
  async executeClose(symbol, price, tradeId, orderIntent = null) {
    const position = this.account.positions.get(symbol);

    if (!position || position.quantity === 0) {
      throw new Error(`No position in ${symbol} to close`);
    }

    const result = await this.executeSell(symbol, position.quantity, price, tradeId, orderIntent);
    return { ...result, action: 'CLOSE' };
  }

  /**
   * Reduce or close a long (reduce-only; no short).
   * @param {object} [orderIntent] - Optional, for riskDollars (champion performance tracker)
   */
  async executeSell(symbol, quantity, price, tradeId, orderIntent = null) {
    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      throw new Error(`Invalid SELL quantity: ${quantity}`);
    }

    const position = this.account.positions.get(symbol);

    if (!position || position.quantity === 0) {
      throw new Error(`No position in ${symbol} to sell`);
    }

    // Adjust quantity if trying to sell more than we have
    const sellQuantity = Math.min(quantity, position.quantity);
    const proceeds = sellQuantity * price;
    const costBasis = sellQuantity * position.avgPrice;
    const pnl = proceeds - costBasis;

    // Risk in dollars for R-multiple (long: risk = (avgPrice - stopLoss) * qty)
    let riskDollars = 0;
    if (orderIntent && orderIntent.stopLoss != null && Number.isFinite(Number(orderIntent.stopLoss))) {
      const stop = Number(orderIntent.stopLoss);
      riskDollars = Math.abs(position.avgPrice - stop) * sellQuantity;
    }

    const executedAt = new Date().toISOString();
    const closeSequence = (position.closeSequence || 0) + 1;
    const normSym = this.normalizeSymbol(symbol);
    const entryTs =
      position.entryTime && String(position.entryTime).length > 0
        ? new Date(position.entryTime).toISOString()
        : executedAt;

    const newQuantity = position.quantity - sellQuantity;

    let lifecycleSummary = null;
    try {
      const tradeLifecycleService = require('./tradeLifecycleService');
      const { finalized } = tradeLifecycleService.notifySellFill({
        tradeGroupId: position.tradeGroupId,
        symbol: normSym,
        exitPrice: price,
        pnl,
        newOpenQuantity: newQuantity,
        exitTimestamp: executedAt,
      });
      if (finalized) lifecycleSummary = finalized;
    } catch (err) {
      console.warn(`[lifecycle] notifySellFill failed: ${err && err.message}`);
    }

    // Update position
    if (newQuantity <= 0) {
      this.account.positions.delete(symbol);
    } else {
      this.account.positions.set(symbol, {
        ...position,
        quantity: newQuantity,
        closeSequence,
      });
    }

    // Add proceeds to balance
    this.account.balance += proceeds;

    // Update PnL
    this.account.dailyPnL += pnl;
    this.account.totalPnL += pnl;

    const executionResult = {
      action: 'SELL',
      symbol,
      filledQuantity: sellQuantity,
      fillPrice: price,
      proceeds,
      costBasis,
      pnl,
      riskDollars: riskDollars > 0 ? riskDollars : undefined,
      position:
        newQuantity > 0
          ? {
              quantity: newQuantity,
              avgPrice: position.avgPrice,
            }
          : null,
      executedAt,
    };

    try {
      const quote = priceFeedService.getQuoteSync(normSym);
      await closedTradeAnalyticsService.recordClosedTrade({
        symbol: normSym,
        entryPriceAvg: position.avgPrice,
        exitPriceAvg: price,
        closedQuantity: sellQuantity,
        realizedPnL: pnl,
        entryTimestamp: entryTs,
        exitTimestamp: executedAt,
        closeReason: orderIntent && orderIntent.action ? orderIntent.action : 'SELL',
        actionSource:
          orderIntent && orderIntent.actionSource ? orderIntent.actionSource : 'webhook',
        strategy: orderIntent && orderIntent.strategy != null ? orderIntent.strategy : null,
        setupId: orderIntent && orderIntent.setupId != null ? orderIntent.setupId : null,
        alertId: orderIntent && orderIntent.alert_id != null ? orderIntent.alert_id : null,
        priceSourceAtExit: quote.source,
        fees: 0,
        slippage: null,
        stopLoss: orderIntent ? orderIntent.stopLoss : null,
        regime: orderIntent && orderIntent.regime != null ? orderIntent.regime : null,
        lifecycleSummary: lifecycleSummary || null,
        tradeGroupId: position.tradeGroupId || null,
        closeSequence,
      });
    } catch (err) {
      console.warn(`[closed-trades] recordClosedTrade failed: ${err && err.message}`);
    }

    this.account.totalTrades++;

    console.log(
      `✅ SELL executed: ${sellQuantity} ${symbol} @ $${price.toFixed(2)} | P&L: $${pnl.toFixed(2)} | Balance: $${this.account.balance.toFixed(2)}`
    );

    return executionResult;
  }

  /**
   * Update trade ledger with execution result
   */
  async updateTradeLedger(tradeId, orderIntent, executionResult) {
    try {
      await tradeLedger.initialize();
      
      // Update status to EXECUTED
      await tradeLedger.updateTradeStatus(tradeId, 'EXECUTED', {
        executed_at: executionResult.executedAt,
        pnl: executionResult.pnl || 0
      });

      // Update to FILLED if order was fully executed
      if (executionResult.filledQuantity === orderIntent.quantity) {
        await tradeLedger.updateTradeStatus(tradeId, 'FILLED', {
          filled_at: executionResult.executedAt,
          pnl: executionResult.pnl || 0
        });
      }
    } catch (error) {
      console.error('❌ Error updating trade ledger:', error);
      // Don't throw - ledger update failure shouldn't fail the trade
    }
  }

  /**
   * Get account summary (book + mark-to-last-seen-price)
   */
  getAccountSummary() {
    const positions = Array.from(this.account.positions.entries()).map(([symbol, pos]) => {
      const normalizedSymbol = this.normalizeSymbol(symbol);
      const quantity = Number(pos.quantity) || 0;
      const avgPrice = Number(pos.avgPrice) || 0;

      const quote = priceFeedService.getQuoteSync(normalizedSymbol);
      let effectiveLastPrice;
      let priceSource;
      let markTimestamp;
      let priceLatency = quote.latencyMs ?? null;

      if (
        quote.price != null &&
        Number.isFinite(Number(quote.price)) &&
        Number(quote.price) > 0
      ) {
        effectiveLastPrice = Number(quote.price);
        priceSource = quote.source;
        markTimestamp = quote.markTimestamp;
      } else {
        effectiveLastPrice = avgPrice;
        priceSource = 'fallback';
        markTimestamp = null;
        priceLatency = null;
      }

      const bookValue = quantity * avgPrice;
      const marketValue = quantity * effectiveLastPrice;
      const unrealizedPnL = marketValue - bookValue;

      return {
        symbol: normalizedSymbol,
        quantity,
        avgPrice,
        lastPrice: effectiveLastPrice,
        priceSource,
        markTimestamp,
        priceLatency,
        currentValue: marketValue,
        bookValue,
        marketValue,
        unrealizedPnL,
      };
    });

    const totalBookValue = positions.reduce((sum, pos) => sum + pos.bookValue, 0);
    const totalMarketValue = positions.reduce((sum, pos) => sum + pos.marketValue, 0);
    const totalUnrealizedPnL = positions.reduce((sum, pos) => sum + pos.unrealizedPnL, 0);

    const bookEquity = this.account.balance + totalBookValue;
    const equity = this.account.balance + totalMarketValue;

    const { pricingMode, priceLatency } = priceFeedService.getAccountPricingMeta(
      positions.map((p) => p.symbol)
    );

    if (String(process.env.PRICE_MTM_LOG || '').trim().toLowerCase() === 'true') {
      console.log(
        `[MTM] equity=${equity.toFixed(4)} unrealizedPnL=${totalUnrealizedPnL.toFixed(4)} mode=${pricingMode}`
      );
    }

    return {
      balance: this.account.balance,
      initialBalance: this.account.initialBalance,
      totalPnL: this.account.totalPnL,
      dailyPnL: this.account.dailyPnL,

      totalValue: equity,
      currentEquity: equity,

      bookEquity,
      equity,
      totalBookValue,
      totalMarketValue,
      totalUnrealizedPnL,

      pricingMode,
      priceLatency,

      openPositions: this.account.positions.size,
      positions,
      totalTrades: this.account.totalTrades,
      enabled: this.enabled,
    };
  }

  /**
   * Initialize account state (rebuild from ledger or load from file)
   */
  async initializeState() {
    // Check for reset flag first
    if (this.resetOnBoot) {
      console.warn('⚠️  DEV RESET ACTIVE: Resetting paper state to initial balance');
      this.resetToInitialState();
      await this.saveAccountState();
      return;
    }

    // Try to rebuild from ledger if enabled
    if (this.rebuildOnBoot) {
      try {
        const rebuilt = await this.rebuildStateFromLedger();
        if (rebuilt) {
          // Rebuild succeeded, state is now accurate
          return;
        }
        // Rebuild failed (ledger unavailable), fall through to load from file
      } catch (error) {
        console.warn('⚠️  Rebuild from ledger failed, falling back to file:', error.message);
      }
    }

    // Fallback: load from file (existing behavior)
    await this.loadAccountState();
  }

  /**
   * Reset account to initial state
   */
  resetToInitialState() {
    const initialBalance = parseFloat(process.env.ACCOUNT_BALANCE || '500');
    this.account = {
      balance: initialBalance,
      initialBalance: initialBalance,
      positions: new Map(),
      lastPriceBySymbol: new Map(),
      dailyPnL: 0,
      totalPnL: 0,
      totalTrades: 0
    };
  }

  /**
   * Rebuild account state from immutable ledger
   * @returns {Promise<boolean>} - True if rebuild succeeded, false otherwise
   */
  async rebuildStateFromLedger() {
    try {
      // Ensure ledger is initialized
      await tradeLedger.initialize();
      
      // Get all FILLED trades from ledger
      const filledTrades = await tradeLedger.getFilledTrades();
      
      if (filledTrades.length === 0) {
        console.log('🔁 Rebuilt paper state: no executed trades found (clean state)');
        this.resetToInitialState();
        await this.saveAccountState();
        return true;
      }

      // Start with initial balance
      const initialBalance = parseFloat(process.env.ACCOUNT_BALANCE || '500');
      let balance = initialBalance;
      const positions = new Map(); // symbol -> {quantity, avgPrice, entryTime, stopLoss, takeProfit}
      const lastPriceBySymbol = new Map(); // symbol -> latest observed trade price
      let totalPnL = 0;
      let totalTrades = 0;

      // Process each trade chronologically
      for (const trade of filledTrades) {
        const symbol = trade.symbol;
        const action = trade.action.toUpperCase();
        const quantity = parseFloat(trade.quantity);
        const price = parseFloat(trade.price);
        const pnl = parseFloat(trade.pnl || 0);
        if (symbol && Number.isFinite(Number(price)) && Number(price) > 0) {
          lastPriceBySymbol.set(String(symbol).toUpperCase().trim(), Number(price));
        }

        if (action === 'BUY') {
          // Get or create position
          const existingPosition = positions.get(symbol) || {
            quantity: 0,
            avgPrice: 0,
            entryTime: null
          };

          // Calculate new average price
          const cost = quantity * price;
          const newQuantity = existingPosition.quantity + quantity;
          const newAvgPrice = existingPosition.quantity > 0
            ? ((existingPosition.quantity * existingPosition.avgPrice) + cost) / newQuantity
            : price;

          // Update position
          positions.set(symbol, {
            quantity: newQuantity,
            avgPrice: newAvgPrice,
            entryTime: existingPosition.entryTime || trade.filled_at || trade.executed_at || trade.created_at,
            stopLoss: trade.stop_loss || null,
            takeProfit: trade.take_profit || null
          });

          // Deduct from balance
          balance -= cost;
          totalTrades++;
        } else if (action === 'SELL' || action === 'CLOSE') {
          const position = positions.get(symbol);
          
          if (!position || position.quantity === 0) {
            console.warn(`⚠️  Ledger inconsistency: SELL for ${symbol} but no position exists`);
            continue;
          }

          // Adjust quantity if trying to sell more than we have
          const sellQuantity = Math.min(quantity, position.quantity);
          const proceeds = sellQuantity * price;
          const costBasis = sellQuantity * position.avgPrice;
          const realizedPnL = proceeds - costBasis;

          // Update position
          const newQuantity = position.quantity - sellQuantity;
          if (newQuantity <= 0) {
            positions.delete(symbol);
          } else {
            positions.set(symbol, {
              ...position,
              quantity: newQuantity
            });
          }

          // Add proceeds to balance
          balance += proceeds;
          totalPnL += realizedPnL;
          totalTrades++;
        }
      }

      // Update account state
      this.account.balance = balance;
      this.account.initialBalance = initialBalance;
      this.account.positions = positions;
      this.account.lastPriceBySymbol = lastPriceBySymbol;
      this.account.totalPnL = totalPnL;
      this.account.dailyPnL = 0; // Daily PnL resets daily, would need date filtering
      this.account.totalTrades = totalTrades; // Store count from ledger (source of truth)

      this.syncPriceFeedLastSeenFromAccount();

      // Save rebuilt state
      await this.saveAccountState();

      const positionCount = positions.size;
      console.log(`🔁 Rebuilt paper state from ledger: trades=${totalTrades} positions=${positionCount} cash=$${balance.toFixed(2)}`);
      
      return true;
    } catch (error) {
      console.error('❌ Error rebuilding state from ledger:', error.message);
      return false;
    }
  }

  /**
   * Load account state from file
   */
  async loadAccountState() {
    const fs = require('fs').promises;
    const path = require('path');
    const stateFile = path.join(process.cwd(), 'data', 'paper_trading_state.json');

    try {
      const data = await fs.readFile(stateFile, 'utf8');
      const state = JSON.parse(data);
      
      this.account.balance = state.balance || this.account.balance;
      this.account.initialBalance = state.initialBalance || this.account.initialBalance;
      this.account.totalPnL = state.totalPnL || 0;
      this.account.dailyPnL = state.dailyPnL || 0;
      this.account.totalTrades = state.totalTrades || 0;
      
      // Restore positions
      if (state.positions) {
        this.account.positions = new Map(Object.entries(state.positions));
      }
      if (state.lastPriceBySymbol) {
        this.account.lastPriceBySymbol = new Map(Object.entries(state.lastPriceBySymbol));
      } else {
        this.account.lastPriceBySymbol = new Map();
      }

      this.syncPriceFeedLastSeenFromAccount();

      console.log(`✅ Loaded paper trading account state: $${this.account.balance.toFixed(2)}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('⚠️  Error loading account state:', error.message);
      }
      // File doesn't exist yet, that's okay
    }
  }

  /**
   * Save account state to file (atomic write)
   */
  async saveAccountState() {
    const fs = require('fs').promises;
    const path = require('path');
    const stateFile = path.join(process.cwd(), 'data', 'paper_trading_state.json');
    const tempFile = `${stateFile}.tmp`;

    try {
      const state = {
        balance: this.account.balance,
        initialBalance: this.account.initialBalance,
        totalPnL: this.account.totalPnL,
        dailyPnL: this.account.dailyPnL,
        totalTrades: this.account.totalTrades || 0,
        positions: Object.fromEntries(this.account.positions),
        lastPriceBySymbol: Object.fromEntries(this.account.lastPriceBySymbol || new Map()),
        lastUpdated: new Date().toISOString()
      };

      // Ensure directory exists
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      
      // Atomic write: write to temp file first, then rename
      await fs.writeFile(tempFile, JSON.stringify(state, null, 2));
      await fs.rename(tempFile, stateFile);
    } catch (error) {
      console.error('❌ Error saving account state:', error);
      // Clean up temp file if it exists
      try {
        await fs.unlink(tempFile);
      } catch (unlinkError) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Reset daily PnL (called at start of new day)
   */
  resetDailyPnL() {
    this.account.dailyPnL = 0;
    console.log('📅 Daily PnL reset');
  }
}

// Singleton instance
const paperTradingService = new PaperTradingService();

module.exports = paperTradingService;


