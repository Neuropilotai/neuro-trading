/**
 * Risk Check Middleware
 * Validates orders through risk engine before processing
 * 
 * Feature Flag: ENABLE_RISK_ENGINE (default: true)
 */

const riskEngine = require('../services/riskEngine');
const bosATRFilter = require('../services/bosAtFilter');

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
    } else if (action === 'SELL') {
      stopLoss = price * 1.02; // 2% stop loss for short positions
    }
  }
  
  if (!takeProfit || isNaN(takeProfit)) {
    if (action === 'BUY') {
      takeProfit = price * 1.02; // 2% take profit for long positions
    } else if (action === 'SELL') {
      takeProfit = price * 0.98; // 2% take profit for short positions
    }
  }

  return {
    symbol: body.symbol,
    action: action,
    quantity: parseFloat(body.quantity || defaultQuantity),
    price: price,
    stopLoss: stopLoss,
    takeProfit: takeProfit,
    confidence: body.confidence ? parseFloat(body.confidence) : null,
    // Flags to indicate if values were defaults (allows indicator override)
    _stopLossWasDefault: stopLossWasDefault,
    _takeProfitWasDefault: takeProfitWasDefault
  };
}

/**
 * Risk check middleware
 */
async function riskCheck(req, res, next) {
  try {
    const orderIntent = extractOrderIntent(req);
    
    // Skip trading enabled check for TradingView-only symbols (contain : or !)
    // These are alerts only, not actual trades
    const isTradingViewOnlySymbol = orderIntent.symbol.includes(':') || orderIntent.symbol.includes('!');
    
    // Use same default as paperTradingService to avoid mismatch
    const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '500');
    
    // For TradingView-only symbols, skip the trading enabled check
    // They will be logged as ALERT_ONLY and not executed
    if (isTradingViewOnlySymbol) {
      // Attach order intent and mark as TradingView-only
      req.orderIntent = orderIntent;
      req.isTradingViewOnlySymbol = true;
      return next();
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

module.exports = { riskCheck };


