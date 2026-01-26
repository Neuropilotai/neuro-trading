/**
 * Simple Moving Average Crossover Strategy
 * Example strategy implementation
 * 
 * Entry: Fast MA crosses above Slow MA (golden cross)
 * Exit: Fast MA crosses below Slow MA (death cross) or stop loss
 */

const Strategy = require('./Strategy');

class SimpleMovingAverageStrategy extends Strategy {
  constructor(config = {}) {
    super(
      'sma_crossover',
      'Simple Moving Average Crossover',
      {
        fastPeriod: config.fastPeriod || 10,
        slowPeriod: config.slowPeriod || 30,
        stopLossPct: config.stopLossPct || 0.02, // 2%
        takeProfitPct: config.takeProfitPct || 0.04, // 4%
        ...config
      }
    );

    this.state = {
      fastMA: [],
      slowMA: [],
      position: null, // {action: 'BUY'|'SELL', entryPrice, entryTime, stopLoss, takeProfit}
      lastSignal: null
    };
  }

  /**
   * Calculate moving average
   */
  calculateMA(prices, period) {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    return slice.reduce((sum, p) => sum + p, 0) / period;
  }

  /**
   * Generate signal
   */
  generateSignal(candle, state) {
    const { close } = candle;
    
    // Update price history
    if (!state.priceHistory) state.priceHistory = [];
    state.priceHistory.push(close);
    
    // Keep only last N prices (slowPeriod + 10 for safety)
    const maxHistory = this.config.slowPeriod + 10;
    if (state.priceHistory.length > maxHistory) {
      state.priceHistory = state.priceHistory.slice(-maxHistory);
    }

    // Calculate MAs
    const fastMA = this.calculateMA(state.priceHistory, this.config.fastPeriod);
    const slowMA = this.calculateMA(state.priceHistory, this.config.slowPeriod);

    if (!fastMA || !slowMA) {
      // Not enough data yet
      return null;
    }

    // Update MA arrays for crossover detection
    if (!state.fastMA) state.fastMA = [];
    if (!state.slowMA) state.slowMA = [];
    
    state.fastMA.push(fastMA);
    state.slowMA.push(slowMA);
    
    // Keep only last 2 for crossover detection
    if (state.fastMA.length > 2) state.fastMA = state.fastMA.slice(-2);
    if (state.slowMA.length > 2) state.slowMA = state.slowMA.slice(-2);

    // Detect crossovers
    let signal = null;

    if (state.fastMA.length === 2 && state.slowMA.length === 2) {
      const fastPrev = state.fastMA[0];
      const fastCurr = state.fastMA[1];
      const slowPrev = state.slowMA[0];
      const slowCurr = state.slowMA[1];

      // Golden cross: Fast MA crosses above Slow MA
      if (fastPrev <= slowPrev && fastCurr > slowCurr) {
        // Close existing position if any
        if (state.position) {
          signal = {
            action: 'CLOSE',
            confidence: 0.8,
            reason: 'Golden cross detected, closing existing position'
          };
          state.position = null;
        } else {
          // Open long position
          signal = {
            action: 'BUY',
            confidence: 0.7,
            stopLoss: close * (1 - this.config.stopLossPct),
            takeProfit: close * (1 + this.config.takeProfitPct),
            metadata: {
              fastMA,
              slowMA,
              reason: 'Golden cross'
            }
          };
          state.position = {
            action: 'BUY',
            entryPrice: close,
            entryTime: candle.ts,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit
          };
        }
      }
      // Death cross: Fast MA crosses below Slow MA
      else if (fastPrev >= slowPrev && fastCurr < slowCurr) {
        // Close existing position if any
        if (state.position) {
          signal = {
            action: 'CLOSE',
            confidence: 0.8,
            reason: 'Death cross detected, closing existing position'
          };
          state.position = null;
        }
      }
    }

    // Check stop loss / take profit if in position
    if (state.position && !signal) {
      if (candle.low <= state.position.stopLoss) {
        signal = {
          action: 'CLOSE',
          confidence: 1.0,
          reason: 'Stop loss hit'
        };
        state.position = null;
      } else if (candle.high >= state.position.takeProfit) {
        signal = {
          action: 'CLOSE',
          confidence: 1.0,
          reason: 'Take profit hit'
        };
        state.position = null;
      }
    }

    if (signal) {
      state.lastSignal = { ...signal, timestamp: candle.ts };
    }

    return signal;
  }

  /**
   * Reset strategy
   */
  reset() {
    this.state = {
      fastMA: [],
      slowMA: [],
      position: null,
      lastSignal: null,
      priceHistory: []
    };
  }
}

module.exports = SimpleMovingAverageStrategy;

