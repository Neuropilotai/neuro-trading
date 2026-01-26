/**
 * Strategy Interface
 * Base class for all trading strategies
 * 
 * All strategies must implement:
 * - generateSignal(candle, state) -> signal object
 * - getState() -> current strategy state
 * - reset() -> reset strategy to initial state
 */

class Strategy {
  constructor(id, name, config = {}) {
    this.id = id;
    this.name = name;
    this.config = config;
    this.state = {};
  }

  /**
   * Generate trading signal from current candle
   * @param {object} candle - Current OHLCV candle {ts, open, high, low, close, volume}
   * @param {object} state - Strategy state (can be modified)
   * @returns {object|null} - Signal object or null
   * 
   * Signal format:
   * {
   *   action: 'BUY' | 'SELL' | 'CLOSE' | null,
   *   confidence: 0.0-1.0,
   *   stopLoss: price (optional),
   *   takeProfit: price (optional),
   *   metadata: {} (optional)
   * }
   */
  generateSignal(candle, state) {
    throw new Error('Strategy.generateSignal() must be implemented');
  }

  /**
   * Get current strategy state
   * @returns {object} - Strategy state
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Reset strategy to initial state
   */
  reset() {
    this.state = {};
  }

  /**
   * Get strategy configuration
   * @returns {object} - Strategy config
   */
  getConfig() {
    return { ...this.config };
  }

  /**
   * Validate signal (optional override)
   * @param {object} signal - Generated signal
   * @returns {boolean} - True if signal is valid
   */
  validateSignal(signal) {
    if (!signal) return false;
    if (!signal.action) return false;
    if (signal.action !== 'BUY' && signal.action !== 'SELL' && signal.action !== 'CLOSE') {
      return false;
    }
    if (signal.confidence === undefined || signal.confidence < 0 || signal.confidence > 1) {
      return false;
    }
    return true;
  }
}

module.exports = Strategy;

