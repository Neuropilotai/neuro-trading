# Indicator Generation System 🎯

## Overview

The system now **automatically builds custom indicators** from learned patterns for specific trading styles (scalping, swing, position trading).

## How It Works

### 1. Pattern Learning → Indicator Generation
```
Patterns Learned → Grouped by Type → Indicators Generated → Trading Rules Created
```

1. **Pattern Detection**: System learns patterns from market data
2. **Pattern Grouping**: Patterns grouped by symbol + pattern type
3. **Indicator Building**: Each group becomes a custom indicator
4. **Rule Generation**: Trading rules automatically created from pattern features
5. **Signal Generation**: Buy/sell signals generated from indicator rules

### 2. Trading Style Support

#### Scalping Indicators (1min, 5min)
- **Momentum Burst** - Volume + price spike indicators
- **Volatility Expansion** - Sudden volatility increase indicators
- **Quick Reversal** - Fast direction change indicators
- **Support/Resistance Bounce** - Key level reaction indicators

#### Swing Indicators (15min, 60min, 240min)
- **Breakout** - Trend continuation indicators
- **Mean Reversion** - Range-bound indicators

#### Position Indicators (Daily, Weekly)
- **Long-term Trends** - Multi-day pattern indicators

## Indicator Structure

Each indicator contains:

```json
{
  "indicatorId": "IND_1234567890_abc123",
  "name": "Scalp Momentum Burst - BTCUSDT",
  "tradingStyle": "scalping",
  "symbol": "BTCUSDT",
  "patternType": "momentum_burst",
  "timeframes": ["1", "5"],
  "confidence": 0.85,
  "strength": 0.78,
  "occurrences": 15,
  "features": {
    "avgVolatility": 0.008,
    "avgPriceChange": 0.006,
    "avgVolumeRatio": 1.8,
    "avgMomentumStrength": 0.0108
  },
  "rules": {
    "entry": [
      "Volume ratio > 1.62",
      "Price change > 0.0054",
      "Momentum strength > 0.0097"
    ],
    "exit": [],
    "stopLoss": "0.003",
    "takeProfit": "0.009",
    "riskManagement": {
      "maxPositionSize": "2-5%",
      "maxDailyLoss": "1%",
      "maxHoldTime": "5-15 minutes",
      "minConfidence": 0.75
    }
  },
  "signals": {
    "buy": [
      {
        "condition": "Momentum strength > 0.0086",
        "confidence": 0.78,
        "description": "Strong upward momentum detected"
      }
    ],
    "sell": [],
    "neutral": []
  }
}
```

## API Endpoints

### Get All Indicators
```bash
# Get scalping indicators (default)
curl http://localhost:3014/api/indicators

# Get swing indicators
curl "http://localhost:3014/api/indicators?style=swing"

# Limit results
curl "http://localhost:3014/api/indicators?style=scalping&limit=10"
```

### Get Indicators for Symbol
```bash
curl http://localhost:3014/api/indicators/BTCUSDT
```

### Get Specific Indicator
```bash
curl http://localhost:3014/api/indicators/id/IND_1234567890_abc123
```

### Evaluate Market Conditions
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

### Get Indicator Statistics
```bash
curl http://localhost:3014/api/indicators/stats
```

### Regenerate Indicators
```bash
# Regenerate scalping indicators
curl -X POST http://localhost:3014/api/indicators/regenerate \
  -H "Content-Type: application/json" \
  -d '{"style": "scalping"}'
```

## Configuration

### Environment Variables
```bash
# Enable indicator generation
ENABLE_INDICATOR_GENERATION=true

# Set trading style (scalping, swing, position)
TRADING_STYLE=scalping
```

### Trading Style Modes

#### Scalping Mode
- **Timeframes**: 1min, 5min
- **Patterns**: Momentum burst, volatility expansion, quick reversal, support/resistance
- **Rules**: Tight stops (0.3-0.5%), quick profits (0.5-1.5%)
- **Hold Time**: 5-15 minutes

#### Swing Mode
- **Timeframes**: 15min, 60min, 240min
- **Patterns**: Breakout, mean reversion
- **Rules**: Wider stops (1-2%), larger targets (2-5%)
- **Hold Time**: 1-5 days

#### Position Mode
- **Timeframes**: Daily, Weekly
- **Patterns**: Long-term trends
- **Rules**: Very wide stops (3-5%), large targets (5-10%+)
- **Hold Time**: Weeks to months

## Integration with Trading

### 1. Pattern Learning → Indicator Generation
When patterns are saved, indicators are automatically generated:

```javascript
// In patternLearningEngine.js
async savePatterns() {
  // ... save patterns ...
  
  // Trigger indicator generation
  await indicatorGenerator.generateIndicatorsFromPatterns();
  await indicatorGenerator.saveIndicators();
}
```

### 2. Market Evaluation
Before executing trades, evaluate market conditions:

```javascript
const evaluations = indicatorGenerator.evaluateMarketConditions(
  'BTCUSDT',
  '1',
  {
    price: 50000,
    volume: 1000000,
    volatility: 0.008,
    priceChange: 0.006,
    volumeRatio: 1.9
  }
);

// Get matching indicators
const matches = evaluations.filter(e => e.match);
if (matches.length > 0) {
  const bestMatch = matches[0];
  // Use indicator signals for trading decision
  if (bestMatch.signals.buy.length > 0) {
    // Execute buy signal
  }
}
```

### 3. Indicator-Based Trading Rules
Each indicator provides:
- **Entry Rules**: Conditions to enter a trade
- **Exit Rules**: Conditions to exit a trade
- **Stop Loss**: Risk management level
- **Take Profit**: Profit target level
- **Signals**: Buy/sell/neutral signals

## Storage

### Local Storage
```
data/indicators/
├── indicators_scalping.json
├── indicators_swing.json
└── indicators_position.json
```

### Google Drive (Future)
Indicators will be synced to Google Drive alongside patterns:
```
TradingPatterns/
├── pattern_bank.json
├── indicators_scalping.json
├── indicators_swing.json
└── indicators_position.json
```

## Benefits

✅ **Automatic Indicator Creation** - No manual coding required  
✅ **Style-Specific** - Different indicators for different trading styles  
✅ **Pattern-Based** - Built from actual learned patterns  
✅ **Dynamic Rules** - Trading rules adapt to pattern features  
✅ **Real-Time Evaluation** - Check market conditions against indicators  
✅ **Scalable** - Generate unlimited indicators from patterns  

## Example Workflow

1. **Learn Patterns**: System learns scalping patterns from 1min/5min data
2. **Generate Indicators**: Patterns automatically converted to indicators
3. **Get Indicators**: Query API for scalping indicators
4. **Evaluate Market**: Check if current market matches indicators
5. **Execute Trades**: Use indicator signals for trading decisions
6. **Learn More**: System learns from trade outcomes, improves indicators

## Next Steps

1. **Run Pattern Learning**: Let system learn patterns
   ```bash
   ./scripts/learn_backfill.sh
   ```

2. **Check Indicators**: View generated indicators
   ```bash
   curl http://localhost:3014/api/indicators/stats
   ```

3. **Evaluate Market**: Test indicator evaluation
   ```bash
   curl -X POST http://localhost:3014/api/indicators/evaluate \
     -H "Content-Type: application/json" \
     -d '{"symbol": "BTCUSDT", "timeframe": "1", "marketData": {...}}'
   ```

4. **Use in Trading**: Integrate indicators into trading logic

---

**Status:** ✅ Indicator Generation System Active  
**Trading Style:** Scalping (default)  
**Auto-Generation:** Enabled after pattern saves


