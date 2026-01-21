/**
 * TradingView Webhook Telemetry Service
 * 
 * Tracks webhook receives, authentication methods, and connection health
 * to prevent silent failures from ngrok URL changes or misconfiguration.
 */

const fs = require('fs').promises;
const path = require('path');

class TradingViewTelemetry {
  constructor() {
    this.telemetryPath = path.join(process.cwd(), 'data', 'telemetry', 'last_tradingview_webhook.json');
    this.lastTelemetry = null;
  }

  /**
   * Initialize telemetry (load existing data)
   */
  async initialize() {
    try {
      await fs.mkdir(path.dirname(this.telemetryPath), { recursive: true });
      await this.loadTelemetry();
    } catch (error) {
      console.warn('⚠️  Could not initialize telemetry:', error.message);
    }
  }

  /**
   * Load telemetry from file
   */
  async loadTelemetry() {
    try {
      const data = await fs.readFile(this.telemetryPath, 'utf8');
      this.lastTelemetry = JSON.parse(data);
    } catch (error) {
      // File doesn't exist yet, that's OK
      this.lastTelemetry = null;
    }
  }

  /**
   * Record webhook telemetry
   * @param {object} data - Telemetry data
   */
  async recordWebhook(data) {
    try {
      // Sanitize data - remove any secrets
      const sanitized = this.sanitizeData(data);
      
      const telemetry = {
        receivedAt: new Date().toISOString(),
        remoteIp: sanitized.remoteIp || 'unknown',
        userAgent: sanitized.userAgent || 'unknown',
        authModeUsed: sanitized.authModeUsed || 'none',
        result: sanitized.result || 'unknown',
        alertId: sanitized.alertId || null,
        symbol: sanitized.symbol || null,
        action: sanitized.action || null,
        idempotencyOutcome: sanitized.idempotencyOutcome || null,
        httpStatus: sanitized.httpStatus || null
      };

      // Update in-memory cache
      this.lastTelemetry = telemetry;

      // Persist atomically (write to temp file, then rename)
      const tempPath = this.telemetryPath + '.tmp';
      await fs.writeFile(tempPath, JSON.stringify(telemetry, null, 2), 'utf8');
      await fs.rename(tempPath, this.telemetryPath);

      return telemetry;
    } catch (error) {
      console.error('❌ Error recording telemetry:', error.message);
      // Don't throw - telemetry failure shouldn't break webhook processing
      return null;
    }
  }

  /**
   * Sanitize data to remove secrets
   */
  sanitizeData(data) {
    const sanitized = { ...data };
    
    // Remove any secret fields
    if (sanitized.body) {
      const bodyCopy = { ...sanitized.body };
      delete bodyCopy.secret;
      sanitized.body = bodyCopy;
    }
    
    delete sanitized.secret;
    delete sanitized.rawBody;
    
    return sanitized;
  }

  /**
   * Get last webhook telemetry
   */
  getLastTelemetry() {
    return this.lastTelemetry;
  }

  /**
   * Get telemetry age in seconds
   */
  getTelemetryAge() {
    if (!this.lastTelemetry || !this.lastTelemetry.receivedAt) {
      return null;
    }

    const received = new Date(this.lastTelemetry.receivedAt);
    const now = new Date();
    return Math.floor((now - received) / 1000);
  }

  /**
   * Format telemetry age as human-readable string
   */
  formatTelemetryAge() {
    const age = this.getTelemetryAge();
    if (age === null) {
      return 'never';
    }

    if (age < 60) {
      return `${age} seconds ago`;
    } else if (age < 3600) {
      const minutes = Math.floor(age / 60);
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    } else if (age < 86400) {
      const hours = Math.floor(age / 3600);
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    } else {
      const days = Math.floor(age / 86400);
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    }
  }
}

module.exports = new TradingViewTelemetry();

