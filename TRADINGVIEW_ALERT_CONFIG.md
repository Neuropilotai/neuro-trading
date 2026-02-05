# TradingView Alert Configuration - Complete Guide

**Complete step-by-step guide for setting up TradingView webhook alerts with your trading system.**

---

## 📋 Prerequisites

Before starting, ensure:
- ✅ Your webhook server is running (`node simple_webhook_server.js`)
- ✅ You have a TradingView account (free account works)
- ✅ ngrok is installed (for testing) or you have a production deployment

---

## 🎯 Step 1: Add Pine Script to TradingView

### A. Open TradingView

1. Go to **[TradingView.com](https://www.tradingview.com)** and sign in
2. **Open any chart** (e.g., BTC/USD, SPY, AAPL)
3. **Important:** Pine Editor is only available on TradingView web/desktop, not mobile

### B. Open Pine Editor

1. At the **bottom of the screen**, find the **"Pine Editor"** tab
   - If you don't see it, click the **"+"** button at the bottom and select **"Pine Editor"**
2. You'll see a blank editor with default code

### C. Add Your Strategy

1. **Open your Pine Script file:**
   ```bash
   cd /Users/davidmikulis/neuro-pilot-ai
   cat elite_v2_pinescript_clean.pine | pbcopy  # Copies to clipboard
   ```

2. **In TradingView Pine Editor:**
   - **Delete ALL** the default code (select all and delete)
   - **Paste** your code (Cmd+V / Ctrl+V)
   - Click **"Save"** (top right) - name it "Elite AI Strategy"
   - Click **"Add to Chart"** (top right)

3. **Verify it's working:**
   - You should see the strategy on your chart
   - Look for buy/sell signals (arrows)
   - Check the AI dashboard in the top-right corner

---

## 🌐 Step 2: Get Public Webhook URL

Your server runs on `localhost:3014`, but TradingView needs a public URL.

### Option A: Use ngrok (Recommended for Testing)

**Quick Setup:**
```bash
cd /Users/davidmikulis/neuro-pilot-ai
./setup_ngrok.sh
```

This script will:
- ✅ Check if server is running
- ✅ Start ngrok tunnel
- ✅ Extract public URL automatically
- ✅ Print webhook URL and test command

**Manual Setup:**
```bash
# Terminal 1: Start server (if not running)
cd /Users/davidmikulis/neuro-pilot-ai
export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
node simple_webhook_server.js

# Terminal 2: Start ngrok
ngrok http 3014
```

**Copy the HTTPS URL** (e.g., `https://abc123.ngrok.io`)

### Option B: Deploy to Production

For 24/7 operation, deploy to:
- **Railway:** Already configured (see `railway.toml`)
- **Render:** Use `render.yaml`
- **Fly.io:** Use `fly.toml`

---

## 🚨 Step 3: Create TradingView Alerts

### A. Create BUY Alert

1. **Right-click anywhere on the chart** → **"Create Alert"** or **"Add Alert"**

2. **Condition Tab:**
   - **Condition:** Select your strategy → `🎯 Elite AI Long`
   - **Expiration:** `Never` (or set end date)
   - **Frequency:** `Once Per Bar Close` (recommended)

3. **Webhook URL Tab:**
   - **Webhook URL:** `https://your-ngrok-url.ngrok.io/webhook/tradingview`
     - Replace with your actual ngrok URL from Step 2
   - **Webhook Secret:** `[YOUR_TRADINGVIEW_WEBHOOK_SECRET]`

4. **Message Tab:**
   - **Option A (HMAC Header Auth - Recommended):**
     - Copy from `ALERT_MESSAGE_BUY.txt`:
     ```
     {"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}
     ```
   - **Option B (Body Secret Auth - Alternative):**
     - Copy from `ALERT_MESSAGE_BUY_WITH_SECRET.txt`:
     ```
     {"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}},"secret":"[YOUR_TRADINGVIEW_WEBHOOK_SECRET]"}
     ```
   - **Important:** Paste exactly as shown (no arithmetic in JSON)

5. **Click "Create"**

### B. Create SELL Alert

Repeat the same steps, but:
- **Condition:** `🎯 Elite AI Short`
- **Message:**
  - **Option A (HMAC Header Auth):** Copy from `ALERT_MESSAGE_SELL.txt`
  - **Option B (Body Secret Auth):** Copy from `ALERT_MESSAGE_SELL_WITH_SECRET.txt`
  ```
  {"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}
  ```
  or with secret:
  ```
  {"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}},"secret":"[YOUR_TRADINGVIEW_WEBHOOK_SECRET]"}
  ```

---

## ✅ Step 4: Verify Your Setup

### A. Run Verification Script

```bash
cd /Users/davidmikulis/neuro-pilot-ai
export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
./scripts/verify_tradingview_webhook.sh
```

This tests:
- ✅ Health endpoint
- ✅ Invalid signature (401)
- ✅ Missing signature (401)
- ✅ Valid body secret (200)
- ✅ Invalid body secret (401)
- ✅ Missing required fields with body secret (400)
- ✅ Valid HMAC signature (200)
- ✅ Missing fields (400)
- ✅ Idempotency (409 on duplicate)
- ✅ ngrok public URL (if running)

### B. Manual Verification

**Check server health:**
```bash
curl http://localhost:3014/health | jq '.'
```

**Check account:**
```bash
curl http://localhost:3014/api/account | jq '.'
```

### C. Test Alert in TradingView

1. **Wait for a signal** to trigger naturally
2. **Or manually trigger** (if TradingView allows)
3. **Check server logs** - should see:
   ```
   🚨 TradingView Alert Received
   ✅ Trade executed
   ```

---

## 🔐 Authentication Methods

The webhook server supports **two authentication methods**:

### Method 1: HMAC Signature Header (Recommended)

**How it works:**
- TradingView automatically signs the request with your webhook secret
- Server verifies the `X-TradingView-Signature` header
- Most secure method, recommended for production

**Setup:**
- Configure "Webhook Secret" in TradingView alert settings
- Server uses `TRADINGVIEW_WEBHOOK_SECRET` environment variable
- TradingView handles signature generation automatically

**Alert Message:** Use `ALERT_MESSAGE_BUY.txt` or `ALERT_MESSAGE_SELL.txt` (no secret field needed)

### Method 2: Body Secret (Alternative)

**How it works:**
- Include `"secret"` field in the JSON payload
- Server compares secret with `TRADINGVIEW_WEBHOOK_SECRET`
- Useful if TradingView doesn't support webhook secrets in your plan

**Setup:**
- Use `ALERT_MESSAGE_BUY_WITH_SECRET.txt` or `ALERT_MESSAGE_SELL_WITH_SECRET.txt`
- Secret is included in the JSON payload
- Server removes secret from body after authentication (not logged/stored)

**Priority:** If both header and body secret are present, header auth is checked first.

---

## 🎯 What Happens When Alert Triggers

1. **TradingView** sends alert to your webhook URL
2. **Server** receives and authenticates using one of two methods:
   - **Method 1:** HMAC signature header (`X-TradingView-Signature`)
   - **Method 2:** Body secret field (`"secret"` in JSON)
3. **Validates** payload (required fields: symbol, action, price, quantity, alert_id, timestamp)
4. **Checks** for duplicates (same alert_id + timestamp = 409 Conflict)
5. **Computes defaults** (stop_loss and take_profit if missing):
   - BUY: SL = price * 0.98, TP = price * 1.02
   - SELL: SL = price * 1.02, TP = price * 0.98
6. **Risk engine** validates order (position size, daily limits)
7. **Paper trading** executes order
8. **Trade ledger** saves immutable record
9. **Response** sent back to TradingView

---

## 🐛 Troubleshooting

### Alert Not Triggering

**Symptoms:** No alerts received, no signals on chart

**Solutions:**
- ✅ Check strategy is added to chart (should see signals)
- ✅ Verify alert condition matches signal name exactly: `🎯 Elite AI Long` or `🎯 Elite AI Short`
- ✅ Check alert is enabled (not paused) in TradingView alerts list
- ✅ Verify chart timeframe (signals may not trigger on all timeframes)
- ✅ Check Pine Script is saved and compiled without errors

### Webhook Not Receiving Alerts

**Symptoms:** Alert triggers in TradingView but server doesn't receive it

**Solutions:**
- ✅ Check ngrok is running: `curl http://127.0.0.1:4040/api/tunnels`
- ✅ Verify webhook URL in TradingView matches ngrok URL exactly
- ✅ Check server is running: `curl http://localhost:3014/health`
- ✅ Test webhook URL manually:
  ```bash
  curl -X POST https://your-ngrok-url.ngrok.io/webhook/tradingview \
    -H "Content-Type: application/json" \
    -H "X-TradingView-Signature: sha256=test" \
    -d '{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test","timestamp":1234567890}'
  ```
- ✅ Check ngrok dashboard: `open http://127.0.0.1:4040` (see request history)

### 401 Unauthorized

**Symptoms:** Server returns 401, alert rejected

**Solutions:**

**If using HMAC Header Auth:**
- ✅ Check `TRADINGVIEW_WEBHOOK_SECRET` matches in server and TradingView
  - Server: Check environment variable
  - TradingView: Check "Webhook Secret" field in alert settings
- ✅ Verify signature format: TradingView should send `sha256=<hash>`
- ✅ Check server logs for signature verification errors

**If using Body Secret Auth:**
- ✅ Verify `"secret"` field in alert message matches `TRADINGVIEW_WEBHOOK_SECRET`
- ✅ Check secret is included in JSON payload (not in header)
- ✅ Ensure secret value is exactly: `[YOUR_TRADINGVIEW_WEBHOOK_SECRET]`
- ✅ Check server logs for "Invalid body secret" messages

**General:**
- ✅ Ensure at least one authentication method is provided (header OR body secret)
- ✅ If both are provided, header auth takes priority

### 400 Bad Request

**Symptoms:** Server returns 400, validation failed

**Solutions:**
- ✅ Check JSON format in alert message (no arithmetic expressions)
- ✅ Verify required fields are present:
  - `symbol` (string)
  - `action` ("BUY" or "SELL")
  - `price` (number)
  - `quantity` (number)
  - `alert_id` (string)
  - `timestamp` (number)
- ✅ Check for JSON syntax errors (commas, quotes)
- ✅ **Important:** Do NOT use expressions like `{{close}}*0.98` in JSON
  - Server will compute stop_loss/take_profit automatically if missing

### 409 Conflict (Duplicate Alert)

**Symptoms:** Second alert with same alert_id returns 409

**Solutions:**
- ✅ This is **expected behavior** - idempotency protection
- ✅ Each alert must have unique `alert_id` + `timestamp`
- ✅ Use `tv_{{time}}` in alert_id to ensure uniqueness

### Trade Not Executing

**Symptoms:** Alert received but no trade in account

**Solutions:**
- ✅ Check `ENABLE_PAPER_TRADING=true` (default: true)
- ✅ Check `TRADING_ENABLED=true` (kill switch, default: true)
- ✅ Verify risk limits not exceeded:
  - Daily loss limit
  - Position size limit
  - Max open positions
- ✅ Check server logs for execution errors
- ✅ Verify account balance: `curl http://localhost:3014/api/account | jq '.balance'`

### ngrok URL Changed

**Symptoms:** Alerts stop working after ngrok restart

**Solutions:**
- ✅ ngrok free URLs change on restart
- ✅ Update webhook URL in TradingView alerts
- ✅ Or use ngrok static domain (paid plan)
- ✅ Or deploy to production (Railway/Render) for stable URL

### Strategy Not Producing Signals

**Symptoms:** No buy/sell signals on chart

**Solutions:**
- ✅ Check Pine Script compiled without errors (red lines in editor)
- ✅ Verify strategy settings (risk mode, confidence threshold)
- ✅ Check market conditions (signals only trigger when conditions met)
- ✅ Try different timeframes or symbols
- ✅ Review strategy logic in Pine Script

---

## 📚 Quick Reference

### Alert Message Templates

**Alert Message Templates:**

**Method 1: HMAC Header Auth (Recommended):**
- **BUY Alert** (`ALERT_MESSAGE_BUY.txt`):
```json
{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}
```

- **SELL Alert** (`ALERT_MESSAGE_SELL.txt`):
```json
{"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}
```

**Method 2: Body Secret Auth (Alternative):**
- **BUY Alert** (`ALERT_MESSAGE_BUY_WITH_SECRET.txt`):
```json
{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}},"secret":"[YOUR_TRADINGVIEW_WEBHOOK_SECRET]"}
```

- **SELL Alert** (`ALERT_MESSAGE_SELL_WITH_SECRET.txt`):
```json
{"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}},"secret":"[YOUR_TRADINGVIEW_WEBHOOK_SECRET]"}
```

**Important Notes:**
- ✅ Use only literal substitutions: `{{ticker}}`, `{{close}}`, `{{time}}`
- ❌ Do NOT use arithmetic: `{{close}}*0.98` (invalid JSON)
- ✅ Server computes `stop_loss` and `take_profit` automatically if missing
- ✅ If using body secret auth, secret is removed from body after authentication (not logged/stored)

### Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `symbol` | string | Trading pair | "BTCUSDT" |
| `action` | string | "BUY" or "SELL" | "BUY" |
| `price` | number | Entry price | 50000 |
| `quantity` | number | Position size | 0.1 |
| `alert_id` | string | Unique identifier | "tv_1234567890" |
| `timestamp` | number | Unix timestamp | 1234567890 |

### Optional Fields (Server Computes Defaults)

| Field | Type | Default (BUY) | Default (SELL) |
|-------|------|---------------|----------------|
| `stop_loss` | number | price * 0.98 | price * 1.02 |
| `take_profit` | number | price * 1.02 | price * 0.98 |

### URLs

- **Local Server:** `http://localhost:3014`
- **Health Check:** `http://localhost:3014/health`
- **Account:** `http://localhost:3014/api/account`
- **Webhook:** `http://localhost:3014/webhook/tradingview` (use ngrok URL in TradingView)

### Secrets

- **Webhook Secret:** `[YOUR_TRADINGVIEW_WEBHOOK_SECRET]`
- Set in server: `export TRADINGVIEW_WEBHOOK_SECRET=...`
- Set in TradingView: "Webhook Secret" field in alert settings

---

## 🎉 Success Checklist

- [ ] Pine Script added to TradingView chart
- [ ] Strategy showing signals on chart
- [ ] Server running on port 3014
- [ ] ngrok running (or production deployed)
- [ ] Public webhook URL obtained
- [ ] BUY alert created with `🎯 Elite AI Long` condition
- [ ] SELL alert created with `🎯 Elite AI Short` condition
- [ ] Webhook URL set in both alerts
- [ ] Alert messages use valid JSON (no arithmetic)
- [ ] Webhook secret matches in both places
- [ ] Alerts enabled (not paused)
- [ ] Verification script passes all tests
- [ ] Test alert received and trade executed

---

## 📞 Next Steps After Setup

1. **Monitor trades** via `/api/account` endpoint
2. **Check trade ledger** for all executed trades:
   ```bash
   sqlite3 ./data/trade_ledger.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 10;"
   ```
3. **Generate daily reports:**
   ```bash
   node backend/scripts/dailyReport.js
   ```
4. **Adjust risk settings** in Pine Script or server environment variables
5. **Deploy to production** (Railway, Render, etc.) for 24/7 operation

---

## 🔍 Daily Connection Check Routine

**IMPORTANT:** ngrok URLs change when you restart ngrok. TradingView alerts will silently fail if the URL doesn't match.

### Quick Check Script

Run this daily (or whenever you restart ngrok):

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./scripts/check_tradingview_connection.sh
```

**What it checks:**
- ✅ Server health
- ✅ ngrok status and current URL
- ✅ URL configuration match
- ✅ Last webhook telemetry age
- ✅ Connection recommendations

**Sample Output:**
```
🔍 TradingView Connection Auditor
==================================

1️⃣  Server Health Check
   ✅ PASS - Server is healthy

2️⃣  ngrok Status Check
   ✅ PASS - ngrok is running
   Public URL: https://abc123.ngrok-free.app

3️⃣  URL Configuration Check
   Expected URL: https://xyz789.ngrok-free.app
   ❌ FAIL - URL mismatch detected!
   
   📋 ACTION REQUIRED:
   Update TradingView alert webhook URL to:
   https://abc123.ngrok-free.app/webhook/tradingview

4️⃣  Last Webhook Telemetry
   Last webhook: 2026-01-21T12:00:00Z
   Age: 2 hours ago
   ✅ PASS - Recent webhook received

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Audit Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Passed: 2
Failed: 1
Warnings: 0

❌ FAIL - Issues detected. Review output above.
```

### When ngrok URL Changes

**If the check script shows a URL mismatch:**

1. **Copy the new ngrok URL** from the script output
2. **Update TradingView alerts:**
   - Go to TradingView.com → Alerts (bell icon)
   - Find your alerts (🎯 Elite AI Long, 🎯 Elite AI Short)
   - Click "Edit" on each alert
   - Update "Webhook URL" to: `https://NEW-URL.ngrok-free.app/webhook/tradingview`
   - Click "Save"
3. **Update environment variable (optional but recommended):**
   ```bash
   # Add to .env file
   TRADINGVIEW_PUBLIC_WEBHOOK_URL=https://NEW-URL.ngrok-free.app
   ```
4. **Re-run the check script** to verify:
   ```bash
   ./scripts/check_tradingview_connection.sh
   ```

### API Endpoints for Monitoring

**Check telemetry:**
```bash
curl http://localhost:3014/api/tradingview/telemetry | jq
```

**Check connection status:**
```bash
curl http://localhost:3014/api/tradingview/connection | jq
```

**Response includes:**
- Server health
- ngrok detected URL
- Expected URL from config
- Webhook endpoint URL
- Last webhook details
- Recommendations for fixing issues

### Recommended Daily Routine

1. **Morning:** Run connection check
   ```bash
   ./scripts/check_tradingview_connection.sh
   ```

2. **If URL changed:** Update TradingView alerts (see above)

3. **Verify:** Check last webhook was recent
   ```bash
   curl http://localhost:3014/api/tradingview/telemetry | jq '.telemetry.ageFormatted'
   ```

4. **Monitor:** Watch for alerts during trading hours

### Body Secret Templates (Recommended)

If you're using body secret auth (instead of HMAC header), use these templates:

**BUY Alert Message:**
```json
{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}},"secret":"[YOUR_TRADINGVIEW_WEBHOOK_SECRET]"}
```

**SELL Alert Message:**
```json
{"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}},"secret":"[YOUR_TRADINGVIEW_WEBHOOK_SECRET]"}
```

**Note:** The secret is automatically removed from the body after authentication and never logged or stored.

---

## 🔒 Security Notes

- ✅ HMAC signature verification prevents unauthorized requests
- ✅ Rate limiting prevents abuse (10 requests/minute)
- ✅ Input validation prevents malformed payloads
- ✅ Idempotency prevents duplicate trades
- ✅ Risk engine enforces position and loss limits

**Keep your webhook secret secure!** Never commit it to version control.

---

## 📖 Additional Resources

- **Pine Script Documentation:** https://www.tradingview.com/pine-script-docs/
- **TradingView Alerts:** https://www.tradingview.com/support/solutions/43000529348-webhooks/
- **ngrok Documentation:** https://ngrok.com/docs

---

**Your automated trading system is now ready! 🚀**
