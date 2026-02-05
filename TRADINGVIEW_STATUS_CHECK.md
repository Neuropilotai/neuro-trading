# TradingView Status Check Guide

**Complete guide for monitoring and maintaining your TradingView webhook integration.**

---

## 🚀 Quick Status Check

**One-command check:**
```bash
cd /Users/davidmikulis/neuro-pilot-ai
./check_tradingview_status.sh
```

**With verification suite:**
```bash
./check_tradingview_status.sh --run-verify
```

This checks:
- ✅ Server process (port 3014)
- ✅ Health endpoint (200)
- ✅ Account endpoint (200) with balance/trades
- ✅ Recent trades (from ledger)
- ✅ ngrok status (optional)
- ✅ Verification suite availability

---

## 📋 Daily Routine Checklist

### Morning Check (Before Trading)

```bash
# 1. Quick status
./check_tradingview_status.sh

# 2. Verify server is running
curl http://localhost:3014/health | jq '.status'
# Expected: "healthy"

# 3. Check account
curl http://localhost:3014/api/account | jq '.balance, .totalTrades'

# 4. Check recent trades
sqlite3 ./data/trade_ledger.db "SELECT COUNT(*) FROM trades WHERE DATE(created_at) = DATE('now');"
```

### Evening Check (After Trading)

```bash
# 1. Full status with verification
./check_tradingview_status.sh --run-verify

# 2. Daily report
node backend/scripts/dailyReport.js

# 3. Review trades
sqlite3 ./data/trade_ledger.db "SELECT * FROM trades WHERE DATE(created_at) = DATE('now') ORDER BY created_at DESC;"
```

---

## 🔄 Restart Procedures

### Restart Webhook Server

**Option 1: Manual Restart**
```bash
# Kill existing server
lsof -ti:3014 | xargs kill -9

# Start server
cd /Users/davidmikulis/neuro-pilot-ai
export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
node simple_webhook_server.js
```

**Option 2: Keep Server Running (with caffeinate)**
```bash
# Prevent Mac from sleeping
caffeinate -d node simple_webhook_server.js

# Or run in background with nohup
nohup node simple_webhook_server.js > server.log 2>&1 &
```

**Option 3: Use Screen/Tmux**
```bash
# Start screen session
screen -S trading-server

# Inside screen:
export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
node simple_webhook_server.js

# Detach: Ctrl+A, then D
# Reattach: screen -r trading-server
```

### Restart ngrok and Update TradingView

**Step 1: Restart ngrok**
```bash
# Kill existing ngrok
pkill -f "ngrok http 3014"

# Start new ngrok
./setup_ngrok.sh

# Copy the new public URL (e.g., https://abc123.ngrok.io)
```

**Step 2: Update TradingView Alerts**

