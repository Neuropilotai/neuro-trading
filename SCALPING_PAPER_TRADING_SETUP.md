# Scalping Paper Trading Setup - $500 Starting Balance ✅

## Overview

The system is now configured for **scalping paper trading** with:
- **$500 starting balance** (configurable via `ACCOUNT_BALANCE`)
- **Scalping indicators** automatically used for trade decisions
- **Learning enabled** to improve profitability
- **Daily pattern tracking** for opening trends and time-based patterns
- **Performance monitoring** with detailed statistics

## Configuration

### Environment Variables

Add to your `.env` file:

```bash
# Paper Trading - $500 Starting Balance
ACCOUNT_BALANCE=500
ENABLE_PAPER_TRADING=true

# Scalping Configuration
TRADING_STYLE=scalping
ENABLE_INDICATOR_GENERATION=true

# Learning Configuration
ENABLE_TRADING_LEARNING=true
ENABLE_PATTERN_LEARNING=true
ENABLE_DAILY_PATTERN_TRACKING=true

# Pattern Learning (Scalping Focus)
LEARN_INTERVAL_MINUTES=1
LEARN_CONCURRENCY=4
```

## How It Works

### 1. Trade Execution Flow

```
TradingView Alert → Indicator Evaluation → Trade Execution → Learning → Pattern Tracking
```

1. **Alert Received**: TradingView sends scalping signal
2. **Indicator Match**: System checks if market conditions match scalping indicators
3. **Confidence Boost**: If indicator matches, confidence is boosted
4. **Trade Execution**: Order placed with indicator-based stop loss/take profit
5. **Learning**: System learns from trade outcome
6. **Pattern Tracking**: Daily patterns tracked (opening trends, hourly performance)

### 2. Scalping Indicators Integration

When a trade is executed:
- **Indicator Evaluation**: Market conditions checked against scalping indicators
- **Confidence Boost**: +20% confidence if indicator matches
- **Stop Loss/Take Profit**: Uses indicator rules if not specified
- **Signal Validation**: Only trades when indicators match

### 3. Learning System

The system learns:
- **Pattern Recognition**: Which patterns lead to profitable trades
- **Opening Trends**: Best times to trade (9-11 AM)
- **Hourly Performance**: Which hours are most profitable
- **Symbol Performance**: Which symbols perform best
- **Indicator Effectiveness**: Which indicators are most accurate

### 4. Daily Pattern Tracking

Tracks:
- **Opening Trends** (9-11 AM): Win rate, PnL, best hours
- **Hourly Performance**: Performance by hour of day
- **Day of Week**: Which days are most profitable
- **Symbol Performance**: Best/worst hours per symbol
- **Daily Summary**: Today's trading statistics

## API Endpoints

### Check Account Balance
```bash
curl http://localhost:3014/api/account
```

### Get Daily Patterns
```bash
# All daily pattern statistics
curl http://localhost:3014/api/patterns/daily | jq

# Opening trends only
curl http://localhost:3014/api/patterns/opening | jq

# Best trading times
curl http://localhost:3014/api/patterns/best-times | jq
```

### Get Learning Metrics
```bash
curl http://localhost:3014/api/learning | jq
```

### Get Indicator Statistics
```bash
curl http://localhost:3014/api/indicators/stats | jq
```

### Get Dashboard Data
```bash
curl http://localhost:3014/api/dashboard/trades | jq
curl http://localhost:3014/api/dashboard/positions | jq
curl http://localhost:3014/api/dashboard/account | jq
```

## Starting the System

### 1. Set Environment Variables
```bash
export ACCOUNT_BALANCE=500
export ENABLE_PAPER_TRADING=true
export TRADING_STYLE=scalping
export ENABLE_INDICATOR_GENERATION=true
export ENABLE_TRADING_LEARNING=true
export ENABLE_DAILY_PATTERN_TRACKING=true
```

Or add to `.env` file:
```bash
echo "ACCOUNT_BALANCE=500" >> .env
echo "ENABLE_PAPER_TRADING=true" >> .env
echo "TRADING_STYLE=scalping" >> .env
echo "ENABLE_INDICATOR_GENERATION=true" >> .env
echo "ENABLE_TRADING_LEARNING=true" >> .env
echo "ENABLE_DAILY_PATTERN_TRACKING=true" >> .env
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

### 5. Monitor Performance
```bash
# Watch account balance
watch -n 5 'curl -s http://localhost:3014/api/account | jq'

# Watch daily patterns
watch -n 10 'curl -s http://localhost:3014/api/patterns/daily | jq .dailySummary'

# Watch learning metrics
watch -n 10 'curl -s http://localhost:3014/api/learning | jq .metrics'
```

## Expected Results

### Scalping Performance
- **Trades**: Multiple trades per day (scalping frequency)
- **Hold Time**: 5-15 minutes per trade
- **Stop Loss**: 0.3-0.5% (tight stops)
- **Take Profit**: 0.5-1.5% (quick profits)
- **Win Rate**: Should improve over time as system learns

### Learning Improvements
- **Week 1**: System learns basic patterns
- **Week 2**: Opening trends identified
- **Week 3**: Best trading times discovered
- **Week 4**: Symbol-specific patterns learned

### Daily Patterns
- **Opening Trends**: 9-11 AM performance tracked
- **Best Hours**: Most profitable hours identified
- **Symbol Performance**: Best symbols for scalping
- **Daily Summary**: Today's PnL and win rate

## Monitoring Dashboard

Open in browser:
```
http://localhost:3014/trading_dashboard.html
```

The dashboard shows:
- Account balance and PnL
- Open positions
- Recent trades
- Learning metrics
- Daily patterns

## Profitability Tracking

### Daily Summary
```bash
curl http://localhost:3014/api/patterns/daily | jq .dailySummary
```

Shows:
- Today's trades
- Win rate
- Total PnL
- Wins vs losses

### Opening Trends
```bash
curl http://localhost:3014/api/patterns/opening | jq
```

Shows:
- Best opening hours (9-11 AM)
- Win rate by hour
- PnL by hour
- Average PnL per trade

### Best Trading Times
```bash
curl http://localhost:3014/api/patterns/best-times | jq
```

Shows:
- Top 5 best hours
- Top 5 worst hours
- Performance metrics

## Next Steps

1. **Start Trading**: Send TradingView alerts to webhook
2. **Monitor Learning**: Watch system learn from trades
3. **Track Patterns**: Monitor daily patterns and opening trends
4. **Optimize**: System automatically improves based on performance
5. **Scale**: Increase balance as profitability improves

---

**Status:** ✅ Scalping Paper Trading Configured  
**Starting Balance:** $500  
**Trading Style:** Scalping (1min, 5min)  
**Learning:** Enabled  
**Pattern Tracking:** Enabled


