/**
 * Broker Adapter Abstract Class
 * 
 * Defines the common interface for all broker adapters (Paper, OANDA, IBKR)
 * All broker implementations must extend this class and implement all methods
 * 
 * Feature Flag: BROKER (options: 'paper', 'oanda', 'ibkr')
 */

const EventEmitter = require('events');

class BrokerAdapter extends EventEmitter {
  constructor() {
    super();
    this.name = 'BrokerAdapter';
    this.enabled = true;
    this.connected = false;
  }

  /**
   * Connect to broker
   * @returns {Promise<boolean>} - True if connected successfully
   */
  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from broker
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Check if connected to broker
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Place an order
   * @param {object} orderIntent - Order intent with symbol, action, quantity, price, stopLoss, takeProfit
   * @returns {Promise<object>} - Execution result with tradeId, fillPrice, filledQuantity, pnl
   */
  async placeOrder(orderIntent) {
    throw new Error('placeOrder() must be implemented by subclass');
  }

  /**
   * Cancel an order
   * @param {string} orderId - Order ID to cancel
   * @returns {Promise<boolean>} - True if cancelled successfully
   */
  async cancelOrder(orderId) {
    throw new Error('cancelOrder() must be implemented by subclass');
  }

  /**
   * Get current positions
   * @returns {Promise<Array>} - Array of position objects {symbol, quantity, avgPrice, currentPrice, unrealizedPnL}
   */
  async getPositions() {
    throw new Error('getPositions() must be implemented by subclass');
  }

  /**
   * Get account information
   * @returns {Promise<object>} - Account object with balance, equity, margin, etc.
   */
  async getAccount() {
    throw new Error('getAccount() must be implemented by subclass');
  }

  /**
   * Get account summary (simplified)
   * @returns {Promise<object>} - Summary with balance, totalPnL, dailyPnL, openPositions
   */
  async getAccountSummary() {
    throw new Error('getAccountSummary() must be implemented by subclass');
  }

  /**
   * Get order status
   * @param {string} orderId - Order ID to check
   * @returns {Promise<object>} - Order status {orderId, status, fillPrice, filledQuantity, etc.}
   */
  async getOrderStatus(orderId) {
    throw new Error('getOrderStatus() must be implemented by subclass');
  }

  /**
   * Health check
   * @returns {Promise<object>} - Health status {connected, latency, lastUpdate, etc.}
   */
  async healthCheck() {
    throw new Error('healthCheck() must be implemented by subclass');
  }

  /**
   * Get broker name
   * @returns {string}
   */
  getName() {
    return this.name;
  }

  /**
   * Check if adapter is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }
}

module.exports = BrokerAdapter;


