# 🚀 Quick Start Guide - Complete Trading System

## What You Have

A complete, production-ready trading system with:
- ✅ Multi-symbol scanning (all symbols, not just BTC)
- ✅ Whale detection (follows institutional activity)
- ✅ Pattern learning (always-on, Google Drive storage)
- ✅ Automated trading (80%+ accuracy target)
- ✅ Connection auditor (prevents silent failures)
- ✅ Real-time monitoring dashboards

## 🎯 5-Minute Quick Start

### Step 1: Start the System

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./start_scalping_trading.sh
```

This will:
- ✅ Check and kill any process on port 3014
- ✅ Start the webhook server
- ✅ Start the learning daemon
- ✅ Initialize all services

### Step 2: Open Monitor

```bash
./open_monitor.sh
```

Or manually:
```
http://localhost:3014/monitor
```

### Step 3: Check System Status

```bash
# Check connection
./scripts/check_tradingview_connection.sh

# Check telemetry
curl http://localhost:3014/api/tradingview/telemetry | jq

# Check whale signals
curl http://localhost:3014/api/whales/signals | jq
```

## 📊 Key URLs

### Dashboards
- **System Monitor**: http://localhost:3014/monitor
- **Trading Dashboard**: http://localhost:3014/trading_dashboard.html

### API Endpoints
- **Health**: http://localhost:3014/health
- **Account**: http://localhost:3014/api/account
- **Status**: http://localhost:3014/api/automated/status
- **Whale Signals**: http://localhost:3014/api/whales/signals
- **Telemetry**: http://localhost:3014/api/tradingview/telemetry
- **Connection**: http://localhost:3014/api/tradingview/connection

## 🔍 Daily Routine

### Morning Check

```bash
# 1. Check connection status
./scripts/check_tradingview_connection.sh

# 2. Check last webhook
curl -s http://localhost:3014/api/tradingview/telemetry | jq '.telemetry.ageFormatted'

# 3. View whale activity
curl -s http://localhost:3014/api/whales/signals | jq '.signals[] | {symbol, signal, volumeRatio}'
```

### Monitor During Day

```bash
# Watch system monitor
open http://localhost:3014/monitor

# Or check status periodically
watch -n 30 'curl -s http://localhost:3014/api/automated/status | jq'
```

## 🐋 Whale Detection

The system automatically:
- Detects volume spikes (3x+ = whale)
- Identifies large price movements
- Boosts opportunity scores for whale activity
- Prioritizes trades with whale signals

**Check whale activity:**
```bash
curl http://localhost:3014/api/whales/signals | jq
```

## 🔍 Connection Monitoring

**Prevent silent failures:**
```bash
# Daily check
./scripts/check_tradingview_connection.sh

# If URL changed, update TradingView alerts
# Script will show exact URL to paste
```

## 📈 What the System Does

1. **Scans all symbols** (BTCUSDT, ETHUSDT, SOLUSDT, SPY, QQQ, AAPL, TSLA, NVDA)
2. **Detects whale activity** (large volume/price movements)
3. **Ranks opportunities** (confidence + profit + risk + whale signals)
4. **Executes trades** (automatically when confidence threshold met)
5. **Learns from patterns** (continuous improvement)
6. **Monitors connection** (prevents silent failures)

## 🎯 Configuration

### Add More Symbols

Edit `config/tradingview_universe.json`:
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
    "NVDA",
    "YOUR_SYMBOL_HERE"
  ]
}
```

### Adjust Trading Parameters

Edit `.env`:
```bash
# Confidence threshold (0.80 = 80%)
AUTO_TRADE_MIN_CONFIDENCE=0.80

# Target accuracy
TARGET_ACCURACY=0.80

# Position size (% of balance)
AUTO_POSITION_SIZE_PERCENT=2.0

# Max trades per day
MAX_TRADES_PER_DAY=50
```

### Whale Detection Settings

```bash
# Volume thresholds
WHALE_VOLUME_SPIKE_THRESHOLD=3.0    # 3x = whale
WHALE_LARGE_VOLUME_THRESHOLD=5.0    # 5x = big whale

# Signal thresholds
WHALE_MIN_SIGNAL=0.6                # Minimum to consider
WHALE_STRONG_SIGNAL=0.8              # Strong whale signal
```

## 🚨 Troubleshooting

### System Not Starting

```bash
# Check if port is in use
lsof -i :3014

# Kill process if needed
kill -9 $(lsof -ti:3014)

# Start again
./start_scalping_trading.sh
```

### No Whale Signals

```bash
# Check if enabled
curl -s http://localhost:3014/api/whales/stats | jq '.stats.enabled'

# Lower thresholds if needed
export WHALE_VOLUME_SPIKE_THRESHOLD=2.0
```

### Connection Check Fails

```bash
# Check server health
curl http://localhost:3014/health

# Check ngrok
curl http://127.0.0.1:4040/api/tunnels | jq

# Update expected URL
export TRADINGVIEW_PUBLIC_WEBHOOK_URL=https://your-ngrok-url.ngrok-free.app
```

## 📚 Documentation

- **System Overview**: `SYSTEM_COMPLETE_SUMMARY.md`
- **Multi-Symbol Scalping**: `MULTI_SYMBOL_SCALPING.md`
- **Whale Detection**: `WHALE_DETECTION_AGENT.md`
- **Connection Auditor**: `TRADINGVIEW_CONNECTION_AUDITOR.md`
- **Pattern Learning**: `PATTERN_LEARNING_ALWAYS_ON.md`

## 🎉 You're Ready!

Your system is now:
- ✅ Scanning all symbols
- ✅ Detecting whale activity
- ✅ Learning from patterns
- ✅ Executing trades automatically
- ✅ Monitoring connections

**Start trading: `./start_scalping_trading.sh`** 🚀

