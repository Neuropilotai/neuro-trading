/**
 * TradingView Sync Service
 * Syncs trades to TradingView paper trading (via manual export or webhook)
 * 
 * Note: TradingView doesn't have a public API, so we'll:
 * 1. Export trades in TradingView-compatible format
 * 2. Provide webhook endpoint for TradingView to pull trades
 * 3. Create a manual export feature
 */

const fs = require('fs').promises;
const path = require('path');
const tradeLedger = require('../db/tradeLedger');

class TradingViewSync {
  constructor() {
    this.enabled = process.env.ENABLE_TRADINGVIEW_SYNC !== 'false';
    this.exportPath = path.join(process.cwd(), 'data', 'tradingview_export');
  }

  /**
   * Export trades in TradingView-compatible format
   */
  async exportTrades(format = 'json') {
    if (!this.enabled) return null;

    try {
      const trades = await tradeLedger.getTrades(1000, 0); // Get last 1000 trades
      
      if (format === 'json') {
        return this.exportJSON(trades);
      } else if (format === 'csv') {
        return this.exportCSV(trades);
      } else if (format === 'tradingview') {
        return this.exportTradingViewFormat(trades);
      }
    } catch (error) {
      console.error('❌ Error exporting trades:', error.message);
      return null;
    }
  }

  /**
   * Export as JSON
   */
  async exportJSON(trades) {
    const filePath = path.join(this.exportPath, 'trades.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(trades, null, 2));
    return filePath;
  }

  /**
   * Export as CSV (TradingView can import CSV)
   */
  async exportCSV(trades) {
    const filePath = path.join(this.exportPath, 'trades.csv');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
    const headers = ['Date', 'Time', 'Symbol', 'Action', 'Quantity', 'Price', 'PnL', 'Status'];
    const rows = trades.map(trade => [
      new Date(trade.timestamp).toLocaleDateString(),
      new Date(trade.timestamp).toLocaleTimeString(),
      trade.symbol,
      trade.action,
      trade.quantity || 0,
      trade.price || 0,
      trade.pnl || 0,
      trade.status
    ]);
    
    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    await fs.writeFile(filePath, csv);
    return filePath;
  }

  /**
   * Export in TradingView paper trading format
   */
  async exportTradingViewFormat(trades) {
    // TradingView paper trading uses a specific format
    const filePath = path.join(this.exportPath, 'tradingview_trades.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    
    const tradingViewTrades = trades.map(trade => ({
      id: trade.trade_id,
      symbol: trade.symbol,
      side: trade.action === 'BUY' ? 'buy' : 'sell',
      quantity: trade.quantity || 0,
      price: trade.price || 0,
      timestamp: trade.timestamp,
      pnl: trade.pnl || 0,
      status: trade.status?.toLowerCase() || 'filled'
    }));
    
    await fs.writeFile(filePath, JSON.stringify(tradingViewTrades, null, 2));
    return filePath;
  }

  /**
   * Get trades for webhook (TradingView can pull from here)
   */
  async getTradesForWebhook(since = null) {
    try {
      const trades = await tradeLedger.getTrades(1000, 0);
      
      if (since) {
        const sinceDate = new Date(since);
        return trades.filter(t => new Date(t.timestamp) > sinceDate);
      }
      
      return trades;
    } catch (error) {
      console.error('❌ Error getting trades for webhook:', error.message);
      return [];
    }
  }

  /**
   * Format trade for display in TradingView
   */
  formatTradeForDisplay(trade) {
    return {
      symbol: trade.symbol,
      action: trade.action,
      quantity: trade.quantity,
      price: trade.price,
      timestamp: trade.timestamp,
      pnl: trade.pnl,
      status: trade.status,
      // Add indicator info if available
      indicator: trade.metadata?.indicatorMatch || null
    };
  }
}

module.exports = new TradingViewSync();


