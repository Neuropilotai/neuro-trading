# Scalping Learning System - Configuration Complete ✅

## What Changed

The learning system has been **optimized for scalping** with the following changes:

### ✅ Timeframe Focus
- **Removed:** 15min, 60min, 240min, Daily
- **Kept:** 1min, 5min (scalping timeframes only)

### ✅ Increased History
- **1min:** 20,000 bars (~14 days)
- **5min:** 10,000 bars (~35 days)
- More data = better pattern recognition

### ✅ Faster Processing
- **Interval:** 1 minute (was 5 minutes)
- **Windows:** 5-20 candles (was 20-30)
- **Step:** Every 2 candles (was every 5)

### ✅ Scalping-Specific Patterns
1. **Momentum Burst** (Priority #1) - Volume + price spike
2. **Volatility Expansion** (Priority #2) - Sudden volatility
3. **Quick Reversal** (Priority #3) - Fast direction change
4. **Support/Resistance Bounce** (Priority #4) - Key levels
5. **Breakout** (Priority #5) - Smaller moves

### ✅ Tighter Thresholds
- **Volatility:** 0.8% (was 1.5%)
- **Price Change:** 0.5% (was 2%)
- **Volume Spike:** 1.3x (was 1.5x)

## Current Configuration

```json
{
  "timeframes": ["1", "5"],
  "maxHistoryBars": {
    "1": 20000,
    "5": 10000
  },
  "learningSchedule": {
    "intervalMinutes": 1,
    "focus": "scalping"
  }
}
```

## Commands to Run

### 1. Re-run Backfill (with new limits)
```bash
./scripts/learn_backfill.sh
```

This will now fetch:
- 20,000 bars for 1min (vs 10,000 before)
- 10,000 bars for 5min (vs 5,000 before)

### 2. Restart Daemon (faster interval)
```bash
./scripts/stop_learning_daemon.sh
./scripts/start_learning_daemon.sh
```

The daemon will now process every **1 minute** instead of 5 minutes.

### 3. Monitor Scalping Patterns
```bash
# Check pattern stats
curl http://localhost:3014/api/patterns/stats | jq

# Get momentum burst patterns (scalping priority #1)
curl "http://localhost:3014/api/patterns?type=momentum_burst&limit=20" | jq

# Get volatility expansion patterns (scalping priority #2)
curl "http://localhost:3014/api/patterns?type=volatility_expansion&limit=20" | jq
```

## Expected Benefits

### More Patterns
- **Before:** ~3 patterns from 16,503 candles
- **After:** Expected 10-20+ patterns (smaller windows, more detection)

### Faster Learning
- **Before:** 5-minute cycles = 288 cycles/day
- **After:** 1-minute cycles = 1,440 cycles/day (5x faster)

### Better Scalping Signals
- Detects 0.5% moves (vs 2% before)
- Catches volume spikes faster
- Identifies quick reversals
- Focuses on profitable scalping setups

## Pattern Examples

### Momentum Burst (Scalping)
```json
{
  "patternType": "momentum_burst",
  "timeframe": "1",
  "window": 8,
  "confidence": 0.87,
  "features": {
    "priceChange": 0.006,      // 0.6% move
    "volumeRatio": 2.1,        // 110% volume spike
    "momentumStrength": 0.0126
  },
  "scalping": true,
  "priority": 1
}
```

### Quick Reversal (Scalping)
```json
{
  "patternType": "quick_reversal",
  "timeframe": "5",
  "window": 12,
  "confidence": 0.78,
  "features": {
    "firstHalfChange": 0.008,   // Up 0.8%
    "secondHalfChange": -0.007, // Down 0.7%
    "reversalStrength": 0.015
  },
  "scalping": true,
  "priority": 3
}
```

## Next Steps

1. **Re-run backfill** to get more scalping history
2. **Restart daemon** to use 1-minute intervals
3. **Monitor patterns** to see scalping-specific patterns emerge
4. **Analyze results** to see which scalping patterns are most profitable

---

**Status:** ✅ Scalping-Optimized  
**Focus:** 1min & 5min timeframes  
**Interval:** Every 1 minute  
**Patterns:** Momentum, volatility, reversals, bounces


