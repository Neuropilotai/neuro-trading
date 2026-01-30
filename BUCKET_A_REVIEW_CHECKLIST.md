# Bucket A — Core Code Review Checklist

## Entry Point: `backend/services/automatedScalpingTrader.js`

### Quick Scan Commands (Run in Cursor "Find in Files")
```
TODO
FIXME
console.log
process.env
API_KEY
SECRET
bypass
force
hardcoded
password
token
```

---

## File-by-File Review

### 1. `backend/services/automatedScalpingTrader.js`
**Purpose:** Main automated trading engine

**Check:**
- [ ] All `process.env` have safe defaults
- [ ] No hardcoded API keys or secrets
- [ ] Error handling for broker failures
- [ ] Position sizing logic is safe (no >100% of balance)
- [ ] Symbol routing integration is correct
- [ ] TradingView-only symbols are properly excluded from scanning

**Key Functions:**
- `getSymbolsToMonitor()` - Should filter TradingView-only symbols
- `getMarketData()` - Should skip TradingView-only symbols
- `executeTrade()` - Should handle errors gracefully

---

### 2. `backend/services/symbolRouter.js` (NEW)
**Purpose:** Classifies symbols and routes to appropriate providers

**Check:**
- [ ] Symbol classification logic is correct
- [ ] Binance pattern regex is safe (won't match invalid symbols)
- [ ] TradingView-only detection is accurate
- [ ] `warnedSymbols` Set prevents log spam
- [ ] All methods have clear return types

**Key Methods:**
- `classifySymbol()` - Returns `{source, normalizedSymbol}`
- `shouldScanSymbol()` - Returns boolean
- `shouldFetchFromBinance()` - Returns boolean
- `filterScannableSymbols()` - Returns filtered array

---

### 3. `backend/services/providers/tradingViewOnlyProvider.js` (NEW)
**Purpose:** No-op provider for TradingView-only symbols

**Check:**
- [ ] All methods return empty arrays/null (no actual API calls)
- [ ] No side effects or state changes
- [ ] Properly extends `MarketDataProvider` base class

**Key Methods:**
- `fetchCandles()` - Should return `[]`
- `fetchCandlesSince()` - Should return `[]`
- `normalizeCandle()` - Should return `null`

---

### 4. `backend/services/providerFactory.js`
**Purpose:** Creates and manages market data provider instances

**Check:**
- [ ] Symbol routing integration is correct
- [ ] TradingView-only provider is returned for non-Binance symbols
- [ ] Provider caching works correctly
- [ ] Fallback logic is safe (doesn't crash on unknown providers)

**Key Changes:**
- Added `symbolRouter` check before provider selection
- Returns `TradingViewOnlyProvider` for TradingView-only symbols

---

### 5. `backend/services/deduplicationService.js`
**Purpose:** Prevents duplicate webhook processing

**Check:**
- [ ] `checkDuplicate()` is read-only (doesn't mark as seen)
- [ ] `markAsProcessed()` is only called on success
- [ ] TTL cleanup works correctly
- [ ] File persistence errors are swallowed (in-memory cache still works)
- [ ] Dev endpoints are properly gated

**Key Methods:**
- `checkDuplicate()` - Read-only check
- `markAsProcessed()` - Explicit marking on success
- `getSampleKeys()` - For dev endpoints
- `clearCache()` - For dev endpoints

**Critical Invariant:**
- ✅ 2xx response ⇒ ledger saved ⇒ `markAsProcessed()` called
- ✅ non-2xx response ⇒ NOT marked (can retry)

---

### 6. `backend/middleware/riskCheck.js`
**Purpose:** Risk management middleware for webhook requests

**Check:**
- [ ] TradingView-only symbols bypass trading enabled check (correct behavior)
- [ ] BOS/ATR filter integration is correct
- [ ] Risk engine validation is enforced for Binance symbols
- [ ] No bypasses or force flags
- [ ] Error responses are appropriate (403 for risk failures)

**Key Logic:**
- TradingView-only symbols: Skip `TRADING_ENABLED` check, mark as `ALERT_ONLY`
- Binance symbols: Full risk check + BOS/ATR filter
- BOS trades: Validate ATR expansion and cooldown

---

### 7. `backend/db/tradeLedger.js`
**Purpose:** Immutable trade ledger (source of truth)

**Check:**
- [ ] `getFilledTrades()` returns correct order (chronological)
- [ ] All database operations are atomic
- [ ] Error handling doesn't corrupt state
- [ ] Status updates are idempotent

**Key Methods:**
- `getFilledTrades()` - For state rebuild (NEW)
- `insertTrade()` - Atomic insert
- `updateTradeStatus()` - Idempotent update

---

### 8. `backend/services/paperTradingService.js`
**Purpose:** Paper trading account state management

**Check:**
- [ ] `rebuildStateFromLedger()` logic is correct
- [ ] State rebuild is atomic (no partial state)
- [ ] `totalTrades` is derived from ledger (not `account.trades[]`)
- [ ] No direct manipulation of `account.trades` array
- [ ] Reset flag works correctly

**Key Methods:**
- `rebuildStateFromLedger()` - Reconstructs state from ledger
- `initializeState()` - Entry point (called after server boot)
- `getAccountSummary()` - Returns accurate state

**Critical:**
- ✅ `account.trades = []` should NOT exist
- ✅ `account.trades.push()` should NOT exist
- ✅ `totalTrades` comes from ledger count, not array length

---

### 9. `backend/services/patternLearningEngine.js`
**Purpose:** Pattern learning and recognition

**Check:**
- [ ] TradingView-only symbols are skipped early
- [ ] No processing for non-Binance symbols
- [ ] Symbol routing integration is correct

**Key Changes:**
- Early exit for TradingView-only symbols
- Returns `{processed: 0, patterns: 0, reason: 'tradingview_only'}`

---

### 10. `backend/services/learningDaemon.js`
**Purpose:** Continuous learning cycle manager

**Check:**
- [ ] Symbol filtering is correct (only Binance symbols)
- [ ] `metadata.symbol` is set before provider selection
- [ ] Concurrency limits are respected
- [ ] Error handling doesn't crash the daemon

**Key Changes:**
- Filters pairs using `symbolRouter.shouldScanSymbol()`
- Adds `metadata.symbol` for routing

---

### 11. `backend/services/universeLoader.js`
**Purpose:** Loads and merges trading universe + watchlist

**Check:**
- [ ] Watchlist caching prevents log spam
- [ ] Universe caching prevents repeated merges
- [ ] Cache TTL is configurable
- [ ] File read errors are handled gracefully
- [ ] No race conditions in concurrent loads

**Key Features:**
- Watchlist cache (60s TTL default)
- Universe cache (60s TTL default)
- Promise-based concurrent load protection

---

### 12. `backend/services/bosAtFilter.js` (NEW)
**Purpose:** BOS/ATR expansion filter for webhook validation

**Check:**
- [ ] ATR expansion logic is correct
- [ ] Cooldown tracking is accurate
- [ ] Metrics are properly calculated
- [ ] No false positives/negatives

**Key Methods:**
- `validateBOSTrade()` - Validates BOS trade with ATR + cooldown
- `recordBOS()` - Records BOS signal for cooldown tracking

---

### 13. `simple_webhook_server.js`
**Purpose:** Main webhook server entry point

**Check:**
- [ ] Deduplication invariant is correct (2xx ⇒ marked, non-2xx ⇒ not marked)
- [ ] TradingView-only symbols are handled correctly
- [ ] Ledger save failures return 503 (not 200)
- [ ] `markAsProcessed()` is called only on success
- [ ] Dev endpoints are properly gated
- [ ] No secrets in logs

**Key Flow:**
1. Deduplication check (read-only)
2. Authentication/validation
3. Risk check (with TradingView-only bypass)
4. BOS/ATR filter (if BOS trade)
5. Ledger insert (must succeed for 200)
6. Mark as processed (only if ledger saved)
7. Broker execution (skipped for TradingView-only)

**Critical Invariant:**
```javascript
// ✅ CORRECT:
try {
  await tradeLedger.insertTrade(tradeData);
  await deduplicationService.markAsProcessed(idempotencyKey);
  return res.status(200).json({...});
} catch (error) {
  return res.status(503).json({...}); // NOT marked
}

// ❌ WRONG:
await deduplicationService.markAsProcessed(idempotencyKey);
try {
  await tradeLedger.insertTrade(tradeData);
  return res.status(200).json({...});
} catch (error) {
  return res.status(503).json({...}); // Already marked!
}
```

---

## Cross-File Concerns

### Environment Variables
**Check all files for:**
- [ ] All `process.env` have safe defaults
- [ ] No hardcoded fallbacks that expose secrets
- [ ] Environment variable names are documented

**Common Variables:**
- `ENABLE_AUTOTRADER` (default: true)
- `AUTOTRADER_DATA_SOURCE` (default: 'binance')
- `ENABLE_TRADINGVIEW_ONLY_SYMBOLS` (default: true)
- `TRADING_ENABLED` (default: true)
- `PAPER_STATE_REBUILD_ON_BOOT` (default: true)
- `PAPER_STATE_RESET_ON_BOOT` (default: false)
- `ENABLE_WEBHOOK_DEDUPE` (default: true)
- `DEDUPE_TTL_SECONDS` (default: 3600)

### Error Handling
**Check all files for:**
- [ ] Errors are caught and logged appropriately
- [ ] No unhandled promise rejections
- [ ] Database errors don't crash the server
- [ ] Network errors are handled gracefully

### Security
**Check all files for:**
- [ ] No secrets in code
- [ ] No secrets in logs
- [ ] Authentication is enforced
- [ ] Rate limiting is active
- [ ] Input validation is present

### State Management
**Check all files for:**
- [ ] Paper trading state is atomic
- [ ] Ledger is append-only
- [ ] No race conditions in state updates
- [ ] State rebuild is idempotent

---

## Testing Checklist

After code review, verify:

1. **Deduplication:**
   - [ ] Failed request (403/500/503) does NOT mark as processed
   - [ ] Successful request (200) DOES mark as processed
   - [ ] Duplicate request returns 409

2. **Symbol Routing:**
   - [ ] TradingView-only symbols (OANDA:XAUUSD) skip Binance
   - [ ] Binance symbols (BTCUSDT) fetch from Binance
   - [ ] Watchlist merge doesn't spam logs

3. **Paper Trading:**
   - [ ] State rebuild from ledger works
   - [ ] State reset flag works
   - [ ] `totalTrades` matches ledger count

4. **Risk Management:**
   - [ ] TradingView-only symbols bypass `TRADING_ENABLED` check
   - [ ] Binance symbols respect `TRADING_ENABLED` check
   - [ ] BOS/ATR filter works correctly

---

## Red Flags to Watch For

🚩 **Hardcoded values:**
- API keys, secrets, passwords
- Magic numbers without constants
- Hardcoded URLs or endpoints

🚩 **Bypass logic:**
- `if (dev) bypass()`
- `force: true` flags
- `skipValidation` options

🚩 **Unsafe operations:**
- `eval()` or `Function()` constructors
- Unsanitized user input
- SQL injection risks

🚩 **State corruption risks:**
- Non-atomic state updates
- Race conditions
- Missing error handling

🚩 **Logging issues:**
- Secrets in logs
- Excessive logging in production
- Missing error logs

---

## Review Order (Recommended)

1. **Start with entry point:** `simple_webhook_server.js`
2. **Follow the flow:**
   - Deduplication → `deduplicationService.js`
   - Risk check → `riskCheck.js`
   - Symbol routing → `symbolRouter.js`
   - Provider selection → `providerFactory.js`
   - Ledger operations → `tradeLedger.js`
   - Paper trading → `paperTradingService.js`
3. **Review supporting services:**
   - `automatedScalpingTrader.js`
   - `learningDaemon.js`
   - `patternLearningEngine.js`
   - `universeLoader.js`
   - `bosAtFilter.js`

---

## Sign-Off

After completing this checklist:

- [ ] All files reviewed
- [ ] No red flags found
- [ ] All environment variables documented
- [ ] Error handling verified
- [ ] Security concerns addressed
- [ ] Ready for commit

**Reviewer:** _________________  
**Date:** _________________  
**Status:** ☐ Approved  ☐ Needs Changes

