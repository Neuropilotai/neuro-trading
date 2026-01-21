# 🐋 Whale Detection Agent

## Overview

The Whale Detection Agent monitors market activity to identify large institutional/whale buying patterns and guides the automated trading system to prioritize opportunities with whale activity.

## Features

### 1. **Volume Spike Detection**
- Detects unusual volume increases (3x+ average = whale activity)
- Identifies large volume spikes (5x+ = big whale)
- Tracks volume accumulation patterns (sustained high volume)

### 2. **Price Movement Analysis**
- Monitors significant price moves (2%+ = significant)
- Detects large price movements (5%+ = big move)
- Correlates volume with price action

### 3. **Whale Pattern Recognition**
- **Whale Buying**: High volume + price increase
- **Whale Selling**: High volume + price decrease
- **Volume Accumulation**: Sustained high volume over time
- **Price Momentum**: Strong price movement with volume confirmation

### 4. **Opportunity Ranking Boost**
- Opportunities with whale signals get boosted scores
- Strong whale signals (0.8+) = 50% score boost
- Moderate signals (0.6+) = 10-30% score boost
- System automatically prioritizes whale-detected opportunities

## How It Works

### Detection Process

1. **Volume Analysis**
   - Compares current volume to 20-candle average
   - Compares to 5-candle recent average
   - Flags spikes above thresholds

2. **Price Analysis**
   - Calculates price change percentage
   - Identifies momentum patterns
   - Correlates with volume activity

3. **Pattern Matching**
   - Detects whale buying patterns (volume + price up)
   - Detects whale selling patterns (volume + price down)
   - Identifies accumulation patterns

4. **Signal Generation**
   - Composite signal (0-1) based on all patterns
   - Strong signals (0.8+) trigger events
   - Signals stored for 5 minutes

### Integration with Trading System

The whale detection agent is integrated into the automated scalping trader:

1. **During Symbol Scanning**
   - Each symbol is analyzed for whale activity
   - Whale signal attached to opportunities
   - Signals boost opportunity scores

2. **Opportunity Ranking**
   - Whale signal contributes 15% to composite score
   - Additional boost multiplier (up to 1.5x)
   - Whale-detected opportunities rank higher

3. **Trade Execution**
   - System prioritizes opportunities with whale activity
   - Strong whale signals = higher confidence trades
   - Better entry timing by following whales

## Configuration

### Environment Variables

```bash
# Enable/disable whale detection
ENABLE_WHALE_DETECTION=true

# Volume thresholds (multiples of average)
WHALE_VOLUME_SPIKE_THRESHOLD=3.0    # 3x average = whale
WHALE_LARGE_VOLUME_THRESHOLD=5.0     # 5x = big whale

# Price movement thresholds
WHALE_PRICE_MOVE_THRESHOLD=0.02      # 2% move = significant
WHALE_LARGE_PRICE_MOVE=0.05          # 5% = big move

# Time windows (candles)
WHALE_SHORT_WINDOW=5                 # 5 candles
WHALE_MEDIUM_WINDOW=20               # 20 candles
WHALE_LONG_WINDOW=100                # 100 candles

# Signal thresholds
WHALE_MIN_SIGNAL=0.6                 # Minimum to consider
WHALE_STRONG_SIGNAL=0.8              # Strong whale signal
```

## API Endpoints

### Get All Whale Signals
```bash
GET /api/whales/signals
```

Response:
```json
{
  "success": true,
  "signals": [
    {
      "symbol": "BTCUSDT",
      "signal": 0.85,
      "timestamp": 1234567890,
      "timeframe": "1",
      "patterns": {
        "volumeSpike": true,
        "whaleBuying": true,
        "largeVolumeSpike": false
      },
      "volumeRatio": 4.2,
      "priceChangePercent": 0.025
    }
  ],
  "count": 1
}
```

### Get Whale Signal for Symbol
```bash
GET /api/whales/signals/:symbol
```

Example:
```bash
curl http://localhost:3014/api/whales/signals/BTCUSDT
```

### Get Whale Statistics
```bash
GET /api/whales/stats
```

Response:
```json
{
  "success": true,
  "stats": {
    "whalesDetected": 42,
    "signalsGenerated": 156,
    "opportunitiesBoosted": 89,
    "lastScan": "2026-01-21T12:00:00Z",
    "enabled": true,
    "isRunning": true,
    "activeSignals": 5
  }
}
```

## Example Output

When whale activity is detected:

```
🐋 Strong whale detected: BTCUSDT
   Signal: 0.85
   Volume ratio: 4.2x
   Price change: +2.5%
   Patterns: volumeSpike, whaleBuying, priceMomentum
   
🎯 Best opportunity: BTCUSDT (confidence: 88.2%, whale boost: 1.5x)
   Whale signal: 0.85 (strong)
   Composite score: 0.92
```

## Benefits

1. **Follow the Money**: Trade alongside institutional/whale activity
2. **Better Timing**: Enter when big players are moving
3. **Higher Confidence**: Whale signals validate opportunities
4. **Automatic Prioritization**: System automatically ranks whale opportunities higher
5. **Real-time Detection**: Monitors all symbols continuously

## Monitoring

### Dashboard Integration

The whale detection agent is integrated into the trading system monitor:
- Shows active whale signals
- Displays signal strength
- Highlights symbols with whale activity

### Logs

Whale detection logs:
- `🐋 Strong whale detected: SYMBOL` - Strong signals (0.8+)
- `⏳ Whale signal: SYMBOL (0.65)` - Moderate signals
- `✅ Opportunity boosted by whale signal` - When whale boosts a trade

## Best Practices

1. **Monitor Multiple Symbols**: Whales move across different assets
2. **Combine with Indicators**: Whale signals + technical indicators = best opportunities
3. **Watch for Accumulation**: Sustained volume often precedes big moves
4. **Follow the Trend**: Whale buying + uptrend = strong opportunity
5. **Risk Management**: Even whale signals need stop losses

## Troubleshooting

### No Whale Signals Detected
- Check volume thresholds (may be too high)
- Verify market data is being received
- Check that symbols are being scanned

### Too Many Signals
- Increase volume thresholds
- Increase price move thresholds
- Adjust signal minimum threshold

### Signals Not Boosting Opportunities
- Verify whale detection is enabled
- Check opportunity ranking logic
- Ensure signals are recent (< 5 minutes)

## Next Steps

1. **Monitor Whale Activity**: Check `/api/whales/signals` regularly
2. **Adjust Thresholds**: Tune based on your trading style
3. **Combine with Learning**: System learns from whale-following trades
4. **Track Performance**: Monitor if whale signals improve win rate

---

**The whale detection agent helps you "follow the smart money" and prioritize the best opportunities!** 🐋📈

