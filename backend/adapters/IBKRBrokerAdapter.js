/**
 * Interactive Brokers (IBKR) Broker Adapter
 * 
 * Implements BrokerAdapter interface for Interactive Brokers TWS/IB Gateway
 * Uses the 'ib' npm package for IBKR API connection
 * 
 * Environment Variables:
 * - IBKR_HOST: TWS/IB Gateway host (default: 'localhost')
 * - IBKR_PORT: TWS/IB Gateway port (default: 7497 for paper, 7496 for live)
 * - IBKR_CLIENT_ID: Client ID for connection (default: 1)
 * 
 * Prerequisites:
 * - TWS or IB Gateway must be running
 * - API connections must be enabled in TWS/Gateway settings
 * - npm install ib (if not already installed)
 */

const BrokerAdapter = require('./BrokerAdapter');
const EventEmitter = require('events');

class IBKRBrokerAdapter extends BrokerAdapter {
  constructor() {
    super();
    this.name = 'IBKR';
    this.enabled = process.env.BROKER === 'ibkr';
    this.connected = false;
    this.host = process.env.IBKR_HOST || 'localhost';
    this.port = parseInt(process.env.IBKR_PORT || '7497', 10); // 7497 = paper, 7496 = live
    this.clientId = parseInt(process.env.IBKR_CLIENT_ID || '1', 10);
    this.ib = null; // Will hold IB API instance
    this.positions = new Map(); // Cache positions: symbol -> position data
    this.accountData = {}; // Cache account data
    this.orders = new Map(); // Cache orders: orderId -> order data
    this.connectionTimeout = null;
  }

