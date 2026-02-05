# Paper Trading State Rebuild Implementation

## Summary

Implemented deterministic paper trading state rebuild from immutable ledger on boot. This ensures state consistency between the ledger (source of truth) and the cached state file.

---

## Files Changed

### 1. `backend/db/tradeLedger.js`
**Added:** `getFilledTrades()` method
- Returns all trades with `status = 'FILLED'` ordered chronologically
- Used by rebuild function to reconstruct state

### 2. `backend/services/paperTradingService.js`
**Major Changes:**
- Added `initializeState()` method (replaces direct `loadAccountState()` call)
- Added `rebuildStateFromLedger()` method (reconstructs state from FILLED trades)
- Added `resetToInitialState()` method (for dev reset)
- Updated `saveAccountState()` to use atomic write (temp file + rename)
- Added `totalTrades` counter to account object
- Updated `getAccountSummary()` to use ledger-based `totalTrades` count

**Environment Variables:**
- `PAPER_STATE_REBUILD_ON_BOOT=true` (default: true)
- `PAPER_STATE_RESET_ON_BOOT=false` (default: false)

---

## Code Changes

### `backend/db/tradeLedger.js`

```javascript
/**
 * Get all FILLED trades (for state rebuild)
 * @returns {Promise<Array>} - Array of filled trades ordered by execution time
 */
async getFilledTrades() {
  if (!this.enabled || !this.db) {
    return [];
  }

  return new Promise((resolve, reject) => {
    this.db.all(
      `SELECT * FROM trades 
       WHERE status = 'FILLED' 
       ORDER BY COALESCE(filled_at, executed_at, created_at) ASC`,
      [],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      }
    );
  });
}
```

### `backend/services/paperTradingService.js`

**Constructor Changes:**
```javascript
// Environment flags
this.rebuildOnBoot = process.env.PAPER_STATE_REBUILD_ON_BOOT !== 'false';
this.resetOnBoot = process.env.PAPER_STATE_RESET_ON_BOOT === 'true';

// Initialize state (rebuild from ledger or load from file)
this.initializeState();
```

**New Methods:**

1. **`initializeState()`** - Entry point for state initialization
   - Checks reset flag first
   - Attempts rebuild from ledger if enabled
   - Falls back to file load if rebuild fails

2. **`rebuildStateFromLedger()`** - Reconstructs state from FILLED trades
   - Reads all FILLED trades chronologically
   - Replays BUY/SELL operations
   - Calculates balance, positions, PnL
   - Saves rebuilt state atomically

3. **`resetToInitialState()`** - Resets to clean state
   - Sets balance to `ACCOUNT_BALANCE`
   - Clears all positions and trades

**Atomic Write:**
```javascript
// Write to temp file first, then rename (atomic)
const tempFile = `${stateFile}.tmp`;
await fs.writeFile(tempFile, JSON.stringify(state, null, 2));
await fs.rename(tempFile, stateFile);
```

---

## State Rebuild Logic

### Process Flow:
1. **Read FILLED trades** from ledger (chronological order)
2. **Initialize** with `ACCOUNT_BALANCE`
3. **Replay each trade:**
   - **BUY:** Deduct cost, add to position (calculate avg price)
   - **SELL/CLOSE:** Add proceeds, reduce/close position, calculate realized PnL
4. **Calculate totals:**
   - `balance` = initialBalance - all buy costs + all sell proceeds
   - `totalPnL` = sum of realized PnL from sells
   - `positions` = Map of open positions (symbol -> {quantity, avgPrice, ...})
   - `totalTrades` = count of executed trades
5. **Save** rebuilt state to file (atomic write)

### Position Averaging:
- When buying more of existing position, recalculate average price:
  ```javascript
  newAvgPrice = (oldQty * oldAvgPrice + newCost) / newQty
  ```

---

## Environment Variables

Add to `.env`:

```bash
# Paper State Management
PAPER_STATE_REBUILD_ON_BOOT=true   # Rebuild from ledger on boot (default: true)
PAPER_STATE_RESET_ON_BOOT=false    # Reset to initial state on boot (default: false)
```

---

## Testing Commands

