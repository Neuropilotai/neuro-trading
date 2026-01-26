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
      
      // Save attribution
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
        const existing = await evaluationDb.db.get(
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

    // Update cache
    this.patternCache.set(patternId, stats);

    // Save to database
    await evaluationDb.updatePatternPerformance(patternId, stats);
  }

  /**
   * Get pattern performance
   */
  async getPatternPerformance(patternId) {
    // Try cache first
    if (this.patternCache.has(patternId)) {
      return this.patternCache.get(patternId);
    }

    // TODO: Load from database if not in cache
    return null;
  }

  /**
   * Get all pattern performance stats
   */
  async getAllPatternPerformance() {
    return Array.from(this.patternCache.values());
  }
}

module.exports = new PatternAttributionService();

