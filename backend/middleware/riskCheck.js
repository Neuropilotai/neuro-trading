/**
 * Risk Check Middleware
 * Validates orders through risk engine before processing.
 * Champion allowlist: execute only setups in champion_registry.json (when enabled).
 *
 * Feature Flag: ENABLE_RISK_ENGINE (default: true)
 * Env: CHAMPION_ALLOWLIST_ENABLED (default: 1) — 0 to allow all setups
 */

const riskEngine = require('../services/riskEngine');
const bosATRFilter = require('../services/bosAtFilter');
const championAllowlist = require('../services/championAllowlist');
const championPerformance = require('../services/championPerformance');
const paperTradingService = require('../services/paperTradingService');

const MAX_NOTIONAL_PCT_PER_TRADE = parseFloat(process.env.MAX_NOTIONAL_PCT_PER_TRADE || '0.10');
const MAX_NOTIONAL_PCT_PER_SYMBOL = parseFloat(process.env.MAX_NOTIONAL_PCT_PER_SYMBOL || '0.25');
const MIN_CASH_RESERVE_PCT = parseFloat(process.env.MIN_CASH_RESERVE_PCT || '0.20');

function getAccountExposureSnapshot() {
  const summary = paperTradingService.getAccountSummary();

  const bookEquity = Number.isFinite(Number(summary.bookEquity))
    ? Number(summary.bookEquity)
    : Number.isFinite(Number(summary.totalValue))
      ? Number(summary.totalValue)
      : Number.isFinite(Number(summary.balance))
        ? Number(summary.balance)
        : 0;

  const balance = Number.isFinite(Number(summary.balance)) ? Number(summary.balance) : 0;

  const positions = Array.isArray(summary.positions) ? summary.positions : [];

  return {
    bookEquity,
    balance,
    positions,
  };
}

function getSymbolBookExposure(positions, symbol) {
  const normalized = String(symbol || '').toUpperCase().trim();

  return positions
    .filter((p) => String(p.symbol || '').toUpperCase().trim() === normalized)
    .reduce((sum, p) => {
      const bookValue = Number.isFinite(Number(p.bookValue))
        ? Number(p.bookValue)
        : Number.isFinite(Number(p.currentValue))
          ? Number(p.currentValue)
          : (Number(p.quantity) || 0) * (Number(p.avgPrice) || 0);

      return sum + bookValue;
    }, 0);
}

