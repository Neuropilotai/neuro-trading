/**
 * TradingView Webhook Authentication Middleware
 * Validates HMAC signature from TradingView alerts
 * 
 * Feature Flag: ENABLE_WEBHOOK_AUTH (default: true)
 */

const crypto = require('crypto');

/**
 * Verify TradingView webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - X-TradingView-Signature header
 * @param {string} secret - TradingView webhook secret
 * @returns {boolean} - True if signature is valid
 */
function verifySignature(payload, signature, secret) {
  if (!secret) {
    throw new Error('TRADINGVIEW_WEBHOOK_SECRET not configured');
  }

  // Calculate expected signature
  const expectedHash = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  // Normalize incoming signature (remove sha256= prefix if present)
  let sigHash = signature;
  if (signature.startsWith('sha256=')) {
    sigHash = signature.substring(7);
  }
  
  // Ensure both are valid hex strings of the same length (64 chars for SHA256)
  if (sigHash.length !== 64 || expectedHash.length !== 64) {
    return false;
  }
  
  // Validate hex format
  if (!/^[0-9a-f]{64}$/i.test(sigHash) || !/^[0-9a-f]{64}$/i.test(expectedHash)) {
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sigHash, 'hex'),
      Buffer.from(expectedHash, 'hex')
    );
  } catch (error) {
    // If comparison fails (e.g., invalid hex), return false
    return false;
  }
}

/**
 * Webhook authentication middleware
 * Supports two authentication methods:
 * 1. HMAC signature header (X-TradingView-Signature)
 * 2. Body secret (JSON field "secret" matching TRADINGVIEW_WEBHOOK_SECRET)
 * 
 * Priority: Header auth is checked first, then body secret auth
 * Checks HMAC signature if ENABLE_WEBHOOK_AUTH is true
 */
async function webhookAuth(req, res, next) {
  // Check if auth is enabled (default: true)
  const authEnabled = process.env.ENABLE_WEBHOOK_AUTH !== 'false';

  if (!authEnabled) {
    console.warn('⚠️  Webhook authentication is DISABLED (ENABLE_WEBHOOK_AUTH=false)');
    return next();
  }

  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  
  if (!secret) {
    console.error('❌ TRADINGVIEW_WEBHOOK_SECRET not set');
    return res.status(500).json({
      error: 'Webhook authentication not configured',
      message: 'TRADINGVIEW_WEBHOOK_SECRET environment variable is required'
    });
  }

  // Method 1: Check HMAC signature header (priority)
  const signature = req.headers['x-tradingview-signature'] || 
                    req.headers['X-TradingView-Signature'];

  if (signature) {
    // Get raw body (set by express.json verify option)
    const rawBody = req.rawBody;
    
    if (!rawBody) {
      console.warn('⚠️  Raw body not available for HMAC verification');
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Raw body not available for signature verification'
      });
    }

    try {
      const isValid = verifySignature(rawBody, signature, secret);
      
      if (isValid) {
        // HMAC signature valid, proceed
        console.log('✅ Webhook authenticated via HMAC signature');
        // Record auth mode for telemetry (will be recorded in main handler)
        req.authModeUsed = 'hmac';
        return next();
      } else {
        // HMAC signature invalid, but header was present - reject
        console.warn(`⚠️  Invalid webhook signature from ${req.ip}`);
        // Record failed auth attempt (await to ensure it's recorded)
        const tradingViewTelemetry = require('../services/tradingViewTelemetry');
        try {
          await tradingViewTelemetry.recordWebhook({
            remoteIp: req.ip || req.connection?.remoteAddress,
            userAgent: req.get('user-agent'),
            authModeUsed: 'hmac',
            result: '401',
            httpStatus: 401
          });
        } catch (telemetryError) {
          // Log but don't block response if telemetry fails
          console.warn('⚠️  Failed to record auth telemetry:', telemetryError.message);
        }
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid signature'
        });
      }
    } catch (error) {
      console.error('❌ Signature verification error:', error);
      // If signature verification fails due to buffer length mismatch, treat as invalid signature
      if (error.message && error.message.includes('byte length')) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid signature format'
        });
      }
      return res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    }
  }

  // Method 2: Check body secret (fallback if no header)
  // Note: req.body is available because express.json() runs before this middleware
  if (req.body && typeof req.body === 'object' && req.body.secret) {
    const bodySecret = req.body.secret;
    
    // Use timing-safe comparison for secret
    try {
      const isValid = crypto.timingSafeEqual(
        Buffer.from(bodySecret, 'utf8'),
        Buffer.from(secret, 'utf8')
      );
      
      if (isValid) {
        // Body secret valid, proceed
        console.log('✅ Webhook authenticated via body secret');
        // Remove secret from body to prevent it from being logged/stored
        delete req.body.secret;
        // Record auth mode for telemetry
        req.authModeUsed = 'body_secret';
        return next();
      } else {
        // Body secret invalid
        console.warn(`⚠️  Invalid body secret from ${req.ip}`);
        // Record failed auth attempt (await to ensure it's recorded)
        const tradingViewTelemetry = require('../services/tradingViewTelemetry');
        try {
          await tradingViewTelemetry.recordWebhook({
            remoteIp: req.ip || req.connection?.remoteAddress,
            userAgent: req.get('user-agent'),
            authModeUsed: 'body_secret',
            result: '401',
            httpStatus: 401
          });
        } catch (telemetryError) {
          // Log but don't block response if telemetry fails
          console.warn('⚠️  Failed to record auth telemetry:', telemetryError.message);
        }
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid secret'
        });
      }
    } catch (error) {
      // If comparison fails (e.g., different lengths), treat as invalid
      console.warn(`⚠️  Body secret comparison failed: ${error.message}`);
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid secret'
      });
    }
  }

  // No authentication method provided
  // Record failed auth attempt (await to ensure it's recorded)
  const tradingViewTelemetry = require('../services/tradingViewTelemetry');
  try {
    await tradingViewTelemetry.recordWebhook({
      remoteIp: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent'),
      authModeUsed: 'none',
      result: '401',
      httpStatus: 401
    });
  } catch (telemetryError) {
    // Log but don't block response if telemetry fails
    console.warn('⚠️  Failed to record auth telemetry:', telemetryError.message);
  }
  
  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Missing authentication: Provide either X-TradingView-Signature header or "secret" field in request body'
  });
}

module.exports = { webhookAuth, verifySignature };

