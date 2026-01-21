# Quick Start: Scalping Paper Trading with $500

## One-Command Start

```bash
./start_scalping_trading.sh
```

This will:
- ✅ Set starting balance to $500
- ✅ Enable scalping indicators
- ✅ Start learning daemon
- ✅ Start webhook server
- ✅ Enable daily pattern tracking

## Manual Start

### 1. Set Environment Variables
```bash
export ACCOUNT_BALANCE=500
export ENABLE_PAPER_TRADING=true
export TRADING_STYLE=scalping
export ENABLE_INDICATOR_GENERATION=true
export ENABLE_TRADING_LEARNING=true
export ENABLE_DAILY_PATTERN_TRACKING=true
```

### 2. Start Learning Daemon
```bash
./scripts/start_learning_daemon.sh
```

### 3. Run Backfill (Learn Patterns)
```bash
./scripts/learn_backfill.sh
```

### 4. Start Webhook Server
```bash
node simple_webhook_server.js
```

## Monitor Performance

### Watch Account Balance
```bash
watch -n 5 'curl -s http://localhost:3014/api/account | jq'
```

### Watch Daily Patterns
```bash
watch -n 10 'curl -s http://localhost:3014/api/patterns/daily | jq .dailySummary'
```

### Watch Opening Trends
```bash
watch -n 10 'curl -s http://localhost:3014/api/patterns/opening-trends | jq'
```

### Watch Best Trading Times
```bash
watch -n 10 'curl -s http://localhost:3014/api/patterns/best-times | jq'
```

## Dashboard

Open in browser:
```
http://localhost:3014/trading_dashboard.html
```

## What the System Does

1. **Receives TradingView Alerts** → Webhook endpoint
2. **Evaluates Scalping Indicators** → Checks if market matches learned patterns
3. **Executes Trades** → Uses indicator-based stop loss/take profit
4. **Learns from Outcomes** → Improves pattern recognition
5. **Tracks Daily Patterns** → Identifies best trading times
6. **Improves Over Time** → Gets more profitable as it learns

## Expected Results

- **Week 1**: System learns basic patterns
- **Week 2**: Opening trends identified (9-11 AM)
- **Week 3**: Best trading hours discovered
- **Week 4**: Symbol-specific patterns learned

## API Endpoints

- `GET /api/account` - Account balance and PnL
- `GET /api/patterns/daily` - Daily pattern statistics
- `GET /api/patterns/opening-trends` - Opening hour trends
- `GET /api/patterns/best-times` - Best/worst trading hours
- `GET /api/indicators/stats` - Indicator statistics
- `GET /api/learning` - Learning metrics

---

**Ready to start scalping!** 🚀


