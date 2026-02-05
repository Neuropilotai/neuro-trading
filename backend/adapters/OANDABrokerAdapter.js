/**
 * OANDA Broker Adapter
 * 
 * Implements BrokerAdapter interface for OANDA REST v20 API
 * Uses native fetch (Node 18+)
 * 
 * Environment Variables:
 * - BROKER=oanda
 * - OANDA_API_KEY: OANDA API key
 * - OANDA_ACCOUNT_ID: OANDA account ID
 * - OANDA_ENVIRONMENT: 'practice' or 'live' (default: 'practice')
 */

const BrokerAdapter = require('./BrokerAdapter');

class OANDABrokerAdapter extends BrokerAdapter {
  constructor() {
    super();
    this.name = 'OANDA';
    this.enabled = (process.env.BROKER || 'paper') === 'oanda';
    this.connected = false;
    // Support both OANDA_API_KEY and OANDA_API_TOKEN
    this.apiKey = process.env.OANDA_API_KEY || process.env.OANDA_API_TOKEN;
    this.accountId = process.env.OANDA_ACCOUNT_ID;
    this.environment = process.env.OANDA_ENV || process.env.OANDA_ENVIRONMENT || 'practice';
    this.baseUrl = process.env.OANDA_BASE_URL || (this.environment === 'live' 
      ? 'https://api-fxtrade.oanda.com'
      : 'https://api-fxpractice.oanda.com');
    this.practiceExecution = process.env.OANDA_PRACTICE_EXECUTION === 'true';
  }

