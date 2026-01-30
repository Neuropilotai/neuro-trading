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

class PaperTradingService extends EventEmitter {
  constructor() {
    super();
    this.enabled = process.env.ENABLE_PAPER_TRADING !== 'false';
    
    // Paper trading account (default $500 for scalping)
    this.account = {
      balance: parseFloat(process.env.ACCOUNT_BALANCE || '500'),
      initialBalance: parseFloat(process.env.ACCOUNT_BALANCE || '500'),
      positions: new Map(), // symbol -> {quantity, avgPrice, entryTime}
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

  /**
   * Execute a paper trade order
   * @param {object} orderIntent - Validated order intent
   * @returns {Promise<object>} - Execution result
   */
  async executeOrder(orderIntent) {
    if (!this.enabled) {
      throw new Error('Paper trading is disabled (ENABLE_PAPER_TRADING=false)');
    }

    const { symbol, action, quantity, price, stopLoss, takeProfit } = orderIntent;
    const tradeId = `TRADE_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
      // Execute based on action
      let executionResult;
      
      if (action === 'BUY') {
        executionResult = await this.executeBuy(symbol, quantity, price, stopLoss, takeProfit, tradeId);
      } else if (action === 'SELL' || action === 'CLOSE') {
        executionResult = await this.executeSell(symbol, quantity, price, tradeId);
      } else {
        throw new Error(`Invalid action: ${action}`);
      }

      // Update trade ledger
      await this.updateTradeLedger(tradeId, orderIntent, executionResult);

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

    // Update position
    this.account.positions.set(symbol, {
      quantity: newQuantity,
      avgPrice: newAvgPrice,
      entryTime: existingPosition.entryTime || new Date().toISOString(),
      stopLoss,
      takeProfit
    });

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
   * Execute a SELL/CLOSE order
   */
  async executeSell(symbol, quantity, price, tradeId) {
    const position = this.account.positions.get(symbol);

    if (!position || position.quantity === 0) {
      throw new Error(`No position in ${symbol} to sell`);
    }

    // Adjust quantity if trying to sell more than we have
    const sellQuantity = Math.min(quantity, position.quantity);
    const proceeds = sellQuantity * price;
    const costBasis = sellQuantity * position.avgPrice;
    const pnl = proceeds - costBasis;

    // Update position
    const newQuantity = position.quantity - sellQuantity;
    if (newQuantity <= 0) {
      this.account.positions.delete(symbol);
    } else {
      this.account.positions.set(symbol, {
        ...position,
        quantity: newQuantity
      });
    }

    // Add proceeds to balance
    this.account.balance += proceeds;

    // Update PnL
    this.account.dailyPnL += pnl;
    this.account.totalPnL += pnl;

      // Create execution result
      const executionResult = {
        action: 'SELL',
        symbol,
        filledQuantity: sellQuantity,
        fillPrice: price,
        proceeds,
        costBasis,
        pnl,
        position: newQuantity > 0 ? {
          quantity: newQuantity,
          avgPrice: position.avgPrice
        } : null,
        executedAt: new Date().toISOString()
      };

      // Increment trade count (ledger is source of truth, this is just a counter)
      this.account.totalTrades++;

      console.log(`✅ SELL executed: ${sellQuantity} ${symbol} @ $${price.toFixed(2)} | P&L: $${pnl.toFixed(2)} | Balance: $${this.account.balance.toFixed(2)}`);

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
   * Get account summary
   */
  getAccountSummary() {
    const totalPositionValue = Array.from(this.account.positions.values())
      .reduce((sum, pos) => sum + (pos.quantity * pos.avgPrice), 0);

    return {
      balance: this.account.balance,
      initialBalance: this.account.initialBalance,
      totalPnL: this.account.totalPnL,
      dailyPnL: this.account.dailyPnL,
      totalValue: this.account.balance + totalPositionValue,
      openPositions: this.account.positions.size,
      positions: Array.from(this.account.positions.entries()).map(([symbol, pos]) => ({
        symbol,
        quantity: pos.quantity,
        avgPrice: pos.avgPrice,
        currentValue: pos.quantity * pos.avgPrice,
        unrealizedPnL: 0 // Would need current price to calculate
      })),
      totalTrades: this.account.totalTrades, // Count from ledger (source of truth)
      enabled: this.enabled
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
      let totalPnL = 0;
      let totalTrades = 0;

      // Process each trade chronologically
      for (const trade of filledTrades) {
        const symbol = trade.symbol;
        const action = trade.action.toUpperCase();
        const quantity = parseFloat(trade.quantity);
        const price = parseFloat(trade.price);
        const pnl = parseFloat(trade.pnl || 0);

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
      this.account.totalPnL = totalPnL;
      this.account.dailyPnL = 0; // Daily PnL resets daily, would need date filtering
      this.account.totalTrades = totalTrades; // Store count from ledger (source of truth)

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


