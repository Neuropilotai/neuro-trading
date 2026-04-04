/**
 * Broker Adapter Factory
 * 
 * Creates and returns the appropriate broker adapter based on BROKER environment variable
 * 
 * Environment Variable: BROKER
 * - 'paper' or unset: PaperBrokerAdapter (default)
 * - 'oanda': OANDABrokerAdapter
 * - 'ibkr': IBKRBrokerAdapter
 */

const PaperBrokerAdapter = require('./PaperBrokerAdapter');
const OANDABrokerAdapter = require('./OANDABrokerAdapter');
const IBKRBrokerAdapter = require('./IBKRBrokerAdapter');
const AlpacaBrokerAdapter = require('./AlpacaBrokerAdapter');

let brokerAdapterInstance = null;

/**
 * Get the current broker adapter instance
 * @returns {BrokerAdapter} - Broker adapter instance
 */
function getBrokerAdapter() {
  if (brokerAdapterInstance) {
    return brokerAdapterInstance;
  }

  const brokerType = (process.env.BROKER || 'paper').toLowerCase();
  const strict = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NEUROPILOT_BROKER_STRICT || '').trim().toLowerCase()
  );

  switch (brokerType) {
    case 'paper':
      console.log('📊 Using Paper Broker Adapter');
      brokerAdapterInstance = new PaperBrokerAdapter();
      break;

    case 'oanda':
      console.log('🌐 Using OANDA Broker Adapter');
      brokerAdapterInstance = new OANDABrokerAdapter();
      break;

    case 'ibkr':
      console.log('📈 Using IBKR Broker Adapter');
      brokerAdapterInstance = new IBKRBrokerAdapter();
      break;

    case 'alpaca':
      console.log('🦙 Using Alpaca Broker Adapter (V1 stub if not wired)');
      brokerAdapterInstance = new AlpacaBrokerAdapter();
      break;

    default:
      if (strict) {
        throw new Error(`Unknown BROKER="${brokerType}". Set BROKER=paper|oanda|ibkr|alpaca or unset NEUROPILOT_BROKER_STRICT.`);
      }
      console.warn(`⚠️  Unknown broker type: ${brokerType}, defaulting to paper`);
      brokerAdapterInstance = new PaperBrokerAdapter();
  }

  // Note: Connection is handled during server startup (simple_webhook_server.js)
  // We don't auto-connect here to avoid race conditions with isConnected() checks
  // The server startup will await the connection properly

  return brokerAdapterInstance;
}

/**
 * Reset the broker adapter instance (for testing)
 */
function resetBrokerAdapter() {
  if (brokerAdapterInstance && typeof brokerAdapterInstance.disconnect === 'function') {
    brokerAdapterInstance.disconnect().catch(() => {});
  }
  brokerAdapterInstance = null;
}

module.exports = {
  getBrokerAdapter,
  resetBrokerAdapter
};


