/**
 * TradingView Webhook Authentication Middleware
 * Validates HMAC signature from TradingView alerts
 * 
 * Feature Flag: ENABLE_WEBHOOK_AUTH (default: true)
 */

const crypto = require('crypto');

// ===== DEBUG LOGGING =====
// Feature flag: WEBHOOK_AUTH_DEBUG=true enables detailed auth debugging
const AUTH_DEBUG = process.env.WEBHOOK_AUTH_DEBUG === 'true';
const dbg = (...args) => {
  if (AUTH_DEBUG) console.log('[auth-debug]', ...args);
};

// ===== OPTIONAL SERVICES =====
// Telemetry service is optional - auth works without it
function safeRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    return null; // Service not available - expected in isolated repos
  }
}

const tradingViewTelemetry = safeRequire('../services/tradingViewTelemetry');

/**
 * Verify TradingView webhook signature
 * @param {Buffer|string} payload - Raw request body (Buffer preferred for byte-exact verification)
 * @param {string} signature - X-TradingView-Signature header
 * @param {string} secret - TradingView webhook secret
 * @returns {boolean} - True if signature is valid
 */
function verifySignature(payload, signature, secret) {
  if (!secret) {
    throw new Error('TRADINGVIEW_WEBHOOK_SECRET or WEBHOOK_SECRET not configured');
  }

  // CRITICAL: Ensure payload is Buffer for byte-exact HMAC
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');

  // Calculate expected signature on exact bytes
  const expectedHash = crypto
    .createHmac('sha256', secret)
    .update(payloadBuffer)
    .digest('hex');

  // Normalize incoming signature (remove sha256= prefix if present, case-insensitive)
  let sigHash = signature.replace(/^sha256=/i, '').trim();
  
  // Debug logging (safe - only shows first 8 chars, never full hashes)
  dbg('expectedHash head:', expectedHash.slice(0, 8));
  dbg('receivedHash head:', sigHash.slice(0, 8));
  dbg('receivedHash len:', sigHash.length);
  
  // Ensure both are valid hex strings of the same length (64 chars for SHA256)
  if (sigHash.length !== 64 || expectedHash.length !== 64) {
    dbg('hash length mismatch:', { sigHash: sigHash.length, expectedHash: expectedHash.length });
    return false;
  }
  
  // Validate hex format
  if (!/^[0-9a-f]{64}$/i.test(sigHash) || !/^[0-9a-f]{64}$/i.test(expectedHash)) {
    dbg('invalid hex format');
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(sigHash, 'hex'),
      Buffer.from(expectedHash, 'hex')
    );
    dbg('signature match:', isValid);
    return isValid;
  } catch (error) {
    // If comparison fails (e.g., invalid hex), return false
    dbg('timing-safe comparison error:', error.message);
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

  // Support both TRADINGVIEW_WEBHOOK_SECRET and WEBHOOK_SECRET (fallback)
  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
  
  if (!secret) {
    console.error('❌ TRADINGVIEW_WEBHOOK_SECRET or WEBHOOK_SECRET not set');
    return res.status(500).json({
      error: 'Webhook authentication not configured',
      message: 'TRADINGVIEW_WEBHOOK_SECRET or WEBHOOK_SECRET environment variable is required'
    });
  }

  // Method 1: Check HMAC signature header (priority)
  // Use req.get() - Express normalizes header names (case-insensitive)
  const signature = req.get('X-TradingView-Signature');

  if (signature) {
    // Get raw body Buffer (byte-exact for HMAC) - priority over string
    const rawBodyBuffer = req.rawBodyBuffer;
    const rawBody = req.rawBody; // Fallback string (for compatibility)
    
    // Debug logging (only if WEBHOOK_AUTH_DEBUG=true)
    dbg('auth enabled:', process.env.ENABLE_WEBHOOK_AUTH !== 'false');
    dbg('has signature header:', !!signature);
    dbg('signature prefix:', String(signature).slice(0, 8)); // shows "sha256=" or hex start
    dbg('rawBodyBuffer bytes:', rawBodyBuffer?.length ?? null);
    dbg('rawBody string bytes:', rawBody ? Buffer.byteLength(rawBody, 'utf8') : null);
    dbg('content-type:', req.get('content-type'));
    dbg('secret source:', process.env.TRADINGVIEW_WEBHOOK_SECRET ? 'TRADINGVIEW_WEBHOOK_SECRET' :
                          process.env.WEBHOOK_SECRET ? 'WEBHOOK_SECRET' : 'NONE');
    
    // CRITICAL: HMAC must be calculated on the exact bytes sent
    const payloadBuffer = rawBodyBuffer ?? Buffer.from(rawBody ?? '', 'utf8');
    
    if (!payloadBuffer || payloadBuffer.length === 0) {
      console.warn('⚠️  Raw body not available for HMAC verification');
      console.warn(`   💡 Check: express.json({ verify }) must run BEFORE webhookAuth middleware`);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Raw body not available for signature verification'
      });
    }

    try {
      const isValid = verifySignature(payloadBuffer, signature, secret);
      
      if (isValid) {
        // HMAC signature valid, proceed
        console.log('✅ Webhook authenticated via HMAC signature');
        // Record auth mode for telemetry (will be recorded in main handler)
        req.authModeUsed = 'hmac';
        return next();
      } else {
        // HMAC signature invalid, but header was present - reject
        console.warn(`⚠️  Invalid webhook signature from ${req.ip}`);
        // Record failed auth attempt (if telemetry available)
        if (tradingViewTelemetry) {
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
        // Record failed auth attempt (if telemetry available)
        if (tradingViewTelemetry) {
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
  // Record failed auth attempt (if telemetry available)
  if (tradingViewTelemetry) {
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
  }
  
  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Missing authentication: Provide either X-TradingView-Signature header or "secret" field in request body'
  });
}

module.exports = { webhookAuth, verifySignature };

