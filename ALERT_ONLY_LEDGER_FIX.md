# ALERT_ONLY Ledger Status Fix

## Problem

TradingView-only symbols (e.g., `OANDA:XAUUSD`) were being stored in `trade_ledger.db` with `status='VALIDATED'` instead of `status='ALERT_ONLY'`, even though the API response showed `ALERT_ONLY`.

**Root Cause:** Trade was inserted into ledger with `status='VALIDATED'` before the TradingView-only check, and the status update to `'ALERT_ONLY'` happened after insertion (line 270), which never updated the ledger.

## Solution

**File:** `simple_webhook_server.js`

### Changes Made

1. **Early Symbol Classification** (Line 138-141)
   - Check if symbol is TradingView-only BEFORE creating trade record
   - Use `symbolRouter.classifySymbol()` for consistent classification

2. **Status Set Before Insert** (Line 147-152)
   - Set `initialStatus = 'ALERT_ONLY'` for TradingView-only symbols
   - Set `initialStatus = 'VALIDATED'` for normal symbols
   - Add logging: `"ℹ️  Routing TradingView-only symbol to ALERT_ONLY ledger status: <symbol>"`

3. **Trade Data Creation** (Line 171)
   - Use `status: initialStatus` instead of hardcoded `'VALIDATED'`

4. **Removed Post-Insert Status Update** (Line 263-266)
   - Removed duplicate `isTradingViewSymbol` check
   - Removed `executionResult` creation for TradingView-only symbols
   - Removed `tradeData.status = 'ALERT_ONLY'` after insert (no longer needed)

5. **API Response Update** (Line 410-429)
   - For TradingView-only symbols: `executed: false, reason: 'TRADINGVIEW_ONLY'`
   - For normal executions: `executed: true` with execution details
   - For non-executed (kill switch): `executed: false` (no reason)

## Code Diffs

### Before (Line 159, 170, 270):
```javascript
status: 'VALIDATED',  // Always VALIDATED initially
// ...
const ledgerId = await tradeLedger.insertTrade(tradeData);  // Inserted with VALIDATED
// ...
tradeData.status = 'ALERT_ONLY';  // Updated AFTER insert (never persisted)
```

### After (Line 138-152, 171, 180):
```javascript
// Check symbol type BEFORE creating trade record
const symbolRouter = require('./backend/services/symbolRouter');
const symbolClassification = symbolRouter.classifySymbol(orderIntent.symbol);
const isTradingViewOnlySymbol = symbolClassification.source === 'tradingview_only';

// Set status based on symbol type
const initialStatus = isTradingViewOnlySymbol ? 'ALERT_ONLY' : 'VALIDATED';

if (isTradingViewOnlySymbol) {
    console.log(`ℹ️  Routing TradingView-only symbol to ALERT_ONLY ledger status: ${symbolClassification.normalizedSymbol}`);
}

const tradeData = {
    // ...
    status: initialStatus,  // Correct status from the start
    // ...
};

// Insert with correct status
const ledgerId = await tradeLedger.insertTrade(tradeData);
```

### API Response (Line 410-429):
```javascript
let executionResponse;
if (isTradingViewOnlySymbol) {
    // TradingView-only symbols: not executed, reason provided
    executionResponse = {
        executed: false,
        reason: 'TRADINGVIEW_ONLY'
    };
} else if (executionResult) {
    // Normal execution
    executionResponse = {
        executed: true,
        tradeId: executionResult.tradeId,
        fillPrice: executionResult.executionResult?.fillPrice,
        filledQuantity: executionResult.executionResult?.filledQuantity,
        pnl: executionResult.executionResult?.pnl
    };
} else {
    // No execution (e.g., TRADING_ENABLED=false for Binance symbols)
    executionResponse = { executed: false };
}
```

## Test Plan

### Test A: TradingView-Only Symbol (OANDA:XAUUSD)

```bash
# 1. Start server
node simple_webhook_server.js

# 2. Send TradingView-only alert
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"OANDA:XAUUSD",
    "action":"BUY",
    "price":2050,
    "quantity":0.1,
    "alert_id":"test_xau_alert_only",
    "timestamp":1738230000,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected API Response:
# {
#   "status": "success",
#   "execution": {
#     "executed": false,
#     "reason": "TRADINGVIEW_ONLY"
#   },
#   "data": {
#     "status": "ALERT_ONLY"
#   }
# }

# 3. Verify SQLite
sqlite3 data/trade_ledger.db "SELECT symbol, status, idempotency_key FROM trades WHERE symbol='OANDA:XAUUSD' ORDER BY created_at DESC LIMIT 1;"

# Expected:
# OANDA:XAUUSD | ALERT_ONLY | alert_test_xau_alert_only
```

### Test B: Binance Symbol with Kill Switch (BTCUSDT)

```bash
# 1. Ensure TRADING_ENABLED=false in .env
# 2. Restart server
# 3. Send Binance symbol alert
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"BTCUSDT",
    "action":"BUY",
    "price":50000,
    "quantity":0.01,
    "alert_id":"test_btc_killswitch",
    "timestamp":1738230001,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }' | jq .

# Expected API Response:
# {
#   "status": "success",
#   "execution": {
#     "executed": false
#   },
#   "data": {
#     "status": "VALIDATED"  (or REJECTED if risk engine blocks)
#   }
# }

# 4. Verify SQLite
sqlite3 data/trade_ledger.db "SELECT symbol, status FROM trades WHERE symbol='BTCUSDT' ORDER BY created_at DESC LIMIT 1;"

# Expected:
# BTCUSDT | VALIDATED (or REJECTED)
```

## Files Changed

1. **`simple_webhook_server.js`**
   - Added early symbol classification (line 138-141)
   - Set status before insert (line 147-152, 171)
   - Removed post-insert status update (line 263-266)
   - Updated API response (line 410-429)

## Verification Commands

```bash
# Check ledger status for TradingView-only symbols
sqlite3 data/trade_ledger.db "SELECT symbol, status, created_at FROM trades WHERE symbol LIKE '%:%' OR symbol LIKE '%!%' ORDER BY created_at DESC LIMIT 5;"

# Expected: All should show status='ALERT_ONLY'

# Check ledger status for Binance symbols
sqlite3 data/trade_ledger.db "SELECT symbol, status, created_at FROM trades WHERE symbol LIKE '%USDT' ORDER BY created_at DESC LIMIT 5;"

# Expected: Should show status='VALIDATED', 'FILLED', or 'REJECTED' (not ALERT_ONLY)
```

## Summary

✅ **Fixed:** TradingView-only symbols now persist with `status='ALERT_ONLY'` in ledger  
✅ **Fixed:** API response shows `executed: false, reason: 'TRADINGVIEW_ONLY'` for TradingView-only symbols  
✅ **Preserved:** Normal flow for Binance symbols unchanged  
✅ **Preserved:** TRADING_ENABLED kill switch behavior unchanged  

---

**Status:** ✅ Implementation complete and ready for testing

