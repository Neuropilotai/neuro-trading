# Update Pine Script in TradingView - Step by Step

**Your Pine Script has been updated! Now update it in TradingView.**

---

## 🚀 Quick Update Steps

### Step 1: Copy Updated Pine Script

```bash
cd /Users/davidmikulis/neuro-pilot-ai
cat elite_v2_pinescript_clean.pine | pbcopy
```

**Or open the file:**
```bash
open elite_v2_pinescript_clean.pine
# Then select all (Cmd+A) and copy (Cmd+C)
```

### Step 2: Update in TradingView

1. **Go to TradingView.com** → Sign in
2. **Open any chart**
3. **Click "Pine Editor"** (bottom of screen)
4. **Open your saved strategy:**
   - Click **"Open"** (top left)
   - Find your strategy (e.g., "Elite AI Strategy")
   - Click to open
5. **Replace the code:**
   - Select all (Cmd+A / Ctrl+A)
   - Delete
   - Paste your updated code (Cmd+V / Ctrl+V)
6. **Save:**
   - Click **"Save"** (top right)
7. **Add to Chart:**
   - Click **"Add to Chart"** (top right)
   - This replaces the old version

### Step 3: Verify It Works

1. **Check chart:**
   - Should see strategy signals (buy/sell arrows)
   - Should see AI dashboard (top-right)
   - No red error lines in Pine Editor

2. **Test an alert:**
   - Wait for a signal or trigger manually
   - Check server logs for: `🚨 TradingView Alert Received`
   - Verify format is correct

---

## ✅ What Changed

### Before:
```pine
alertcondition(super_long_signal, "🎯 Elite AI Long", "ELITE AI LONG! " + webhook_json)
```
- Sent: `{"score":85.3,"confidence":0.82,...}` (old format)
- Required manual message in TradingView alerts

### After:
```pine
alertcondition(super_long_signal, "🎯 Elite AI Long", webhook_json_buy)
```
- Sends: `{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}` (server format)
- **Automatic!** No manual message needed

---

## 🎯 Benefits

**Now you can:**
- ✅ Create alerts without setting the message manually
- ✅ Pine Script automatically sends correct format
- ✅ Consistent format across all alerts
- ✅ Easier to create new alerts

**Your alerts will now:**
- ✅ Work automatically with your server
- ✅ Send the correct JSON format
- ✅ Include all required fields
- ✅ Be properly authenticated

---

## 📋 After Updating Pine Script

### Option A: Keep Existing Alerts (They Still Work)
- Your current alerts will continue working
- The message you set in TradingView overrides Pine Script
- No changes needed

### Option B: Simplify Alerts (Recommended)
1. **Edit each alert** in TradingView
2. **Clear the Alert Message field** (or leave default)
3. **Pine Script will now send correct format automatically**
4. **Save**

**Benefits:**
- No need to copy/paste message templates
- Easier to manage
- Consistent format

---

## 🧪 Test After Update

```bash
# 1. Get webhook URL
./scripts/get_public_webhook_url.sh

# 2. Run operations check
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
./scripts/tradingview_ops.sh

# 3. Trigger a test alert in TradingView
# 4. Check server logs
# 5. Verify trade executed
```

---

## 🎉 You're Done!

After updating the Pine Script:
- ✅ Alerts will automatically send correct format
- ✅ No manual message configuration needed
- ✅ Server will receive properly formatted alerts
- ✅ Trades will execute automatically

**Your system is now fully automated!**

---

**Last Updated:** 2026-01-20


