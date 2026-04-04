/**
 * OANDA adapter — V2 facade for pipeline (single broker).
 * Extends OANDABrokerAdapter; supports OANDA_ENV as alias for OANDA_ENVIRONMENT.
 *
 * Env:
 * - OANDA_API_KEY
 * - OANDA_ACCOUNT_ID
 * - OANDA_ENV or OANDA_ENVIRONMENT: practice | live
 *
 * Safety: OANDA_ENV=live requires ENABLE_LIVE_TRADING=1 (strict) before connect/placeOrder.
 */

const OANDABrokerAdapter = require('./OANDABrokerAdapter');

class OandaAdapter extends OANDABrokerAdapter {
  /**
   * @param {{ env?: object }} [opts] - defaults to process.env
   */
  constructor(opts = {}) {
    super();
    const env = opts.env || process.env;
    this._oandaV2Env = env;
    this.enabled = true;
    const envName = String(env.OANDA_ENV || env.OANDA_ENVIRONMENT || 'practice').toLowerCase();
    this.environment = envName;
    this.baseUrl =
      envName === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com';
    this.apiKey = env.OANDA_API_KEY;
    this.accountId = env.OANDA_ACCOUNT_ID;
  }

  _assertLiveAllowed() {
    if (this.environment === 'live' && String(this._oandaV2Env.ENABLE_LIVE_TRADING || '').trim() !== '1') {
      throw new Error('OANDA_ENV=live blocked: ENABLE_LIVE_TRADING must be 1');
    }
  }

  async connect() {
    this._assertLiveAllowed();
    if (!this.apiKey || !this.accountId) {
      throw new Error('OANDA_API_KEY and OANDA_ACCOUNT_ID must be set');
    }
    return super.connect();
  }

  async placeOrder(orderIntent) {
    this._assertLiveAllowed();
    return super.placeOrder(orderIntent);
  }

  async healthCheck() {
    try {
      this._assertLiveAllowed();
      return await super.healthCheck();
    } catch (e) {
      return {
        connected: false,
        ok: false,
        broker: 'OANDA',
        error: e && e.message ? String(e.message).slice(0, 200) : 'health_failed',
        degraded: true,
      };
    }
  }
}

module.exports = OandaAdapter;
