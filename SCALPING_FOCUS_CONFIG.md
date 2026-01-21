# Scalping-Focused Learning Configuration

## Overview

The learning system has been optimized for **scalping** - focusing on 1-minute and 5-minute timeframes with high-frequency pattern detection.

## Changes Made

### 1. Timeframe Focus
- **Before:** 1, 5, 15, 60, 240, D (6 timeframes)
- **After:** 1, 5 (2 timeframes - scalping only)

### 2. History Limits (More Data for Scalping)
- **1min:** 20,000 bars (~14 days)
- **5min:** 10,000 bars (~35 days)

### 3. Learning Interval
- **Before:** Every 5 minutes
- **After:** Every 1 minute (faster pattern detection)

### 4. Pattern Detection (Scalping-Optimized)
- **Smaller windows:** 5-20 candles (vs 20-30 for swing trading)
- **Faster detection:** Check every 2 candles (vs every 5)
- **Tighter thresholds:** More sensitive to small moves
- **Priority patterns:**
  1. Momentum Burst (volume + price spike)
  2. Volatility Expansion (sudden volatility increase)
  3. Quick Reversal (fast direction change)
  4. Support/Resistance Bounce (key level reactions)
  5. Breakout (smaller moves detected)

### 5. Pattern Types (Scalping-Specific)
- **Momentum Burst** - Volume spike with price movement (priority #1)
- **Volatility Expansion** - Sudden volatility increase (priority #2)
- **Quick Reversal** - Fast direction change (priority #3)
- **Support/Resistance Bounce** - Key level reactions (priority #4)
- **Breakout** - Smaller moves detected (priority #5)

## Configuration

### Current Settings
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

### Environment Variables
```bash
# Scalping-optimized
LEARN_INTERVAL_MINUTES=1        # Process every 1 minute
LEARN_CONCURRENCY=4             # 4 parallel workers (M3)
LEARN_BACKFILL_BARS_1=20000    # More history for 1min
LEARN_BACKFILL_BARS_5=10000    # More history for 5min
```

## Benefits of Scalping Focus

✅ **Faster Pattern Detection** - 1-minute intervals vs 5 minutes  
✅ **More Patterns** - Smaller windows catch more opportunities  
✅ **Higher Frequency** - More learning cycles per day  
✅ **Tighter Thresholds** - Detects smaller moves  
✅ **Priority System** - Focuses on most profitable scalping patterns  

## Pattern Characteristics

### Scalping Patterns Are:
- **Fast:** 5-20 candle windows
- **Sensitive:** Detect 0.5%+ moves (vs 2%+ for swing)
- **Volume-Driven:** Prioritize volume spikes
- **Short-Lived:** Patterns last minutes, not hours

### Example Scalping Pattern
```json
{
  "patternType": "momentum_burst",
  "timeframe": "1",
  "window": 10,
  "confidence": 0.85,
  "features": {
    "priceChange": 0.008,      // 0.8% move
    "volumeRatio": 1.8,         // 80% volume spike
    "momentumStrength": 0.0144
  },
  "scalping": true,
  "priority": 1
}
```

## Next Steps

1. **Run backfill** to get more scalping history:
   ```bash
   ./scripts/learn_backfill.sh
   ```

2. **Start daemon** (now runs every 1 minute):
   ```bash
   ./scripts/start_learning_daemon.sh
   ```

3. **Monitor scalping patterns**:
   ```bash
   curl http://localhost:3014/api/patterns/stats | jq '.patternStats.patternsByType'
   ```

4. **Check scalping-specific patterns**:
   ```bash
   curl "http://localhost:3014/api/patterns?type=momentum_burst&limit=10" | jq
   ```

## Expected Results

With scalping focus, you should see:
- **More patterns detected** (smaller windows = more opportunities)
- **Faster learning** (1-minute cycles vs 5 minutes)
- **Higher pattern frequency** (scalping patterns occur more often)
- **Better pattern quality** (focused on profitable scalping setups)

---

**Status:** ✅ Scalping-Optimized  
**Timeframes:** 1min, 5min only  
**Interval:** Every 1 minute  
**Focus:** Momentum, volatility, quick reversals


