/**
 * BOS (Break of Structure) + ATR Expansion Filter
 * 
 * Filters BOS trades based on:
 * 1. ATR expansion confirmation (ATR must be expanding, not flat/shrinking)
 * 2. BOS cooldown (after 3 same-direction BOS signals, require CHOCH or pullback)
 * 
 * Feature Flag: ENABLE_BOS_ATR_FILTER (default: true)
 */

class BOSATRFilter {
  constructor() {
    this.enabled = process.env.ENABLE_BOS_ATR_FILTER !== 'false';
    
    // Track BOS signals per symbol (in-memory, resets on restart)
    // Structure: { symbol: { direction: 'BUY'|'SELL', count: number, lastBOS: timestamp, lastCHOCH: timestamp } }
    this.bosHistory = new Map();
    
    // ATR expansion lookback (default: 14 bars)
    this.atrLookback = parseInt(process.env.ATR_EXPANSION_LOOKBACK || '14', 10);
    
    // BOS cooldown threshold (default: 3 same-direction signals)
    this.bosCooldownThreshold = parseInt(process.env.BOS_COOLDOWN_THRESHOLD || '3', 10);
    
    // Minimum bars since last CHOCH (default: 5)
    this.minBarsSinceCHOCH = parseInt(process.env.MIN_BARS_SINCE_CHOCH || '5', 10);
    
    // ATR expansion threshold (default: 1.0 = ATR > SMA(ATR, 14))
    this.atrExpansionThreshold = parseFloat(process.env.ATR_EXPANSION_THRESHOLD || '1.0', 10);
  }

