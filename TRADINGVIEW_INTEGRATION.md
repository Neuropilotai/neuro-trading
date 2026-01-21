# TradingView Integration Guide

## Overview

While TradingView doesn't have a public API to directly place orders in their paper trading account, we've created several ways to see what the system is doing and sync trades.

## What's Available

### 1. Real-Time System Monitor 🖥️

**URL:** `http://localhost:3014/monitor`

A live dashboard showing:
- ✅ **Performance Metrics**: Accuracy, win rate, total trades
- ✅ **Active Positions**: Current open positions
- ✅ **Market Analysis**: What symbols are being analyzed
- ✅ **Indicators**: Which indicators are being evaluated
- ✅ **Live Activity Feed**: Real-time trading activity

**Features:**
- Auto-refreshes every 5 seconds
- Shows what the system is "seeing"
- Displays indicator matches
- Shows trade signals being generated

### 2. Trade Export for TradingView 📤

**URL:** `http://localhost:3014/api/tradingview/export?format=csv`

Export trades in formats TradingView can import:
- **CSV**: `?format=csv` - Can be imported into TradingView
- **JSON**: `?format=json` - For programmatic use
- **TradingView Format**: `?format=tradingview` - Optimized format

**How to Use:**
1. Download the CSV: `curl http://localhost:3014/api/tradingview/export?format=csv -o trades.csv`
2. Import into TradingView (if they support CSV import)
3. Or manually enter trades into TradingView paper trading

### 3. Webhook Endpoint for TradingView 🔗

**URL:** `http://localhost:3014/api/tradingview/trades`

TradingView can pull trades from this endpoint:
- Returns all trades in JSON format
- Can filter by date: `?since=2024-01-20T00:00:00Z`
- Includes indicator information

## Viewing System Activity

### Option 1: System Monitor Dashboard (Recommended)

1. **Open in browser:**
   ```
   http://localhost:3014/monitor
   ```

2. **What you'll see:**
   - Real-time performance metrics
   - Active positions
   - Indicators being evaluated
   - Market analysis
   - Live activity feed

3. **Auto-updates every 5 seconds**

### Option 2: API Endpoints

**Check what system is analyzing:**
```bash
# Get active positions
curl http://localhost:3014/api/dashboard/positions | jq

# Get recent trades
curl http://localhost:3014/api/dashboard/trades | jq

# Get automated trading status
curl http://localhost:3014/api/automated/status | jq

# Get indicators being used
curl http://localhost:3014/api/indicators?style=scalping | jq
```

### Option 3: Export Trades

**Download trades:**
```bash
# CSV format (for manual entry into TradingView)
curl http://localhost:3014/api/tradingview/export?format=csv -o trades.csv

# JSON format
curl http://localhost:3014/api/tradingview/export?format=json -o trades.json
```

## Manual Sync to TradingView Paper Trading

Since TradingView doesn't have a public API, you can manually sync:

### Method 1: Use System Monitor

1. Open `http://localhost:3014/monitor`
2. Watch trades as they happen
3. Manually enter into TradingView paper trading

### Method 2: Export and Review

1. Export trades: `http://localhost:3014/api/tradingview/export?format=csv`
2. Review the CSV file
3. Enter trades into TradingView paper trading manually

### Method 3: Use TradingView Webhooks (Future)

If TradingView adds webhook support, you can:
1. Configure TradingView to pull from: `http://localhost:3014/api/tradingview/trades`
2. Trades will sync automatically

## What the System Sees

The monitor dashboard shows exactly what the automated system is analyzing:

### Market Data
- Current prices
- Volume
- Volatility
- Price changes

### Indicators
- Which indicators are active
- Confidence levels
- Strength scores
- Pattern matches

### Trade Signals
- Buy/sell signals being generated
- Confidence scores
- Stop loss/take profit levels
- Entry/exit conditions

## Real-Time Monitoring

### Watch Live Activity

Open the monitor dashboard and you'll see:
- ✅ Every trade being executed
- ✅ Indicator evaluations
- ✅ Market analysis
- ✅ Performance updates
- ✅ Position management

### Example Activity Feed

```
[10:30:15] INFO: Checking BTCUSDT for trading opportunities
[10:30:16] INFO: Indicator match: Scalp Momentum Burst - BTCUSDT (confidence: 85.2%)
[10:30:17] TRADE: Auto-trading BTCUSDT: BUY @ 50000.00
[10:30:18] INFO: Trade executed successfully
[10:30:20] INFO: Position opened: BTCUSDT @ 50000.00
```

## Next Steps

1. **Open Monitor**: `http://localhost:3014/monitor`
2. **Watch Activity**: See what the system is analyzing
3. **Track Performance**: Monitor accuracy and trades
4. **Export Trades**: Download for manual entry if needed

---

**Note:** TradingView doesn't currently support direct API integration for paper trading. The monitor dashboard and export features provide full visibility into what the system is doing.


