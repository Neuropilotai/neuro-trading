# Evaluation Spine Implementation Plan

## A) Updated Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    TradingView Platform                      │
│  (Pine Script Strategies → Webhook Alerts)                 │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              simple_webhook_server.js                        │
│  (Live Trading Execution)                                    │
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              EVALUATION SPINE (NEW)                          │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │         Strategy Interface (Plugin)                │    │
│  │  - generateSignal(candle, state) -> signal        │    │
│  │  - getState() -> state                            │    │
│  │  - reset()                                         │    │
│  └────────────────────────────────────────────────────┘    │
│                       │                                      │
│                       ▼                                      │
│  ┌────────────────────────────────────────────────────┐    │
│  │         BacktestEngine                             │    │
│  │  - Replay historical candles                       │    │
│  │  - Execute strategy signals                        │    │
│  │  - Track P&L, trades, metrics                      │    │
│  │  - No lookahead guarantee                          │    │
│  └────────────────────────────────────────────────────┘    │
│                       │                                      │
│                       ▼                                      │
│  ┌────────────────────────────────────────────────────┐    │
│  │         WalkForwardValidator                       │    │
│  │  - Rolling train/test windows                      │    │
│  │  - Out-of-sample validation                        │    │
│  │  - Performance degradation detection               │    │
│  └────────────────────────────────────────────────────┘    │
│                       │                                      │
│                       ▼                                      │
│  ┌────────────────────────────────────────────────────┐    │
│  │         EvaluationDatabase (SQLite)                 │    │
│  │  - backtest_runs                                   │    │
│  │  - walkforward_runs                                │    │
│  │  - daily_risk_stats                                │    │
│  │  - pattern_performance                             │    │
│  │  - trade_pattern_attribution                       │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              OHLCV Cache + Providers                         │
│  (Historical Data Source)                                    │
└─────────────────────────────────────────────────────────────┘
```

## B) Database Schema (SQL)

```sql
-- Evaluation Database Schema
-- File: backend/db/evaluationSchema.sql

-- Backtest runs
CREATE TABLE IF NOT EXISTS backtest_runs (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    initial_capital REAL NOT NULL,
    final_capital REAL NOT NULL,
    total_trades INTEGER NOT NULL,
    winning_trades INTEGER NOT NULL,
    losing_trades INTEGER NOT NULL,
    win_rate REAL NOT NULL,
    net_profit REAL NOT NULL,
    net_profit_pct REAL NOT NULL,
    max_drawdown REAL NOT NULL,
    max_drawdown_pct REAL NOT NULL,
    sharpe_ratio REAL,
    profit_factor REAL,
    avg_trade_duration_seconds INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    config_json TEXT, -- JSON config used for backtest
    notes TEXT
);

