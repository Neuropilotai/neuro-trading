# Quick Access Guide

## Open System Monitor

### Option 1: Use the Script (Easiest)
```bash
./open_monitor.sh
```

### Option 2: Open in Browser Manually
**macOS:**
```bash
open http://localhost:3014/monitor
```

**Or just copy and paste this URL into your browser:**
```
http://localhost:3014/monitor
```

## All Available URLs

### Monitoring & Dashboards
- **System Monitor**: http://localhost:3014/monitor
- **Trading Dashboard**: http://localhost:3014/trading_dashboard.html
- **Health Check**: http://localhost:3014/health

### API Endpoints
- **Account**: http://localhost:3014/api/account
- **Performance**: http://localhost:3014/api/automated/performance
- **Status**: http://localhost:3014/api/automated/status
- **Positions**: http://localhost:3014/api/dashboard/positions
- **Trades**: http://localhost:3014/api/dashboard/trades
- **Daily Patterns**: http://localhost:3014/api/patterns/daily
- **Indicators**: http://localhost:3014/api/indicators

### TradingView Integration
- **Export Trades**: http://localhost:3014/api/tradingview/export?format=csv
- **Get Trades**: http://localhost:3014/api/tradingview/trades

## Quick Commands

### Check if Server is Running
```bash
curl http://localhost:3014/health
```

### Open Monitor
```bash
./open_monitor.sh
```

### View Performance
```bash
curl http://localhost:3014/api/automated/performance | jq
```

### View Account
```bash
curl http://localhost:3014/api/account | jq
```


