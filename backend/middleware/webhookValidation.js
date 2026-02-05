/**
 * TradingView Webhook Validation Middleware
 * Validates alert payload schema and required fields
 * 
 * Feature Flag: ENABLE_WEBHOOK_VALIDATION (default: true)
 */

/**
 * Validate TradingView alert payload
 * @param {object} payload - Alert payload
 * @returns {{valid: boolean, errors: string[]}} - Validation result
 */
function validateAlertPayload(payload) {
  const errors = [];

  // Required fields
  const requiredFields = ['symbol', 'action', 'price', 'quantity', 'alert_id', 'timestamp'];
  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate action (check type before calling toUpperCase)
  if (payload.action !== undefined && payload.action !== null && payload.action !== '') {
    // Explicitly check that action is a string or can be safely converted
    if (typeof payload.action !== 'string' && typeof payload.action !== 'number') {
      errors.push(`Invalid action type: ${typeof payload.action}. Action must be a string or number`);
    } else {
      // Safely convert to string and uppercase
      const actionStr = String(payload.action).toUpperCase();
      if (!['BUY', 'SELL', 'CLOSE'].includes(actionStr)) {
        errors.push(`Invalid action: ${payload.action}. Must be BUY, SELL, or CLOSE`);
      }
    }
  }

  // Validate price (must be positive number)
  if (payload.price !== undefined) {
    const price = parseFloat(payload.price);
    if (isNaN(price) || price <= 0) {
      errors.push(`Invalid price: ${payload.price}. Must be a positive number`);
    }
  }

  // Validate quantity (if provided, must be positive)
  if (payload.quantity !== undefined) {
    const quantity = parseFloat(payload.quantity);
    if (isNaN(quantity) || quantity <= 0) {
      errors.push(`Invalid quantity: ${payload.quantity}. Must be a positive number`);
    }
  }

  // Validate confidence (if provided, must be 0-1)
  if (payload.confidence !== undefined) {
    const confidence = parseFloat(payload.confidence);
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      errors.push(`Invalid confidence: ${payload.confidence}. Must be between 0 and 1`);
    }
  }

  // Validate alert_id (if provided, must be string)
  if (payload.alert_id !== undefined && typeof payload.alert_id !== 'string') {
    errors.push(`Invalid alert_id: ${payload.alert_id}. Must be a string`);
  }

  // Validate timestamp (if provided, must be valid and within reasonable bounds)
  if (payload.timestamp !== undefined) {
    const timestamp = parseInt(payload.timestamp);
    if (isNaN(timestamp) || timestamp <= 0) {
      errors.push(`Invalid timestamp: ${payload.timestamp}. Must be a positive integer`);
    } else {
      // Timestamp sanity check: not too old (24 hours) or too future (5 minutes)
      const now = Date.now();
      const timestampMs = timestamp * 1000; // Assume seconds, convert to ms
      const ageMs = now - timestampMs;
      const futureMs = timestampMs - now;
      
      // Allow timestamps in seconds or milliseconds
      const timestampMsAdjusted = timestamp < 10000000000 ? timestamp * 1000 : timestamp;
      const ageMsAdjusted = now - timestampMsAdjusted;
      const futureMsAdjusted = timestampMsAdjusted - now;
      
      const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
      const maxFutureMs = 5 * 60 * 1000; // 5 minutes
      
      if (ageMsAdjusted > maxAgeMs) {
        errors.push(`Timestamp too old: ${Math.floor(ageMsAdjusted / 1000 / 60)} minutes ago (max: 24 hours)`);
      } else if (futureMsAdjusted > maxFutureMs) {
        errors.push(`Timestamp too far in future: ${Math.floor(futureMsAdjusted / 1000 / 60)} minutes (max: 5 minutes)`);
      }
    }
  }

  // Validate symbol allowlist (if configured)
  if (payload.symbol !== undefined) {
    const allowedSymbols = process.env.ALLOWED_SYMBOLS;
    if (allowedSymbols && allowedSymbols.trim() !== '') {
      const symbolList = allowedSymbols.split(',').map(s => s.trim().toUpperCase());
      const symbolUpper = String(payload.symbol).toUpperCase();
      if (!symbolList.includes(symbolUpper)) {
        errors.push(`Symbol not allowed: ${payload.symbol}. Allowed symbols: ${symbolList.join(', ')}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Webhook validation middleware
 */
async function webhookValidation(req, res, next) {
  // Check if validation is enabled (default: true)
  const validationEnabled = process.env.ENABLE_WEBHOOK_VALIDATION !== 'false';

  if (!validationEnabled) {
    console.warn('⚠️  Webhook validation is DISABLED (ENABLE_WEBHOOK_VALIDATION=false)');
    return next();
  }

  try {
    const validation = validateAlertPayload(req.body);

    if (!validation.valid) {
      console.warn('❌ Webhook validation failed:', validation.errors);
      // Record telemetry for validation failure (await to ensure it's recorded)
      const tradingViewTelemetry = require('../services/tradingViewTelemetry');
      try {
        await tradingViewTelemetry.recordWebhook({
          remoteIp: req.ip || req.connection?.remoteAddress,
          userAgent: req.get('user-agent'),
          authModeUsed: req.authModeUsed || 'unknown',
          result: '400',
          httpStatus: 400,
          alertId: req.body.alert_id,
          symbol: req.body.symbol,
          action: req.body.action
        });
      } catch (telemetryError) {
        // Log but don't block response if telemetry fails
        console.warn('⚠️  Failed to record validation telemetry:', telemetryError.message);
      }
      
      return res.status(400).json({
        error: 'Validation failed',
        message: 'Invalid alert payload',
        errors: validation.errors
      });
    }

    // Validation passed
    next();
  } catch (error) {
    // Handle errors from validateAlertPayload (e.g., TypeError from toUpperCase)
    console.error('❌ Error in webhook validation:', error);
    return res.status(500).json({
      error: 'Validation error',
      message: 'An error occurred while validating the request'
    });
  }
}

module.exports = { webhookValidation, validateAlertPayload };

