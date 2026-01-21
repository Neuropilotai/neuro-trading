/**
 * Daily Pattern Tracker
 * Tracks opening trends, daily patterns, and time-based trading performance
 */

const fs = require('fs').promises;
const path = require('path');

class DailyPatternTracker {
  constructor() {
    this.enabled = process.env.ENABLE_DAILY_PATTERN_TRACKING !== 'false';
    this.dataPath = path.join(process.cwd(), 'data', 'daily_patterns.json');
    
    // Daily patterns data
    this.patterns = {
      openingTrends: new Map(), // hour -> {wins, losses, pnl, trades}
      hourlyPerformance: new Map(), // hour -> {wins, losses, pnl, trades}
      dayOfWeek: new Map(), // day -> {wins, losses, pnl, trades}
      symbolPerformance: new Map(), // symbol -> {wins, losses, pnl, trades, bestHour, worstHour}
      dailyStats: [] // Array of daily summaries
    };
    
    // Load existing data
    this.loadData();
    
    // Save periodically
    setInterval(() => this.saveData(), 300000); // Every 5 minutes
  }

  /**
   * Track a trade for pattern analysis
   */
  trackTrade(trade) {
    if (!this.enabled) return;

    const { symbol, action, pnl, fillPrice, filledQuantity, timestamp } = trade;
    const date = new Date(timestamp || Date.now());
    const hour = date.getHours();
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
    const isOpening = hour >= 9 && hour <= 11; // Market opening hours (9-11 AM)
    const isClosing = hour >= 15 && hour <= 16; // Market closing hours (3-4 PM)

    // Track opening trends (9-11 AM)
    if (isOpening) {
      const key = `${hour}:00`;
      if (!this.patterns.openingTrends.has(key)) {
        this.patterns.openingTrends.set(key, { wins: 0, losses: 0, pnl: 0, trades: 0 });
      }
      const trend = this.patterns.openingTrends.get(key);
      trend.trades++;
      if (pnl > 0) trend.wins++;
      else if (pnl < 0) trend.losses++;
      trend.pnl += pnl;
    }

    // Track hourly performance
    if (!this.patterns.hourlyPerformance.has(hour)) {
      this.patterns.hourlyPerformance.set(hour, { wins: 0, losses: 0, pnl: 0, trades: 0 });
    }
    const hourly = this.patterns.hourlyPerformance.get(hour);
    hourly.trades++;
    if (pnl > 0) hourly.wins++;
    else if (pnl < 0) hourly.losses++;
    hourly.pnl += pnl;

    // Track day of week performance
    const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];
    if (!this.patterns.dayOfWeek.has(dayName)) {
      this.patterns.dayOfWeek.set(dayName, { wins: 0, losses: 0, pnl: 0, trades: 0 });
    }
    const day = this.patterns.dayOfWeek.get(dayName);
    day.trades++;
    if (pnl > 0) day.wins++;
    else if (pnl < 0) day.losses++;
    day.pnl += pnl;

    // Track symbol performance
    if (!this.patterns.symbolPerformance.has(symbol)) {
      this.patterns.symbolPerformance.set(symbol, {
        wins: 0,
        losses: 0,
        pnl: 0,
        trades: 0,
        hourlyPnL: new Map(),
        bestHour: null,
        worstHour: null
      });
    }
    const symbolData = this.patterns.symbolPerformance.get(symbol);
    symbolData.trades++;
    if (pnl > 0) symbolData.wins++;
    else if (pnl < 0) symbolData.losses++;
    symbolData.pnl += pnl;

    // Track hourly PnL per symbol
    if (!symbolData.hourlyPnL.has(hour)) {
      symbolData.hourlyPnL.set(hour, { pnl: 0, trades: 0 });
    }
    const symbolHourly = symbolData.hourlyPnL.get(hour);
    symbolHourly.pnl += pnl;
    symbolHourly.trades++;