  /**
   * Simple HTTP helper using native fetch
   */
  async request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`OANDA response parse error: ${e.message}`);
    }

    if (!res.ok) {
      const errMsg = data.errorMessage || data.message || res.statusText;
      throw new Error(`OANDA API error ${res.status}: ${errMsg}`);
    }

    return data;
  }

  /**
   * Connect to OANDA API (lightweight check)
   */
  async connect() {
    if (!this.apiKey || !this.accountId) {
      throw new Error('OANDA_API_KEY and OANDA_ACCOUNT_ID must be set');
    }

    try {
      await this.getAccount(); // Lightweight connectivity check
      this.connected = true;
      console.log('✅ OANDA adapter connected');
      return true;
    } catch (error) {
      this.connected = false;
      console.error('❌ OANDA connect failed:', error.message);
      throw error;
    }
  }

  /**
   * Disconnect from OANDA
   */
  async disconnect() {
    this.connected = false;
    console.log('📴 OANDA broker adapter disconnected');
  }

  /**
   * Place an order via OANDA API
   * Supports XAUUSD and other OANDA instruments
   * Uses MARKET order for simplicity
   */
  async placeOrder(orderIntent) {
    if (!this.connected) {
      throw new Error('OANDA adapter not connected. Call connect() first.');
    }

    const { symbol, action, quantity, price, stopLoss, takeProfit } = orderIntent;

    if (!symbol || !action || !quantity) {
      throw new Error('Missing required fields: symbol, action, quantity');
    }

    // Normalize symbol (remove exchange prefix if present, e.g., "OANDA:XAUUSD" -> "XAUUSD")
    const normalizedSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
    
    // For XAUUSD, OANDA uses "XAU_USD" format
    const oandaSymbol = normalizedSymbol === 'XAUUSD' ? 'XAU_USD' : normalizedSymbol;

    const units = action === 'BUY'
      ? Math.abs(quantity)
      : action === 'SELL' || action === 'CLOSE'
        ? -Math.abs(quantity)
        : (() => { throw new Error(`Invalid action: ${action}`); })();

    const orderBody = {
      order: {
        units: units.toString(),
        instrument: oandaSymbol,
        type: price ? 'LIMIT' : 'MARKET',
        positionFill: 'DEFAULT',
      }
    };

    if (price) {
      orderBody.order.price = price.toString();
      orderBody.order.timeInForce = 'GTC';
    }

    if (takeProfit) {
      orderBody.order.takeProfitOnFill = { price: takeProfit.toString() };
    }
    if (stopLoss) {
      orderBody.order.stopLossOnFill = { price: stopLoss.toString() };
    }

    try {
      const data = await this.request(
        'POST',
        `/v3/accounts/${this.accountId}/orders`,
        orderBody
      );

      const fill = data.orderFillTransaction || data.orderCreateTransaction || {};
      const executedAt = fill.time || new Date().toISOString();
      const fillPrice = fill.price ? parseFloat(fill.price) : price || null;
      const filledQuantity = fill.units ? Math.abs(parseFloat(fill.units)) : Math.abs(quantity);

      return {
        success: true,
        tradeId: fill.id || fill.orderID || `OANDA_${Date.now()}`,
        executionResult: {
          action,
          symbol: normalizedSymbol, // Return normalized symbol
          filledQuantity,
          fillPrice,
          pnl: 0,
          executedAt
        }
      };
    } catch (error) {
      // If practice execution is enabled and we're in paper mode, log but don't fail
      const tradingMode = process.env.TRADING_MODE || 'paper';
      if (tradingMode === 'paper' && this.practiceExecution) {
        console.warn(`⚠️  OANDA practice execution failed (continuing with paper): ${error.message}`);
        // Return paper execution result
        return {
          success: true,
          tradeId: `PAPER_${Date.now()}`,
          executionResult: {
            action,
            symbol: normalizedSymbol,
            filledQuantity: quantity,
            fillPrice: price || null,
            pnl: 0,
            executedAt: new Date().toISOString()
          }
        };
      }
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    if (!this.connected) {
      throw new Error('OANDA adapter not connected');
    }

    await this.request(
      'PUT',
      `/v3/accounts/${this.accountId}/orders/${orderId}/cancel`
    );

    return true;
  }

  /**
   * Get current positions from OANDA
   */
  async getPositions() {
    if (!this.connected) {
      throw new Error('OANDA adapter not connected');
    }

    const data = await this.request(
      'GET',
      `/v3/accounts/${this.accountId}/openPositions`
    );

    const positions = (data.positions || []).map(pos => {
      const longUnits = parseFloat(pos.long.units || 0);
      const shortUnits = parseFloat(pos.short.units || 0);
      const netUnits = longUnits - shortUnits;
      const avgPrice = pos.long.averagePrice || pos.short.averagePrice || null;
      // Normalize symbol (XAU_USD -> XAUUSD)
      const normalizedSymbol = pos.instrument === 'XAU_USD' ? 'XAUUSD' : pos.instrument;
      return {
        symbol: normalizedSymbol,
        quantity: netUnits,
        avgPrice: avgPrice ? parseFloat(avgPrice) : null,
        currentPrice: avgPrice ? parseFloat(avgPrice) : null,
        currentValue: avgPrice ? netUnits * parseFloat(avgPrice) : 0,
        unrealizedPnL: 0 // Would need prices to compute accurately
      };
    });

    return positions;
  }

  /**
   * Get account information from OANDA
   */
  async getAccount() {
    if (!this.connected && this.enabled) {
      // Try to connect lazily
      await this.connect();
    }

    const data = await this.request(
      'GET',
      `/v3/accounts/${this.accountId}/summary`
    );

    const account = data.account || {};
    return {
      balance: parseFloat(account.balance || '0'),
      equity: parseFloat(account.NAV || account.balance || '0'),
      marginAvailable: parseFloat(account.marginAvailable || account.NAV || account.balance || '0'),
      unrealizedPnL: parseFloat(account.unrealizedPL || '0'),
      openPositionCount: parseInt(account.openPositionCount || '0', 10),
      currency: account.currency || 'USD'
    };
  }

  /**
   * Get account summary (normalized)
   */
  async getAccountSummary() {
    const account = await this.getAccount();
    const positions = await this.getPositions();

    return {
      balance: account.balance,
      initialBalance: null,
      totalPnL: account.unrealizedPnL,
      dailyPnL: null,
      totalValue: account.equity,
      openPositions: account.openPositionCount,
      positions,
      totalTrades: null,
      enabled: this.enabled
    };
  }

  /**
   * Get order status
   */
  async getOrderStatus(orderId) {
    if (!this.connected) {
      throw new Error('OANDA adapter not connected');
    }

    const data = await this.request(
      'GET',
      `/v3/accounts/${this.accountId}/orders/${orderId}`
    );

    const order = data.order || {};
    return {
      orderId,
      status: order.state || 'UNKNOWN',
      fillPrice: order.price ? parseFloat(order.price) : null,
      filledQuantity: order.units ? Math.abs(parseFloat(order.units)) : null,
      executedAt: order.createTime || null
    };
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const account = await this.getAccount();
      return {
        connected: true,
        enabled: this.enabled,
        latency: null,
        lastUpdate: new Date().toISOString(),
        broker: 'OANDA',
        environment: this.environment,
        accountId: this.accountId ? '***' + this.accountId.slice(-4) : 'not set',
        balance: account.balance,
        equity: account.equity
      };
    } catch (error) {
      return {
        connected: false,
        enabled: this.enabled,
        error: error.message,
        broker: 'OANDA'
      };
    }
  }
}

module.exports = OANDABrokerAdapter;

