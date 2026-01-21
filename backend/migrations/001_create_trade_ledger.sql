-- Immutable Trade Ledger Migration
-- Creates append-only trade ledger table
-- Feature Flag: ENABLE_TRADE_LEDGER

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT UNIQUE NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  confidence REAL,
  account_balance REAL,
  pnl REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  alert_id TEXT,
  alert_timestamp INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT,
  filled_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_idempotency_key ON trades(idempotency_key);


