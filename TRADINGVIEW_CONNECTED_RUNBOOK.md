# TradingView Connected Runbook

**Complete operational guide for maintaining TradingView webhook integration.**

---

## 🚀 Initial Setup (One-Time)

### Step 1: Start Server

```bash
cd /Users/davidmikulis/neuro-pilot-ai

# Set webhook secret
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784

# Start server
node simple_webhook_server.js
```

**Keep this terminal open** or run in background:
```bash
# Option 1: Background with nohup
nohup node simple_webhook_server.js > server.log 2>&1 &

# Option 2: Screen session
screen -S trading-server
# Inside screen: node simple_webhook_server.js
# Detach: Ctrl+A, then D
```

### Step 2: Start ngrok

**In a new terminal:**
```bash
cd /Users/davidmikulis/neuro-pilot-ai
./setup_ngrok.sh
```

**Copy the public URL** (e.g., `https://abc123.ngrok.io`)

### Step 3: Run Operations Check

```bash
cd /Users/davidmikulis/neuro-pilot-ai
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
./scripts/tradingview_ops.sh
```

This will show:
- ✅ Server status
- ✅ Health check
- ✅ Webhook URL to paste
- ✅ Alert message templates
- ✅ Verification results
- ✅ TradingView UI checklist

### Step 4: Add Strategy to TradingView Chart