function validateExposureLimits(orderIntent) {
  if (process.env.ENABLE_EXPOSURE_GUARDS === 'false') {
    return;
  }
  const tradingMode = String(process.env.TRADING_MODE || 'paper').toLowerCase();
  if (tradingMode === 'live') {
    return;
  }
  if (!paperTradingService.enabled) {
    return;
  }

  const action = String(orderIntent.action || '').toUpperCase().trim();

  if (action !== 'BUY') {
    return;
  }

  const quantity = Number(orderIntent.quantity);
  const price = Number(orderIntent.price);
  const symbol = String(orderIntent.symbol || '').toUpperCase().trim();

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`Invalid quantity for exposure check: ${orderIntent.quantity}`);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price for exposure check: ${orderIntent.price}`);
  }

  const orderNotional = quantity * price;
  const { bookEquity, balance, positions } = getAccountExposureSnapshot();

  if (!Number.isFinite(bookEquity) || bookEquity <= 0) {
    throw new Error(`Invalid account equity for exposure check: ${bookEquity}`);
  }

  const maxPerTrade = bookEquity * MAX_NOTIONAL_PCT_PER_TRADE;
  if (orderNotional > maxPerTrade) {
    throw new Error(
      `Trade exposure too large: $${orderNotional.toFixed(2)} > $${maxPerTrade.toFixed(2)} (${(MAX_NOTIONAL_PCT_PER_TRADE * 100).toFixed(1)}% of equity)`
    );
  }

  const currentSymbolExposure = getSymbolBookExposure(positions, symbol);
  const nextSymbolExposure = currentSymbolExposure + orderNotional;
  const maxPerSymbol = bookEquity * MAX_NOTIONAL_PCT_PER_SYMBOL;

  if (nextSymbolExposure > maxPerSymbol) {
    throw new Error(
      `Symbol exposure too large for ${symbol}: next $${nextSymbolExposure.toFixed(2)} > $${maxPerSymbol.toFixed(2)} (${(MAX_NOTIONAL_PCT_PER_SYMBOL * 100).toFixed(1)}% of equity)`
    );
  }

  const remainingCash = balance - orderNotional;
  const minCashReserve = bookEquity * MIN_CASH_RESERVE_PCT;

  if (remainingCash < minCashReserve) {
    throw new Error(
      `Cash reserve violation: remaining $${remainingCash.toFixed(2)} < required reserve $${minCashReserve.toFixed(2)} (${(MIN_CASH_RESERVE_PCT * 100).toFixed(1)}% of equity)`
    );
  }
}

/** Hard bounds on webhook price per symbol (catches bad TV feeds / wrong placeholders). */
const PRICE_GUARDS_BY_SYMBOL = Object.freeze({
  XAUUSD: { min: 1500, max: 3500 },
  BTCUSD: { min: 10000, max: 150000 },
  BTCUSDT: { min: 10000, max: 150000 },
  EURUSD: { min: 0.5, max: 2.0 },
});

/**
 * Extract order intent from request body
 * Computes default stop_loss and take_profit if missing
 */
function extractOrderIntent(req) {
  const body = req.body;
  
  // Parse price first before using it in calculations
  const price = parseFloat(body.price);
  
  // Validate price is a valid positive number
  if (isNaN(price) || price <= 0) {
    throw new Error(`Invalid price: ${body.price}. Must be a positive number`);
  }

  const symbolKey = String(body.symbol || '').toUpperCase().trim();
  const priceGuard = PRICE_GUARDS_BY_SYMBOL[symbolKey];
  if (priceGuard && (price < priceGuard.min || price > priceGuard.max)) {
    throw new Error(`${symbolKey} price out of bounds: ${price}`);
  }

  // Calculate quantity if not provided (use 1% of account balance as default)
  // Use same default as paperTradingService to avoid mismatch
  const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '500');
  const defaultQuantity = body.quantity || Math.floor((accountBalance * 0.01) / price);
  const action = body.action?.toUpperCase();
  
  // Extract stop_loss and take_profit, or compute defaults
  let stopLoss = body.stop_loss ? parseFloat(body.stop_loss) : body.stopLoss ? parseFloat(body.stopLoss) : null;
  let takeProfit = body.take_profit ? parseFloat(body.take_profit) : body.takeProfit ? parseFloat(body.takeProfit) : null;
  
  // Track whether values were provided or computed as defaults (for indicator override)
  const stopLossWasDefault = !stopLoss || isNaN(stopLoss);
  const takeProfitWasDefault = !takeProfit || isNaN(takeProfit);
  
  // Compute defaults if missing (server-side safety)
  if (!stopLoss || isNaN(stopLoss)) {
    if (action === 'BUY') {
      stopLoss = price * 0.98; // 2% stop loss for long positions
    } else if (action === 'SELL' || action === 'CLOSE') {
      stopLoss = price * 1.02; // SELL/CLOSE exits — same placeholder shape as SELL for risk engine
    }
  }

  if (!takeProfit || isNaN(takeProfit)) {
    if (action === 'BUY') {
      takeProfit = price * 1.02; // 2% take profit for long positions
    } else if (action === 'SELL' || action === 'CLOSE') {
      takeProfit = price * 0.98;
    }
  }

  const setupId = body.setupId != null ? String(body.setupId) : (body.setup_id != null ? String(body.setup_id) : null);

  return {
    symbol: body.symbol,
    action: action,
    quantity: parseFloat(body.quantity || defaultQuantity),
    price: price,
    stopLoss: stopLoss,
    takeProfit: takeProfit,
    confidence: body.confidence ? parseFloat(body.confidence) : null,
    setupId,
    // Flags to indicate if values were defaults (allows indicator override)
    _stopLossWasDefault: stopLossWasDefault,
    _takeProfitWasDefault: takeProfitWasDefault
  };
}

/**
 * Risk check middleware
 */
async function riskCheck(req, res, next) {
  let orderIntent;
  try {
    orderIntent = extractOrderIntent(req);
  } catch (error) {
    console.error('❌ Risk check failed:', error.message);
    return res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }

  // Skip trading enabled check for TradingView-only symbols (contain : or !)
  const isTradingViewOnlySymbol =
    orderIntent.symbol.includes(':') || orderIntent.symbol.includes('!');

  const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '500');

  if (isTradingViewOnlySymbol) {
    req.orderIntent = orderIntent;
    req.isTradingViewOnlySymbol = true;
    return next();
  }

  try {
    validateExposureLimits(orderIntent);
  } catch (error) {
    console.error('❌ Exposure check failed:', error.message);
    return res.status(403).json({
      status: 'error',
      error: error.message,
    });
  }

  try {
    // Confidence gate: skip low-confidence signals
    if (orderIntent.confidence != null && orderIntent.confidence < 0.5) {
      return res.status(403).json({
        error: 'Confidence below threshold',
        message: 'confidence < 0.5',
        confidence: orderIntent.confidence,
        orderIntent,
      });
    }

    const setupId = orderIntent.setupId || orderIntent.setup_id;

    // 1. Champion allowlist — selection
    if (championAllowlist.isChampionAllowlistEnabled()) {
      const allowlist = championAllowlist.loadChampionAllowlist();
      if (allowlist.size > 0) {
        if (!setupId || !allowlist.has(String(setupId))) {
          return res.status(403).json({
            error: 'Setup not in champion allowlist',
            message: 'Setup not in champion allowlist',
            setupId: setupId || null,
            orderIntent,
          });
        }
      }
    }

    // 2. Kill switch — protection (never execute disabled champions)
    if (setupId && !championPerformance.isChampionActive(setupId)) {
      return res.status(403).json({
        error: 'Champion disabled by kill switch',
        message: 'Champion disabled by kill switch',
        setupId,
        orderIntent,
      });
    }

    const validation = await riskEngine.validateOrder(orderIntent, accountBalance);

    if (!validation.allowed) {
      console.warn(`🚫 Risk check failed: ${validation.reason}`);
      return res.status(403).json({
        error: 'Risk check failed',
        message: validation.reason,
        orderIntent
      });
    }

    // BOS/ATR filter check (if alert indicates BOS trade)
    // Check if alert contains BOS signal indicator
    const isBOSTrade = req.body.signal_type === 'BOS' || 
                       req.body.pattern_type === 'BOS' ||
                       req.body.bos === true ||
                       (req.body.metadata && req.body.metadata.bos === true);
    
    if (isBOSTrade) {
      // Try to get candles if available, otherwise use alert data
      let candles = null;
      
      // If alert includes recent candles, use them
      if (req.body.candles && Array.isArray(req.body.candles)) {
        candles = req.body.candles;
      }
      
      // Validate BOS trade with ATR expansion and cooldown
      const bosValidation = bosATRFilter.validateBOSTrade(
        orderIntent.symbol,
        orderIntent.action,
        candles,
        req.body
      );
      
      // Attach BOS metrics to request for logging
      req.bosMetrics = bosValidation.metrics;
      
      if (!bosValidation.allowed) {
        console.warn(`🚫 BOS/ATR filter failed: ${bosValidation.reason}`);
        return res.status(403).json({
          error: 'BOS/ATR filter failed',
          message: bosValidation.reason,
          orderIntent,
          bosMetrics: bosValidation.metrics
        });
      }
      
      // Record BOS signal (only if validation passed)
      bosATRFilter.recordBOS(orderIntent.symbol, orderIntent.action);
    }

    // Attach order intent to request for downstream handlers
    req.orderIntent = orderIntent;
    next();
  } catch (error) {
    console.error('❌ Risk check error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

module.exports = {
  riskCheck,
  extractOrderIntent,
  validateExposureLimits,
  getAccountExposureSnapshot,
  getSymbolBookExposure,
};


