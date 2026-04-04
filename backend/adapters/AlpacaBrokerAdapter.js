/**
 * Alpaca Markets — stub adapter (V1).
 * Implements the common BrokerAdapter surface; no simulated fills.
 * Set BROKER=alpaca + ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY for future wiring.
 */

const BrokerAdapter = require('./BrokerAdapter');

class AlpacaBrokerAdapter extends BrokerAdapter {
  constructor() {
    super();
    this.name = 'Alpaca';
    this.enabled = String(process.env.BROKER || '').toLowerCase() === 'alpaca';
    this.connected = false;
  }

  async connect() {
    const k = process.env.ALPACA_API_KEY_ID || process.env.ALPACA_API_KEY;
    const s = process.env.ALPACA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY;
    if (!k || !String(k).trim() || !s || !String(s).trim()) {
      throw new Error('Alpaca adapter: credentials not configured (ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY)');
    }
    this.connected = false;
    throw new Error('Alpaca adapter: REST integration not implemented in V1 (stub only)');
  }

  async disconnect() {
    this.connected = false;
  }

  async placeOrder() {
    throw new Error('Alpaca adapter: placeOrder not implemented in V1');
  }

  async cancelOrder() {
    return false;
  }

  async getPositions() {
    return [];
  }

  async getAccount() {
    return { balance: 0, equity: 0 };
  }

  async getAccountSummary() {
    return {
      balance: 0,
      totalValue: 0,
      openPositions: 0,
      positions: [],
    };
  }

  async getOrderStatus(orderId) {
    return { orderId, status: 'UNKNOWN' };
  }

  async healthCheck() {
    const k = process.env.ALPACA_API_KEY_ID || process.env.ALPACA_API_KEY;
    const s = process.env.ALPACA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY;
    const creds = Boolean(k && String(k).trim() && s && String(s).trim());
    return {
      connected: false,
      ok: false,
      enabled: this.enabled,
      broker: 'Alpaca',
      degraded: true,
      stub: true,
      message: creds
        ? 'Alpaca V1 stub: credentials present but API not wired'
        : 'Alpaca V1 stub: credentials missing',
    };
  }

  supportsPaperMode() {
    return true;
  }
}

module.exports = AlpacaBrokerAdapter;
