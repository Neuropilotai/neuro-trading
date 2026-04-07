/**
 * TradingView Webhook Authentication Middleware
 *
 * Primary (simple): JSON body field "secret" must equal TRADINGVIEW_WEBHOOK_SECRET (timing-safe).
 * Optional: X-TradingView-Signature HMAC-SHA256 over raw body (TradingView “secret” header mode).
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
 * 1. Body secret (JSON "secret" === env TRADINGVIEW_WEBHOOK_SECRET) — preferred for alert JSON
 * 2. HMAC header X-TradingView-Signature (raw body)
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

  // Method 1: Body JSON "secret" (same value as TRADINGVIEW_WEBHOOK_SECRET)
  if (req.body && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, 'secret')) {
    const bodySecret = req.body.secret;
    const expectedStr = String(secret);
    const gotStr = bodySecret == null ? '' : String(bodySecret);

    try {
      const a = Buffer.from(gotStr, 'utf8');
      const b = Buffer.from(expectedStr, 'utf8');
      if (a.length !== b.length) {
        throw new Error('length mismatch');
      }
      const isValid = crypto.timingSafeEqual(a, b);

      if (isValid) {
        console.log('✅ Webhook authenticated via body secret');
        delete req.body.secret;
        req.authModeUsed = 'body_secret';
        return next();
      }
    } catch {
      /* fall through to invalid */
    }

    console.warn(`⚠️  Invalid body secret from ${req.ip}`);
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
      console.warn('⚠️  Failed to record auth telemetry:', telemetryError.message);
    }
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid secret'
    });
  }

  // Method 2: HMAC signature header
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
    message:
      'Missing authentication: add JSON field "secret" with the same value as TRADINGVIEW_WEBHOOK_SECRET, or send X-TradingView-Signature'
  });
}

module.exports = { webhookAuth, verifySignature };