  /**
   * Calculate ATR from candles
   * @param {Array} candles - Array of candle objects {high, low, close}
   * @param {number} period - ATR period (default: 14)
   * @returns {number|null} - ATR value or null if insufficient data
   */
  calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) {
      return null;
    }

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    // Calculate ATR as SMA of true ranges
    if (trueRanges.length < period) {
      return null;
    }

    const atrValues = [];
    for (let i = trueRanges.length - period; i < trueRanges.length; i++) {
      atrValues.push(trueRanges[i]);
    }

    return atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
  }

  /**
   * Calculate ATR slope (expansion/contraction)
   * @param {Array} candles - Array of candle objects
   * @param {number} period - ATR period
   * @returns {{currentATR: number, avgATR: number, slope: number, isExpanding: boolean}|null}
   */
  calculateATRExpansion(candles, period = 14) {
    if (!candles || candles.length < period * 2) {
      return null;
    }

    // Calculate current ATR
    const currentATR = this.calculateATR(candles.slice(-period - 1), period);
    if (!currentATR) {
      return null;
    }

    // Calculate ATR for lookback period (average of last N ATR values)
    const atrValues = [];
    for (let i = candles.length - period * 2; i < candles.length - period; i++) {
      const windowCandles = candles.slice(Math.max(0, i - period), i + 1);
      const atr = this.calculateATR(windowCandles, period);
      if (atr) {
        atrValues.push(atr);
      }
    }

    if (atrValues.length === 0) {
      return null;
    }

    const avgATR = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
    const slope = (currentATR - avgATR) / avgATR; // Percentage change
    const isExpanding = currentATR > avgATR * this.atrExpansionThreshold;

    return {
      currentATR,
      avgATR,
      slope,
      isExpanding
    };
  }

  /**
   * Check if ATR is expanding (3 bars in a row)
   * @param {Array} candles - Array of candle objects
   * @returns {boolean} - True if ATR is expanding
   */
  isATRExpanding(candles) {
    if (!candles || candles.length < this.atrLookback + 3) {
      return false;
    }

    // Check last 3 bars for ATR expansion
    const atrValues = [];
    for (let i = 0; i < 3; i++) {
      const windowStart = candles.length - this.atrLookback - 3 + i;
      const windowEnd = candles.length - 3 + i + 1;
      const windowCandles = candles.slice(Math.max(0, windowStart), windowEnd);
      const atr = this.calculateATR(windowCandles, this.atrLookback);
      if (atr) {
        atrValues.push(atr);
      }
    }

    if (atrValues.length < 3) {
      return false;
    }

    // Check if ATR is rising for 3 consecutive bars
    return atrValues[2] > atrValues[1] && atrValues[1] > atrValues[0];
  }

  /**
   * Get BOS history for symbol
   * @param {string} symbol - Trading symbol
   * @returns {Object} - BOS history {direction, count, lastBOS, lastCHOCH}
   */
  getBOSHistory(symbol) {
    return this.bosHistory.get(symbol) || {
      direction: null,
      count: 0,
      lastBOS: null,
      lastCHOCH: null
    };
  }

  /**
   * Record BOS signal
   * @param {string} symbol - Trading symbol
   * @param {string} direction - 'BUY' or 'SELL'
   */
  recordBOS(symbol, direction) {
    const history = this.getBOSHistory(symbol);
    
    if (history.direction === direction) {
      // Same direction - increment count
      history.count += 1;
    } else {
      // Different direction - reset count
      history.direction = direction;
      history.count = 1;
    }
    
    history.lastBOS = Date.now();
    this.bosHistory.set(symbol, history);
  }

  /**
   * Record CHOCH (Change of Character)
   * @param {string} symbol - Trading symbol
   */
  recordCHOCH(symbol) {
    const history = this.getBOSHistory(symbol);
    history.lastCHOCH = Date.now();
    // Reset BOS count on CHOCH
    history.count = 0;
    this.bosHistory.set(symbol, history);
  }

  /**
   * Check if BOS cooldown is required
   * @param {string} symbol - Trading symbol
   * @param {string} direction - 'BUY' or 'SELL'
   * @param {Array} candles - Array of candle objects (for time-based checks)
   * @returns {{required: boolean, reason: string|null}}
   */
  checkBOSCooldown(symbol, direction, candles = []) {
    const history = this.getBOSHistory(symbol);
    
    // If different direction, no cooldown needed
    if (history.direction !== direction) {
      return { required: false, reason: null };
    }

    // If count < threshold, no cooldown needed
    if (history.count < this.bosCooldownThreshold) {
      return { required: false, reason: null };
    }

    // Cooldown required - check if CHOCH occurred recently
    if (history.lastCHOCH) {
      const barsSinceCHOCH = this.getBarsSinceTimestamp(history.lastCHOCH, candles);
      if (barsSinceCHOCH >= this.minBarsSinceCHOCH) {
        return {
          required: true,
          reason: `BOS cooldown: ${history.count} ${direction} signals, need CHOCH or pullback (last CHOCH: ${barsSinceCHOCH} bars ago)`
        };
      }
    } else {
      // No CHOCH recorded - require cooldown
      return {
        required: true,
        reason: `BOS cooldown: ${history.count} ${direction} signals, no CHOCH recorded`
      };
    }

    return { required: false, reason: null };
  }

  /**
   * Get number of bars since timestamp (approximate)
   * @param {number} timestamp - Timestamp in milliseconds
   * @param {Array} candles - Array of candle objects
   * @returns {number} - Number of bars (or 0 if can't determine)
   */
  getBarsSinceTimestamp(timestamp, candles) {
    if (!candles || candles.length === 0) {
      return 0;
    }

    // Assume 1-minute candles (can be improved with actual timeframe)
    const now = Date.now();
    const msSince = now - timestamp;
    const minutesSince = msSince / (1000 * 60);
    
    return Math.floor(minutesSince);
  }

  /**
   * Validate BOS trade with ATR expansion and cooldown checks
   * @param {string} symbol - Trading symbol
   * @param {string} action - 'BUY' or 'SELL'
   * @param {Array} candles - Array of candle objects {high, low, close, timestamp}
   * @param {Object} alertData - Alert metadata (may contain atr_slope, bos_count, etc.)
   * @returns {{allowed: boolean, reason: string|null, metrics: Object}}
   */
  validateBOSTrade(symbol, action, candles = [], alertData = {}) {
    if (!this.enabled) {
      return {
        allowed: true,
        reason: null,
        metrics: {
          filterEnabled: false
        }
      };
    }

    const direction = action.toUpperCase();
    const metrics = {
      filterEnabled: true,
      atrExpansion: null,
      atrSlope: null,
      bosCount: null,
      barsSinceCHOCH: null,
      cooldownRequired: false
    };

    // Check ATR expansion (if candles provided)
    if (candles && candles.length > 0) {
      // Method 1: ATR > SMA(ATR, 14)
      const atrExpansion = this.calculateATRExpansion(candles, this.atrLookback);
      if (atrExpansion) {
        metrics.atrExpansion = atrExpansion.isExpanding;
        metrics.atrSlope = atrExpansion.slope;
        metrics.currentATR = atrExpansion.currentATR;
        metrics.avgATR = atrExpansion.avgATR;

        if (!atrExpansion.isExpanding) {
          return {
            allowed: false,
            reason: `ATR not expanding: current=${atrExpansion.currentATR.toFixed(4)}, avg=${atrExpansion.avgATR.toFixed(4)}, slope=${(atrExpansion.slope * 100).toFixed(2)}%`,
            metrics
          };
        }
      } else {
        // Fallback: Check if ATR is rising 3 bars in a row
        const isExpanding = this.isATRExpanding(candles);
        metrics.atrExpansion = isExpanding;
        
        if (!isExpanding) {
          return {
            allowed: false,
            reason: 'ATR not expanding (3-bar check failed)',
            metrics
          };
        }
      }
    } else if (alertData.atr_slope !== undefined) {
      // Use ATR slope from alert if provided
      metrics.atrSlope = parseFloat(alertData.atr_slope);
      metrics.atrExpansion = metrics.atrSlope > 0;
      
      if (!metrics.atrExpansion) {
        return {
          allowed: false,
          reason: `ATR not expanding: slope=${metrics.atrSlope.toFixed(4)}`,
          metrics
        };
      }
    } else {
      // No ATR data available - allow but log warning
      console.warn(`⚠️  BOS ATR filter: No ATR data available for ${symbol}, allowing trade`);
    }

    // Check BOS cooldown
    const history = this.getBOSHistory(symbol);
    metrics.bosCount = history.count;
    metrics.bosDirection = history.direction;
    
    if (history.lastCHOCH) {
      metrics.barsSinceCHOCH = this.getBarsSinceTimestamp(history.lastCHOCH, candles);
    }

    const cooldownCheck = this.checkBOSCooldown(symbol, direction, candles);
    metrics.cooldownRequired = cooldownCheck.required;

    if (cooldownCheck.required) {
      return {
        allowed: false,
        reason: cooldownCheck.reason,
        metrics
      };
    }

    // All checks passed
    return {
      allowed: true,
      reason: null,
      metrics
    };
  }

  /**
   * Get filter stats
   * @returns {Object} - Filter statistics
   */
  getStats() {
    return {
      enabled: this.enabled,
      trackedSymbols: this.bosHistory.size,
      atrLookback: this.atrLookback,
      bosCooldownThreshold: this.bosCooldownThreshold,
      minBarsSinceCHOCH: this.minBarsSinceCHOCH,
      atrExpansionThreshold: this.atrExpansionThreshold
    };
  }

  /**
   * Clear BOS history for a symbol (for testing)
   * @param {string} symbol - Trading symbol
   */
  clearHistory(symbol) {
    this.bosHistory.delete(symbol);
  }

  /**
   * Clear all BOS history (for testing)
   */
  clearAllHistory() {
    this.bosHistory.clear();
  }
}

// Singleton instance
const bosATRFilter = new BOSATRFilter();

module.exports = bosATRFilter;

