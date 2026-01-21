# Pine Script Webhook Update Guide

**Do you need to update your Pine Script in TradingView?**

---

## 🎯 Quick Answer

**It depends on how you configured your alerts:**

### Option A: Using Alert Message Templates (Recommended) ✅
**No update needed** - If you configured alerts in TradingView with the message templates from:
- `ALERT_MESSAGE_BUY.txt`
- `ALERT_MESSAGE_SELL.txt`

The alert message you set in TradingView UI overrides the Pine Script's `webhook_json`, so your server will receive the correct format.

### Option B: Using Pine Script's webhook_json (Optional)
**Update needed** - If you want the Pine Script to automatically send the correct format, you need to update the `webhook_json` variable in your Pine Script.

---

## 📋 Current Situation

### Your Pine Script Currently Sends:
```pine
webhook_json = '{"score":' + str.tostring(ai_score, "#.#") + ',"confidence":' + str.tostring(nn_confidence_adjusted, "#.##") + ',"mode":"' + riskMode + '","sharpe":' + str.tostring(sharpe_approx, "#.##") + ',"signal":"' + (super_long_signal ? "LONG" : super_short_signal ? "SHORT" : "NONE") + '","regime":"' + current_regime + '","accuracy":' + str.tostring(aiAccuracy, "#.###") + ',"timestamp":"{{time}}"}'
```

**This format includes:**
- `score`, `confidence`, `mode`, `sharpe`, `signal`, `regime`, `accuracy`, `timestamp`

**But your server expects:**
- `symbol`, `action`, `price`, `quantity`, `alert_id`, `timestamp` (required)
- `stop_loss`, `take_profit` (optional, computed server-side)

### Your Alert Templates Send:
```json
{"symbol":"{{ticker}}","action":"BUY","price":{{close}},"quantity":0.1,"alert_id":"tv_{{time}}","timestamp":{{time}}}
```

**This matches what your server expects!** ✅

---

## ✅ Recommended: Use Alert Message Templates (No Update Needed)

**If you configured your TradingView alerts with the message templates, you're all set!**

**How to verify:**
1. Go to: [https://www.tradingview.com/alerts](https://www.tradingview.com/alerts)
2. Click on your alert → **Edit**
3. Check the **Message** field
4. Should match `ALERT_MESSAGE_BUY.txt` or `ALERT_MESSAGE_SELL.txt`

**If it matches:** ✅ No update needed - TradingView will send the correct format.

**If it doesn't match:** Update the alert message in TradingView UI (not the Pine Script).

---

## 🔧 Optional: Update Pine Script to Auto-Send Correct Format

**If you want the Pine Script to automatically send the correct format** (so you don't have to manually set the message in TradingView), update the Pine Script:

### Step 1: Update webhook_json in Pine Script

**Replace the current `webhook_json` line** (around line 279) with:

**For BUY alerts:**
```pine
webhook_json = '{"symbol":"{{ticker}}","action":"BUY","price":' + str.tostring(close) + ',"quantity":0.1,"alert_id":"tv_' + str.tostring(time) + '","timestamp":' + str.tostring(time) + '}'
```

**For SELL alerts:**
```pine
webhook_json = '{"symbol":"{{ticker}}","action":"SELL","price":' + str.tostring(close) + ',"quantity":0.1,"alert_id":"tv_' + str.tostring(time) + '","timestamp":' + str.tostring(time) + '}'
```

**But wait!** Your Pine Script has both BUY and SELL conditions, so you need **conditional webhook_json**:

### Step 2: Update Pine Script with Conditional Format

**Replace the webhook_json section** (around line 279) with:

```pine
// ===== ELITE WEBHOOK EXPORT ALERTS =====
// Generate webhook JSON based on signal type
var string webhook_json = ""
if super_long_signal
    webhook_json := '{"symbol":"{{ticker}}","action":"BUY","price":' + str.tostring(close) + ',"quantity":0.1,"alert_id":"tv_' + str.tostring(time) + '","timestamp":' + str.tostring(time) + '}'
else if super_short_signal
    webhook_json := '{"symbol":"{{ticker}}","action":"SELL","price":' + str.tostring(close) + ',"quantity":0.1,"alert_id":"tv_' + str.tostring(time) + '","timestamp":' + str.tostring(time) + '}'
else
    webhook_json := '{"symbol":"{{ticker}}","action":"NONE","price":' + str.tostring(close) + ',"quantity":0.1,"alert_id":"tv_' + str.tostring(time) + '","timestamp":' + str.tostring(time) + '}'

alertcondition(super_long_signal, "🎯 Elite AI Long", "ELITE AI LONG! " + webhook_json)
alertcondition(super_short_signal, "🎯 Elite AI Short", "ELITE AI SHORT! " + webhook_json)
```

**Note:** TradingView's `{{ticker}}` and `{{time}}` are template variables that get replaced when the alert triggers. In Pine Script, you need to use `str.tostring(close)` and `str.tostring(time)` instead.

---

## 🤔 Which Approach Should You Use?

### Use Alert Message Templates (Current Setup) ✅ **RECOMMENDED**

**Pros:**
- ✅ No Pine Script changes needed
- ✅ Easy to update (just change TradingView alert message)
- ✅ Works immediately
- ✅ Can include additional fields if needed

**Cons:**
- ⚠️ Must manually set message in each alert
- ⚠️ If you create new alerts, must remember to set message

### Update Pine Script (Optional)

**Pros:**
- ✅ Automatic - no manual message configuration
- ✅ Consistent format across all alerts
- ✅ Works for new alerts automatically

**Cons:**
- ⚠️ Requires Pine Script update
- ⚠️ Must re-add strategy to chart
- ⚠️ More complex (conditional logic)

---

## 📝 Recommendation

**Keep using the alert message templates** (current setup). It's simpler and you've already configured it correctly.

**Only update the Pine Script if:**
- You frequently create new alerts
- You want the format to be automatic
- You're comfortable editing Pine Script

---

## ✅ Verification

**To verify your current setup is working:**

1. **Check alert message in TradingView:**
   - Go to alerts → Edit
   - Verify message matches template

2. **Test an alert:**
   - Trigger a test alert
   - Check server logs
   - Should see: `🚨 TradingView Alert Received`
   - Should see correct JSON format

3. **Check trade execution:**
   ```bash
   curl http://localhost:3014/api/account | jq '.'
   # Should show trades being executed
   ```

---

## 🎯 Summary

**Current Status:** ✅ Your setup should work as-is if alerts are configured with the message templates.

**Action Needed:** 
- ✅ **None** - If alerts use templates from `ALERT_MESSAGE_BUY.txt` / `ALERT_MESSAGE_SELL.txt`
- ⚠️ **Update alert messages** - If alerts are using Pine Script's default webhook_json
- 🔧 **Update Pine Script** - Only if you want automatic format (optional)

**Quick Check:**
```bash
# Run operations check
./scripts/tradingview_ops.sh

# It will show you the exact alert messages to use
# Compare with what's in your TradingView alerts
```

---

**Last Updated:** 2026-01-20


