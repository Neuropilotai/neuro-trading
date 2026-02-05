# Deduplication Fix: Mark Only on Success

## Problem

The deduplication service was marking alerts as "seen" too early - before the request was actually accepted/processed successfully. This caused false duplicates when:
- Trading is disabled (kill switch)
- Risk checks fail (403)
- Broker is down
- Any validation fails after dedupe check

**Example:**
1. First webhook → 403 Risk check failed (kill switch)
2. Second webhook → 409 Duplicate alert (incorrectly marked as duplicate)

## Solution

Split deduplication into two phases:
1. **Check** (read-only) - happens in middleware, before validation/risk checks
2. **Mark as processed** - happens only when request successfully returns 200

This ensures failed requests (403, 500, etc.) can be retried.

## Changes

### `backend/services/deduplicationService.js`

**Before:**
- `checkDuplicate()` both checked AND marked as seen in one call

**After:**
- `checkDuplicate()` - read-only check (does NOT mark as seen)
- `markAsProcessed(idempotencyKey)` - new method to mark as processed (only called on success)

### `simple_webhook_server.js`

**Before:**
- Dedupe check happened in middleware and immediately marked as seen
- Even failed requests (403) were marked as duplicates

**After:**
- Dedupe check in middleware is read-only
- `markAsProcessed()` called only when returning 200 response (success)

## Code Diffs

### `backend/services/deduplicationService.js`

```javascript
// OLD: checkDuplicate() both checked AND marked
async checkDuplicate(alertData) {
  // ... check logic ...
  // ❌ BUG: Marked as seen even if request fails later
  this.cache.set(idempotencyKey, now);
  return { isDuplicate: false, idempotencyKey };
}

// NEW: Split into check (read-only) and mark (on success)
async checkDuplicate(alertData) {
  // ... check logic only ...
  // ✅ FIX: Does NOT mark as seen
  return { isDuplicate: false, idempotencyKey };
}

async markAsProcessed(idempotencyKey) {
  // ✅ NEW: Only called when request succeeds
  this.cache.set(idempotencyKey, Date.now());
  this.saveCache().catch(err => {
    console.warn('⚠️  Could not save deduplication cache:', err.message);
  });
}
```

### `simple_webhook_server.js`

```javascript
// Middleware: Read-only check
async (req, res, next) => {
  const dedupeResult = await deduplicationService.checkDuplicate(req.body);
  if (dedupeResult.isDuplicate) {
    return res.status(409).json({ error: 'Duplicate alert' });
  }
  req.idempotencyKey = dedupeResult.idempotencyKey;
  next(); // Continue to risk checks, etc.
}

// Main handler: Mark as processed ONLY on success (200)
async (req, res) => {
  try {
    // ... process request ...
    
    // ✅ FIX: Mark as processed only when returning 200
    if (idempotencyKey) {
      await deduplicationService.markAsProcessed(idempotencyKey);
    }
    
    res.status(200).json({ status: 'success', ... });
  } catch (error) {
    // ❌ Error path: Does NOT mark as processed (can retry)
    res.status(500).json({ error: error.message });
  }
}
```

## Test Plan

### Test A: Failed Request (403) Should NOT Mark as Duplicate

```bash
# 1. Ensure trading is disabled
export TRADING_ENABLED=false

# 2. Start server
node simple_webhook_server.js

# 3. Send first webhook (should return 403)
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"BTCUSDT",
    "action":"BUY",
    "price":50000,
    "quantity":0.01,
    "alert_id":"test_retry_1",
    "timestamp":1738230000,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected: HTTP 403, "Risk check failed", "Trading is disabled"

# 4. Check dedupe stats (should show size: 0)
curl -s http://localhost:3001/api/dedupe/stats | jq .

# Expected: size: 0 (NOT marked as duplicate)

# 5. Send same webhook again (should also return 403, NOT 409)
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"BTCUSDT",
    "action":"BUY",
    "price":50000,
    "quantity":0.01,
    "alert_id":"test_retry_1",
    "timestamp":1738230000,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected: HTTP 403 (NOT 409 - can retry failed requests)
```

### Test B: Successful Request (200) Should Mark as Duplicate

```bash
# 1. Enable trading in dev environment
# Note: TradingView-only symbols (OANDA:XAUUSD) bypass riskCheck kill switch
# But for Binance symbols, you need TRADING_ENABLED=true
export TRADING_ENABLED=true

# OR use TradingView-only symbol (OANDA:XAUUSD) which bypasses kill switch
# (riskCheck middleware already has bypass for symbols containing : or !)

# 2. Send first webhook (should return 200)
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"OANDA:XAUUSD",
    "action":"BUY",
    "price":2050,
    "quantity":0.1,
    "alert_id":"test_success_1",
    "timestamp":1738230001,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected: HTTP 200, status: "success"

# 3. Check dedupe stats (should show size: 1)
curl -s http://localhost:3001/api/dedupe/stats | jq .

# Expected: size: 1, sampleKeys: ["alert_test_success_1"]

# 4. Send same webhook again (should return 409)
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"OANDA:XAUUSD",
    "action":"BUY",
    "price":2050,
    "quantity":0.1,
    "alert_id":"test_success_1",
    "timestamp":1738230001,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected: HTTP 409, "Duplicate alert"
```

