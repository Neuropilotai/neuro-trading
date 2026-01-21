# TradingView Setup Guide - Complete

**Status:** Your webhook server is ready! Now connect TradingView alerts.

---

## 🎯 Quick Setup Steps

### Step 1: Get Your Webhook URL

Your webhook server is running at:
```
http://localhost:3014/webhook/tradingview
```

**For production/testing from TradingView, you'll need:**
- A public URL (use ngrok, Railway, or similar)
- Or deploy to a cloud service (Railway, Render, Fly.io)

---

### Step 2: Configure TradingView Alert

#### A. Open Your Pine Script Strategy

1. Go to [TradingView.com](https://tradingview.com)
2. Open a chart
3. Add your Pine Script strategy (or use `elite_v2_pinescript_clean.pine`)
4. Click on the strategy name → **Settings** → **Alerts**

#### B. Create Alert

1. Click **"Create Alert"**
2. **Condition:** Select your strategy signal (e.g., "🎯 Elite AI Long" or "🎯 Elite AI Short")
3. **Webhook URL:** Enter your webhook URL
   - Local testing: Use ngrok to expose `http://localhost:3014`
   - Production: Use your deployed URL

#### C. Alert Message Format

Use this JSON format in the alert message:

```json
{
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "price": {{close}},
  "quantity": {{strategy.order.contracts}},
  "stop_loss": {{close}} * 0.98,
  "take_profit": {{close}} * 1.02,
  "alert_id": "{{time}}",
  "timestamp": {{time}},
  "confidence": 0.85
}
```

**Or use Pine Script variables:**
```
{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"stop_loss":{{close}}*0.98,"take_profit":{{close}}*1.02,"alert_id":"{{time}}","timestamp":{{time}}}
```

#### D. Set Webhook Secret

1. In TradingView alert settings, find **"Webhook Secret"** or **"Secret"** field
2. Enter: `11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784`
   - (Or use the secret from your `.env` file)

---

## 🌐 Making Your Webhook Public (For Testing)

### Option 1: Use ngrok (Easiest for Testing)

```bash
# Install ngrok: https://ngrok.com/download

# Expose your local server
ngrok http 3014
```

You'll get a URL like: `https://abc123.ngrok.io`

**Update TradingView webhook URL to:**
```
https://abc123.ngrok.io/webhook/tradingview
```

### Option 2: Deploy to Railway/Render

Deploy your `simple_webhook_server.js` to:
- **Railway:** Already configured (see `railway.toml`)
- **Render:** Use `render.yaml`
- **Fly.io:** Use `fly.toml`

Then use your production URL in TradingView.

---

## 📋 TradingView Alert Configuration Checklist

- [ ] Pine Script strategy loaded on chart
- [ ] Alert created with strategy condition
- [ ] Webhook URL set (public URL, not localhost)
- [ ] Alert message uses JSON format (see above)
- [ ] Webhook secret matches `TRADINGVIEW_WEBHOOK_SECRET`
- [ ] Alert enabled and active

---

## 🧪 Test Your TradingView Alert

### Step 1: Test Alert Manually

In TradingView:
1. Right-click on your strategy → **"Create Alert"**
2. Set condition to trigger immediately (or use "Once Per Bar Close")
3. Click **"Test Webhook"** (if available)
4. Or trigger the alert manually

### Step 2: Verify in Your System

```bash
# Check if alert was received
curl http://localhost:3014/api/account | jq '.'

# Check trade ledger
sqlite3 ./data/trade_ledger.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 1;"

# Check server logs
# (Look for "🚨 TradingView Alert Received" in server terminal)
```

---

## 🔧 Pine Script Alert Setup (Detailed)

### For `elite_v2_pinescript_clean.pine`

The script already has alert conditions defined:
- `🎯 Elite AI Long` - Buy signal
- `🎯 Elite AI Short` - Sell signal

**Alert Message Template:**

```
{"symbol":"{{ticker}}","action":"{{strategy.order.action}}","price":{{close}},"quantity":{{strategy.order.contracts}},"stop_loss":{{close}}*0.98,"take_profit":{{close}}*1.02,"alert_id":"tv_{{time}}","timestamp":{{time}},"confidence":0.85}
```

**Webhook URL:**
```
https://your-public-url.com/webhook/tradingview
```

**Secret:**
```
11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
```

---

## 🚀 Production Deployment Options

### Option A: Railway (Recommended)

1. **Push to GitHub:**
   ```bash
   git add .
   git commit -m "Trading system with webhook server"
   git push
   ```

2. **Deploy on Railway:**
   - Connect GitHub repo
   - Set environment variables (see `.env.example`)
   - Deploy `simple_webhook_server.js` as a service
   - Get public URL: `https://your-app.railway.app`

3. **Update TradingView:**
   - Webhook URL: `https://your-app.railway.app/webhook/tradingview`

### Option B: ngrok (Quick Testing)

```bash
# Install ngrok
brew install ngrok  # or download from ngrok.com

# Start your server
node simple_webhook_server.js

# In another terminal, expose it
ngrok http 3014

# Use the ngrok URL in TradingView
```

**Note:** ngrok URLs change on restart. For production, use Railway/Render.

---

## ✅ Verification Steps

Once TradingView is configured:

1. **Trigger a test alert** from TradingView
2. **Check server logs** - Should see "🚨 TradingView Alert Received"
3. **Check account** - Balance should update
4. **Check ledger** - Trade should be saved
5. **Check positions** - Should show open position

---

## 🐛 Troubleshooting

### Alert not received
- ✅ Check webhook URL is correct (public, not localhost)
- ✅ Verify secret matches in TradingView and server
- ✅ Check server is running and accessible
- ✅ Verify alert is enabled in TradingView

### 401 Unauthorized
- ✅ Secret mismatch - check `TRADINGVIEW_WEBHOOK_SECRET` matches
- ✅ Signature format - TradingView should send `sha256=<hash>`

### 400 Bad Request
- ✅ Check JSON format in alert message
- ✅ Verify required fields: symbol, action, price

### Trade not executing
- ✅ Check `ENABLE_PAPER_TRADING=true`
- ✅ Check `TRADING_ENABLED=true` (kill switch)
- ✅ Verify risk limits not exceeded
- ✅ Check server logs for errors

---

## 📚 Next Steps

1. **Set up public URL** (ngrok for testing, Railway for production)
2. **Configure TradingView alert** with webhook URL and secret
3. **Test with a real alert** from TradingView
4. **Monitor trades** via `/api/account` and trade ledger
5. **Generate daily reports** with `node backend/scripts/dailyReport.js`

---

## 🎉 You're Ready!

Your system is:
- ✅ Server running and tested
- ✅ Authentication working
- ✅ Paper trading executing
- ✅ Trade ledger saving

**Next:** Connect TradingView alerts and start trading!

---

**Quick Reference:**
- Webhook URL: `http://localhost:3014/webhook/tradingview` (local) or your public URL
- Secret: `11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784`
- Health Check: `http://localhost:3014/health`
- Account: `http://localhost:3014/api/account`


