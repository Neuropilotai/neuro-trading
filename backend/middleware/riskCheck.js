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
  
  // Calculate quantity if not provided (use 1% of account balance as default)
  const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '100000');
  const defaultQuantity = body.quantity || (price > 0 ? Math.floor((accountBalance * 0.01) / price) : 0);
  const action = body.action?.toUpperCase();
  
  // Extract stop_loss and take_profit, or compute defaults
  let stopLoss = body.stop_loss ? parseFloat(body.stop_loss) : body.stopLoss ? parseFloat(body.stopLoss) : null;
  let takeProfit = body.take_profit ? parseFloat(body.take_profit) : body.takeProfit ? parseFloat(body.takeProfit) : null;
  
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
    confidence: body.confidence ? parseFloat(body.confidence) : null
  };
}

/**
 * Risk check middleware
 */
async function riskCheck(req, res, next) {
  try {
    const orderIntent = extractOrderIntent(req);
    const accountBalance = parseFloat(process.env.ACCOUNT_BALANCE || '100000');
    
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