### Test A: Verify Clean State (No FILLED Trades)
```bash
# 1. Ensure no FILLED trades in ledger (or delete state file)
rm data/paper_trading_state.json

# 2. Restart server
pkill -f simple_webhook_server.js
node simple_webhook_server.js

# 3. Check health endpoint
curl http://localhost:3001/health | grep -E "openPositions|totalTrades"

# Expected:
# "openPositions": 0
# "totalTrades": 0
```

### Test B: Create FILLED Trade and Rebuild
```bash
# 1. Create a test trade via webhook (with TRADING_ENABLED=true temporarily)
# Edit .env: TRADING_ENABLED=true
# Restart server

# 2. Execute a trade
curl -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":"BTCUSDT",
    "action":"BUY",
    "price":50000,
    "quantity":0.01,
    "alert_id":"test_rebuild_1",
    "timestamp":1738230004,
    "secret":"[DEV_SECRET_PLACEHOLDER]"
  }'

# 3. Verify trade is FILLED in ledger
# (Check data/trade_ledger.db or logs)

# 4. Delete state file and restart
rm data/paper_trading_state.json
pkill -f simple_webhook_server.js
node simple_webhook_server.js

# 5. Check health endpoint
curl http://localhost:3001/health | grep -E "openPositions|totalTrades|balance"

# Expected:
# "openPositions": 1
# "totalTrades": 1
# "balance": <initialBalance - (0.01 * 50000)>
```

### Test C: Reset Flag
```bash
# 1. Add to .env
echo "PAPER_STATE_RESET_ON_BOOT=true" >> .env

# 2. Restart server
pkill -f simple_webhook_server.js
node simple_webhook_server.js

# 3. Check logs for: "⚠️  DEV RESET ACTIVE"

# 4. Check health endpoint
curl http://localhost:3001/health | grep -E "openPositions|totalTrades|balance"

# Expected:
# "openPositions": 0
# "totalTrades": 0
# "balance": <ACCOUNT_BALANCE>
```

---

## Log Messages

**On successful rebuild:**
```
🔁 Rebuilt paper state from ledger: trades=X positions=Y cash=$Z
```

**On clean state (no trades):**
```
🔁 Rebuilt paper state: no executed trades found (clean state)
```

**On reset:**
```
⚠️  DEV RESET ACTIVE: Resetting paper state to initial balance
```

**On rebuild failure (fallback to file):**
```
⚠️  Rebuild from ledger failed, falling back to file: <error>
✅ Loaded paper trading account state: $X
```

---

## State File Format

`data/paper_trading_state.json`:
```json
{
  "balance": 50000.0,
  "initialBalance": 100000.0,
  "totalPnL": -5000.0,
  "dailyPnL": 0.0,
  "totalTrades": 5,
  "positions": {
    "BTCUSDT": {
      "quantity": 0.1,
      "avgPrice": 50000.0,
      "entryTime": "2026-01-30T10:00:00.000Z",
      "stopLoss": 49000.0,
      "takeProfit": 51000.0
    }
  },
  "lastUpdated": "2026-01-30T10:43:13.653Z"
}
```

---

## Health Endpoint Output

After rebuild, `/health` should show:
```json
{
  "account": {
    "balance": 50000.0,
    "initialBalance": 100000.0,
    "totalPnL": -5000.0,
    "openPositions": 1,
    "totalTrades": 5,
    "positions": [
      {
        "symbol": "BTCUSDT",
        "quantity": 0.1,
        "avgPrice": 50000.0,
        "currentValue": 5000.0
      }
    ]
  }
}
```

**Consistency Checks:**
- `openPositions` === `positions.length`
- `totalTrades` === count of FILLED trades in ledger
- `balance` === initialBalance - all buy costs + all sell proceeds

---

## Edge Cases Handled

1. **No ledger available:** Falls back to file load
2. **No FILLED trades:** Resets to clean initial state
3. **Ledger inconsistency:** Logs warning, continues processing
4. **Atomic write failure:** Cleans up temp file
5. **Reset flag:** Ignores ledger, resets to initial state

---

## Files Modified

| File | Changes |
|------|---------|
| `backend/db/tradeLedger.js` | Added `getFilledTrades()` method |
| `backend/services/paperTradingService.js` | Added rebuild logic, atomic writes, env flags |

---

## Next Steps

1. **Test locally** using commands above
2. **Verify** health endpoint shows consistent state
3. **Monitor** logs for rebuild messages
4. **Optional:** Add CLI command to manually trigger rebuild

---

**END OF IMPLEMENTATION**

