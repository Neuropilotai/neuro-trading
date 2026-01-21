/**
 * Paper Broker Adapter
 * 
 * Implements BrokerAdapter interface for paper trading
 * Wraps the existing PaperTradingService
 */

const BrokerAdapter = require('./BrokerAdapter');
const paperTradingService = require('../services/paperTradingService');
const tradeLedger = require('../db/tradeLedger');
const riskEngine = require('../services/riskEngine');
const tradingLearningService = require('../services/tradingLearningService');

class PaperBrokerAdapter extends BrokerAdapter {
  constructor() {
    super();
    this.name = 'Paper';
    this.enabled = process.env.ENABLE_PAPER_TRADING !== 'false';
    this.connected = true; // Paper trading is always "connected"
  }

  /**
   * Connect to broker (paper trading is always connected)
   */
  async connect() {
    this.connected = true;
    console.log('✅ Paper broker adapter connected');
    return true;
  }

  /**
   * Disconnect from broker
   */
  async disconnect() {
    this.connected = false;
    console.log('📴 Paper broker adapter disconnected');
  }

  /**
   * Place an order (implements BrokerAdapter interface)
   * @param {object} orderIntent - Order intent
   * @returns {Promise<object>} - Execution result
   */
  async placeOrder(orderIntent) {
    if (!this.enabled) {
      throw new Error('Paper trading is disabled (ENABLE_PAPER_TRADING=false)');
    }

    if (!this.connected) {
      throw new Error('Paper broker adapter not connected');
    }

    // Use existing paper trading service
    const result = await paperTradingService.executeOrder(orderIntent);
    
    // Return in BrokerAdapter format
    return {
      success: result.success,
      tradeId: result.tradeId,
      executionResult: result.executionResult
    };
  }

  /**
   * Cancel an order (paper trading - orders execute immediately, so this is a no-op)
   */
  async cancelOrder(orderId) {
    console.log(`⚠️  Paper trading: cancelOrder() called for ${orderId} (orders execute immediately, cannot cancel)`);
    return false; // Paper orders execute immediately, cannot cancel
  }

  /**
   * Get current positions
   */
  async getPositions() {
    const accountSummary = paperTradingService.getAccountSummary();
    return accountSummary.positions.map(pos => ({
      symbol: pos.symbol,
      quantity: pos.quantity,
      avgPrice: pos.avgPrice,
      currentPrice: pos.avgPrice, // Paper trading uses entry price as current
      currentValue: pos.currentValue,
      unrealizedPnL: pos.unrealizedPnL || 0
    }));
  }

  /**
   * Get account information
   */
  async getAccount() {
    const summary = paperTradingService.getAccountSummary();
    return {
      balance: summary.balance,
      equity: summary.totalValue,
      margin: 0, // Paper trading has no margin
      marginUsed: 0,
      marginAvailable: summary.balance,
      initialBalance: summary.initialBalance,
      totalPnL: summary.totalPnL,
      dailyPnL: summary.dailyPnL,
      openPositions: summary.openPositions,
      totalTrades: summary.totalTrades
    };
  }

  /**
   * Get account summary
   */
  async getAccountSummary() {
    return paperTradingService.getAccountSummary();
  }

  /**
   * Get order status (paper trading - orders execute immediately)
   */
  async getOrderStatus(orderId) {
    // In paper trading, orders execute immediately
    // Try to find in trade ledger
    try {
      await tradeLedger.initialize();
      const trade = await tradeLedger.getTradeById(orderId);
      if (trade) {
        return {
          orderId: trade.trade_id,
          status: trade.status || 'FILLED',
          fillPrice: trade.price,
          filledQuantity: trade.quantity,
          executedAt: trade.executed_at || trade.created_at
        };
      }
    } catch (error) {
      console.warn(`⚠️  Could not find order ${orderId} in ledger:`, error.message);
    }

    return {
      orderId,
      status: 'UNKNOWN',
      message: 'Order not found (paper orders execute immediately)'
    };
  }

  /**
   * Health check
   */
  async healthCheck() {
    return {
      connected: this.connected,
      enabled: this.enabled,
      latency: 0, // Paper trading has no latency
      lastUpdate: new Date().toISOString(),
      broker: 'Paper',
      accountBalance: paperTradingService.getAccountSummary().balance
    };
  }
}

module.exports = PaperBrokerAdapter;


