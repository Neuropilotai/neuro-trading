# TradingView Quick Setup

**Your webhook server is ready!** Now connect TradingView alerts.

---

## 🚀 3-Step Setup

### Step 1: Make Your Server Public

**Option A: Use ngrok (Quick Testing)**
```bash
# Install ngrok (if not installed)
brew install ngrok

# Expose your server
ngrok http 3014
```

You'll get a URL like: `https://abc123.ngrok.io`

**Option B: Deploy to Railway (Production)**
- Your `railway.toml` is already configured
- Deploy and get a public URL

---

### Step 2: Configure TradingView Alert

1. **Go to TradingView.com** → Open a chart
2. **Add your Pine Script** (`elite_v2_pinescript_clean.pine`)
3. **Right-click chart** → **"Create Alert"**
4. **Set Condition:** `🎯 Elite AI Long` (or `🎯 Elite AI Short`)
5. **Webhook URL:** `https://your-ngrok-url.ngrok.io/webhook/tradingview`
6. **Alert Message:** (see below)
7. **Webhook Secret:** `[YOUR_TRADINGVIEW_WEBHOOK_SECRET]`

---

### Step 3: Alert Message Format

**For BUY alerts:**
```json
{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"stop_loss":{{close}}*0.98,"take_profit":{{close}}*1.02,"alert_id":"tv_{{time}}","timestamp":{{time}}}
```

**For SELL alerts:**
```json
{"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"stop_loss":{{close}}*1.02,"take_profit":{{close}}*0.98,"alert_id":"tv_{{time}}","timestamp":{{time}}}
```

**Or use Pine Script variables:**
```
{"symbol":"{{ticker}}","action":"{{strategy.order.action}}","price":{{close}},"quantity":{{strategy.order.contracts}},"stop_loss":{{close}}*0.98,"take_profit":{{close}}*1.02,"alert_id":"tv_{{time}}","timestamp":{{time}}}
```

---

## ✅ Quick Test

1. **Start ngrok:**
   ```bash
   ./setup_ngrok.sh
   ```

2. **Copy the ngrok URL** (e.g., `https://abc123.ngrok.io`)

3. **In TradingView:**
   - Create alert with webhook URL: `https://abc123.ngrok.io/webhook/tradingview`
   - Set secret: `[YOUR_TRADINGVIEW_WEBHOOK_SECRET]`
   - Trigger test alert

4. **Check your server:**
   ```bash
   # Should see alert in server logs
   # Check account updated
   curl http://localhost:3014/api/account | jq '.'
   ```

---

## 📋 Checklist

- [ ] Server running on port 3014
- [ ] ngrok installed and running (or Railway deployed)
- [ ] Public webhook URL obtained
- [ ] TradingView alert created
- [ ] Webhook URL set in TradingView
- [ ] Secret matches in TradingView and server
- [ ] Alert message uses correct JSON format
- [ ] Test alert sent and received

---

## 🎯 What Happens When Alert Triggers

1. **TradingView** sends alert to your webhook
2. **Server** authenticates (HMAC signature)
3. **Validates** payload (required fields)
4. **Checks** for duplicates
5. **Risk engine** validates order
6. **Paper trading** executes order
7. **Trade ledger** saves record
8. **Response** sent back to TradingView

---

## 📚 Full Guide

See `TRADINGVIEW_SETUP_COMPLETE.md` for detailed instructions.

---

**Ready to connect!** Start with ngrok for testing, then deploy to Railway for production.


