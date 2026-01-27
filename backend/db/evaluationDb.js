/**
 * Evaluation Database
 * SQLite database for backtest results, walk-forward validation, and pattern performance
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs').promises;

class EvaluationDatabase {
  constructor() {
    this.dbPath = path.join(__dirname, '../../data/evaluation.db');
    this.db = null;
  }

  /**
   * Initialize database (create if doesn't exist, run schema)
   */
  async initialize() {
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

    // Run schema
    const schemaPath = path.join(__dirname, 'evaluationSchema.sql');
    const schema = await fs.readFile(schemaPath, 'utf8');
    
    return new Promise((resolve, reject) => {
      this.db.exec(schema, (err) => {
        if (err) {
          console.error('❌ Error creating evaluation schema:', err.message);
          reject(err);
        } else {
          // Add profit_factor column if it doesn't exist (migration)
          this.db.run(
            'ALTER TABLE pattern_performance ADD COLUMN profit_factor REAL',
            (alterErr) => {
              // Ignore error if column already exists
              if (alterErr && !alterErr.message.includes('duplicate column')) {
                console.warn('⚠️  Could not add profit_factor column:', alterErr.message);
              }
              console.log('✅ Evaluation database initialized');
              resolve();
            }
          );
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
          else resolve();
        });
      });
    }
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
   */
  async updatePatternPerformance(patternId, performance) {
    const query = `
      INSERT INTO pattern_performance (
        id, pattern_id, pattern_type, symbol, timeframe,
        total_trades, winning_trades, losing_trades, win_rate,
        avg_return_pct, total_return_pct, profit_factor, sharpe_ratio,
        last_trade_date, first_seen_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pattern_id) DO UPDATE SET
        total_trades = excluded.total_trades,
        winning_trades = excluded.winning_trades,
        losing_trades = excluded.losing_trades,
        win_rate = excluded.win_rate,
        avg_return_pct = excluded.avg_return_pct,
        total_return_pct = excluded.total_return_pct,
        profit_factor = excluded.profit_factor,
        sharpe_ratio = excluded.sharpe_ratio,
        last_trade_date = excluded.last_trade_date,
        last_updated = datetime('now')
    `;

    return new Promise((resolve, reject) => {
      this.db.run(query, [
        `pattern_${patternId}`,
        patternId,
        performance.patternType,
        performance.symbol || null,
        performance.timeframe || null,
        performance.totalTrades,
        performance.winningTrades,
        performance.losingTrades,
        performance.winRate,
        performance.avgReturnPct,
        performance.totalReturnPct,
        performance.profitFactor !== undefined ? performance.profitFactor : null,
        performance.sharpeRatio || null,
        performance.lastTradeDate || null,
        performance.firstSeenDate || new Date().toISOString()
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Save trade-pattern attribution
   */
  async saveTradePatternAttribution(tradeId, patternId, attribution) {
    const query = `
      INSERT INTO trade_pattern_attribution (
        id, trade_id, pattern_id, pattern_confidence, trade_pnl, trade_pnl_pct
      ) VALUES (?, ?, ?, ?, ?, ?)
    `;

    // Deterministic ID
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(`${tradeId}|${patternId}`).digest('hex');
    const id = `attr_${hash.substring(0, 16)}`;

    return new Promise((resolve, reject) => {
      this.db.run(query, [
        id,
        tradeId,
        patternId,
        attribution.patternConfidence,
        attribution.tradePnL,
        attribution.tradePnLPct
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
    `;

    return new Promise((resolve, reject) => {
      this.db.all(query, patternIds, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const result = new Map();
          for (const row of rows) {
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
          resolve(result);
        }
      });
    });
  }

  /**
   * Get validated patterns based on performance thresholds
   * @param {object} config - Filter config { minWinRate, minProfitFactor, minSampleSize }
   * @returns {Promise<Array<string>>} - Array of validated pattern IDs
   */
  async getValidatedPatterns(config) {
    const {
      minWinRate = 0.50,
      minProfitFactor = 1.0,
      minSampleSize = 10
    } = config;

    const query = `
      SELECT pattern_id, profit_factor
      FROM pattern_performance
      WHERE total_trades >= ?
        AND win_rate >= ?
    `;

    return new Promise((resolve, reject) => {
      this.db.all(query, [minSampleSize, minWinRate], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          // Filter by profit_factor (handle NULL as 0)
          const validated = rows
            .filter(row => {
              const pf = row.profit_factor;
              if (pf === null || pf === undefined) {
                return minProfitFactor === 0; // Only allow NULL if threshold is 0
              }
              return pf >= minProfitFactor;
            })
            .map(row => row.pattern_id);
          resolve(validated);
        }
      });
    });
  }
}

module.exports = new EvaluationDatabase();

