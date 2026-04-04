/**
 * Evaluation Database
 * SQLite database for backtest results, walk-forward validation, and pattern performance
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;

class EvaluationDatabase {
  constructor() {
    // 1) Explicit path (Railway: EVALUATION_DB_PATH=/data/evaluation.db)
    // 2) Derive from DATA_DIR so evaluation DB lives under /data when DATA_DIR=/data
    // 3) Local dev: project-relative data/evaluation.db
    const dataDir = process.env.DATA_DIR;
    const fallback = dataDir
      ? path.join(dataDir, 'evaluation.db')
      : path.join(__dirname, '../../data/evaluation.db');
    this.dbPath = process.env.EVALUATION_DB_PATH || fallback;
    this.db = null;
  }

  /**
   * Ensure a column exists in a table (idempotent migration)
   * @param {string} table - Table name
   * @param {string} column - Column name
   * @param {string} ddlFragment - DDL fragment (e.g., "INTEGER DEFAULT 1")
   */
  async ensureColumn(table, column, ddlFragment) {
    const cols = await this.allAsync(`PRAGMA table_info(${table})`);
    const exists = cols.some(c => c.name === column);
    if (!exists) {
      await this.runAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlFragment}`);
    }
  }

  /**
   * Ensure an index exists (idempotent - SQLite supports IF NOT EXISTS)
   * @param {string} name - Index name
   * @param {string} sql - CREATE INDEX SQL statement
   */
  async ensureIndex(name, sql) {
    try {
      await this.runAsync(sql); // CREATE INDEX IF NOT EXISTS is safe in SQLite
    } catch (err) {
      // If index creation fails because column doesn't exist yet, that's ok
      // The migration will create the column first, then retry the index
      if (err.message && err.message.includes('no such column')) {
        // Column doesn't exist yet - migration will handle it
        return;
      }
      throw err;
    }
  }

  /**
   * Ensure a table exists (idempotent - SQLite supports IF NOT EXISTS)
   * @param {string} tableName - Table name
   * @param {string} createSql - CREATE TABLE SQL statement
   */
  async ensureTable(tableName, createSql) {
    try {
      // Check if table exists
      const tableInfo = await this.allAsync(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        [tableName]
      );
      
      if (tableInfo.length === 0) {
        // Table doesn't exist, create it
        await this.runAsync(createSql);
        console.log(`✅ Created table: ${tableName}`);
      }
    } catch (err) {
      // If table already exists, that's ok (idempotent)
      if (err.message && err.message.includes('already exists')) {
        return;
      }
      throw err;
    }
  }

  /**
   * Initialize database (create if doesn't exist, run schema)
   * Idempotent: early-returns if already initialized
   */
  async initialize() {
    // Early return if already initialized (prevents re-opening/re-migrating)
    if (this.db) return;
    
    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    await fs.mkdir(dataDir, { recursive: true });

    // Open database
    this.db = new sqlite3.Database(this.dbPath, (err) => {
      if (err) {
        console.error('❌ Error opening evaluation database:', err.message);
        throw err;
      }
    });

    // SQLite hardening: WAL mode + busy_timeout to prevent hangs
    await this.runAsync('PRAGMA journal_mode=WAL;');
    await this.runAsync('PRAGMA synchronous=NORMAL;');
    await this.runAsync('PRAGMA busy_timeout=5000;');

    // Run schema
    const schemaPath = path.join(__dirname, 'evaluationSchema.sql');
    const schema = await fs.readFile(schemaPath, 'utf8');
    
    return new Promise(async (resolve, reject) => {
      // Execute schema - may fail on index creation for existing DBs, that's ok
      this.db.exec(schema, async (schemaErr) => {
        // Schema errors are ok if they're about missing columns (for existing DBs)
        // The migration will handle creating columns and indexes
        
        try {
          // Add profit_factor column if it doesn't exist (migration)
          await this.ensureColumn('pattern_performance', 'profit_factor', 'REAL');
          
          // Add legacy_pattern_id columns if they don't exist (migration)
          await this.ensureColumn('pattern_performance', 'legacy_pattern_id', 'TEXT');
          await this.ensureColumn('trade_pattern_attribution', 'legacy_pattern_id', 'TEXT');

          // Migration: Convert PATTERN_BT_ to canonical PATTERN_ format
          // This migration is idempotent (safe to run multiple times)
          try {
            // Step 1: Fill legacy_pattern_id if empty and pattern_id starts with PATTERN_BT_
            const fillLegacyResult = await this.runAsync(`
              UPDATE pattern_performance
              SET legacy_pattern_id = pattern_id
              WHERE legacy_pattern_id IS NULL
                AND pattern_id LIKE 'PATTERN_BT_%'
            `);
            
            // Step 2: Convert pattern_id from PATTERN_BT_ to PATTERN_ (canonical format)
            const convertResult = await this.runAsync(`
              UPDATE pattern_performance
              SET pattern_id = REPLACE(pattern_id, 'PATTERN_BT_', 'PATTERN_')
              WHERE pattern_id LIKE 'PATTERN_BT_%'
            `);
            
            // Also update the id column to match (id = 'pattern_' + pattern_id)
            await this.runAsync(`
              UPDATE pattern_performance
              SET id = 'pattern_' || pattern_id
              WHERE pattern_id LIKE 'PATTERN_%'
                AND id NOT LIKE 'pattern_PATTERN_%'
            `);
            
            // Step 3: Also migrate trade_pattern_attribution table
            // First fill legacy_pattern_id if empty
            await this.runAsync(`
              UPDATE trade_pattern_attribution
              SET legacy_pattern_id = pattern_id
              WHERE legacy_pattern_id IS NULL
                AND pattern_id LIKE 'PATTERN_BT_%'
            `);
            
            // Then convert pattern_id to canonical format
            const convertAttributionResult = await this.runAsync(`
              UPDATE trade_pattern_attribution
              SET pattern_id = REPLACE(pattern_id, 'PATTERN_BT_', 'PATTERN_')
              WHERE pattern_id LIKE 'PATTERN_BT_%'
            `);
            
            const totalMigrated = (fillLegacyResult.changes || 0) + (convertResult.changes || 0);
            const totalAttributionMigrated = convertAttributionResult.changes || 0;
            if (totalMigrated > 0 || totalAttributionMigrated > 0) {
              console.log(`✅ Migrated ${totalMigrated} pattern IDs in pattern_performance and ${totalAttributionMigrated} in trade_pattern_attribution from PATTERN_BT_ to canonical format`);
            }
          } catch (migrationErr) {
            // Migration errors are non-fatal (might be no rows to migrate)
            if (!migrationErr.message.includes('no such column')) {
              console.warn('⚠️  Pattern ID migration warning:', migrationErr.message);
            }
          }

          // Add pattern aging columns (idempotent) - MUST be done before indexes
          await this.ensureColumn('pattern_performance', 'is_active', 'INTEGER DEFAULT 1');
          await this.ensureColumn('pattern_performance', 'disabled_reason', 'TEXT');
          await this.ensureColumn('pattern_performance', 'disabled_at', 'TEXT');
          await this.ensureColumn('pattern_performance', 'last_trade_at', 'TEXT');
          await this.ensureColumn('pattern_performance', 'last_seen_at', 'TEXT');

          // Phase 1: Pattern backtesting columns
          await this.ensureColumn('pattern_performance', 'source', 'TEXT DEFAULT \'backtest\'');
          await this.ensureColumn('pattern_performance', 'is_validated', 'INTEGER DEFAULT 0');
          await this.ensureColumn('pattern_performance', 'trades_long', 'INTEGER DEFAULT 0');
          await this.ensureColumn('pattern_performance', 'trades_short', 'INTEGER DEFAULT 0');
          // Defensive ALTER for prod DBs created before these columns (ignore ONLY duplicate column errors)
          // B) Safe migration: catch ONLY if "duplicate column name", rethrow otherwise (don't mask real errors)
          await this.runAsync('ALTER TABLE pattern_performance ADD COLUMN trades_long INTEGER DEFAULT 0').catch(e => {
            if (!String(e.message || e).includes('duplicate column name')) throw e;
          });
          await this.runAsync('ALTER TABLE pattern_performance ADD COLUMN trades_short INTEGER DEFAULT 0').catch(e => {
            if (!String(e.message || e).includes('duplicate column name')) throw e;
          });

          // Add indexes for pattern aging (after columns are ensured)
          await this.ensureIndex('idx_pattern_perf_active', `
            CREATE INDEX IF NOT EXISTS idx_pattern_perf_active
            ON pattern_performance(is_active)
          `);
          await this.ensureIndex('idx_pattern_perf_last_trade', `
            CREATE INDEX IF NOT EXISTS idx_pattern_perf_last_trade
            ON pattern_performance(last_trade_at)
          `);
          // Phase 1: Index for validated patterns
          await this.ensureIndex('idx_pattern_perf_validated', `
            CREATE INDEX IF NOT EXISTS idx_pattern_perf_validated
            ON pattern_performance(is_validated, is_active, source)
          `);

          // Phase 2: Pattern Performance History table
          await this.ensureTable('pattern_performance_history', `
            CREATE TABLE IF NOT EXISTS pattern_performance_history (
              id TEXT PRIMARY KEY,
              pattern_id TEXT NOT NULL,
              snapshot_date TEXT NOT NULL,
              total_trades INTEGER NOT NULL,
              winning_trades INTEGER NOT NULL,
              losing_trades INTEGER NOT NULL,
              win_rate REAL,
              profit_factor REAL,
              avg_return_pct REAL,
              total_return_pct REAL,
              sharpe_ratio REAL,
              is_active INTEGER DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY (pattern_id) REFERENCES pattern_performance(pattern_id)
            )
          `);
          await this.ensureIndex('idx_pattern_history_pattern_date', `
            CREATE INDEX IF NOT EXISTS idx_pattern_history_pattern_date
            ON pattern_performance_history(pattern_id, snapshot_date DESC)
          `);
          await this.ensureIndex('idx_pattern_history_date', `
            CREATE INDEX IF NOT EXISTS idx_pattern_history_date
            ON pattern_performance_history(snapshot_date DESC)
          `);

          // Learning Loop MVP: trades_ai ledger (one row per trade + features/regime/params)
          // source: tradingview | oanda_paper | oanda_live (Mix A+B; scoring weight by source)
          await this.ensureTable('trades_ai', `
            CREATE TABLE IF NOT EXISTS trades_ai (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts_open TEXT NOT NULL,
              ts_close TEXT NOT NULL,
              symbol TEXT NOT NULL,
              tf TEXT,
              setup_id TEXT NOT NULL,
              side TEXT NOT NULL,
              entry REAL NOT NULL,
              exit REAL NOT NULL,
              sl REAL,
              tp REAL,
              pnl REAL,
              r_mult REAL,
              regime TEXT,
              features_json TEXT,
              params_json TEXT,
              source TEXT NOT NULL DEFAULT 'oanda_paper',
              batch_id TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
          `);
          await this.ensureColumn('trades_ai', 'batch_id', 'TEXT');
          await this.ensureIndex('idx_trades_ai_setup_id', `
            CREATE INDEX IF NOT EXISTS idx_trades_ai_setup_id ON trades_ai(setup_id)
          `);
          await this.ensureIndex('idx_trades_ai_ts_close', `
            CREATE INDEX IF NOT EXISTS idx_trades_ai_ts_close ON trades_ai(ts_close)
          `);
          await this.ensureIndex('idx_trades_ai_source', `
            CREATE INDEX IF NOT EXISTS idx_trades_ai_source ON trades_ai(source)
          `);

          console.log('✅ Evaluation database initialized');
          resolve();
        } catch (migrationErr) {
          console.error('❌ Error running migrations:', migrationErr.message);
          reject(migrationErr);
        }
      });
    });
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.db) {
      return new Promise((resolve, reject) => {
        this.db.close((err) => {
          if (err) reject(err);
          else {
            this.db = null; // Clear reference to allow re-initialization
            resolve();
          }
        });
      });
    }
  }

  /**
   * Promise-based wrapper for db.run()
   */
  async runAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  /**
   * Promise-based wrapper for db.get()
   */
  async getAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  /**
   * Promise-based wrapper for db.all()
   */
  async allAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Save backtest run
   */
  async saveBacktestRun(backtestData) {
    const query = `
      INSERT INTO backtest_runs (
        id, strategy_id, symbol, timeframe, start_date, end_date,
        initial_capital, final_capital, total_trades, winning_trades, losing_trades,
        win_rate, net_profit, net_profit_pct, max_drawdown, max_drawdown_pct,
        sharpe_ratio, profit_factor, avg_trade_duration_seconds, config_json, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      this.db.run(query, [
        backtestData.id,
        backtestData.strategyId,
        backtestData.symbol,
        backtestData.timeframe,
        backtestData.startDate,
        backtestData.endDate,
        backtestData.initialCapital,
        backtestData.finalCapital,
        backtestData.totalTrades,
        backtestData.winningTrades,
        backtestData.losingTrades,
        backtestData.winRate,
        backtestData.netProfit,
        backtestData.netProfitPct,
        backtestData.maxDrawdown,
        backtestData.maxDrawdownPct,
        backtestData.sharpeRatio || null,
        backtestData.profitFactor || null,
        backtestData.avgTradeDurationSeconds || null,
        backtestData.configJson ? JSON.stringify(backtestData.configJson) : null,
        backtestData.notes || null
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Save walk-forward run
   */
  async saveWalkForwardRun(wfData) {
    const query = `
      INSERT INTO walkforward_runs (
        id, strategy_id, symbol, timeframe,
        train_start_date, train_end_date, test_start_date, test_end_date,
        step_days, fold_number, train_performance_json, test_performance_json,
        degradation_detected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      this.db.run(query, [
        wfData.id,
        wfData.strategyId,
        wfData.symbol,
        wfData.timeframe,
        wfData.trainStartDate,
        wfData.trainEndDate,
        wfData.testStartDate,
        wfData.testEndDate,
        wfData.stepDays,
        wfData.foldNumber,
        JSON.stringify(wfData.trainPerformance),
        JSON.stringify(wfData.testPerformance),
        wfData.degradationDetected ? 1 : 0
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Save daily risk stats
   */
  async saveDailyRiskStats(stats) {
    const query = `
      INSERT OR REPLACE INTO daily_risk_stats (
        id, date, account_balance, daily_pnl, daily_pnl_pct,
        trade_count, open_positions_count, max_drawdown_pct, risk_limit_breaches
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const id = `risk_${stats.date}`;

    return new Promise((resolve, reject) => {
      this.db.run(query, [
        id,
        stats.date,
        stats.accountBalance,
        stats.dailyPnL,
        stats.dailyPnLPct,
        stats.tradeCount,
        stats.openPositionsCount,
        stats.maxDrawdownPct,
        stats.riskLimitBreaches || 0
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Update pattern performance
   * Rule: pattern_id is canonical (from runtime), legacy_pattern_id stores old BT IDs
   */
  async updatePatternPerformance(patternId, performance) {
    // Check if source column exists (for backward compatibility)
    const perfCols = await this.allAsync(`PRAGMA table_info(pattern_performance)`);
    const hasSourceCol = perfCols.some(c => c.name === 'source');
    const hasLegacyCol = perfCols.some(c => c.name === 'legacy_pattern_id');
    const sourceCol = hasSourceCol ? ', source' : '';
    const sourceVal = hasSourceCol ? ', ?' : '';
    const sourceUpdate = hasSourceCol ? ', source = excluded.source' : '';
    const legacyCol = hasLegacyCol ? ', legacy_pattern_id' : '';
    const legacyVal = hasLegacyCol ? ', ?' : '';
    const legacyUpdate = hasLegacyCol ? ', legacy_pattern_id = excluded.legacy_pattern_id' : '';

    // Map camelCase and snake_case to DB columns (callers may send either)
    const winRate = performance.winRate ?? performance.win_rate ?? null;
    const profitFactor = performance.profitFactor ?? performance.profit_factor ?? null;
    const totalTrades = performance.totalTrades ?? performance.total_trades ?? 0;
    const winningTrades = performance.winningTrades ?? performance.winning_trades ?? 0;
    const losingTrades = performance.losingTrades ?? performance.losing_trades ?? 0;
    const avgReturnPct = performance.avgReturnPct ?? performance.avg_return_pct ?? null;
    const totalReturnPct = performance.totalReturnPct ?? performance.total_return_pct ?? null;
    const sharpeRatio = performance.sharpeRatio ?? performance.sharpe_ratio ?? null;

    // Extract canonical ID and legacy ID
    // patternId is always the canonical ID (string)
    // legacyPatternId comes from performance object if provided
    const canonicalId = patternId;
    const legacyId = performance.legacyPatternId || performance.legacy_pattern_id || null;

    const query = `
      INSERT INTO pattern_performance (
        id, pattern_id, pattern_type, symbol, timeframe,
        total_trades, winning_trades, losing_trades, win_rate,
        avg_return_pct, total_return_pct, profit_factor, sharpe_ratio,
        last_trade_date, first_seen_date, last_trade_at, last_seen_at${sourceCol}${legacyCol}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${sourceVal}${legacyVal})
      ON CONFLICT(pattern_id) DO UPDATE SET
        total_trades = excluded.total_trades,
        winning_trades = excluded.winning_trades,
        losing_trades = excluded.losing_trades,
        win_rate = excluded.win_rate,
        avg_return_pct = excluded.avg_return_pct,
        total_return_pct = excluded.total_return_pct,
        profit_factor = COALESCE(excluded.profit_factor, profit_factor),
        sharpe_ratio = excluded.sharpe_ratio,
        last_trade_date = excluded.last_trade_date,
        last_trade_at = COALESCE(excluded.last_trade_at, excluded.last_trade_date, last_trade_at),
        last_seen_at = COALESCE(excluded.last_seen_at, datetime('now')),
        last_updated = datetime('now')${sourceUpdate}${legacyUpdate}
    `;

    const nowIso = new Date().toISOString();
    const lastTradeAt = performance.lastTradeDate || performance.lastTradeAt || null;
    const params = [
      `pattern_${canonicalId}`,
      canonicalId,
      performance.patternType,
      performance.symbol || null,
      performance.timeframe || null,
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      avgReturnPct,
      totalReturnPct,
      profitFactor,
      sharpeRatio,
      performance.lastTradeDate || null,
      performance.firstSeenDate || nowIso,
      lastTradeAt,
      nowIso
    ];
    if (hasSourceCol) {
      params.push(performance.source || 'backtest');
    }
    if (hasLegacyCol) {
      params.push(legacyId);
    }

    return new Promise((resolve, reject) => {
      this.db.run(query, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Save trade-pattern attribution (idempotent)
   */
  async saveTradePatternAttribution(tradeId, patternId, attribution) {
    // Use INSERT OR REPLACE to allow corrections to PnL values
    // This ensures that if the same trade-pattern pair is inserted with different PnL,
    // the new values will replace the old ones instead of being silently ignored
    const query = `
      INSERT OR REPLACE INTO trade_pattern_attribution (
        id, trade_id, pattern_id, pattern_confidence, trade_pnl, trade_pnl_pct
      ) VALUES (?, ?, ?, ?, ?, ?)
    `;

    // Deterministic ID
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(`${tradeId}|${patternId}`).digest('hex');
    const id = `attr_${hash.substring(0, 16)}`;

    return this.runAsync(query, [
      id,
      tradeId,
      patternId,
      attribution.patternConfidence,
      attribution.tradePnL,
      attribution.tradePnLPct
    ]);
  }

  /**
   * Get backtest runs
   */
  async getBacktestRuns(filters = {}) {
    let query = 'SELECT * FROM backtest_runs WHERE 1=1';
    const params = [];

    if (filters.strategyId) {
      query += ' AND strategy_id = ?';
      params.push(filters.strategyId);
    }
    if (filters.symbol) {
      query += ' AND symbol = ?';
      params.push(filters.symbol);
    }
    if (filters.timeframe) {
      query += ' AND timeframe = ?';
      params.push(filters.timeframe);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(filters.limit || 100);

    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Get walk-forward runs
   */
  async getWalkForwardRuns(filters = {}) {
    let query = 'SELECT * FROM walkforward_runs WHERE 1=1';
    const params = [];

    if (filters.strategyId) {
      query += ' AND strategy_id = ?';
      params.push(filters.strategyId);
    }
    if (filters.symbol) {
      query += ' AND symbol = ?';
      params.push(filters.symbol);
    }

    query += ' ORDER BY fold_number ASC';

    return new Promise((resolve, reject) => {
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else {
          // Parse JSON fields
          const parsed = rows.map(row => ({
            ...row,
            trainPerformance: JSON.parse(row.train_performance_json),
            testPerformance: JSON.parse(row.test_performance_json),
            degradationDetected: row.degradation_detected === 1
          }));
          resolve(parsed);
        }
      });
    });
  }

  /**
   * Get pattern performance for given pattern IDs
   * @param {Array<string>} patternIds - Array of pattern IDs
   * @returns {Promise<Map<string, object>>} - Map of patternId -> performance stats
   */
  async getPatternPerformance(patternIds) {
    if (!patternIds || patternIds.length === 0) {
      return new Map();
    }

    // Support both canonical (PATTERN_xxx) and legacy (PATTERN_BT_xxx) formats
    // Lookup by pattern_id OR legacy_pattern_id for backward compatibility
    const placeholders = patternIds.map(() => '?').join(',');
    const query = `
      SELECT 
        pattern_id,
        total_trades,
        winning_trades,
        losing_trades,
        win_rate,
        profit_factor,
        avg_return_pct,
        first_seen_date,
        last_updated
      FROM pattern_performance
      WHERE pattern_id IN (${placeholders})
         OR legacy_pattern_id IN (${placeholders})
    `;

    // Query with patternIds twice (once for pattern_id, once for legacy_pattern_id)
    const rows = await this.allAsync(query, [...patternIds, ...patternIds]);
    
    const result = new Map();
    for (const row of rows) {
      // Always return canonical pattern_id (even if found via legacy_pattern_id)
      result.set(row.pattern_id, {
        patternId: row.pattern_id,
        totalTrades: row.total_trades,
        winningTrades: row.winning_trades,
        losingTrades: row.losing_trades,
        winRate: row.win_rate,
        profitFactor: row.profit_factor,
        avgReturnPct: row.avg_return_pct,
        firstSeenDate: row.first_seen_date,
        lastUpdated: row.last_updated
      });
    }
    
    return result;
  }

  /**
   * Get pattern performance within a rolling window
   * @param {string} patternId - Pattern ID
   * @param {number} windowDays - Number of days for the rolling window
   * @returns {Promise<object>} - Performance stats { total_trades, winning_trades, losing_trades, win_rate, profit_factor, last_trade_at_window }
   */
  async getPatternPerformanceWindow(patternId, windowDays) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    const cutoffIso = cutoffDate.toISOString();

    // Support both canonical (PATTERN_xxx) and legacy (PATTERN_BT_xxx) formats
    // Lookup by pattern_id OR legacy_pattern_id for backward compatibility
    const query = `
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN trade_pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN trade_pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
        MAX(created_at) as last_trade_at_window,
        SUM(CASE WHEN trade_pnl > 0 THEN trade_pnl ELSE 0 END) as gross_profit,
        SUM(CASE WHEN trade_pnl < 0 THEN ABS(trade_pnl) ELSE 0 END) as gross_loss
      FROM trade_pattern_attribution
      WHERE (pattern_id = ? OR legacy_pattern_id = ?)
        AND created_at >= ?
    `;

    const row = await this.getAsync(query, [patternId, patternId, cutoffIso]);

    if (!row || row.total_trades === 0) {
      return {
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        win_rate: 0,
        profit_factor: null,
        last_trade_at_window: null
      };
    }

    const totalTrades = row.total_trades || 0;
    const winningTrades = row.winning_trades || 0;
    const losingTrades = row.losing_trades || 0;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
    
    // Calculate profit_factor
    const grossProfit = row.gross_profit || 0;
    const grossLoss = row.gross_loss || 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0);

    return {
      total_trades: totalTrades,
      winning_trades: winningTrades,
      losing_trades: losingTrades,
      win_rate: winRate,
      profit_factor: profitFactor,
      last_trade_at_window: row.last_trade_at_window || null
    };
  }

  /**
   * Get validated patterns based on performance thresholds
   * Central validation gate - used by all consumers
   * @param {object} config - Filter config { minWinRate, minProfitFactor, minSampleSize, source }
   * @returns {Promise<Array<string>>} - Array of validated pattern IDs
   */
  async getValidatedPatterns(config = {}) {
    const {
      minWinRate = 0.50,
      minProfitFactor = 1.0,
      minSampleSize = 30,
      source = null // null = any source, 'backtest' = backtest only, etc.
    } = config;

    // Check if columns exist (for backward compatibility)
    const cols = await this.allAsync(`PRAGMA table_info(pattern_performance)`);
    const hasIsActive = cols.some(c => c.name === 'is_active');
    const hasIsValidated = cols.some(c => c.name === 'is_validated');
    const hasSource = cols.some(c => c.name === 'source');

    // Build query filters
    const activeFilter = hasIsActive ? 'AND (is_active = 1 OR is_active IS NULL)' : '';
    const validatedFilter = hasIsValidated ? 'AND is_validated = 1' : '';
    const sourceFilter = (hasSource && source) ? 'AND source = ?' : '';
    
    const params = [minSampleSize, minWinRate];
    if (hasSource && source) {
      params.push(source);
    }

    const query = `
      SELECT pattern_id, profit_factor
      FROM pattern_performance
      WHERE total_trades >= ?
        AND win_rate >= ?
        ${activeFilter}
        ${validatedFilter}
        ${sourceFilter}
    `;

    const rows = await this.allAsync(query, params);
    
    // Filter by profit_factor
    // NULL profit_factor means "perfect" (no losses) - should always pass any threshold
    const validated = rows
      .filter(row => {
        const pf = row.profit_factor;
        if (pf === null || pf === undefined) {
          return true; // NULL = perfect (no losses) = infinite profit factor
        }
        return pf >= minProfitFactor;
      })
      .map(row => row.pattern_id);
    
    return validated;
  }

  /**
   * Get validated pattern rows with full metadata needed for canonical ID computation
   * @param {object} options - { activeOnly = true }
   * @returns {Promise<Array<object>>} - Array of rows with pattern_id, pattern_type, symbol, timeframe, legacy_pattern_id
   */
  async getValidatedPatternRows({ activeOnly = true } = {}) {
    const where = [];
    const params = [];

    where.push('is_validated = 1');
    where.push("source = 'backtest'");
    if (activeOnly) where.push('is_active = 1');

    const sql = `
      SELECT pattern_id, pattern_type, symbol, timeframe, legacy_pattern_id
      FROM pattern_performance
      WHERE ${where.join(' AND ')}
      LIMIT 5000
    `;

    return await this.allAsync(sql, params);
  }

  /**
   * Create snapshot of current pattern performance (Phase 2)
   * Called nightly by cron to build historical memory
   * @param {string} date - Snapshot date (ISO format YYYY-MM-DD), defaults to today
   * @returns {Promise<object>} - { snapshotsCreated, snapshotDate }
   */
  async createPatternPerformanceSnapshot(date = null) {
    const snapshotDate = date || new Date().toISOString().split('T')[0];
    
    // Get all active patterns
    const patterns = await this.allAsync(`
      SELECT 
        pattern_id,
        total_trades,
        winning_trades,
        losing_trades,
        win_rate,
        profit_factor,
        avg_return_pct,
        total_return_pct,
        sharpe_ratio,
        is_active
      FROM pattern_performance
      WHERE is_active = 1
    `);

    let snapshotsCreated = 0;
    
    for (const pattern of patterns) {
      const id = `hist_${pattern.pattern_id}_${snapshotDate}`;
      
      // Check if snapshot already exists (idempotent)
      const existing = await this.getAsync(
        'SELECT id FROM pattern_performance_history WHERE id = ?',
        [id]
      );
      
      if (existing) {
        continue; // Already snapshotted today
      }

      await this.runAsync(`
        INSERT INTO pattern_performance_history (
          id, pattern_id, snapshot_date,
          total_trades, winning_trades, losing_trades,
          win_rate, profit_factor, avg_return_pct,
          total_return_pct, sharpe_ratio, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        pattern.pattern_id,
        snapshotDate,
        pattern.total_trades,
        pattern.winning_trades,
        pattern.losing_trades,
        pattern.win_rate,
        pattern.profit_factor,
        pattern.avg_return_pct,
        pattern.total_return_pct,
        pattern.sharpe_ratio,
        pattern.is_active
      ]);
      
      snapshotsCreated++;
    }

    return { snapshotsCreated, snapshotDate };
  }

  /**
   * Normalize source to Mix A+B enum: tradingview | oanda_paper | oanda_live.
   * Legacy: paper -> oanda_paper, live -> oanda_live, backtest -> tradingview.
   */
  static normalizeSource(source) {
    const s = String(source || '').toLowerCase().trim();
    if (s === 'tradingview' || s === 'oanda_paper' || s === 'oanda_live') return s;
    if (s === 'paper') return 'oanda_paper';
    if (s === 'live') return 'oanda_live';
    if (s === 'backtest') return 'tradingview';
    return 'oanda_paper';
  }

  normalizeSource(source) {
    return EvaluationDatabase.normalizeSource(source);
  }

  /**
   * Insert one AI trade record (Learning Loop ledger).
   * @param {object} row - { ts_open, ts_close, symbol, tf, setup_id, side, entry, exit, sl, tp, pnl, r_mult, regime, features_json, params_json, source, batch_id? }
   * @returns {Promise<{ lastID: number }>}
   */
  async insertTradeAi(row) {
    const source = EvaluationDatabase.normalizeSource(row.source);
    const query = `
      INSERT INTO trades_ai (
        ts_open, ts_close, symbol, tf, setup_id, side, entry, exit, sl, tp,
        pnl, r_mult, regime, features_json, params_json, source, batch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      row.ts_open,
      row.ts_close,
      row.symbol,
      row.tf != null && row.tf !== '' ? String(row.tf) : null,
      row.setup_id,
      row.side,
      row.entry,
      row.exit,
      row.sl ?? null,
      row.tp ?? null,
      row.pnl ?? null,
      row.r_mult ?? null,
      row.regime ?? null,
      typeof row.features_json === 'string' ? row.features_json : (row.features_json ? JSON.stringify(row.features_json) : null),
      typeof row.params_json === 'string' ? row.params_json : (row.params_json ? JSON.stringify(row.params_json) : null),
      source,
      row.batch_id != null ? String(row.batch_id) : null
    ];
    const result = await this.runAsync(query, params);
    return { lastID: result.lastID };
  }

  /**
   * Get AI trades with optional filters (setup_id, symbol, tf, source, limit).
   * @param {object} filters - { setup_id, symbol, tf, source, limit }
   * @returns {Promise<Array<object>>}
   */
  async getTradesAi(filters = {}) {
    const conditions = [];
    const params = [];
    if (filters.setup_id != null && filters.setup_id !== '') {
      conditions.push('setup_id = ?');
      params.push(filters.setup_id);
    }
    if (filters.symbol != null && filters.symbol !== '') {
      conditions.push('symbol = ?');
      params.push(filters.symbol);
    }
    if (filters.tf != null && filters.tf !== '') {
      conditions.push('tf = ?');
      params.push(String(filters.tf));
    }
    if (filters.source != null && filters.source !== '') {
      conditions.push('source = ?');
      params.push(filters.source);
    }
    const limit = Math.min(5000, Math.max(1, parseInt(filters.limit, 10) || 500));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM trades_ai ${where} ORDER BY ts_close DESC LIMIT ?`;
    params.push(limit);
    const rows = await this.allAsync(query, params);
    return rows;
  }

  /**
   * Build WHERE clause and params for trades_ai filters (setup_id, symbol, tf).
   * Returns { where: 'WHERE ...' or '', params } — never raw conditions without WHERE.
   * @param {object} filters - { setup_id, symbol, tf }
   * @returns {{ where: string, params: any[] }}
   */
  _tradesAiFilterWhere(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.setup_id) {
      conditions.push('setup_id = ?');
      params.push(String(filters.setup_id));
    }
    if (filters.symbol) {
      conditions.push('symbol = ?');
      params.push(String(filters.symbol));
    }
    if (filters.tf != null && filters.tf !== '') {
      conditions.push('tf = ?');
      params.push(String(filters.tf));
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
  }

  /**
   * Same as _tradesAiFilterWhere but adds batch-only filter (batch_id IS NOT NULL AND batch_id != '').
   * Use for summary and perf so we don't mix oanda_paper + tradingview non-batch trades.
   * Always returns a clause starting with WHERE (never raw conditions).
   */
  _tradesAiWhereWithBatch(filters = {}) {
    const { where, params } = this._tradesAiFilterWhere(filters);
    const batchClause = `(batch_id IS NOT NULL AND batch_id != '')`;

    return {
      where: where ? `${where} AND ${batchClause}` : `WHERE ${batchClause}`,
      params,
    };
  }

  /**
   * Aggregate summary for trades_ai (setup_id + symbol + optional tf).
   * Only includes trades with batch_id set (same as getTradesAiBatches).
   * @param {object} filters - { setup_id, symbol, tf? }
   * @returns {Promise<object>} - { count, sum_pnl, avg_pnl, wins, losses, min_ts_open, max_ts_open }
   */
  async getTradesAiSummary(filters = {}) {
    const { where, params } = this._tradesAiWhereWithBatch(filters);
    const query = `
      SELECT
        COUNT(*) AS count,
        SUM(pnl) AS sum_pnl,
        AVG(pnl) AS avg_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
        MIN(ts_open) AS min_ts_open,
        MAX(ts_open) AS max_ts_open
      FROM trades_ai ${where}
    `;
    const row = await this.getAsync(query, params);
    return {
      count: row?.count ?? 0,
      sum_pnl: row?.sum_pnl ?? null,
      avg_pnl: row?.avg_pnl ?? null,
      wins: row?.wins ?? 0,
      losses: row?.losses ?? 0,
      min_ts_open: row?.min_ts_open ?? null,
      max_ts_open: row?.max_ts_open ?? null
    };
  }

  /**
   * Aggregates by batch_id (batch_id IS NOT NULL AND batch_id != ''), ordered by MAX(created_at) DESC.
   * @param {object} filters - { setup_id, symbol, tf? }
   * @returns {Promise<Array<object>>} - [{ batch_id, count, sum_pnl, avg_pnl, wins, losses, min_ts_open, max_ts_open, max_created_at }, ...]
   */
  async getTradesAiBatches(filters = {}) {
    const { where, params } = this._tradesAiWhereWithBatch(filters);
    const query = `
      SELECT
        batch_id,
        COUNT(*) AS count,
        SUM(pnl) AS sum_pnl,
        AVG(pnl) AS avg_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
        MIN(ts_open) AS min_ts_open,
        MAX(ts_open) AS max_ts_open,
        MAX(created_at) AS max_created_at
      FROM trades_ai
      ${where}
      GROUP BY batch_id
      ORDER BY max_created_at DESC
    `;
    const rows = await this.allAsync(query, params);
    return rows;
  }

  /**
   * Performance metrics for trades_ai (batch-only): by side, by session_bucket (if in features_json), pnl distribution.
   * @param {object} filters - { setup_id, symbol, tf? }
   * @returns {Promise<object>} - { by_side: [...], by_session_bucket: [...]|null, pnl_distribution: { min, max, avg, p10, p50, p90 } }
   */
  async getTradesAiPerf(filters = {}) {
    const { where, params } = this._tradesAiWhereWithBatch(filters);

    const bySideQuery = `
      SELECT
        side,
        COUNT(*) AS n,
        SUM(pnl) AS sum_pnl,
        AVG(pnl) AS avg_pnl,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
        MIN(pnl) AS min_pnl,
        MAX(pnl) AS max_pnl
      FROM trades_ai
      ${where}
      GROUP BY side
      ORDER BY n DESC
    `;
    const bySessionQuery = `
  SELECT
    json_extract(features_json, '$.session_bucket') AS session_bucket,
    COUNT(*) AS n,
    SUM(pnl) AS sum_pnl,
    AVG(pnl) AS avg_pnl,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
    MIN(pnl) AS min_pnl,
    MAX(pnl) AS max_pnl
  FROM trades_ai
  ${where}
    AND features_json IS NOT NULL
    AND json_extract(features_json, '$.session_bucket') IS NOT NULL
    AND json_extract(features_json, '$.session_bucket') != ''
  GROUP BY json_extract(features_json, '$.session_bucket')
  ORDER BY n DESC
`;
    const distQuery = `SELECT pnl FROM trades_ai ${where}`;
    const bySideParams = params;
    const bySessionParams = params;
    const distParams = params;

    let bySide;
    let bySessionBucket = null;
    let pnlRows;
    try {
      bySide = await this.allAsync(bySideQuery, bySideParams);
      try {
        const sbRows = await this.allAsync(bySessionQuery, bySessionParams);
        if (sbRows.length > 0) bySessionBucket = sbRows;
      } catch (_) {
        // SQLite without JSON or no session_bucket in schema: skip
      }
      pnlRows = await this.allAsync(distQuery, distParams);
    } catch (e) {
      console.error('[getTradesAiPerf] SQLITE FAIL', {
        message: e.message,
        bySideQuery,
        bySideParams,
        bySessionQuery,
        bySessionParams,
        distQuery,
        distParams,
      });
      throw e;
    }
    const pnls = pnlRows.map((r) => (r.pnl != null ? Number(r.pnl) : null)).filter((v) => v != null);
    const sorted = pnls.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const pct = (p) => (n === 0 ? null : sorted[Math.min(Math.floor((p / 100) * n), n - 1)]);
    const pnl_distribution = {
      min: n ? Math.min(...sorted) : null,
      max: n ? Math.max(...sorted) : null,
      avg: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
      p10: pct(10),
      p50: pct(50),
      p90: pct(90)
    };

    return { by_side: bySide, by_session_bucket: bySessionBucket, pnl_distribution };
  }

  /**
   * Delete trades_ai rows by batch_id (for re-import / purge without polluting DB).
   * @param {string} batch_id - Required; no-op if empty (safety).
   * @returns {Promise<{ deleted: number }>}
   */
  async deleteTradesAiByBatchId(batch_id) {
    const id = batch_id != null ? String(batch_id).trim() : '';
    if (id === '') return { deleted: 0 };
    const result = await this.runAsync('DELETE FROM trades_ai WHERE batch_id = ?', [id]);
    return { deleted: result.changes ?? 0 };
  }
}

module.exports = new EvaluationDatabase();

