# Current State Audit - TradingView Webhook Integration

**Date:** 2026-01-20  
**Auditor:** Senior Full-Stack Engineer

---

## ✅ Present Files

| File | Status | Notes |
|------|--------|-------|
| `TRADINGVIEW_ALERT_CONFIG.md` | ✅ Present | Needs update for valid JSON templates |
| `ALERT_MESSAGE_BUY.txt` | ✅ Present | **CRITICAL:** Contains invalid JSON (arithmetic expressions) |
| `ALERT_MESSAGE_SELL.txt` | ✅ Present | **CRITICAL:** Contains invalid JSON (arithmetic expressions) |
| `setup_ngrok.sh` | ✅ Present | Basic version exists, needs enhancement |
| `simple_webhook_server.js` | ✅ Present | Has rawBody capture, needs stop_loss/take_profit defaults |

---

## ❌ Missing Files

| File | Priority | Required For |
|------|----------|--------------|
| `scripts/verify_tradingview_webhook.sh` | 🔴 CRITICAL | Verification & testing |
| Enhanced `setup_ngrok.sh` | 🟡 HIGH | Public URL extraction |

---

## 🔍 Code Inspection Results

### ✅ Working Correctly

1. **rawBody Capture** (`simple_webhook_server.js:33-40`)
   - ✅ Uses `express.json()` with `verify` option
   - ✅ Stores `req.rawBody` for HMAC verification

2. **Signature Validation** (`backend/middleware/webhookAuth.js`)
   - ✅ Returns 401 on invalid signature
   - ✅ Uses timing-safe comparison
   - ✅ Handles buffer length mismatches

3. **Payload Validation** (`backend/middleware/webhookValidation.js`)
   - ✅ Validates required fields: `symbol`, `action`, `price`
   - ✅ Returns 400 with JSON error on validation failure
   - ⚠️ **GAP:** Does not require `alert_id` or `timestamp` (should be required for idempotency)

4. **Idempotency** (`backend/services/deduplicationService.js`)
   - ✅ Uses `alert_id` + `timestamp` for deduplication
   - ✅ Returns 409 on duplicate alerts

### ⚠️ Critical Gaps

1. **Alert Message Templates** (`ALERT_MESSAGE_BUY.txt`, `ALERT_MESSAGE_SELL.txt`)
   - ❌ **CRITICAL:** Contains arithmetic expressions in JSON: `{{close}}*0.98`
   - ❌ TradingView substitution will produce invalid JSON
   - ❌ Example: `{"price":50000*0.98}` is invalid JSON
   - ✅ **FIX:** Remove arithmetic, compute server-side

2. **Server-Side Defaults** (`simple_webhook_server.js`, `backend/middleware/riskCheck.js`)
   - ⚠️ `riskCheck.js:25-26` extracts `stopLoss`/`takeProfit` but allows `null`
   - ❌ **GAP:** No server-side computation of defaults if missing
   - ✅ **FIX:** Compute defaults in `riskCheck.js` before validation

3. **Required Fields** (`backend/middleware/webhookValidation.js`)
   - ⚠️ Only requires: `symbol`, `action`, `price`
   - ❌ **GAP:** `alert_id` and `timestamp` should be required for idempotency
   - ✅ **FIX:** Add to required fields list

4. **Error Handling** (`simple_webhook_server.js`)
   - ✅ Has try-catch blocks
   - ⚠️ **GAP:** No explicit handling for malformed JSON (express.json handles it, but should be explicit)

---

## 📋 Implementation Checklist

### Deliverable A: Current State ✅
- [x] Located all files
- [x] Inspected server code
- [x] Identified critical gaps
- [x] Created audit report

### Deliverable B: Alert Templates ⏳
- [ ] Fix `ALERT_MESSAGE_BUY.txt` (remove arithmetic)
- [ ] Fix `ALERT_MESSAGE_SELL.txt` (remove arithmetic)
- [ ] Ensure valid JSON after TradingView substitution

### Deliverable C: Server Safety ⏳
- [ ] Add `alert_id` and `timestamp` to required fields
- [ ] Compute `stop_loss` defaults in `riskCheck.js` (BUY: price * 0.98, SELL: price * 1.02)
- [ ] Compute `take_profit` defaults in `riskCheck.js` (BUY: price * 1.02, SELL: price * 0.98)
- [ ] Ensure no 500 errors on missing optional fields

### Deliverable D: ngrok Script ⏳
- [ ] Check ngrok installation
- [ ] Extract public URL from ngrok API
- [ ] Print webhook URL and test command
- [ ] Handle errors gracefully

### Deliverable E: Verification Script ⏳
- [ ] Test localhost health endpoint
- [ ] Test invalid signature (401)
- [ ] Test valid signature (200)
- [ ] Test ngrok public URL (if running)
- [ ] Test idempotency (same alert_id twice)

### Deliverable F: Complete Guide ⏳
- [ ] Step-by-step Pine Editor instructions
- [ ] Alert configuration with valid templates
- [ ] ngrok setup instructions
- [ ] Verification steps
- [ ] Troubleshooting section

---

## 🎯 Priority Order

1. **🔴 CRITICAL:** Fix alert templates (invalid JSON)
2. **🔴 CRITICAL:** Add server-side defaults (stop_loss/take_profit)
3. **🟡 HIGH:** Add required fields (alert_id, timestamp)
4. **🟡 HIGH:** Create verification script
5. **🟢 MEDIUM:** Enhance ngrok script
6. **🟢 MEDIUM:** Update guide

---

## 📊 Summary

**Files Present:** 5/6 (83%)  
**Critical Gaps:** 3  
**High Priority Fixes:** 2  
**Ready for Production:** ❌ No (templates will break)

**Next Steps:** Implement all fixes in priority order.