  /**
   * Connect to TWS/IB Gateway
   */
  async connect() {
    if (this.connected && this.ib) {
      return true;
    }

    try {
      // Dynamic import of 'ib' package (optional dependency)
      let ib;
      try {
        ib = require('ib');
      } catch (error) {
        console.error('❌ IBKR adapter: "ib" package not installed');
        console.error('   Install with: npm install ib');
        console.error('   Or use paper trading: BROKER=paper');
        throw new Error('IBKR adapter requires "ib" package. Install with: npm install ib');
      }

      // Create IB API instance
      this.ib = new ib({
        host: this.host,
        port: this.port,
        clientId: this.clientId
      });

      // Set up event handlers
      this.setupEventHandlers();

      // Connect with timeout
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`IBKR connection timeout after 10s to ${this.host}:${this.port}`));
        }, 10000);

        this.ib.once('connected', () => {
          clearTimeout(timeout);
          this.connected = true;
          console.log(`✅ IBKR connected to ${this.host}:${this.port} (client ID: ${this.clientId})`);
          
          // Request account updates
          this.requestAccountUpdates();
          this.requestPositions();
          
          resolve(true);
        });

        this.ib.once('error', (error) => {
          clearTimeout(timeout);
          reject(new Error(`IBKR connection error: ${error.message || error}`));
        });

        // Start connection
        this.ib.connect();
      });

    } catch (error) {
      console.error(`❌ IBKR connection failed: ${error.message}`);
      this.connected = false;
      throw error;
    }
  }

  /**
   * Set up IB API event handlers
   */
  setupEventHandlers() {
    if (!this.ib) return;

    // Account updates
    this.ib.on('accountSummary', (accountId, tag, value, currency) => {
      if (!this.accountData[accountId]) {
        this.accountData[accountId] = {};
      }
      this.accountData[accountId][tag] = value;
    });

    // Position updates
    this.ib.on('position', (account, contract, position, avgCost) => {
      const symbol = contract.symbol;
      this.positions.set(symbol, {
        symbol,
        quantity: position,
        avgPrice: avgCost,
        account,
        contract
      });
    });

    // Order status updates
    this.ib.on('orderStatus', (orderId, status, filled, remaining, avgFillPrice, permId, parentId, lastFillPrice, clientId, whyHeld) => {
      if (this.orders.has(orderId)) {
        const order = this.orders.get(orderId);
        order.status = status;
        order.filled = filled;
        order.remaining = remaining;
        order.avgFillPrice = avgFillPrice;
      }
    });

    // Error handling
    this.ib.on('error', (error) => {
      console.error(`❌ IBKR error:`, error);
      if (error.code === 502) {
        // Connection lost
        this.connected = false;
        console.warn('⚠️  IBKR connection lost, attempting reconnect...');
        // Could implement auto-reconnect here
      }
    });

    // Disconnected
    this.ib.on('disconnected', () => {
      this.connected = false;
      console.warn('⚠️  IBKR disconnected');
    });
  }

  /**
   * Request account updates
   */
  requestAccountUpdates() {
    if (!this.ib || !this.connected) return;

    try {
      // Request account summary (common tags)
      const accountId = process.env.IBKR_ACCOUNT_ID || 'All';
      this.ib.reqAccountSummary(accountId, [
        'TotalCashValue',
        'NetLiquidation',
        'BuyingPower',
        'GrossPositionValue',
        'UnrealizedPnL',
        'RealizedPnL'
      ]);
    } catch (error) {
      console.error('❌ Error requesting account updates:', error.message);
    }
  }

  /**
   * Request positions
   */
  requestPositions() {
    if (!this.ib || !this.connected) return;

    try {
      this.ib.reqPositions();
    } catch (error) {
      console.error('❌ Error requesting positions:', error.message);
    }
  }

  /**
   * Disconnect from TWS/IB Gateway
   */
  async disconnect() {
    if (this.ib) {
      try {
        this.ib.disconnect();
      } catch (error) {
        console.error('❌ Error disconnecting IBKR:', error.message);
      }
      this.ib = null;
    }
    this.connected = false;
    this.positions.clear();
    this.accountData = {};
    this.orders.clear();
    console.log('📴 IBKR broker adapter disconnected');
  }

  /**
   * Convert symbol to IBKR contract
   */
  createContract(symbol, orderIntent = null) {
    // IBKR contract format
    // For stocks: { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD' }
    // For forex: { symbol, secType: 'CASH', exchange: 'IDEALPRO', currency: 'USD' }
    // For crypto: { symbol, secType: 'CRYPTO', exchange: 'PAXOS', currency: 'USD' }
    
    // Try to detect contract type from symbol
    let secType = 'STK'; // Default to stock
    let exchange = 'SMART';
    let currency = 'USD';

    // Forex detection (e.g., EURUSD, GBPUSD)
    if (symbol.length === 6 && /^[A-Z]{6}$/.test(symbol)) {
      secType = 'CASH';
      exchange = 'IDEALPRO';
      currency = symbol.slice(3); // Second currency
    }
    // Crypto detection (e.g., BTCUSD, ETHUSD)
    else if (symbol.includes('BTC') || symbol.includes('ETH') || symbol.includes('USDT')) {
      secType = 'CRYPTO';
      exchange = 'PAXOS';
      currency = 'USD';
    }

    return {
      symbol: symbol.replace('USDT', 'USD'), // Normalize symbol
      secType,
      exchange,
      currency
    };
  }

  /**
   * Convert orderIntent to IBKR order
   */
  createOrder(orderIntent) {
    const { action, quantity, price, stopLoss, takeProfit } = orderIntent;

    // Determine order type
    let orderType = 'MKT'; // Market order by default
    let lmtPrice = null;
    let auxPrice = null;

    if (price && price > 0) {
      orderType = 'LMT'; // Limit order
      lmtPrice = price;
    }

    // Create base order
    const order = {
      action: action === 'BUY' ? 'BUY' : 'SELL',
      totalQuantity: quantity,
      orderType: orderType,
      tif: 'DAY' // Time in force: Day order
    };

    if (lmtPrice) {
      order.lmtPrice = lmtPrice;
    }

    // Add stop loss and take profit as bracket orders if provided
    if (stopLoss || takeProfit) {
      order.orderType = 'LMT';
      order.lmtPrice = price;
      
      // Create parent order with bracket
      const parentOrder = { ...order };
      const stopOrder = stopLoss ? {
        action: action === 'BUY' ? 'SELL' : 'BUY',
        totalQuantity: quantity,
        orderType: 'STP',
        auxPrice: stopLoss,
        parentId: 0
      } : null;
      
      const profitOrder = takeProfit ? {
        action: action === 'BUY' ? 'SELL' : 'BUY',
        totalQuantity: quantity,
        orderType: 'LMT',
        lmtPrice: takeProfit,
        parentId: 0
      } : null;

      return { parentOrder, stopOrder, profitOrder };
    }

    return { order };
  }

  /**
   * Place an order via IBKR
   */
  async placeOrder(orderIntent) {
    if (!this.connected) {
      throw new Error('IBKR adapter not connected. Call connect() first.');
    }

    if (!this.ib) {
      throw new Error('IBKR API instance not available');
    }

    try {
      const { symbol, action, quantity, price } = orderIntent;
      
      // Create contract
      const contract = this.createContract(symbol, orderIntent);
      
      // Create order
      const orderData = this.createOrder(orderIntent);
      const order = orderData.order || orderData.parentOrder;
      
      // Place order
      return new Promise((resolve, reject) => {
        const orderId = Date.now(); // Generate order ID
        
        // Store order
        this.orders.set(orderId, {
          orderId,
          symbol,
          action,
          quantity,
          price,
          status: 'SUBMITTED',
          contract,
          order
        });

        // Place order via IB API
        this.ib.placeOrder(orderId, contract, order, (error, orderId) => {
          if (error) {
            this.orders.delete(orderId);
            reject(new Error(`IBKR order placement failed: ${error.message || error}`));
            return;
          }

          // If bracket order (stop loss/take profit), place child orders
          if (orderData.stopOrder || orderData.profitOrder) {
            // Note: IBKR bracket orders require special handling
            // For now, we'll place the main order and log that SL/TP should be set separately
            console.log('⚠️  IBKR: Stop loss and take profit should be set as bracket orders (requires additional implementation)');
          }

          // Wait for order status update
          setTimeout(() => {
            const orderInfo = this.orders.get(orderId);
            if (orderInfo) {
              resolve({
                success: true,
                tradeId: `IBKR_${orderId}`,
                executionResult: {
                  action,
                  symbol,
                  filledQuantity: orderInfo.filled || 0,
                  fillPrice: orderInfo.avgFillPrice || price,
                  pnl: 0, // Will be calculated when position closes
                  executedAt: new Date().toISOString(),
                  orderId: orderId,
                  status: orderInfo.status || 'SUBMITTED'
                }
              });
            } else {
              resolve({
                success: true,
                tradeId: `IBKR_${orderId}`,
                executionResult: {
                  action,
                  symbol,
                  filledQuantity: 0,
                  fillPrice: price,
                  pnl: 0,
                  executedAt: new Date().toISOString(),
                  orderId: orderId,
                  status: 'SUBMITTED'
                }
              });
            }
          }, 1000); // Wait 1 second for order status
        });
      });

    } catch (error) {
      console.error(`❌ IBKR placeOrder error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    if (!this.connected) {
      throw new Error('IBKR adapter not connected');
    }

    if (!this.ib) {
      throw new Error('IBKR API instance not available');
    }

    try {
      return new Promise((resolve, reject) => {
        this.ib.cancelOrder(orderId, (error) => {
          if (error) {
            reject(new Error(`IBKR order cancellation failed: ${error.message || error}`));
            return;
          }

          // Update order status
          if (this.orders.has(orderId)) {
            const order = this.orders.get(orderId);
            order.status = 'CANCELLED';
          }

          resolve(true);
        });
      });
    } catch (error) {
      console.error(`❌ IBKR cancelOrder error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get current positions from IBKR
   */
  async getPositions() {
    if (!this.connected) {
      throw new Error('IBKR adapter not connected');
    }

    // Request fresh positions
    this.requestPositions();

    // Return cached positions
    return Array.from(this.positions.values()).map(pos => ({
      symbol: pos.symbol,
      quantity: pos.quantity,
      avgPrice: pos.avgPrice,
      currentPrice: pos.avgPrice, // Would need market data for current price
      currentValue: pos.quantity * pos.avgPrice,
      unrealizedPnL: 0 // Would need current price to calculate
    }));
  }

  /**
   * Get account information from IBKR
   */
  async getAccount() {
    if (!this.connected) {
      throw new Error('IBKR adapter not connected');
    }

    // Request fresh account data
    this.requestAccountUpdates();

    // Wait a bit for data to arrive
    await new Promise(resolve => setTimeout(resolve, 500));

    // Get account ID (use first available or 'All')
    const accountId = Object.keys(this.accountData)[0] || 'All';
    const account = this.accountData[accountId] || {};

    return {
      balance: parseFloat(account.TotalCashValue || 0),
      equity: parseFloat(account.NetLiquidation || account.TotalCashValue || 0),
      margin: 0, // Would need to calculate from buying power
      marginUsed: 0,
      marginAvailable: parseFloat(account.BuyingPower || 0),
      initialBalance: parseFloat(account.TotalCashValue || 0),
      totalPnL: parseFloat(account.UnrealizedPnL || 0),
      dailyPnL: parseFloat(account.RealizedPnL || 0),
      openPositions: this.positions.size,
      totalTrades: this.orders.size
    };
  }

  /**
   * Get account summary
   */
  async getAccountSummary() {
    const account = await this.getAccount();
    const positions = await this.getPositions();
    
    return {
      balance: account.balance,
      initialBalance: account.initialBalance,
      totalPnL: account.totalPnL,
      dailyPnL: account.dailyPnL,
      totalValue: account.equity,
      openPositions: account.openPositions,
      positions: positions,
      totalTrades: account.totalTrades,
      enabled: this.enabled
    };
  }

  /**
   * Get order status
   */
  async getOrderStatus(orderId) {
    if (!this.connected) {
      throw new Error('IBKR adapter not connected');
    }

    const order = this.orders.get(orderId);
    if (!order) {
      return {
        orderId,
        status: 'UNKNOWN',
        message: 'Order not found'
      };
    }

    return {
      orderId,
      status: order.status || 'UNKNOWN',
      fillPrice: order.avgFillPrice || null,
      filledQuantity: order.filled || 0,
      remainingQuantity: order.remaining || order.quantity,
      executedAt: order.executedAt || null
    };
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const latency = this.connected ? 0 : null; // Would measure actual latency
      
      return {
        connected: this.connected,
        enabled: this.enabled,
        latency: latency,
        lastUpdate: new Date().toISOString(),
        broker: 'IBKR',
        host: this.host,
        port: this.port,
        clientId: this.clientId,
        positionsCount: this.positions.size,
        ordersCount: this.orders.size
      };
    } catch (error) {
      return {
        connected: false,
        enabled: this.enabled,
        error: error.message,
        broker: 'IBKR'
      };
    }
  }
}

module.exports = IBKRBrokerAdapter;