-- Walk-forward runs
CREATE TABLE IF NOT EXISTS walkforward_runs (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    train_start_date TEXT NOT NULL,
    train_end_date TEXT NOT NULL,
    test_start_date TEXT NOT NULL,
    test_end_date TEXT NOT NULL,
    step_days INTEGER NOT NULL,
    fold_number INTEGER NOT NULL,
    train_performance_json TEXT, -- JSON with train metrics
    test_performance_json TEXT, -- JSON with test metrics
    degradation_detected INTEGER DEFAULT 0, -- 0 or 1
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Daily risk stats (from risk engine)
CREATE TABLE IF NOT EXISTS daily_risk_stats (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,
    account_balance REAL NOT NULL,
    daily_pnl REAL NOT NULL,
    daily_pnl_pct REAL NOT NULL,
    trade_count INTEGER NOT NULL,
    open_positions_count INTEGER NOT NULL,
    max_drawdown_pct REAL NOT NULL,
    risk_limit_breaches INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pattern performance tracking
CREATE TABLE IF NOT EXISTS pattern_performance (
    id TEXT PRIMARY KEY,
    pattern_id TEXT NOT NULL,
    pattern_type TEXT NOT NULL,
    symbol TEXT,
    timeframe TEXT,
    total_trades INTEGER NOT NULL DEFAULT 0,
    winning_trades INTEGER NOT NULL DEFAULT 0,
    losing_trades INTEGER NOT NULL DEFAULT 0,
    win_rate REAL,
    avg_return_pct REAL,
    total_return_pct REAL,
    sharpe_ratio REAL,
    last_trade_date TEXT,
    first_seen_date TEXT NOT NULL,
    last_updated TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(pattern_id)
);

-- Trade-to-pattern attribution
CREATE TABLE IF NOT EXISTS trade_pattern_attribution (
    id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    pattern_id TEXT NOT NULL,
    pattern_confidence REAL,
    trade_pnl REAL,
    trade_pnl_pct REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (pattern_id) REFERENCES pattern_performance(pattern_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_backtest_strategy ON backtest_runs(strategy_id, symbol, timeframe);
CREATE INDEX IF NOT EXISTS idx_walkforward_strategy ON walkforward_runs(strategy_id, symbol, timeframe);
CREATE INDEX IF NOT EXISTS idx_daily_risk_date ON daily_risk_stats(date);
CREATE INDEX IF NOT EXISTS idx_pattern_perf_type ON pattern_performance(pattern_type);
CREATE INDEX IF NOT EXISTS idx_trade_attribution_trade ON trade_pattern_attribution(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_attribution_pattern ON trade_pattern_attribution(pattern_id);
```

## C) Implementation Plan (Ordered Tasks)

### Phase 1: Foundation (Remove Fake, Create Interface)
1. ✅ Remove fake backtesting from `tradingview_api_wrapper.js`
2. ✅ Create Strategy interface (`backend/strategies/Strategy.js`)
3. ✅ Create example strategy (`backend/strategies/SimpleMovingAverageStrategy.js`)
4. ✅ Create evaluation database module (`backend/db/evaluationDb.js`)

### Phase 2: Backtest Engine
5. ✅ Create BacktestEngine (`backend/services/backtestEngine.js`)
6. ✅ Implement historical replay (no lookahead)
7. ✅ Implement fill model (next candle open)
8. ✅ Implement P&L calculation
9. ✅ Add metrics calculation (Sharpe, drawdown, etc.)

### Phase 3: Walk-Forward Validator
10. ✅ Create WalkForwardValidator (`backend/services/walkForwardValidator.js`)
11. ✅ Implement rolling window logic
12. ✅ Implement degradation detection

### Phase 4: Pattern Attribution
13. ✅ Create PatternAttributionService (`backend/services/patternAttributionService.js`)
14. ✅ Link trades to patterns
15. ✅ Update pattern performance stats

### Phase 5: CLI & Integration
16. ✅ Create CLI commands (`cli/backtest.js`, `cli/walkforward.js`)
17. ✅ Integrate with risk engine for daily stats
18. ✅ Add API endpoints for querying results

### Phase 6: Testing
19. ✅ Unit tests for no lookahead
20. ✅ Unit tests for P&L math
21. ✅ Integration tests for backtest engine

### Phase 7: Documentation
22. ✅ Document assumptions (fill model, spread, slippage)
23. ✅ Document strategy interface
24. ✅ Document CLI usage

---

## Implementation Assumptions

### Fill Model
- **Entry:** Signal generated on candle close → filled at next candle open
- **Exit:** Stop loss/take profit checked on candle close → filled at next candle open
- **Rationale:** Conservative, realistic for backtesting

### Spread/Slippage Model
- **Spread:** 0.1% for crypto, 0.05% for stocks (configurable)
- **Slippage:** 0.05% for market orders (configurable)
- **Rationale:** Conservative estimates for paper trading

### Risk Sizing
- Uses existing `riskEngine` logic
- Position size: `min(maxPositionSizePercent, accountBalance * riskPercent)`
- Stop loss enforced: 2% default (from riskCheck middleware)

### Data Requirements
- Minimum 100 candles for backtest
- Candles must be sorted by timestamp (ascending)
- No gaps larger than 3x timeframe (warns but continues)

---

## File Structure

```
backend/
├── strategies/
│   ├── Strategy.js (interface)
│   └── SimpleMovingAverageStrategy.js (example)
├── services/
│   ├── backtestEngine.js (NEW)
│   ├── walkForwardValidator.js (NEW)
│   └── patternAttributionService.js (NEW)
├── db/
│   ├── evaluationDb.js (NEW)
│   └── evaluationSchema.sql (NEW)
cli/
├── backtest.js (NEW)
└── walkforward.js (NEW)
tests/
├── backtestEngine.test.js (NEW)
└── walkforward.test.js (NEW)
```

---

**Ready to implement. Proceeding with code...**

