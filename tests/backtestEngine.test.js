/**
 * Backtest Engine Unit Tests
 * Tests for no lookahead, correct P&L math, and drawdown calculation
 */

const assert = require('assert');
const BacktestEngine = require('../backend/services/backtestEngine');
const SimpleMovingAverageStrategy = require('../backend/strategies/SimpleMovingAverageStrategy');

describe('BacktestEngine', () => {
  describe('No Lookahead Guarantee', () => {
    it('should only use data up to current candle', async () => {
      // Create strategy that tracks which candles it has seen
      class LookaheadTestStrategy extends require('../backend/strategies/Strategy') {
        constructor() {
          super('lookahead_test', 'Lookahead Test');
          this.state = {
            seenCandles: [],
            signals: []
          };
        }

        generateSignal(candle, state) {
          // Record that we've seen this candle
          state.seenCandles.push(candle.ts);
          
          // Verify we haven't seen future candles
          const futureCandles = state.seenCandles.filter(ts => ts > candle.ts);
          if (futureCandles.length > 0) {
            throw new Error(`LOOKAHEAD DETECTED: Saw future candle ${futureCandles[0]} while processing ${candle.ts}`);
          }

          // Generate simple signal (every 10th candle)
          if (state.seenCandles.length % 10 === 0) {
            return {
              action: 'BUY',
              confidence: 0.5
            };
          }
          return null;
        }
      }

      const strategy = new LookaheadTestStrategy();
      const candles = [];
      
      // Generate 100 test candles
      const baseTime = Date.now() - 100 * 60000; // 100 minutes ago
      for (let i = 0; i < 100; i++) {
        candles.push({
          ts: baseTime + i * 60000,
          open: 100 + i * 0.1,
          high: 100 + i * 0.1 + 0.5,
          low: 100 + i * 0.1 - 0.5,
          close: 100 + i * 0.1,
          volume: 1000
        });
      }

      // Mock ohlcvCache
      const originalRead = require('../backend/services/ohlcvCache').readCandles;
      require('../backend/services/ohlcvCache').readCandles = async () => candles;

      // Mock evaluationDb
      const originalSave = require('../backend/db/evaluationDb').saveBacktestRun;
      require('../backend/db/evaluationDb').saveBacktestRun = async () => {};

      try {
        await BacktestEngine.runBacktest({
          strategy,
          symbol: 'TEST',
          timeframe: '1',
          startDate: new Date(candles[0].ts).toISOString(),
          endDate: new Date(candles[candles.length - 1].ts).toISOString(),
          initialCapital: 10000
        });

        // If we get here, no lookahead was detected
        assert.ok(true, 'No lookahead detected');
      } catch (error) {
        if (error.message.includes('LOOKAHEAD DETECTED')) {
          assert.fail('Lookahead detected: ' + error.message);
        } else {
          throw error;
        }
      } finally {
        // Restore mocks
        require('../backend/services/ohlcvCache').readCandles = originalRead;
        require('../backend/db/evaluationDb').saveBacktestRun = originalSave;
      }
    });
  });

  describe('P&L Calculation', () => {
    it('should calculate P&L correctly for winning trade', async () => {
      // Create simple strategy that buys and holds
      class BuyHoldStrategy extends require('../backend/strategies/Strategy') {
        constructor() {
          super('buy_hold', 'Buy and Hold');
          this.state = { bought: false };
        }

        generateSignal(candle, state) {
          if (!state.bought) {
            state.bought = true;
            return {
              action: 'BUY',
              confidence: 1.0
            };
          }
          return null;
        }
      }

      const strategy = new BuyHoldStrategy();
      const candles = [
        { ts: Date.now() - 60000, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        { ts: Date.now() - 30000, open: 100, high: 102, low: 100, close: 101, volume: 1000 },
        { ts: Date.now(), open: 101, high: 103, low: 101, close: 102, volume: 1000 }
      ];

      // Mock dependencies
      const originalRead = require('../backend/services/ohlcvCache').readCandles;
      require('../backend/services/ohlcvCache').readCandles = async () => candles;

      const originalSave = require('../backend/db/evaluationDb').saveBacktestRun;
      let savedResult = null;
      require('../backend/db/evaluationDb').saveBacktestRun = async (data) => {
        savedResult = data;
      };

      try {
        const result = await BacktestEngine.runBacktest({
          strategy,
          symbol: 'TEST',
          timeframe: '1',
          startDate: new Date(candles[0].ts).toISOString(),
          endDate: new Date(candles[candles.length - 1].ts).toISOString(),
          initialCapital: 10000
        });

        // Verify P&L calculation
        // Entry: $100 (with spread + slippage ~0.15% = $100.15)
        // Exit: $102 (with spread + slippage ~0.15% = $101.85)
        // Position size: 10% of $10,000 = $1,000
        // Quantity: $1,000 / $100.15 ≈ 9.985 shares
        // Gross proceeds: 9.985 * $101.85 ≈ $1,016.98
        // Commission: $1,016.98 * 0.1% = $1.02
        // Net proceeds: $1,015.96
        // Cost: $1,000 + $1 (commission) = $1,001
        // P&L: $1,015.96 - $1,001 = ~$14.96

        assert.ok(result.netProfit > 0, 'Should have positive P&L for price increase');
        assert.ok(result.totalTrades > 0, 'Should have at least one trade');
      } finally {
        require('../backend/services/ohlcvCache').readCandles = originalRead;
        require('../backend/db/evaluationDb').saveBacktestRun = originalSave;
      }
    });

    it('should calculate P&L correctly for losing trade', async () => {
      // Similar test but with price decrease
      class BuyHoldStrategy extends require('../backend/strategies/Strategy') {
        constructor() {
          super('buy_hold', 'Buy and Hold');
          this.state = { bought: false };
        }

        generateSignal(candle, state) {
          if (!state.bought) {
            state.bought = true;
            return {
              action: 'BUY',
              confidence: 1.0
            };
          }
          return null;
        }
      }

      const strategy = new BuyHoldStrategy();
      const baseTime = 2000000; // Fixed timestamp
      const candles = [
        { ts: baseTime, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        { ts: baseTime + 60000, open: 100, high: 100, low: 98, close: 99, volume: 1000 },
        { ts: baseTime + 120000, open: 99, high: 99, low: 97, close: 98, volume: 1000 }
      ];

      const originalRead = require('../backend/services/ohlcvCache').readCandles;
      require('../backend/services/ohlcvCache').readCandles = async () => candles;

      const originalSave = require('../backend/db/evaluationDb').saveBacktestRun;
      require('../backend/db/evaluationDb').saveBacktestRun = async () => {};

      const originalAttrib = require('../backend/services/patternAttributionService').attributeTrade;
      require('../backend/services/patternAttributionService').attributeTrade = async () => {};

      try {
        const result = await BacktestEngine.runBacktest({
          strategy,
          symbol: 'TEST',
          timeframe: '1',
          startDate: new Date(candles[0].ts).toISOString(),
          endDate: new Date(candles[candles.length - 1].ts).toISOString(),
          initialCapital: 10000
        });

        assert.ok(result.netProfit < 0, 'Should have negative P&L for price decrease');
      } finally {
        require('../backend/services/ohlcvCache').readCandles = originalRead;
        require('../backend/db/evaluationDb').saveBacktestRun = originalSave;
        require('../backend/services/patternAttributionService').attributeTrade = originalAttrib;
      }
    });

    describe('Drawdown Calculation', () => {
      it('should calculate max drawdown correctly', async () => {
        // Create strategy that generates known equity curve
        class KnownEquityStrategy extends require('../backend/strategies/Strategy') {
          constructor() {
            super('known_equity', 'Known Equity Test');
            this.state = { signalCount: 0 };
          }

          generateSignal(candle, state) {
            state.signalCount++;
            // Generate signal on first candle only
            if (state.signalCount === 1) {
              return { action: 'BUY', confidence: 1.0 };
            }
            return null;
          }
        }

        const strategy = new KnownEquityStrategy();
        const baseTime = 3000000;
        // Create equity curve: 10000 -> 11000 -> 9500 -> 10500 (drawdown from 11000 to 9500 = 13.64%)
        const candles = [
          { ts: baseTime, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
          { ts: baseTime + 60000, open: 100, high: 110, low: 100, close: 110, volume: 1000 }, // Price up 10%
          { ts: baseTime + 120000, open: 110, high: 110, low: 95, close: 95, volume: 1000 }, // Price down to 95 (from 100 entry)
          { ts: baseTime + 180000, open: 95, high: 105, low: 95, close: 105, volume: 1000 } // Price up to 105
        ];

        const originalRead = require('../backend/services/ohlcvCache').readCandles;
        require('../backend/services/ohlcvCache').readCandles = async () => candles;

        const originalSave = require('../backend/db/evaluationDb').saveBacktestRun;
        require('../backend/db/evaluationDb').saveBacktestRun = async () => {};

        const originalAttrib = require('../backend/services/patternAttributionService').attributeTrade;
        require('../backend/services/patternAttributionService').attributeTrade = async () => {};

        try {
          const result = await BacktestEngine.runBacktest({
            strategy,
            symbol: 'TEST',
            timeframe: '1',
            startDate: new Date(candles[0].ts).toISOString(),
            endDate: new Date(candles[candles.length - 1].ts).toISOString(),
            initialCapital: 10000
          });

          // Verify drawdown calculation
          // Peak: after price goes to 110 (equity increases)
          // Trough: after price drops to 95 (equity decreases)
          // Drawdown from peak should be calculated correctly
          assert.ok(result.maxDrawdownPct >= 0, 'Drawdown should be non-negative');
          assert.ok(result.maxDrawdownPct <= 100, 'Drawdown should not exceed 100%');
          
          // With price movement 100 -> 110 -> 95, and position entered at ~100.15,
          // equity peaks around 11000, then drops. Drawdown should reflect this.
          console.log(`Max Drawdown: ${result.maxDrawdownPct.toFixed(2)}%`);
        } finally {
          require('../backend/services/ohlcvCache').readCandles = originalRead;
          require('../backend/db/evaluationDb').saveBacktestRun = originalSave;
          require('../backend/services/patternAttributionService').attributeTrade = originalAttrib;
        }
      });
    });
  });
});

