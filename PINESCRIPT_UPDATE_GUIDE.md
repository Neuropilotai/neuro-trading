# Pine Script Update Guide

**Your Pine Script has been updated to automatically send the correct webhook format!**

---

## ✅ What Changed

### Updated Webhook Format

**Before:**
- Pine Script sent: `{"score":85.3,"confidence":0.82,"mode":"Aggressive",...}`
- Required manual message configuration in TradingView alerts

**After:**
- Pine Script automatically sends: `{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}`
- Matches your server's expected format
- No manual message configuration needed!

---

## 🔄 How to Update in TradingView

### Step 1: Update Pine Script in TradingView

1. **Go to TradingView.com** → Open a chart
2. **Open Pine Editor** (bottom of screen)
3. **Open your saved strategy** (or create new)
4. **Copy the updated Pine Script:**
   ```bash
   cd /Users/davidmikulis/neuro-pilot-ai
   cat elite_v2_pinescript_clean.pine | pbcopy
   ```
5. **In TradingView Pine Editor:**
   - Delete all code
   - Paste the updated code
   - Click **"Save"**
   - Click **"Add to Chart"** (replaces old version)

### Step 2: Update Your Alerts (Simplified!)

**Now you can simplify your alerts:**

1. **Go to:** [https://www.tradingview.com/alerts](https://www.tradingview.com/alerts)

2. **For each alert (BUY and SELL):**
   - Click three dots (⋯) → **Edit**
   - **Condition:** `🎯 Elite AI Long` (BUY) or `🎯 Elite AI Short` (SELL)
   - **Webhook URL:** Your ngrok URL (get with `./scripts/get_public_webhook_url.sh`)
   - **Webhook Secret:** `[YOUR_TRADINGVIEW_WEBHOOK_SECRET]`
   - **Alert Message:** Leave empty or use default (Pine Script will send correct format automatically!)
   - **Frequency:** `Once Per Bar Close`
   - Click **Save**

**That's it!** The Pine Script now automatically sends the correct format.

---

## 🎯 What the Update Does

### Main Trading Alerts

**`🎯 Elite AI Long` (BUY):**
- Automatically sends: `{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}`

**`🎯 Elite AI Short` (SELL):**
- Automatically sends: `{"symbol":"{{ticker}}","action":"SELL","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}`

### Other Alert Conditions

**Informational alerts** (High Confidence, Extreme Score, Regime Change, etc.):
- Still use legacy format with AI metrics
- These are for monitoring, not trading
- Can be ignored or configured separately

---

## ✅ Verification

### Step 1: Verify Pine Script Updated

1. **In TradingView:**
   - Check strategy is on chart
   - Verify signals appear (buy/sell arrows)
   - Check AI dashboard shows

### Step 2: Test Alert

1. **Trigger a test alert** (or wait for natural signal)
2. **Check server logs:**
   ```
   🚨 TradingView Alert Received: {...}
   ✅ Trade executed
   ```
3. **Verify format:**
   - Should see: `"symbol"`, `"action"`, `"price"`, `"quantity"`, `"alert_id"`, `"timestamp"`
   - Should NOT see: `"score"`, `"confidence"`, `"mode"` (unless from informational alerts)

### Step 3: Check Trade Execution

```bash
# Check account
curl http://localhost:3014/api/account | jq '.'

# Check recent trades
sqlite3 ./data/trade_ledger.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 1;"
```

---

## 🔄 Migration from Old Setup

**If you already have alerts configured with message templates:**

### Option A: Keep Current Setup (Works Fine)
- Your alerts will continue working
- No changes needed
- Templates override Pine Script message

### Option B: Simplify Alerts (Recommended)
1. Update Pine Script in TradingView (Step 1 above)
2. Edit each alert
3. **Clear the Alert Message field** (or leave default)
4. Pine Script will now send correct format automatically
5. Save alert

**Benefits:**
- ✅ No need to copy/paste message templates
- ✅ Consistent format across all alerts
- ✅ Easier to create new alerts

---

## 📋 Quick Checklist

- [ ] Updated Pine Script in TradingView
- [ ] Strategy showing on chart with signals
- [ ] Alerts configured (can use default message now)
- [ ] Webhook URL set correctly
- [ ] Webhook secret matches
- [ ] Test alert triggered
- [ ] Server received alert
- [ ] Trade executed successfully

---

## 🎉 Benefits

**Before Update:**
- Had to manually set alert message in each alert
- Easy to make mistakes
- Inconsistent format

**After Update:**
- ✅ Pine Script sends correct format automatically
- ✅ No manual message configuration needed
- ✅ Consistent format guaranteed
- ✅ Easier to create new alerts

---

## 📞 Troubleshooting

### Alert Still Sending Old Format

**Solution:**
- Verify Pine Script is updated in TradingView
- Check you're using the updated version on chart
- Re-add strategy to chart if needed

### Server Rejects Alert

**Solution:**
- Check server logs for error
- Verify webhook URL is correct
- Verify webhook secret matches
- Run verification: `./scripts/verify_tradingview_webhook.sh`

### No Signals on Chart

**Solution:**
- Check Pine Script compiled without errors
- Verify strategy settings
- Try different timeframes
- Check market conditions

---

**Last Updated:** 2026-01-20  
**Status:** Pine Script Updated ✅


