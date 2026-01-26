/**
 * Risk Check Middleware
 * Validates orders through risk engine before processing
 * 
 * Feature Flag: ENABLE_RISK_ENGINE (default: true)
 */

const riskEngine = require('../services/riskEngine');

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
    // Use same default as paperTradingService to avoid mismatch
    const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '500');
    
    const validation = await riskEngine.validateOrder(orderIntent, accountBalance);

    if (!validation.allowed) {
      console.warn(`🚫 Risk check failed: ${validation.reason}`);
      return res.status(403).json({
        error: 'Risk check failed',
        message: validation.reason,
        orderIntent
      });
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