1. **Open TradingView Chart:**
   - Go to: [https://www.tradingview.com/chart](https://www.tradingview.com/chart)
   - Select your trading pair (e.g., BTCUSDT)

2. **Open Pine Editor:**
   - Click **"Pine Editor"** tab at the bottom
   - If you see existing code, click **"New"** to start fresh

3. **Paste Strategy Code:**
   - Open `elite_v2_pinescript_clean.pine` from your repo
   - Copy all code (Cmd+A, Cmd+C)
   - Paste into Pine Editor (Cmd+V)

4. **Save and Add to Chart:**
   - Click **"Save"** (or press Cmd+S)
   - Click **"Add to Chart"** (or press Cmd+Enter)
   - Strategy will appear on your chart with indicators

5. **Enable Webhook Export (Important!):**
   - In chart settings, find **"📊 Elite Visuals"** group
   - Ensure **"📡 Enable Webhook Export"** is checked (true)
   - This enables the `🎯 Elite AI Long` and `🎯 Elite AI Short` alert conditions
   - If unchecked, these alertconditions won't exist and alerts cannot be created

### Step 5: Create Trading Alerts in TradingView

**Prerequisites:** Strategy must be added to chart and `enableWebhookExport` must be true.

1. **Go to Alerts:**
   - Click **"Alert"** button on chart (or go to [https://www.tradingview.com/alerts](https://www.tradingview.com/alerts))

2. **Create BUY Alert:**
   - Click **"Create Alert"** (or edit existing)
   - **Condition:** Select your strategy → `🎯 Elite AI Long`
     - If you don't see this option, ensure `enableWebhookExport` is true in strategy settings
   - **Webhook URL:** Paste from `tradingview_ops.sh` output (e.g., `https://abc123.ngrok.io/webhook/tradingview`)
   - **Webhook Secret:** `11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784`
   - **Alert Message:** Will auto-populate with:
     ```
     {"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}
     ```
     - This matches `ALERT_MESSAGE_BUY.txt` exactly (no manual copy needed)
   - **Frequency:** `Once Per Bar Close` (important: prevents duplicate alerts)
   - **Status:** Enabled (green dot)
   - Click **Save**

3. **Create SELL Alert:**
   - Click **"Create Alert"** again
   - **Condition:** Select your strategy → `🎯 Elite AI Short`
   - **Webhook URL:** Same as BUY alert (paste from `tradingview_ops.sh`)
   - **Webhook Secret:** Same as BUY alert
   - **Alert Message:** Will auto-populate with:
     ```
     {"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}
     ```
     - This matches `ALERT_MESSAGE_SELL.txt` exactly (no manual copy needed)
   - **Frequency:** `Once Per Bar Close`
   - **Status:** Enabled (green dot)
   - Click **Save**

**Note:** The alert message is automatically set by the Pine Script `alertcondition()` function. You don't need to manually copy from template files—TradingView will use the message defined in the strategy code.

---

## 🔄 When ngrok URL Changes

**ngrok free URLs change on restart.** Follow these steps:

### Step 1: Get New URL

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./scripts/tradingview_ops.sh
```

**Copy the new Webhook URL** from the output.

### Step 2: Update TradingView Alerts

1. **Go to:** [https://www.tradingview.com/alerts](https://www.tradingview.com/alerts)

2. **For each alert (BUY and SELL):**
   - Click the three dots (⋯) next to the alert → **Edit**
   - Update **Webhook URL** to the new URL from step 1
     - Format: `https://<new-ngrok-id>.ngrok.io/webhook/tradingview`
   - **Do NOT change the Alert Message** (it's automatically set by the strategy)
   - Click **Save**

**Important:** You only need to update the Webhook URL. The alert message, condition, and secret remain the same.

### Step 3: Verify Connection

```bash
# Test new URL
curl -X POST <new-webhook-url> \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: sha256=test" \
  -d '{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test","timestamp":1234567890}'
```

**Expected:** 401 (auth fails, but URL is reachable)

---

## 📅 Daily Routine

### Morning Check

```bash
cd /Users/davidmikulis/neuro-pilot-ai
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
./scripts/tradingview_ops.sh
```

**Verify:**
- ✅ Server health: OK
- ✅ Webhook URL: Available
- ✅ Verification: PASSED

### Check Alert Logs

1. **TradingView Alert History:**
   - Go to: [https://www.tradingview.com/alerts](https://www.tradingview.com/alerts)
   - Click on an alert (BUY or SELL) → **History** tab
   - Check for:
     - ✅ Green checkmarks = Success (200)
     - ❌ Red X = Failed (check error message)
     - ⏸️ Gray = Pending/Not triggered yet
   - Click on a history entry to see:
     - Request payload (should match template format)
     - Response status code
     - Error details (if any)

2. **ngrok Dashboard (Request Inspector):**
   - Visit: http://127.0.0.1:4040
   - Click **"Requests"** tab
   - See all incoming webhook requests:
     - Method: POST
     - Path: `/webhook/tradingview`
     - Status: 200 (success), 401 (auth failed), 400 (validation failed), 409 (duplicate)
   - Click a request to see:
     - Request headers (including `X-TradingView-Signature`)
     - Request body (JSON payload)
     - Response body (server response)

3. **Server Logs (Terminal Output):**
   ```bash
   # If using nohup
   tail -f server.log
   
   # If using screen
   screen -r trading-server
   
   # Look for lines like:
   # [INFO] Webhook received: BUY BTCUSDT @ 50000
   # [INFO] Trade executed: TRADE_1234567890_abc123
   # [ERROR] Invalid signature
   # [WARN] Duplicate alert detected
   ```

4. **Trade Ledger (Database):**
   ```bash
   # View today's trades
   sqlite3 ./data/trade_ledger.db "SELECT * FROM trades WHERE DATE(created_at) = DATE('now') ORDER BY created_at DESC;"
   
   # View all trades
   sqlite3 ./data/trade_ledger.db "SELECT trade_id, symbol, action, price, quantity, status, created_at FROM trades ORDER BY created_at DESC LIMIT 10;"
   ```

### Evening Check

```bash
# Full status
./check_tradingview_status.sh

# Generate daily report
node backend/scripts/dailyReport.js
```

---

## 🐛 Troubleshooting

### 401 Unauthorized from TradingView

**Symptoms:** Server logs show 401, alerts rejected

**Solutions:**
1. ✅ **Check webhook secret matches:**
   ```bash
   echo $TRADINGVIEW_WEBHOOK_SECRET
   # Should be: 11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
   ```

2. ✅ **Verify in TradingView:**
   - Go to alert settings
   - Check "Webhook Secret" field
   - Must match server secret exactly

3. ✅ **Check server authentication:**
   ```bash
   curl http://localhost:3014/health | jq '.features.auth'
   # Should be: true
   ```

### ngrok Not Running

**Symptoms:** `tradingview_ops.sh` shows "ngrok not running"

**Solutions:**
1. ✅ **Start ngrok:**
   ```bash
   ./setup_ngrok.sh
   ```

2. ✅ **Get new URL:**
   ```bash
   ./scripts/get_public_webhook_url.sh
   ```

3. ✅ **Update TradingView alerts** with new URL

4. ✅ **For production:** Deploy to Railway/Render for stable URL

### Health Fails

**Symptoms:** Health endpoint returns non-200

**Solutions:**
1. ✅ **Check server is running:**
   ```bash
   lsof -i :3014
   # Should show node process
   ```

2. ✅ **Check server logs:**
   ```bash
   tail -20 server.log
   # Or if using screen: screen -r trading-server
   ```

3. ✅ **Restart server:**
   ```bash
   lsof -ti:3014 | xargs kill -9
   export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
   node simple_webhook_server.js
   ```

### Alerts Not Triggering

**Symptoms:** Signals on chart but no webhook calls

**Solutions:**
1. ✅ **Check alert is enabled:**
   - TradingView → Alerts
   - Verify green dot (active)
   - Not paused

2. ✅ **Verify `enableWebhookExport` is true:**
   - In chart, open strategy settings
   - Find **"📊 Elite Visuals"** group
   - Ensure **"📡 Enable Webhook Export"** is checked (true)
   - If false, `🎯 Elite AI Long` and `🎯 Elite AI Short` alertconditions don't exist
   - **Fix:** Enable the toggle, then refresh alerts page

3. ✅ **Verify alert condition exists:**
   - In TradingView alert settings, check **Condition** dropdown
   - Must see `🎯 Elite AI Long` and `🎯 Elite AI Short` options
   - If missing, ensure `enableWebhookExport` is true in strategy settings
   - Strategy must be added to chart

4. ✅ **Verify alert condition matches:**
   - Selected condition must match strategy signal exactly
   - BUY alert → `🎯 Elite AI Long`
   - SELL alert → `🎯 Elite AI Short`

5. ✅ **Check alert frequency:**
   - Should be **"Once Per Bar Close"**
   - Not "Once Per Bar" (would trigger multiple times per bar)

4. ✅ **Verify webhook URL:**
   ```bash
   ./scripts/get_public_webhook_url.sh
   # Compare with TradingView alert settings
   ```

5. ✅ **Test alert manually:**
   - In TradingView, click "Test Webhook" (if available)
   - Or wait for natural signal

### Duplicates / Idempotency

**Symptoms:** Same alert processed multiple times

**Solutions:**
1. ✅ **This is expected behavior:**
   - Server returns 409 (Conflict) for duplicates
   - Prevents duplicate trades
   - Each alert must have unique `alert_id` + `timestamp`

2. ✅ **Verify idempotency:**
   ```bash
   ./scripts/verify_tradingview_webhook.sh
   # Should show: Duplicate Request (should return 409) ✅ PASS
   ```

3. ✅ **Check alert message:**
   - Must use `tv_{{time}}` in `alert_id` for uniqueness
   - Must use `{{time}}` for timestamp

---

## 📋 Quick Commands Reference

### Get Webhook URL
```bash
./scripts/get_public_webhook_url.sh
```

### Full Operations Check
```bash
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
./scripts/tradingview_ops.sh
```

### Status Check
```bash
./check_tradingview_status.sh
```

### Verification Suite
```bash
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
./scripts/verify_tradingview_webhook.sh
```

### Restart ngrok
```bash
pkill -f "ngrok http 3014"
./setup_ngrok.sh
```

### Restart Server
```bash
lsof -ti:3014 | xargs kill -9
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
node simple_webhook_server.js
```

---

## 🎯 Success Criteria

System is "connected" when:
- ✅ Server running and healthy (200)
- ✅ ngrok running with public URL
- ✅ Webhook URL accessible
- ✅ TradingView alerts configured with correct URL
- ✅ Verification suite passes
- ✅ Alerts triggering and trades executing

---

## 📞 Support Resources

- **TradingView Alerts:** https://www.tradingview.com/alerts
- **ngrok Dashboard:** http://127.0.0.1:4040
- **Server Health:** http://localhost:3014/health
- **Account Status:** http://localhost:3014/api/account

---

**Last Updated:** 2026-01-20  
**Status:** Production Ready ✅

