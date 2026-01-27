-- Evaluation Database Schema
-- SQLite schema for backtesting, walk-forward validation, and pattern performance

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
    config_json TEXT,
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
    train_performance_json TEXT,
    test_performance_json TEXT,
    degradation_detected INTEGER DEFAULT 0,
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
    profit_factor REAL,
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