    // Update best/worst hours for symbol
    let bestHourPnL = -Infinity;
    let worstHourPnL = Infinity;
    for (const [h, data] of symbolData.hourlyPnL.entries()) {
      if (data.pnl > bestHourPnL) {
        bestHourPnL = data.pnl;
        symbolData.bestHour = h;
      }
      if (data.pnl < worstHourPnL) {
        worstHourPnL = data.pnl;
        symbolData.worstHour = h;
      }
    }
  }

  /**
   * Get opening trend analysis
   */
  getOpeningTrends() {
    const trends = [];
    for (const [hour, data] of this.patterns.openingTrends.entries()) {
      const winRate = data.trades > 0 ? (data.wins / data.trades) * 100 : 0;
      trends.push({
        hour,
        trades: data.trades,
        wins: data.wins,
        losses: data.losses,
        winRate: winRate.toFixed(1),
        pnl: data.pnl.toFixed(2),
        avgPnL: data.trades > 0 ? (data.pnl / data.trades).toFixed(2) : '0.00'
      });
    }
    return trends.sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
  }

  /**
   * Get hourly performance
   */
  getHourlyPerformance() {
    const performance = [];
    for (const [hour, data] of this.patterns.hourlyPerformance.entries()) {
      const winRate = data.trades > 0 ? (data.wins / data.trades) * 100 : 0;
      performance.push({
        hour: `${hour}:00`,
        trades: data.trades,
        wins: data.wins,
        losses: data.losses,
        winRate: winRate.toFixed(1),
        pnl: data.pnl.toFixed(2),
        avgPnL: data.trades > 0 ? (data.pnl / data.trades).toFixed(2) : '0.00'
      });
    }
    return performance.sort((a, b) => a.hour.localeCompare(b.hour));
  }

  /**
   * Get day of week performance
   */
  getDayOfWeekPerformance() {
    const performance = [];
    for (const [day, data] of this.patterns.dayOfWeek.entries()) {
      const winRate = data.trades > 0 ? (data.wins / data.trades) * 100 : 0;
      performance.push({
        day,
        trades: data.trades,
        wins: data.wins,
        losses: data.losses,
        winRate: winRate.toFixed(1),
        pnl: data.pnl.toFixed(2),
        avgPnL: data.trades > 0 ? (data.pnl / data.trades).toFixed(2) : '0.00'
      });
    }
    return performance;
  }

  /**
   * Get symbol performance with time patterns
   */
  getSymbolPerformance() {
    const performance = [];
    for (const [symbol, data] of this.patterns.symbolPerformance.entries()) {
      const winRate = data.trades > 0 ? (data.wins / data.trades) * 100 : 0;
      performance.push({
        symbol,
        trades: data.trades,
        wins: data.wins,
        losses: data.losses,
        winRate: winRate.toFixed(1),
        pnl: data.pnl.toFixed(2),
        avgPnL: data.trades > 0 ? (data.pnl / data.trades).toFixed(2) : '0.00',
        bestHour: data.bestHour !== null ? `${data.bestHour}:00` : 'N/A',
        worstHour: data.worstHour !== null ? `${data.worstHour}:00` : 'N/A'
      });
    }
    return performance.sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl));
  }

  /**
   * Get best trading times
   */
  getBestTradingTimes() {
    const hourly = this.getHourlyPerformance();
    const best = hourly
      .filter(h => h.trades > 0)
      .sort((a, b) => parseFloat(b.pnl) - parseFloat(a.pnl))
      .slice(0, 5);

    return {
      bestHours: best,
      worstHours: hourly
        .filter(h => h.trades > 0)
        .sort((a, b) => parseFloat(a.pnl) - parseFloat(b.pnl))
        .slice(0, 5)
    };
  }

  /**
   * Get daily summary
   */
  getDailySummary() {
    const today = new Date().toISOString().split('T')[0];
    const todayTrades = this.patterns.dailyStats.filter(s => s.date === today);
    
    if (todayTrades.length === 0) {
      return {
        date: today,
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        winRate: 0
      };
    }

    const summary = todayTrades[0];
    return {
      date: summary.date,
      trades: summary.trades,
      wins: summary.wins,
      losses: summary.losses,
      pnl: summary.pnl.toFixed(2),
      winRate: summary.trades > 0 ? ((summary.wins / summary.trades) * 100).toFixed(1) : '0.0'
    };
  }

  /**
   * Load data from file
   */
  async loadData() {
    try {
      const data = await fs.readFile(this.dataPath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Restore Maps from arrays
      if (parsed.openingTrends) {
        this.patterns.openingTrends = new Map(parsed.openingTrends);
      }
      if (parsed.hourlyPerformance) {
        this.patterns.hourlyPerformance = new Map(parsed.hourlyPerformance);
      }
      if (parsed.dayOfWeek) {
        this.patterns.dayOfWeek = new Map(parsed.dayOfWeek);
      }
      if (parsed.symbolPerformance) {
        this.patterns.symbolPerformance = new Map(
          parsed.symbolPerformance.map(([symbol, data]) => [
            symbol,
            {
              ...data,
              hourlyPnL: new Map(data.hourlyPnL || [])
            }
          ])
        );
      }
      if (parsed.dailyStats) {
        this.patterns.dailyStats = parsed.dailyStats;
      }
      
      console.log('✅ Daily pattern data loaded');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('⚠️  Error loading daily pattern data:', error.message);
      }
    }
  }

  /**
   * Save data to file
   */
  async saveData() {
    try {
      await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
      
      const data = {
        openingTrends: Array.from(this.patterns.openingTrends.entries()),
        hourlyPerformance: Array.from(this.patterns.hourlyPerformance.entries()),
        dayOfWeek: Array.from(this.patterns.dayOfWeek.entries()),
        symbolPerformance: Array.from(this.patterns.symbolPerformance.entries()).map(([symbol, data]) => [
          symbol,
          {
            ...data,
            hourlyPnL: Array.from(data.hourlyPnL.entries())
          }
        ]),
        dailyStats: this.patterns.dailyStats
      };
      
      await fs.writeFile(this.dataPath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('❌ Error saving daily pattern data:', error.message);
    }
  }

  /**
   * Get all statistics
   */
  getStats() {
    return {
      openingTrends: this.getOpeningTrends(),
      hourlyPerformance: this.getHourlyPerformance(),
      dayOfWeek: this.getDayOfWeekPerformance(),
      symbolPerformance: this.getSymbolPerformance(),
      bestTradingTimes: this.getBestTradingTimes(),
      dailySummary: this.getDailySummary()
    };
  }
}

module.exports = new DailyPatternTracker();


