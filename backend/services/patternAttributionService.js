/**
 * Pattern Attribution Service
 * Links trades to patterns and tracks pattern performance
 */

const evaluationDb = require('../db/evaluationDb');

class PatternAttributionService {
  constructor() {
    this.patternCache = new Map(); // patternId -> performance stats
  }

  /**
   * Attribute trade to pattern(s)
   * @param {string} tradeId - Trade ID
   * @param {Array} patterns - Array of {patternId, confidence, patternType}
   * @param {object} tradeResult - Trade result {pnl, pnlPct}
   */
  async attributeTrade(tradeId, patterns, tradeResult) {
    if (!patterns || patterns.length === 0) return;

    for (const pattern of patterns) {
      if (!pattern.patternId) continue; // Skip if no pattern ID
      
      // Check if this trade-pattern attribution already exists (idempotency check)
      // This prevents double-counting on webhook retries
      const isNewAttribution = !(await evaluationDb.tradePatternAttributionExists(tradeId, pattern.patternId));
      
      // Save attribution (INSERT OR REPLACE ensures idempotency)
      await evaluationDb.saveTradePatternAttribution(tradeId, pattern.patternId, {
        patternConfidence: pattern.confidence || 0,
        tradePnL: tradeResult.pnl,
        tradePnLPct: tradeResult.pnlPct
      });

      // Update pattern performance
      await this._updatePatternPerformance(pattern.patternId, pattern, tradeResult);
    }
  }

  /**
   * Update pattern performance stats
   * Uses running mean for avg_return_pct (correct math)
   */
  async _updatePatternPerformance(patternId, patternInfo, tradeResult) {
    // Get current stats from database first
    let stats = this.patternCache.get(patternId);
    
    if (!stats) {
      // Try to load from database
      try {
        const existing = await evaluationDb.getAsync(
          'SELECT * FROM pattern_performance WHERE pattern_id = ?',
          [patternId]
        );
        
        if (existing) {
          stats = {
            patternId: existing.pattern_id,
            patternType: existing.pattern_type,
            symbol: existing.symbol,
            timeframe: existing.timeframe,
            totalTrades: existing.total_trades,
            winningTrades: existing.winning_trades,
            losingTrades: existing.losing_trades,
            totalReturnPct: existing.total_return_pct || 0,
            firstSeenDate: existing.first_seen_date
          };
        }
      } catch (e) {
        // Database not available or pattern doesn't exist yet
      }
    }
    
    if (!stats) {
      // Initialize new pattern
      stats = {
        patternId,
        patternType: patternInfo.patternType || 'unknown',
        symbol: patternInfo.symbol || null,
        timeframe: patternInfo.timeframe || null,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalReturnPct: 0,
        firstSeenDate: new Date().toISOString()
      };
    }

    // Update stats (running mean for avg_return_pct)
    const n = stats.totalTrades;
    stats.totalTrades++;
    
    if (tradeResult.pnl > 0) {
      stats.winningTrades++;
    } else if (tradeResult.pnl < 0) {
      stats.losingTrades++;
    }
    
    // Running mean: new_avg = (old_avg * n + new_value) / (n + 1)
    if (n === 0) {
      stats.avgReturnPct = tradeResult.pnlPct;
      stats.totalReturnPct = tradeResult.pnlPct;
    } else {
      stats.avgReturnPct = (stats.avgReturnPct * n + tradeResult.pnlPct) / (n + 1);
      stats.totalReturnPct += tradeResult.pnlPct;
    }
    
    stats.winRate = stats.totalTrades > 0 ? stats.winningTrades / stats.totalTrades : 0;
    stats.lastTradeDate = new Date().toISOString();

    // Calculate profit_factor from trade attributions
    stats.profitFactor = await this._calculateProfitFactor(patternId);

    // Update cache
    this.patternCache.set(patternId, stats);

    // Save to database
    await evaluationDb.updatePatternPerformance(patternId, stats);
  }

  /**
   * Calculate profit_factor from trade attributions
   * profit_factor = grossProfit / grossLoss
   * where grossProfit = sum of winning trade PnLs
   * and grossLoss = absolute sum of losing trade PnLs
   * 
   * Returns NULL if grossLoss == 0 (instead of Infinity) for SQLite compatibility
   */
  async _calculateProfitFactor(patternId) {
    try {
      const rows = await evaluationDb.allAsync(
        'SELECT trade_pnl FROM trade_pattern_attribution WHERE pattern_id = ?',
        [patternId]
      );

      let grossProfit = 0;
      let grossLoss = 0;

      for (const row of rows) {
        const pnl = row.trade_pnl;
        if (pnl > 0) {
          grossProfit += pnl;
        } else if (pnl < 0) {
          grossLoss += Math.abs(pnl);
        }
      }

      // Profit factor = grossProfit / grossLoss
      // If no losses, return NULL (not Infinity) for SQLite compatibility
      if (grossLoss === 0) {
        return grossProfit > 0 ? null : 0; // NULL means "perfect" (no losses), 0 means no profits
      }
      return grossProfit / grossLoss;
    } catch (error) {
      console.error(`❌ Error calculating profit_factor for pattern ${patternId}:`, error.message);
      return null;
    }
  }

  /**
   * Get pattern performance for multiple patterns
   * @param {Array<string>} patternIds - Array of pattern IDs (or single string for backward compat)
   * @returns {Promise<Map<string, object>>} - Map of patternId -> performance stats
   */
  async getPatternPerformance(patternIds) {
    // Handle single patternId for backward compatibility
    if (typeof patternIds === 'string') {
      patternIds = [patternIds];
    }
    if (!Array.isArray(patternIds) || patternIds.length === 0) {
      return new Map();
    }

    // Check cache first
    const result = new Map();
    const missingIds = [];

    for (const patternId of patternIds) {
      if (this.patternCache.has(patternId)) {
        result.set(patternId, this.patternCache.get(patternId));
      } else {
        missingIds.push(patternId);
      }
    }

    // Load missing from database
    if (missingIds.length > 0) {
      try {
        const dbResults = await evaluationDb.getPatternPerformance(missingIds);
        for (const [patternId, stats] of dbResults) {
          result.set(patternId, stats);
          // Update cache
          this.patternCache.set(patternId, stats);
        }
      } catch (error) {
        console.error(`❌ Error loading pattern performance:`, error.message);
      }
    }

    return result;
  }

  /**
   * Get all pattern performance stats
   */
  async getAllPatternPerformance() {
    return Array.from(this.patternCache.values());
  }
}

module.exports = new PatternAttributionService();

