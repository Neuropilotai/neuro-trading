/**
 * Cooldown Guard Middleware
 * Prevents spam by enforcing cooldown period per symbol+action
 * 
 * Feature Flag: COOLDOWN_SECONDS (default: 180 seconds)
 */

class CooldownGuard {
  constructor() {
    this.cooldownSeconds = parseInt(process.env.COOLDOWN_SECONDS || '180', 10);
    this.cooldownMap = new Map(); // key: "symbol:action" -> lastExecTimestamp
    this.enabled = this.cooldownSeconds > 0;
    
    // Cleanup old entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Generate cooldown key from symbol and action
   */
  getKey(symbol, action) {
    return `${String(symbol).toUpperCase()}:${String(action).toUpperCase()}`;
  }

  /**
   * Check if symbol+action is in cooldown
   * @param {string} symbol - Trading symbol
   * @param {string} action - Action (BUY/SELL)
   * @returns {{inCooldown: boolean, reason: string|null, remainingSeconds: number}}
   */
  checkCooldown(symbol, action) {
    if (!this.enabled) {
      return { inCooldown: false, reason: null, remainingSeconds: 0 };
    }

    const key = this.getKey(symbol, action);
    const lastExec = this.cooldownMap.get(key);

    if (!lastExec) {
      return { inCooldown: false, reason: null, remainingSeconds: 0 };
    }

    const now = Date.now();
    const ageSeconds = (now - lastExec) / 1000;
    const remainingSeconds = Math.max(0, this.cooldownSeconds - ageSeconds);

    if (remainingSeconds > 0) {
      return {
        inCooldown: true,
        reason: `Cooldown active: ${remainingSeconds.toFixed(0)}s remaining for ${symbol} ${action}`,
        remainingSeconds: Math.ceil(remainingSeconds)
      };
    }

    // Cooldown expired, remove entry
    this.cooldownMap.delete(key);
    return { inCooldown: false, reason: null, remainingSeconds: 0 };
  }

  /**
   * Record execution (call after successful trade)
   * @param {string} symbol - Trading symbol
   * @param {string} action - Action (BUY/SELL)
   */
  recordExecution(symbol, action) {
    if (!this.enabled) {
      return;
    }

    const key = this.getKey(symbol, action);
    this.cooldownMap.set(key, Date.now());
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [key, timestamp] of this.cooldownMap.entries()) {
      const ageSeconds = (now - timestamp) / 1000;
      if (ageSeconds >= this.cooldownSeconds) {
        this.cooldownMap.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} expired cooldown entries`);
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      enabled: this.enabled,
      cooldownSeconds: this.cooldownSeconds,
      activeCooldowns: this.cooldownMap.size
    };
  }
}

// Singleton instance
const cooldownGuard = new CooldownGuard();

/**
 * Cooldown guard middleware
 */
function cooldownGuardMiddleware(req, res, next) {
  if (!cooldownGuard.enabled) {
    return next();
  }

  const symbol = req.body.symbol;
  const action = req.body.action;

  if (!symbol || !action) {
    // Missing fields will be caught by validation middleware
    return next();
  }

  const check = cooldownGuard.checkCooldown(symbol, action);

  if (check.inCooldown) {
    console.warn(`⚠️  Cooldown guard blocked: ${check.reason}`);
    
    // Record telemetry
    const tradingViewTelemetry = require('../services/tradingViewTelemetry');
    tradingViewTelemetry.recordWebhook({
      remoteIp: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('user-agent'),
      authModeUsed: req.authModeUsed || 'unknown',
      result: '429',
      httpStatus: 429,
      alertId: req.body.alert_id,
      symbol,
      action,
      rejectionReason: check.reason
    }).catch(() => {}); // Don't block on telemetry errors

    return res.status(429).json({
      error: 'Cooldown active',
      message: check.reason,
      remainingSeconds: check.remainingSeconds
    });
  }

  // Attach cooldown guard to request for later use
  req.cooldownGuard = cooldownGuard;
  next();
}

module.exports = { cooldownGuardMiddleware, cooldownGuard };

