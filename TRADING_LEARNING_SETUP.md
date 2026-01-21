# Trading Learning System Setup

**Date:** 2026-01-20  
**Status:** ✅ Implemented

---

## 🎯 Overview

The trading system now includes an **automatic learning service** that:
- ✅ **Automatically executes trades** from TradingView alerts (paper trading)
- ✅ **Learns from each trade** outcome (win/loss, PnL)
- ✅ **Tracks performance metrics** (win rate, profit factor, best symbols)
- ✅ **Adjusts strategy parameters** based on learning (confidence threshold, position size)
- ✅ **Saves learning state** persistently

---

## 🚀 How It Works

### 1. Automatic Trade Execution

When a TradingView alert arrives:
1. Webhook receives and validates alert
2. Risk engine checks limits
3. **Paper trading service executes the trade automatically**
4. Trade is saved to ledger
5. **Learning service analyzes the trade outcome**

### 2. Learning Process

After each trade:
- ✅ Win/loss tracking
- ✅ PnL calculation
- ✅ Symbol performance analysis
- ✅ Strategy performance tracking
- ✅ Confidence threshold adjustment
- ✅ Position size multiplier adjustment
- ✅ Risk adjustment based on recent performance

### 3. Learning Metrics

The system tracks:
- **Total trades** executed
- **Win rate** (winning trades / total trades)
- **Profit factor** (total wins / total losses)
- **Average win/loss** amounts
- **Best/worst performing symbols**
- **Top performing strategies**
- **Recommended confidence threshold**
- **Recommended position size multiplier**

---

## 📊 Endpoints

### Health Check (includes learning status)
```bash
curl http://localhost:3014/health | jq '.learning'
```

### Learning Metrics
```bash
curl http://localhost:3014/api/learning | jq '.'
```

**Response includes:**
- Total trades, win rate, profit factor
- Top 5 symbols by PnL
- Top 3 strategies by performance
- Learning insights (confidence threshold, position size multiplier)
- Best/worst symbols

### Account Summary
```bash
curl http://localhost:3014/api/account | jq '.'
```

---

## ⚙️ Configuration

### Environment Variables

```bash
# Enable paper trading (default: true)
ENABLE_PAPER_TRADING=true

# Enable learning (default: true)
ENABLE_TRADING_LEARNING=true

# Initial account balance
ACCOUNT_BALANCE=100000
```

### Feature Flags

Both features are **enabled by default**:
- Paper trading: `ENABLE_PAPER_TRADING !== 'false'`
- Learning: `ENABLE_TRADING_LEARNING !== 'false'`

---

## 📈 Learning Insights

The system automatically adjusts:

### 1. Confidence Threshold
- **High win rate (>60%)**: Lowers threshold (more aggressive)
- **Low win rate (<40%)**: Raises threshold (more conservative)
- Range: 0.6 - 0.9

### 2. Position Size Multiplier
- **High profit factor (>2.0)**: Increases position size (up to 1.5x)
- **Low profit factor (<1.0)**: Decreases position size (down to 0.5x)
- Range: 0.5x - 1.5x

### 3. Risk Adjustment
- Based on recent 10 trades
- **High recent win rate (>70%)**: Increases risk (up to 1.2x)
- **Low recent win rate (<30%)**: Decreases risk (down to 0.7x)

---

## 📁 Data Storage

### Learning State
- **File:** `data/trading_learning_state.json`
- **Saved:** Every 5 minutes + after each trade
- **Contains:** Metrics, symbol performance, strategy performance, insights

### Paper Trading State
- **File:** `data/paper_trading_state.json`
- **Saved:** Every minute
- **Contains:** Account balance, positions, PnL

---

## 🧪 Testing

### 1. Check Learning is Enabled

```bash
curl http://localhost:3014/health | jq '.features.learning'
# Should return: true
```

### 2. Send Test Trade

```bash
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784

BODY='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-learn-1","timestamp":'$(date +%s)',"secret":"'$TRADINGVIEW_WEBHOOK_SECRET'"}'

curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

### 3. Check Learning Metrics

```bash
curl http://localhost:3014/api/learning | jq '.'
```

**Expected output:**
```json
{
  "totalTrades": 1,
  "winningTrades": 0,
  "losingTrades": 0,
  "winRate": 0,
  "profitFactor": 0,
  "bestSymbol": null,
  "insights": {
    "confidenceThreshold": 0.7,
    "positionSizeMultiplier": 1.0,
    "riskAdjustment": 1.0
  },
  "topSymbols": [...],
  "topStrategies": [...]
}
```

### 4. Execute Multiple Trades

Send several trades (BUY and SELL) to see learning in action:

```bash
# Trade 1: BUY
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"learn-1","timestamp":'$(date +%s)',"secret":"'$TRADINGVIEW_WEBHOOK_SECRET'"}'

# Trade 2: SELL (close position)
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","action":"SELL","price":51000,"quantity":0.1,"alert_id":"learn-2","timestamp":'$(date +%s)',"secret":"'$TRADINGVIEW_WEBHOOK_SECRET'"}'

# Check learning metrics
curl http://localhost:3014/api/learning | jq '.winRate, .profitFactor, .insights'
```

---

## 📊 Learning Output Example

After several trades, you'll see:

```
🧠 Learning Update:
   Total Trades: 10
   Win Rate: 60.0%
   Profit Factor: 1.85
   Best Symbol: BTCUSDT (+$500.00)
   Confidence Threshold: 0.68
   Position Size Multiplier: 1.15x
```

---

## 🎯 Integration with TradingView

### Setup

1. **Start server:**
   ```bash
   export TRADINGVIEW_WEBHOOK_SECRET=your-secret
   export ENABLE_PAPER_TRADING=true
   export ENABLE_TRADING_LEARNING=true
   node simple_webhook_server.js
   ```

2. **Configure TradingView alerts:**
   - Use `ALERT_MESSAGE_BUY.txt` or `ALERT_MESSAGE_BUY_WITH_SECRET.txt`
   - Set webhook URL to your ngrok URL or production server
   - Enable alerts for `🎯 Elite AI Long` and `🎯 Elite AI Short`

3. **Monitor learning:**
   ```bash
   # Watch learning metrics update in real-time
   watch -n 5 'curl -s http://localhost:3014/api/learning | jq ".winRate, .profitFactor, .totalTrades"'
   ```

---

## 🔍 Troubleshooting

### Learning Not Working

1. **Check if enabled:**
   ```bash
   curl http://localhost:3014/health | jq '.features.learning'
   ```

2. **Check environment variable:**
   ```bash
   echo $ENABLE_TRADING_LEARNING
   # Should be: true or unset (defaults to true)
   ```

3. **Check server logs:**
   - Look for "🧠 Learning Update:" messages after trades
   - Check for errors in learning service

### Trades Not Executing

1. **Check paper trading enabled:**
   ```bash
   curl http://localhost:3014/health | jq '.features.paperTrading'
   ```

2. **Check account balance:**
   ```bash
   curl http://localhost:3014/api/account | jq '.balance'
   ```

3. **Check risk limits:**
   - Daily loss limit may be reached
   - Position size limits may be exceeded

---

## 📚 Next Steps

1. **Monitor learning metrics** as trades execute
2. **Review top performing symbols** and strategies
3. **Adjust TradingView strategy** based on learning insights
4. **Use recommended confidence threshold** in Pine Script
5. **Scale position sizes** based on profit factor

---

**System is now learning and creating trades automatically!** 🚀