1. **Go to TradingView:** [https://www.tradingview.com/alerts](https://www.tradingview.com/alerts)
2. **For each alert:**
   - Click the three dots (⋯) → **Edit**
   - Update **Webhook URL** to: `https://your-new-ngrok-url.ngrok.io/webhook/tradingview`
   - Click **Save**

**Step 3: Verify Connection**
```bash
# Test new URL
curl -X POST https://your-new-ngrok-url.ngrok.io/health
# Expected: {"status":"healthy",...}
```

---

## 📊 Where to Check TradingView Alert Logs

### TradingView Web App

1. **Alert History:**
   - Go to: [https://www.tradingview.com/alerts](https://www.tradingview.com/alerts)
   - Click on an alert → **History** tab
   - See all trigger times and webhook responses

2. **Alert Status:**
   - Green dot = Active
   - Red dot = Paused
   - Yellow dot = Error (check webhook URL)

### ngrok Dashboard

1. **Request Logs:**
   - Visit: http://127.0.0.1:4040
   - Click on your webhook endpoint
   - See all incoming requests from TradingView
   - Check request/response details

2. **Request History:**
   - Shows timestamp, method, status code
   - Click any request to see full details

### Server Logs

**In your server terminal**, you'll see:
```
🚨 TradingView Alert Received: {...}
✅ Trade executed: TRADE_...
```

**Check server logs:**
```bash
# If using nohup
tail -f server.log

# If using screen
screen -r trading-server

# If running in foreground
# Logs appear directly in terminal
```

### Trade Ledger

```bash
# All trades
sqlite3 ./data/trade_ledger.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 10;"

# Today's trades
sqlite3 ./data/trade_ledger.db "SELECT * FROM trades WHERE DATE(created_at) = DATE('now') ORDER BY created_at DESC;"

# Failed trades
sqlite3 ./data/trade_ledger.db "SELECT * FROM trades WHERE status = 'REJECTED' ORDER BY created_at DESC;"
```

---

## 🐛 Troubleshooting

### Health Endpoint Fails

**Symptoms:** `./check_tradingview_status.sh` shows health endpoint FAIL

**Solutions:**
1. ✅ Check server is running:
   ```bash
   lsof -i :3014
   # Should show node process
   ```

2. ✅ Check server logs for errors:
   ```bash
   # If using nohup
   tail -20 server.log
   ```

3. ✅ Restart server:
   ```bash
   lsof -ti:3014 | xargs kill -9
   export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
   node simple_webhook_server.js
   ```

4. ✅ Check port conflicts:
   ```bash
   lsof -i :3014
   # If another process, kill it or change WEBHOOK_PORT
   ```

### Account Endpoint Fails

**Symptoms:** Account endpoint returns non-200

**Solutions:**
1. ✅ Check if paper trading is enabled:
   ```bash
   # In server, check ENABLE_PAPER_TRADING env var
   # Should be: ENABLE_PAPER_TRADING=true (or not set, defaults to true)
   ```

2. ✅ Check account service:
   ```bash
   curl http://localhost:3014/api/account
   # Should return JSON with balance, trades, etc.
   ```

3. ✅ Check data directory:
   ```bash
   ls -la data/
   # Should exist and be writable
   ```

### ngrok Not Running / URL Changed

**Symptoms:** WARN in status check, alerts not received

**Solutions:**
1. ✅ Restart ngrok:
   ```bash
   ./setup_ngrok.sh
   ```

2. ✅ Get new URL:
   ```bash
   curl -s http://127.0.0.1:4040/api/tunnels | jq '.tunnels[0].public_url'
   ```

3. ✅ Update TradingView alerts with new URL:
   - Go to: https://www.tradingview.com/alerts
   - Edit each alert
   - Update webhook URL
   - Save

4. ✅ Use static domain (paid ngrok):
   - Configure in ngrok dashboard
   - URL won't change on restart

5. ✅ Deploy to production (recommended):
   - Railway, Render, or Fly.io
   - Stable URL, no ngrok needed

### Alerts Not Triggering

**Symptoms:** No alerts received, signals on chart but no webhook calls

**Solutions:**
1. ✅ Check alert is enabled:
   - TradingView → Alerts
   - Verify alert has green dot (active)
   - Not paused or disabled

2. ✅ Verify alert condition:
   - Condition must match strategy signal name exactly
   - `🎯 Elite AI Long` or `🎯 Elite AI Short`

3. ✅ Check alert frequency:
   - Should be "Once Per Bar Close" (recommended)
   - Not "Once Per Bar" (may trigger too often)

4. ✅ Verify chart timeframe:
   - Signals may not trigger on all timeframes
   - Try different timeframes

5. ✅ Check TradingView account limits:
   - Free accounts have alert limits
   - Upgrade if needed

6. ✅ Test alert manually:
   - In TradingView, click "Test Webhook" (if available)
   - Or wait for natural signal

### 401 Unauthorized from TradingView

**Symptoms:** Server logs show 401, alerts rejected

**Solutions:**
1. ✅ Check webhook secret matches:
   ```bash
   # Server secret
   echo $TRADINGVIEW_WEBHOOK_SECRET
   
   # Should match TradingView alert settings
   # Expected: [YOUR_TRADINGVIEW_WEBHOOK_SECRET]
   ```

2. ✅ Verify signature format:
   - TradingView sends: `sha256=<hash>`
   - Check server logs for received signature

3. ✅ Check server environment:
   ```bash
   # Verify secret is set
   node -e "console.log(process.env.TRADINGVIEW_WEBHOOK_SECRET || 'NOT SET')"
   ```

4. ✅ Update TradingView alert:
   - Go to alert settings
   - Verify "Webhook Secret" field matches server secret
   - Save and retry

5. ✅ Check authentication is enabled:
   ```bash
   curl http://localhost:3014/health | jq '.features.auth'
   # Should be: true
   ```

---

## 📈 Monitoring Commands

### Quick Health Check
```bash
./check_tradingview_status.sh
```

### Detailed Status
```bash
# Server health
curl http://localhost:3014/health | jq '.'

# Account details
curl http://localhost:3014/api/account | jq '.'

# Recent trades
sqlite3 ./data/trade_ledger.db "SELECT trade_id, symbol, action, status, created_at FROM trades ORDER BY created_at DESC LIMIT 5;"
```

### Full Verification
```bash
export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
./scripts/verify_tradingview_webhook.sh
```

### ngrok Status
```bash
# Check if running
curl -s http://127.0.0.1:4040/api/tunnels | jq '.tunnels[0].public_url'

# Or visit dashboard
open http://127.0.0.1:4040
```

---

## 🔧 Maintenance Tasks

### Daily
- [ ] Run `./check_tradingview_status.sh`
- [ ] Check account balance
- [ ] Review recent trades
- [ ] Verify alerts are active in TradingView

### Weekly
- [ ] Review trade ledger for errors
- [ ] Check server logs for issues
- [ ] Verify ngrok URL hasn't changed
- [ ] Generate weekly report

### Monthly
- [ ] Review performance metrics
- [ ] Check for system updates
- [ ] Backup trade ledger
- [ ] Review and optimize strategy

---

## 📞 Quick Reference

**Status Check:**
```bash
./check_tradingview_status.sh
```

**Server Health:**
```bash
curl http://localhost:3014/health
```

**Account:**
```bash
curl http://localhost:3014/api/account
```

**Restart Server:**
```bash
lsof -ti:3014 | xargs kill -9 && node simple_webhook_server.js
```

**Restart ngrok:**
```bash
./setup_ngrok.sh
```

**TradingView Alerts:**
https://www.tradingview.com/alerts

**ngrok Dashboard:**
http://127.0.0.1:4040

---

**Last Updated:** 2026-01-20  
**Status:** Production Ready ✅
