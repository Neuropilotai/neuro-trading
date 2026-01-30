# Symbol Routing Implementation Summary

## Changes Made

### 1. **New Symbol Router** (`backend/services/symbolRouter.js`)
- **Purpose:** Classifies symbols and determines data source
- **Key Functions:**
  - `classifySymbol(symbol)` → `{source: 'binance'|'tradingview_only'|'unknown', normalizedSymbol}`
  - `shouldScanSymbol(symbol)` → `boolean` (for autotrader)
  - `shouldFetchFromBinance(symbol)` → `boolean` (for market data)
  - `filterScannableSymbols(symbols[])` → filtered array
- **Rules:**
  - TradingView-only: Contains `:` or `!`, or starts with `OANDA:`, `FX:`, `COMEX:`, `TVC:`
  - Binance: Matches `/^[A-Z0-9]{5,15}$/` and ends with `USDT`
  - Unknown: Everything else

### 2. **Watchlist Caching** (`backend/services/universeLoader.js`)
- **Added:** In-memory cache with TTL (default 60s)
- **Prevents:** Repeated "Merged X symbols from watchlist" spam
- **Cache:** `watchlistCache.symbols` and `watchlistCache.lastLoadTime`
- **Env Var:** `WATCHLIST_CACHE_TTL_MS=60000`

### 3. **TradingView-Only Provider** (`backend/services/providers/tradingViewOnlyProvider.js`)
- **Purpose:** No-op provider that returns empty arrays
- **Prevents:** Binance API calls for TradingView-only symbols
- **Behavior:** `fetchCandles()` and `fetchCandlesSince()` return `[]`

### 4. **Provider Factory Routing** (`backend/services/providerFactory.js`)
- **Added:** Symbol check before provider selection
- **Logic:** If symbol is TradingView-only, return `TradingViewOnlyProvider`
- **Prevents:** Binance API errors for non-Binance symbols

### 5. **Automated Scalping Trader** (`backend/services/automatedScalpingTrader.js`)
- **Updated `getSymbolsToMonitor()`:**
  - Checks `ENABLE_AUTOTRADER` flag
  - Filters symbols using `symbolRouter.filterScannableSymbols()`
  - Only returns Binance symbols for scanning
  - Logs summary (e.g., "Monitoring 3 scannable symbols (1 TradingView-only excluded)")
- **Updated `getMarketData()`:**
  - Early return for TradingView-only symbols
  - Prevents market data fetch attempts

### 6. **Learning Daemon** (`backend/services/learningDaemon.js`)
- **Updated:** Filters symbol pairs to only Binance symbols
- **Respects:** `ENABLE_AUTOTRADER` flag
- **Prevents:** Learning cycles from processing TradingView-only symbols

### 7. **Pattern Learning Engine** (`backend/services/patternLearningEngine.js`)
- **Added:** Early skip for TradingView-only symbols
- **Returns:** `{processed: 0, patterns: 0, reason: 'tradingview_only'}`
- **Prevents:** Unnecessary processing

### 8. **Environment Variables** (`TRADING_ENV.example`)
- **New Flags:**
  - `ENABLE_AUTOTRADER=true/false` (default: true)
  - `AUTOTRADER_DATA_SOURCE=binance` (default: binance)
  - `ENABLE_TRADINGVIEW_ONLY_SYMBOLS=true` (default: true)
  - `WATCHLIST_CACHE_TTL_MS=60000` (default: 60000)
  - `LOG_LEVEL=info` (default: info)

### 9. **Watchlist Updated** (`config/tradingview_watchlist.txt`)
- **Changed:** `PAXGUSDT`, `XAUTUSDT` → `OANDA:XAUUSD`
- **Now:** Uses TradingView symbol format

---

## Files Changed

| File | Change | Why |
|------|--------|-----|
| `backend/services/symbolRouter.js` | **NEW** | Symbol classification and routing logic |
| `backend/services/providers/tradingViewOnlyProvider.js` | **NEW** | No-op provider for TradingView-only symbols |
| `backend/services/universeLoader.js` | **MODIFIED** | Added watchlist caching (TTL-based) |
| `backend/services/providerFactory.js` | **MODIFIED** | Routes TradingView-only symbols to no-op provider |
| `backend/services/automatedScalpingTrader.js` | **MODIFIED** | Filters symbols, skips market data for TradingView-only |
| `backend/services/learningDaemon.js` | **MODIFIED** | Filters symbol pairs to only Binance symbols |
| `backend/services/patternLearningEngine.js` | **MODIFIED** | Early skip for TradingView-only symbols |
| `config/tradingview_watchlist.txt` | **MODIFIED** | Updated to TradingView format (`OANDA:XAUUSD`) |
| `simple_webhook_server.js` | **MODIFIED** | Already has TradingView symbol skip (from previous fix) |
| `TRADING_ENV.example` | **NEW** | Environment variable documentation |

