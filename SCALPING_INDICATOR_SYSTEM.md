# Scalping Indicator Generation System ✅

## Overview

The system now **automatically builds custom scalping indicators** from learned patterns. Each indicator is tailored for scalping (1min/5min timeframes) with specific trading rules and signals.

## What Was Implemented

### 1. Indicator Generator Service (`backend/services/indicatorGenerator.js`)
- **Automatic Generation**: Builds indicators from learned patterns
- **Style-Specific**: Different indicators for scalping, swing, position trading
- **Trading Rules**: Automatically generates entry/exit rules from pattern features
- **Signals**: Creates buy/sell signals based on indicator conditions

### 2. Scalping-Focused Configuration
- **Timeframes**: 1min, 5min only
- **Pattern Types**: Momentum burst, volatility expansion, quick reversal, support/resistance
- **Tight Rules**: 0.3-0.5% stops, 0.5-1.5% targets
- **Fast Execution**: 5-15 minute hold times

### 3. API Endpoints
- `GET /api/indicators` - Get all indicators for a trading style
- `GET /api/indicators/:symbol` - Get indicators for a symbol
- `GET /api/indicators/id/:indicatorId` - Get specific indicator
- `POST /api/indicators/evaluate` - Evaluate market conditions
- `GET /api/indicators/stats` - Get indicator statistics
- `POST /api/indicators/regenerate` - Regenerate indicators from patterns

### 4. Automatic Integration
- **Pattern Learning → Indicator Generation**: When patterns are saved, indicators are automatically generated
- **Learning Daemon**: Indicator generator initialized with learning daemon
- **Server Startup**: Indicator generator initialized when server starts

## How It Works

### Pattern → Indicator Flow

```
1. Pattern Learning
   ↓
2. Patterns Grouped (by symbol + type)
   ↓
3. Indicator Features Calculated
   ↓
4. Trading Rules Generated
   ↓
5. Buy/Sell Signals Created
   ↓
6. Indicator Saved
```

### Example: Momentum Burst Indicator

**Input Pattern:**
```json
{
  "patternType": "momentum_burst",
  "symbol": "BTCUSDT",
  "timeframe": "1",
  "confidence": 0.85,
  "features": {
    "priceChange": 0.006,
    "volumeRatio": 1.8,
    "momentumStrength": 0.0108
  }
}
```

**Generated Indicator:**
```json
{
  "indicatorId": "IND_1234567890_abc123",
  "name": "Scalp Momentum Burst - BTCUSDT",
  "tradingStyle": "scalping",
  "rules": {
    "entry": [
      "Volume ratio > 1.62",
      "Price change > 0.0054",
      "Momentum strength > 0.0097"
    ],
    "stopLoss": "0.003",
    "takeProfit": "0.009"
  },
  "signals": {
    "buy": [{
      "condition": "Momentum strength > 0.0086",
      "confidence": 0.78,
      "description": "Strong upward momentum detected"
    }]
  }
}
```

## Usage

### 1. Start Learning (Patterns → Indicators)
```bash
# Start learning daemon (generates patterns)
./scripts/start_learning_daemon.sh

# Run backfill (learns patterns from history)
./scripts/learn_backfill.sh
```

### 2. Check Generated Indicators
```bash
# Get all scalping indicators
curl http://localhost:3014/api/indicators

# Get indicators for BTCUSDT
curl http://localhost:3014/api/indicators/BTCUSDT

# Get indicator statistics
curl http://localhost:3014/api/indicators/stats
```

### 3. Evaluate Market Conditions
```bash
curl -X POST http://localhost:3014/api/indicators/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "timeframe": "1",
    "marketData": {
      "price": 50000,
      "volume": 1000000,
      "volatility": 0.008,
      "priceChange": 0.006,
      "volumeRatio": 1.9
    }
  }'
```

### 4. Use in Trading
The indicators can be used to:
- **Filter trades**: Only trade when indicators match
- **Set stops/targets**: Use indicator rules for risk management
- **Generate signals**: Use indicator buy/sell signals
- **Boost confidence**: Higher confidence when multiple indicators match

## Configuration

### Environment Variables
```bash
# Enable indicator generation
ENABLE_INDICATOR_GENERATION=true

# Set trading style (scalping, swing, position)
TRADING_STYLE=scalping
```

### Trading Style Modes

#### Scalping (Default)
- **Timeframes**: 1min, 5min
- **Patterns**: Momentum burst, volatility expansion, quick reversal, support/resistance
- **Stops**: 0.3-0.5%
- **Targets**: 0.5-1.5%
- **Hold Time**: 5-15 minutes

#### Swing
- **Timeframes**: 15min, 60min, 240min
- **Patterns**: Breakout, mean reversion
- **Stops**: 1-2%
- **Targets**: 2-5%
- **Hold Time**: 1-5 days

#### Position
- **Timeframes**: Daily, Weekly
- **Patterns**: Long-term trends
- **Stops**: 3-5%
- **Targets**: 5-10%+
- **Hold Time**: Weeks to months

## Benefits

✅ **Automatic**: No manual coding required  
✅ **Scalping-Optimized**: Built specifically for scalping  
✅ **Pattern-Based**: Uses actual learned patterns  
✅ **Dynamic Rules**: Rules adapt to pattern features  
✅ **Real-Time**: Evaluate market conditions instantly  
✅ **Scalable**: Generate unlimited indicators  

## Next Steps

1. **Run Learning**: Let system learn scalping patterns
   ```bash
   ./scripts/learn_backfill.sh
   ```

2. **Check Indicators**: View generated indicators
   ```bash
   curl http://localhost:3014/api/indicators/stats | jq
   ```

3. **Test Evaluation**: Evaluate market conditions
   ```bash
   curl -X POST http://localhost:3014/api/indicators/evaluate \
     -H "Content-Type: application/json" \
     -d '{"symbol": "BTCUSDT", "timeframe": "1", "marketData": {...}}' | jq
   ```

4. **Integrate Trading**: Use indicators in trading logic

---

**Status:** ✅ Scalping Indicator System Complete  
**Trading Style:** Scalping (1min, 5min)  
**Auto-Generation:** Enabled  
**Integration:** Pattern Learning → Indicator Generation


