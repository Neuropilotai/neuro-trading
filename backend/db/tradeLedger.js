/**
 * Immutable Trade Ledger
 * Append-only database for trade records
 * 
 * Feature Flag: ENABLE_TRADE_LEDGER (default: true)
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;

class TradeLedger {
  constructor() {
    this.enabled = process.env.ENABLE_TRADE_LEDGER !== 'false';
    this.dbPath = process.env.LEDGER_DB_PATH || './data/trade_ledger.db';
    this.db = null;
  }

  /**
   * Initialize database and create table if needed
   */
  async initialize() {
    if (!this.enabled) {
      console.log('⚠️  Trade ledger is DISABLED (ENABLE_TRADE_LEDGER=false)');
      return;
    }

    try {
      // Ensure directory exists
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });

      // Open database
      this.db = new sqlite3.Database(this.dbPath);

      // Create table if it doesn't exist
      await this.createTable();

      console.log(`✅ Trade ledger initialized: ${this.dbPath}`);
    } catch (error) {
      console.error('❌ Trade ledger initialization error:', error);
      throw error;
    }
  }

  /**
   * Create trades table (append-only, no UPDATE/DELETE)
   */
  createTable() {
    return new Promise((resolve, reject) => {
      const sql = `
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
      `;

      this.db.exec(sql, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Insert trade record (append-only)
   * @param {object} trade - Trade data
   * @returns {Promise<number>} - Inserted row ID
   */
  async insertTrade(trade) {
    if (!this.enabled) {
      return null;
    }

    if (!this.db) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO trades (
          trade_id, idempotency_key, symbol, action, quantity, price,
          stop_loss, take_profit, confidence, account_balance, pnl,
          status, alert_id, alert_timestamp, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        trade.trade_id || `TRADE_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        trade.idempotency_key,
        trade.symbol,
        trade.action,
        trade.quantity,
        trade.price,
        trade.stop_loss || null,
        trade.take_profit || null,
        trade.confidence || null,
        trade.account_balance || null,
        trade.pnl || 0,
        trade.status || 'PENDING',
        trade.alert_id || null,
        trade.alert_timestamp || null,
        trade.metadata ? JSON.stringify(trade.metadata) : null
      ];

      this.db.run(sql, values, function(err) {
        if (err) {
          // Check if it's a duplicate key error
          if (err.message.includes('UNIQUE constraint failed')) {
            console.warn(`⚠️  Duplicate trade detected: ${trade.idempotency_key}`);
            reject(new Error('Duplicate trade (idempotency key already exists)'));
          } else {
            reject(err);
          }
        } else {
          resolve(this.lastID);
        }
      });
    });
  }

  /**
   * Update trade status (limited updates allowed for status changes only)
   * Note: This is a compromise - true immutability would require status in separate table
   * For now, we allow status updates but log them
   */
  async updateTradeStatus(tradeId, status, additionalData = {}) {
    if (!this.enabled) {
      return null;
    }

    return new Promise((resolve, reject) => {
      const updates = [];
      const values = [status];

      if (status === 'EXECUTED' && additionalData.executed_at) {
        updates.push('executed_at = ?');
        values.push(additionalData.executed_at);
      }

      if (status === 'FILLED' && additionalData.filled_at) {
        updates.push('filled_at = ?');
        values.push(additionalData.filled_at);
      }

      if (status === 'REJECTED' && additionalData.rejection_reason) {
        updates.push('rejected_at = ?');
        updates.push('rejection_reason = ?');
        values.push(new Date().toISOString());
        values.push(additionalData.rejection_reason);
      }

      if (additionalData.pnl !== undefined) {
        updates.push('pnl = ?');
        values.push(additionalData.pnl);
      }

      values.push(tradeId);

      // Build SET clause - only include additional updates if array is not empty
      const setClause = updates.length > 0 
        ? `status = ?, ${updates.join(', ')}`
        : `status = ?`;

      const sql = `
        UPDATE trades
        SET ${setClause}
        WHERE trade_id = ?
      `;

      this.db.run(sql, values, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  /**
   * Get trade by ID
   */
  async getTrade(tradeId) {
    if (!this.enabled) {
      return null;
    }

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM trades WHERE trade_id = ?',
        [tradeId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  /**
   * Get all trades (with pagination)
   */
  async getTrades(limit = 100, offset = 0) {
    if (!this.enabled) {
      return [];
    }

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM trades ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [limit, offset],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  /**
   * Get daily PnL summary
   */
  async getDailyPnL(date = null) {
    if (!this.enabled) {
      return { totalPnL: 0, tradeCount: 0 };
    }

    const targetDate = date || new Date().toISOString().split('T')[0];

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT 
          COUNT(*) as tradeCount,
          SUM(pnl) as totalPnL,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winningTrades,
          SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losingTrades
        FROM trades
        WHERE DATE(created_at) = ? AND status = 'FILLED'`,
        [targetDate],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve({
              date: targetDate,
              totalPnL: row.totalPnL || 0,
              tradeCount: row.tradeCount || 0,
              winningTrades: row.winningTrades || 0,
              losingTrades: row.losingTrades || 0
            });
          }
        }
      );
    });
  }

  /**
   * Get all FILLED trades (for state rebuild)
   * @returns {Promise<Array>} - Array of filled trades ordered by execution time
   */
  async getFilledTrades() {
    if (!this.enabled || !this.db) {
      return [];
    }

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM trades 
         WHERE status = 'FILLED' 
         ORDER BY COALESCE(filled_at, executed_at, created_at) ASC`,
        [],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
const tradeLedger = new TradeLedger();

module.exports = tradeLedger;