---

## Test Plan

### A) Start Server
```bash
cd /Users/davidmikulis/neuro-pilot-ai
node simple_webhook_server.js
```

**Expected Output:**
```
✅ Trade ledger initialized: ./data/trade_ledger.db
✅ Evaluation DB initialized
🚀 Webhook server listening on port 3014
```

**Verify:**
```bash
curl http://localhost:3014/health
# Should return: {"status":"ok","timestamp":"..."}
```

### B) Test Watchlist Caching
**Expected:** "Merged X symbols from watchlist" should print **at most once per minute**

**Verify:**
- Start server
- Wait 30 seconds
- Check logs - should NOT see repeated "Merged" messages
- If learning daemon runs, it should use cached watchlist

### C) Test Symbol Routing
**Test 1: TradingView Symbol (OANDA:XAUUSD)**
```bash
# Send test webhook
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "OANDA:XAUUSD",
    "action": "BUY",
    "price": 2000.0,
    "quantity": 0.1,
    "alert_id": "test_123",
    "timestamp": 1234567890
  }'
```

**Expected:**
- Log: `ℹ️  TradingView symbol detected (OANDA:XAUUSD), skipping broker execution`
- No Binance API calls
- Trade logged with status `ALERT_ONLY`

**Test 2: Binance Symbol (BTCUSDT)**
```bash
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "action": "BUY",
    "price": 50000.0,
    "quantity": 0.01,
    "alert_id": "test_456",
    "timestamp": 1234567890
  }'
```

**Expected:**
- Normal broker execution (paper trading)
- Trade logged with status `FILLED` or `PENDING`

### D) Test Automated Scanner
**Expected:** Scanner should only process Binance symbols

**Verify:**
- Check logs for "Monitoring X scannable symbols"
- Should NOT see Binance API errors for `OANDA:XAUUSD`
- Should see market data fetches for `BTCUSDT`, `ETHUSDT`, etc.

**If autotrader is enabled:**
```bash
# Check logs for symbol filtering
# Should see: "Monitoring 3 scannable symbols (1 TradingView-only excluded)"
```

### E) Test Learning Daemon
**Expected:** Learning daemon should skip TradingView-only symbols

**Verify:**
- If daemon runs, check logs
- Should NOT see errors for `OANDA:XAUUSD`
- Should process `BTCUSDT`, `ETHUSDT`, etc. normally

---

## Environment Variables

Add to your `.env` file:

```bash
# Automated Trading
ENABLE_AUTOTRADER=true
AUTOTRADER_DATA_SOURCE=binance

# Symbol Routing
ENABLE_TRADINGVIEW_ONLY_SYMBOLS=true

# Watchlist Caching
WATCHLIST_CACHE_TTL_MS=60000

# Logging
LOG_LEVEL=info
```

---

## Verification Checklist

- [ ] Server starts without errors
- [ ] `/health` endpoint responds
- [ ] Watchlist merge log appears at most once per minute
- [ ] TradingView webhook accepts `OANDA:XAUUSD` without Binance errors
- [ ] TradingView webhook accepts `BTCUSDT` and executes normally
- [ ] Automated scanner only processes Binance symbols
- [ ] No Binance API 400 errors in logs
- [ ] Learning daemon skips TradingView-only symbols

---

## Troubleshooting

### Issue: Still seeing Binance errors
**Check:**
1. Is `ENABLE_TRADINGVIEW_ONLY_SYMBOLS=true` in `.env`?
2. Is symbol format correct (contains `:` or `!`)?
3. Check `symbolRouter.classifySymbol()` output in logs

### Issue: Watchlist merge spam continues
**Check:**
1. Is `WATCHLIST_CACHE_TTL_MS` set correctly?
2. Is `universeLoader.load()` being called too frequently?
3. Check cache hit rate in logs

### Issue: Scanner still processes TradingView symbols
**Check:**
1. Is `ENABLE_AUTOTRADER=true`?
2. Is `AUTOTRADER_DATA_SOURCE=binance`?
3. Check `symbolRouter.shouldScanSymbol()` output

---

## Next Steps

1. **Test locally** using the test plan above
2. **Monitor logs** for any Binance API errors
3. **Verify** TradingView webhooks work for both symbol types
4. **Adjust** `WATCHLIST_CACHE_TTL_MS` if needed (longer = less spam, but slower updates)

---

**END OF IMPLEMENTATION SUMMARY**