### Test C: Ledger Failure Should NOT Mark as Duplicate

```bash
# 1. Simulate ledger failure (if possible) or check behavior
# If ledger save fails, request should return 503 (Service Unavailable)

# 2. Send webhook (should return 503 if ledger fails)
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"OANDA:XAUUSD",
    "action":"BUY",
    "price":2050,
    "quantity":0.1,
    "alert_id":"test_ledger_fail",
    "timestamp":1738230002,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected: HTTP 503, error: "LEDGER_WRITE_FAILED"

# 3. Check dedupe stats (should show size: 0)
curl -s http://localhost:3001/api/dedupe/stats | jq .

# Expected: size: 0 (ledger failure = not accepted = can retry)

# 4. Retry same webhook (should return 503 again, NOT 409)
# Expected: Can retry until ledger is fixed
```

### Test D: Error Path (500) Should NOT Mark as Duplicate

```bash
# 1. Send webhook that causes server error (e.g., invalid data)
# (This test depends on what causes 500 errors in your system)

# 2. Check dedupe stats (should show size: 0)
curl -s http://localhost:3001/api/dedupe/stats | jq .

# Expected: size: 0 (error path does NOT mark as duplicate)

# 3. Retry same request (should NOT return 409)
# Expected: Can retry failed requests
```

### Test E: Status Code Semantics (200 vs 202/204)

```bash
# Note: Current implementation only marks on 200 with ledger success
# If you add async acceptance (202 Accepted), decide if that should also mark

# Current behavior:
# - 200 + ledger success → mark as processed ✅
# - 200 + ledger failure → do NOT mark (can retry) ✅
# - 403/500 → do NOT mark (can retry) ✅
# - 202/204 → not currently used, but would need explicit decision
```

## Hardening Improvements

### 1. Idempotent `markAsProcessed()`
- Safe to call multiple times with the same key
- Updates timestamp if key already exists
- Always swallows cache persistence errors (in-memory cache is source of truth)

### 2. Consistent Key Usage
- Handler always uses `req.idempotencyKey` from middleware
- No "undefined in one branch" bugs

### 3. True Acceptance Criteria (Clean Invariant)
- **2xx response** ⇒ ledger saved ⇒ marked as processed
- **non-2xx response** (403, 500, 503) ⇒ not marked ⇒ can retry
- Ledger save failure returns 503 (Service Unavailable) so TradingView retries
- File save failure is graceful degradation (still marks in-memory)

### 4. Async Safety
- Mark happens BEFORE `res.json()` is called
- Avoids race conditions where process crashes after sending response

### 5. TTL Semantics
- TTL starts when alert is accepted (mark time), not when first received
- Failed requests don't consume TTL

### 6. Response Semantics
- `status: "success"` means "received and recorded in ledger"
- `execution.executed: false` means trade was not executed (but was recorded)
- This prevents endless retries for trades rejected for execution reasons

## Summary

✅ **Fixed:** Dedupe only marks as processed on successful 200 responses (ledger saved)  
✅ **Fixed:** Failed requests (403, 500, 503) can be retried  
✅ **Fixed:** Ledger failure returns 503 (not 200) so TradingView retries  
✅ **Hardened:** Clean invariant: 2xx ⇒ ledger saved ⇒ marked, non-2xx ⇒ not marked  
✅ **Hardened:** `markAsProcessed()` is idempotent and safe  
✅ **Hardened:** Consistent key usage throughout handler  
✅ **Hardened:** Mark happens before response is sent (async safety)  
✅ **Preserved:** Successful requests are still deduplicated correctly  

---

**Status:** ✅ Implementation complete, hardened, and ready for testing

## Acceptance Criteria

With `TRADING_ENABLED=false`:
1. Webhook #1 → 403
2. Webhook #2 (same `alert_id`) → 403 (not 409) ✅
3. `/api/dedupe/stats` → `size: 0` ✅

With `TRADING_ENABLED=true` (or TradingView-only symbol):
1. Webhook #1 → 200
2. `/api/dedupe/stats` → `size: 1` ✅
3. Webhook #2 (same `alert_id`) → 409 ✅

With ledger failure:
1. Webhook #1 → 503 (LEDGER_WRITE_FAILED)
2. `/api/dedupe/stats` → `size: 0` ✅
3. Webhook #2 (same `alert_id`) → 503 again (not 409) ✅

