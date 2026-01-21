# Multi-Symbol Scalping System

## Overview

The automated trading system has been enhanced to scan **ALL symbols** in the universe simultaneously, evaluate opportunities across multiple timeframes, and dynamically select the best trading opportunities based on real-time market conditions.

## Key Features

### 1. **Parallel Multi-Symbol Scanning**
- Scans ALL symbols from `config/tradingview_universe.json` simultaneously
- No longer limited to just BTC or a few symbols
- Processes all symbols in parallel for maximum efficiency

### 2. **Multi-Timeframe Analysis**
- Analyzes both **1-minute** and **5-minute** timeframes for each symbol
- Uses scalping-optimized patterns and indicators
- Combines signals from multiple timeframes for better decision making

### 3. **Intelligent Opportunity Ranking**
The system ranks opportunities using a composite score based on:
- **Confidence (40%)**: Indicator confidence level
- **Expected Profit (25%)**: Potential profit percentage
- **Risk/Reward Ratio (20%)**: Prefers 3:1 or better
- **Market Conditions (15%)**: Volume and volatility analysis
- **Timeframe Bonus (5%)**: Slight preference for 1-minute entries

### 4. **Dynamic Symbol Selection**
- Automatically selects the **best opportunity** across all symbols
- Considers real-time market conditions (volume, volatility, trends)
- Only trades when confidence threshold is met (default: 80%)

### 5. **Real-Time Monitoring**
- Monitor dashboard shows:
  - All symbols being scanned
  - Last scan timestamp
  - Top opportunities found
  - Active positions across symbols

## How It Works

### Trading Cycle (Every 30 seconds by default)

1. **Scan Phase**
   - Fetches all symbols from universe config
   - Scans each symbol in parallel (1min + 5min timeframes)
   - Evaluates indicators for each symbol/timeframe combination

2. **Ranking Phase**
   - Calculates composite score for each opportunity
   - Ranks opportunities by score (best first)
   - Filters by confidence threshold

3. **Execution Phase**
   - Selects the top-ranked opportunity
   - Executes trade if confidence ≥ threshold
   - Tracks position with stop loss and take profit

4. **Position Management**
   - Monitors all active positions
   - Exits on stop loss, take profit, or time limit (15 min for scalping)

## Configuration

### Environment Variables

```bash
# Enable automated trading
ENABLE_AUTOMATED_TRADING=true

# Confidence threshold (0.80 = 80%)
AUTO_TRADE_MIN_CONFIDENCE=0.80

# Target accuracy (system adjusts confidence to maintain this)
TARGET_ACCURACY=0.80

# Check interval (seconds)
AUTO_TRADE_CHECK_INTERVAL=30

# Position size (% of balance per trade)
AUTO_POSITION_SIZE_PERCENT=2.0

# Max trades per day
MAX_TRADES_PER_DAY=50

# Min time between trades (seconds)
MIN_TIME_BETWEEN_TRADES=60
```

### Universe Configuration

Edit `config/tradingview_universe.json` to add/remove symbols:

```json
{
  "symbols": [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "SPY",
    "QQQ",
    "AAPL",
    "TSLA",
    "NVDA"
  ],
  "timeframes": ["1", "5"]
}
```

## Monitoring

### Dashboard
Open in browser: `http://localhost:3014/monitor`

Shows:
- **Multi-Symbol Scanner**: All symbols being monitored, last scan time
- **Top Opportunities**: Best opportunities found in last scan
- **Active Positions**: Current positions across all symbols
- **Performance Metrics**: Accuracy, win rate, confidence threshold

### API Endpoints

```bash
# Get full status including scanning activity
curl http://localhost:3014/api/automated/status

# Get performance metrics
curl http://localhost:3014/api/automated/performance
```

## Example Output

```
🔍 Scanning 8 symbols for scalping opportunities...
📊 Monitoring 8 symbols: BTCUSDT, ETHUSDT, SOLUSDT, SPY, QQQ, AAPL, TSLA, NVDA
🎯 Best opportunity: ETHUSDT (confidence: 85.2%, expected profit: 1.2%)
🎯 Executing trade: ETHUSDT BUY @ $2450.50
   Timeframe: 1min
   Indicator: scalp_momentum_burst
   Confidence: 85.2%
   Expected Profit: 1.20%
   Risk/Reward: 2.40:1
   Stop Loss: $2438.25
   Take Profit: $2479.96
✅ Trade executed successfully: ETHUSDT BUY
```

## Benefits

1. **Maximum Coverage**: No longer limited to one symbol - scans entire universe
2. **Better Opportunities**: Compares all symbols and picks the best
3. **Faster Decisions**: Parallel scanning means faster opportunity detection
4. **Adaptive**: Adjusts confidence threshold to maintain target accuracy
5. **Scalable**: Easily add more symbols to universe config

## Troubleshooting

### System only trading one symbol
- Check `config/tradingview_universe.json` - ensure multiple symbols are listed
- Verify market data providers are working for all symbols
- Check logs for errors fetching data for specific symbols

### No opportunities found
- Lower confidence threshold temporarily: `AUTO_TRADE_MIN_CONFIDENCE=0.70`
- Check that indicators are being generated: `curl http://localhost:3014/api/indicators/stats`
- Verify learning system is running: `curl http://localhost:3014/learn/status`

### Too many trades
- Increase `MIN_TIME_BETWEEN_TRADES` (e.g., 120 seconds)
- Lower `MAX_TRADES_PER_DAY` (e.g., 20)
- Increase confidence threshold

## Next Steps

1. **Add more symbols** to `config/tradingview_universe.json`
2. **Monitor performance** via dashboard: `http://localhost:3014/monitor`
3. **Adjust confidence** based on accuracy (system auto-adjusts)
4. **Review opportunities** in dashboard to see what system is evaluating

