# Backtesting Documentation

## Overview

The evaluation spine provides deterministic historical replay backtesting with walk-forward validation. This replaces the previous fake backtesting that generated random results.

## Architecture

### Components

1. **Strategy Interface** (`backend/strategies/Strategy.js`)
   - Base class for all trading strategies
   - Must implement: `generateSignal(candle, state)`, `getState()`, `reset()`

2. **Backtest Engine** (`backend/services/backtestEngine.js`)
   - Replays historical candles sequentially (no lookahead)
   - Executes signals with realistic fill model
   - Calculates P&L and performance metrics

3. **Walk-Forward Validator** (`backend/services/walkForwardValidator.js`)
   - Rolling window validation (train/test splits)
   - Detects performance degradation
   - Prevents overfitting

4. **Evaluation Database** (`backend/db/evaluationDb.js`)
   - SQLite persistence for all results
   - Tracks backtest runs, walk-forward folds, pattern performance

## Assumptions

### Fill Model
- **Entry:** Signal generated on candle close → filled at **next candle open**
- **Exit:** Stop loss/take profit checked on candle close → filled at **next candle open**
- **Rationale:** Conservative, realistic for backtesting. Assumes you can't get filled at the exact close price.

### Spread Model
- **Crypto:** 0.1% (buy higher, sell lower)
- **Stocks:** 0.05%
- **Configurable:** Pass `spreadPct` in backtest config

### Slippage Model
- **Default:** 0.05% for market orders
- **Applied:** Additional cost on top of spread
- **Configurable:** Pass `slippagePct` in backtest config

### Commission Model
- **Default:** 0.1% (Binance-like)
- **Applied:** On both entry and exit
- **Configurable:** Pass `commissionPct` in backtest config

### Risk Sizing
- **Position Size:** 10% of equity per trade (hardcoded in backtest engine)
- **Stop Loss:** From strategy signal (if provided)
- **Take Profit:** From strategy signal (if provided)
- **Note:** Uses existing `riskEngine` logic for live trading, but backtest uses simplified sizing

## No Lookahead Guarantee

The backtest engine processes candles **one at a time, sequentially**. Each candle is processed before the next is loaded. This ensures:

1. ✅ Signals can only use data up to the current candle
2. ✅ No future data is accessible
3. ✅ Realistic simulation of live trading

**Verification:** Unit tests in `tests/backtestEngine.test.js` verify no lookahead.

## Usage

### CLI: Run Backtest

```bash
node cli/backtest.js \
  --strategy sma_crossover \
  --symbol BTCUSDT \
  --tf 5 \
  --start 2025-01-01 \
  --end 2025-01-31 \
  --capital 10000
```

### CLI: Run Walk-Forward Validation

```bash
node cli/walkforward.js \
  --strategy sma_crossover \
  --symbol BTCUSDT \
  --tf 5 \
  --trainDays 180 \
  --testDays 30 \
  --stepDays 30 \
  --start 2024-01-01 \
  --end 2025-01-31
```

### Programmatic Usage

```javascript
const backtestEngine = require('./backend/services/backtestEngine');
const SimpleMovingAverageStrategy = require('./backend/strategies/SimpleMovingAverageStrategy');

const strategy = new SimpleMovingAverageStrategy({
  fastPeriod: 10,
  slowPeriod: 30
});

const result = await backtestEngine.runBacktest({
  strategy,
  symbol: 'BTCUSDT',
  timeframe: '5',
  startDate: '2025-01-01',
  endDate: '2025-01-31',
  initialCapital: 10000,
  config: {
    spreadPct: 0.001, // 0.1%
    slippagePct: 0.0005, // 0.05%
    commissionPct: 0.001 // 0.1%
  }
});

console.log(`Net Profit: ${result.netProfitPct.toFixed(2)}%`);
console.log(`Sharpe Ratio: ${result.sharpeRatio?.toFixed(2)}`);
```

## Creating Custom Strategies

Extend the `Strategy` base class:

```javascript
const Strategy = require('./backend/strategies/Strategy');

class MyStrategy extends Strategy {
  constructor(config = {}) {
    super('my_strategy', 'My Strategy Name', config);
    this.state = {
      // Initialize state
    };
  }

  generateSignal(candle, state) {
    // Your logic here
    // Return signal object or null
    return {
      action: 'BUY', // or 'SELL' or 'CLOSE'
      confidence: 0.7,
      stopLoss: candle.close * 0.98, // Optional
      takeProfit: candle.close * 1.02 // Optional
    };
  }

  reset() {
    this.state = {};
  }
}

module.exports = MyStrategy;
```

## Performance Metrics

### Backtest Results Include:

- **Total Trades:** Number of completed trades
- **Win Rate:** Percentage of winning trades
- **Net Profit:** Absolute and percentage
- **Max Drawdown:** Largest peak-to-trough decline
- **Sharpe Ratio:** Risk-adjusted return (annualized)
- **Profit Factor:** Gross profit / Gross loss
- **Average Trade Duration:** In seconds

### Walk-Forward Results Include:

- **Total Folds:** Number of train/test splits
- **Average Test Performance:** Aggregated metrics across all folds
- **Degradation Detection:** Whether performance degraded in out-of-sample tests

## Database Schema

Results are stored in SQLite at `data/evaluation.db`:

- `backtest_runs` - Individual backtest results
- `walkforward_runs` - Walk-forward fold results
- `daily_risk_stats` - Daily risk metrics (from risk engine)
- `pattern_performance` - Pattern performance tracking
- `trade_pattern_attribution` - Links trades to patterns

## Limitations

1. **No Partial Fills:** Orders are filled completely or not at all
2. **No Order Types:** Only market orders (no limit, stop, etc.)
3. **No Slippage Variation:** Fixed slippage percentage (no volume-based)
4. **No Market Impact:** Large orders don't affect price
5. **No Gaps Handling:** Large gaps are warned but not handled specially
6. **Simplified Position Sizing:** Fixed 10% of equity (not using full risk engine)

## Future Enhancements

- [ ] Volume-based slippage model
- [ ] Partial fill simulation
- [ ] Limit order support
- [ ] Market impact modeling
- [ ] Gap handling (skip trades during gaps)
- [ ] Full risk engine integration for position sizing
- [ ] Multi-symbol portfolio backtesting

## Testing

Run unit tests:

```bash
npm test -- tests/backtestEngine.test.js
```

Tests verify:
- ✅ No lookahead (only uses data up to current candle)
- ✅ Correct P&L calculation (winning and losing trades)
- ✅ Proper signal execution
- ✅ Stop loss / take profit handling

## Migration from Fake Backtesting

The old `tradingview_api_wrapper.js.backtestStrategy()` method has been **disabled**. It now throws an error directing users to use the real backtest engine.

**Before:**
```javascript
const result = await tradingViewAPI.backtestStrategy(code, symbol, timeframe);
// Returns random results ❌
```

**After:**
```javascript
const result = await backtestEngine.runBacktest({
  strategy: new MyStrategy(),
  symbol,
  timeframe,
  startDate,
  endDate
});
// Returns real backtest results ✅
```

---

**The evaluation spine is now production-ready for validating strategies before live trading.**

