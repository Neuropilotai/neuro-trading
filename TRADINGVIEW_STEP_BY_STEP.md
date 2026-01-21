# TradingView Setup - Step-by-Step Visual Guide

**Complete walkthrough for adding Pine Script to TradingView**

---

## 📊 Step 1: Open TradingView

1. Go to **[TradingView.com](https://www.tradingview.com)**
2. **Sign in** (or create a free account)
3. Open any chart (e.g., BTC/USD, SPY, AAPL)

---

## 📝 Step 2: Open Pine Script Editor

1. At the **bottom of the screen**, find the **"Pine Editor"** tab
   - If you don't see it, click the **"+"** button at the bottom and select **"Pine Editor"**

2. You'll see a blank editor with default code like:
   ```pine
   //@version=5
   indicator("My Script")
   plot(close)
   ```

---

## 📋 Step 3: Copy Your Pine Script

1. **Open your Pine Script file:**
   - File: `elite_v2_pinescript_clean.pine`
   - Location: `/Users/davidmikulis/neuro-pilot-ai/elite_v2_pinescript_clean.pine`

2. **Select ALL the code** (Cmd+A / Ctrl+A)

3. **Copy it** (Cmd+C / Ctrl+C)

---

## 📥 Step 4: Paste Into TradingView

1. **In TradingView Pine Editor:**
   - **Delete ALL the default code** (select all and delete)
   - **Paste your code** (Cmd+V / Ctrl+V)

2. You should see your strategy code with:
   - `//@version=5`
   - `strategy("Elite AI Trading Strategy", ...)`
   - Lots of input parameters
   - AI logic and signals

---

## 💾 Step 5: Save and Add to Chart

1. **Click "Save"** button (top right of Pine Editor)
   - Name it: `"Elite AI Trading Strategy"` or any name you like
   - Click **"Save"**

2. **Click "Add to Chart"** button (top right, next to Save)
   - The strategy will appear on your chart
   - You should see:
     - Buy/sell signals (arrows)
     - AI confidence indicators
     - Background colors showing market regime

---

## ⚙️ Step 6: Configure Strategy Settings

1. **On the chart**, find your strategy name in the indicator list (top left)
2. **Click the gear icon** ⚙️ next to your strategy name
3. **In the Properties tab:**
   - **Initial Capital:** `100000` (or your starting balance)
   - **Base Currency:** `USD`
   - **Order Size:** `25% of equity` (or adjust as needed)
   - **Commission:** Set to your broker's rate (0.1% default)
   - **Slippage:** `5 ticks`

4. **Click "OK"** to save settings

---

## 🚨 Step 7: Create Webhook Alert

### A. Create the Alert

1. **Right-click anywhere on the chart**
2. Select **"Add Alert"** or **"Create Alert"**

### B. Configure Alert Settings

1. **Condition Tab:**
   - **Condition:** Select your strategy → `🎯 Elite AI Long` (for buy signals)
   - **Expiration:** `Never` (or set a date)
   - **Frequency:** `Once Per Bar Close` (recommended)

2. **Webhook URL Tab:**
   - **Webhook URL:** `https://your-ngrok-url.ngrok.io/webhook/tradingview`
     - (Replace with your actual ngrok URL - see Step 8)
   - **Webhook Secret:** `11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784`

3. **Message Tab:**
   - **Alert Message:** Copy this exactly:
   ```
   {"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"stop_loss":{{close}}*0.98,"take_profit":{{close}}*1.02,"alert_id":"tv_{{time}}","timestamp":{{time}}}
   ```

4. **Click "Create"** to save the alert

### C. Create Second Alert for SELL Signals

1. **Create another alert** (same steps as above)
2. **Condition:** `🎯 Elite AI Short`
3. **Message:** Change `"BUY"` to `"SELL"`:
   ```
   {"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"stop_loss":{{close}}*1.02,"take_profit":{{close}}*0.98,"alert_id":"tv_{{time}}","timestamp":{{time}}}
   ```

---

## 🌐 Step 8: Get Public Webhook URL (ngrok)

**Before you can receive alerts, you need a public URL:**

### Option A: Use ngrok (Quick Testing)

1. **Install ngrok:**
   ```bash
   brew install ngrok
   ```
   Or download from: https://ngrok.com/download

2. **Start your server** (if not running):
   ```bash
   cd /Users/davidmikulis/neuro-pilot-ai
   export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
   node simple_webhook_server.js
   ```

3. **In a NEW terminal, start ngrok:**
   ```bash
   ngrok http 3014
   ```

4. **Copy the HTTPS URL** (looks like: `https://abc123.ngrok.io`)
   - This is your public webhook URL
   - Use this in TradingView alert settings

### Option B: Deploy to Railway (Production)

1. Push your code to GitHub
2. Deploy on Railway (your `railway.toml` is configured)
3. Get your production URL

---

## ✅ Step 9: Test Your Setup

1. **In TradingView:**
   - Wait for a signal to trigger
   - Or manually trigger a test alert (if available)

2. **Check your server logs:**
   - Should see: `🚨 TradingView Alert Received`
   - Should see: `✅ Trade executed`

3. **Verify trade:**
   ```bash
   # Check account
   curl http://localhost:3014/api/account | jq '.'
   
   # Check trade ledger
   sqlite3 ./data/trade_ledger.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 1;"
   ```

---

## 🎯 What You Should See

### On TradingView Chart:
- ✅ Green arrows = Buy signals
- ✅ Red arrows = Sell signals
- ✅ Background colors = Market regime
- ✅ AI confidence indicators
- ✅ Strategy performance metrics

### In Your Server:
- ✅ Alerts received and authenticated
- ✅ Trades executed in paper trading
- ✅ Trades saved to ledger
- ✅ Account balance updated

---

## 🐛 Troubleshooting

### Pine Script won't load:
- ✅ Check for syntax errors (red lines in editor)
- ✅ Make sure you copied the ENTIRE file
- ✅ Check `//@version=5` is at the top

### Alert not triggering:
- ✅ Check strategy is added to chart
- ✅ Check alert condition matches strategy signal name
- ✅ Verify alert is enabled (not paused)

### Webhook not receiving alerts:
- ✅ Check ngrok is running and URL is correct
- ✅ Verify webhook URL in TradingView matches ngrok URL
- ✅ Check server is running on port 3014
- ✅ Verify secret matches in both places

### 401 Unauthorized:
- ✅ Check `TRADINGVIEW_WEBHOOK_SECRET` matches in server and TradingView
- ✅ Verify signature format is correct

---

## 📚 Quick Reference

**Files:**
- Pine Script: `elite_v2_pinescript_clean.pine`
- Alert Message: `TRADINGVIEW_ALERT_MESSAGE.txt`
- Server: `simple_webhook_server.js`

**URLs:**
- Local Server: `http://localhost:3014`
- Health Check: `http://localhost:3014/health`
- Account: `http://localhost:3014/api/account`
- Webhook: `http://localhost:3014/webhook/tradingview` (use ngrok URL in TradingView)

**Secrets:**
- Webhook Secret: `11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784`

---

## 🎉 You're Done!

Once you complete these steps:
1. ✅ Pine Script is on your chart
2. ✅ Alerts are configured
3. ✅ Webhook is connected
4. ✅ Server is receiving alerts
5. ✅ Trades are executing

**Your automated trading system is live!**

---

## 📞 Need More Help?

- **Pine Script Issues:** Check TradingView Pine Script documentation
- **Webhook Issues:** Check server logs and `TRADINGVIEW_SETUP_COMPLETE.md`
- **Testing:** Use `./test_manual.sh` to verify server is working


