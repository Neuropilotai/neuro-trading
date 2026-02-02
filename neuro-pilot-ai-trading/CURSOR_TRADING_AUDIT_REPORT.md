# Cursor Trading Audit Report

**Generated:** 2026-01-21  
**Repository:** `neuro-pilot-ai-trading`  
**Audit Scope:** Complete codebase analysis for production readiness

---

## A) REPO IDENTITY

### 1) Is this repo a standalone git repo or a subfolder of another repo?

**Answer:** SUBFOLDER

- **Evidence:** No `.git` directory found in `/Users/davidmikulis/neuro-pilot-ai/neuro-pilot-ai-trading/`
- **Location:** This is a subdirectory of the parent `neuro-pilot-ai` repository
- **Implication:** Git operations should be run from parent directory

### 2) What is the entrypoint actually used by npm start?

**Answer:** `simple_webhook_server.js`

- **File:** `package.json` line 7
- **Script:** `"start": "node simple_webhook_server.js"`
- **Main field:** `package.json` line 5 also declares `"main": "simple_webhook_server.js"`
- **Entrypoint location:** `/Users/davidmikulis/neuro-pilot-ai/neuro-pilot-ai-trading/simple_webhook_server.js`

### 3) Node version assumptions?

**Answer:** Node.js >= 18.0.0

- **File:** `package.json` lines 14-16
- **Engines:** `"node": ">=18.0.0"`
- **No CI/CD files found** in trading subdirectory (may be in parent repo)

---

## B) ENV SOURCE OF TRUTH

### 4) Which env files can be loaded?

**Answer:** `.env` (from project root via `process.cwd()`)

- **File:** `simple_webhook_server.js` line 17
- **Code:** `require('dotenv').config();`
- **Behavior:** Uses default dotenv behavior (loads from `process.cwd()/.env`)
- **Note:** `.gitignore` lines 2-4 also mentions `.env.local` and `.env.*.local`, but these are NOT loaded by default dotenv config (would need explicit path)

**Files that could be loaded (if dotenv configured):**
- `.env` ✅ (loaded by default)
- `.env.local` ❌ (not loaded, only in .gitignore)
- `.env.*.local` ❌ (not loaded, only in .gitignore)

### 5) Where does dotenv get called?

**Answer:** `simple_webhook_server.js` line 17

```17:17:simple_webhook_server.js
require('dotenv').config();
```

- **Timing:** Called at module load time (before any other imports)
- **Path:** Uses default behavior (loads from `process.cwd()/.env`)

### 6) List ALL environment variables referenced in code (process.env.*), grouped by category:

#### **Server/Ports:**
- `PORT` (default: 3001) - `backend/config/index.js:53`
- `WEBHOOK_PORT` (fallback if PORT not set, default: 3001) - `backend/config/index.js:53`
- `NODE_ENV` (default: 'development') - `backend/config/index.js:54`

#### **Webhook Auth & Validation:**
- `TRADINGVIEW_WEBHOOK_SECRET` (required if auth enabled) - `backend/config/index.js:57`, `backend/middleware/webhookAuth.js:74`
- `WEBHOOK_SECRET` (fallback alias for TRADINGVIEW_WEBHOOK_SECRET) - `backend/config/index.js:57`
- `ENABLE_WEBHOOK_AUTH` (default: true) - `backend/config/index.js:58`, `backend/middleware/webhookAuth.js:67`
- `ENABLE_WEBHOOK_VALIDATION` (default: true) - `backend/config/index.js:59`, `backend/middleware/webhookValidation.js:86`
- `ENABLE_WEBHOOK_DEDUPE` (default: true) - `backend/config/index.js:60`, `backend/services/deduplicationService.js:16`
- `DEDUPE_CACHE_FILE` (default: './data/alert_cache.json') - `backend/services/deduplicationService.js:18`
- `DEDUPE_TTL_SECONDS` (default: 3600) - `backend/services/deduplicationService.js:19`
- `WEBHOOK_RATE_LIMIT` (default: 10) - `backend/config/index.js:101`
- `WEBHOOK_MAX_BODY_SIZE` (default: 1048576) - `backend/config/index.js:104`, `simple_webhook_server.js:96`
- `CORS_ORIGIN` (default: '*') - `backend/config/index.js:105`

#### **Risk Engine / Trading Kill Switch:**
- `TRADING_ENABLED` (default: true) - `backend/config/index.js:63`, `backend/services/riskEngine.js:11`
- `ENABLE_RISK_ENGINE` (default: true) - `backend/config/index.js:66`, `backend/services/riskEngine.js:10`
- `MAX_DAILY_LOSS_PERCENT` (default: 2.0) - `backend/config/index.js:67`, `backend/services/riskEngine.js:14`
- `MAX_POSITION_SIZE_PERCENT` (default: 25.0) - `backend/config/index.js:68`, `backend/services/riskEngine.js:15`
- `MAX_OPEN_POSITIONS` (default: 5) - `backend/config/index.js:69`, `backend/services/riskEngine.js:16`
- `REQUIRE_STOP_LOSS` (default: true) - `backend/config/index.js:70`, `backend/services/riskEngine.js:17`
- `REQUIRE_TAKE_PROFIT` (default: false) - `backend/config/index.js:71`, `backend/services/riskEngine.js:18`

#### **Broker & Paper Trading:**
- `BROKER_TYPE` (default: 'paper') - `backend/config/index.js:81`, `backend/adapters/brokerAdapterFactory.js:28`
- `BROKER` (fallback alias for BROKER_TYPE) - `backend/config/index.js:81`, `backend/adapters/brokerAdapterFactory.js:28`
- `ENABLE_PAPER_TRADING` (default: true) - `backend/config/index.js:82`, `backend/services/paperTradingService.js:23`, `backend/adapters/PaperBrokerAdapter.js:18`
- `ACCOUNT_BALANCE` (default: 500) - `backend/config/index.js:74`, `backend/services/paperTradingService.js:27`, `backend/services/riskEngine.js:121`, `backend/middleware/riskCheck.js:35,90`

#### **Ledger & SQLite Paths:**
- `ENABLE_TRADE_LEDGER` (default: true) - `backend/config/index.js:77`, `backend/db/tradeLedger.js:14`
- `LEDGER_DB_PATH` (required in production, default: './data/ledger.sqlite' in dev) - `backend/config/index.js:78`, `backend/db/tradeLedger.js:20-23`

#### **Learning/Indicators/Automation:**
- `ENABLE_GOOGLE_DRIVE_SYNC` (default: false) - `simple_webhook_server.js:1302,1883`
- `GOOGLE_DRIVE_CLIENT_ID` (no default) - `simple_webhook_server.js:1304,1885`
- `GOOGLE_DRIVE_CLIENT_SECRET` (no default) - `simple_webhook_server.js:1305,1886`
- `GOOGLE_DRIVE_REFRESH_TOKEN` (no default) - `simple_webhook_server.js:1306,1887`

#### **Universe/Symbol Allowlist:**
- `ALLOW_TRADINGVIEW_ONLY_EXECUTION` (default: false) - `backend/config/index.js:91`
- `TRADINGVIEW_ONLY_SYMBOL_ALLOWLIST` (default: '') - `backend/config/index.js:92`
- `TRADINGVIEW_PUBLIC_WEBHOOK_URL` (no default) - `simple_webhook_server.js:1570`

#### **Symbol Cooldown & Guards:**
- `SYMBOL_COOLDOWN_MS` (default: 180000) - `backend/config/index.js:85`, `simple_webhook_server.js:82`
- `GUARD_ORDER` (default: 'position_first') - `backend/config/index.js:88`, `simple_webhook_server.js:87`

#### **Dev Endpoints:**
- `ENABLE_DEV_ENDPOINTS` (default: false) - `backend/config/index.js:98`

#### **TradingDrive Path:**
- `TRADINGDRIVE_PATH` (default: process.cwd()) - `simple_webhook_server.js:313`

### 7) For each env var: is there a default? what is it?

**All defaults documented above in section 6.** Summary:

- **Booleans (default: true):** `ENABLE_WEBHOOK_AUTH`, `ENABLE_WEBHOOK_VALIDATION`, `ENABLE_WEBHOOK_DEDUPE`, `ENABLE_RISK_ENGINE`, `TRADING_ENABLED`, `ENABLE_TRADE_LEDGER`, `ENABLE_PAPER_TRADING`, `REQUIRE_STOP_LOSS`
- **Booleans (default: false):** `REQUIRE_TAKE_PROFIT`, `ALLOW_TRADINGVIEW_ONLY_EXECUTION`, `ENABLE_DEV_ENDPOINTS`, `ENABLE_GOOGLE_DRIVE_SYNC`
- **Numbers:** `PORT`/`WEBHOOK_PORT` (3001), `ACCOUNT_BALANCE` (500), `MAX_DAILY_LOSS_PERCENT` (2.0), `MAX_POSITION_SIZE_PERCENT` (25.0), `MAX_OPEN_POSITIONS` (5), `SYMBOL_COOLDOWN_MS` (180000), `WEBHOOK_RATE_LIMIT` (10), `WEBHOOK_MAX_BODY_SIZE` (1048576), `DEDUPE_TTL_SECONDS` (3600)
- **Strings:** `NODE_ENV` ('development'), `BROKER_TYPE`/`BROKER` ('paper'), `GUARD_ORDER` ('position_first'), `CORS_ORIGIN` ('*'), `DEDUPE_CACHE_FILE` ('./data/alert_cache.json'), `TRADINGVIEW_ONLY_SYMBOL_ALLOWLIST` (''), `LEDGER_DB_PATH` (null, uses './data/ledger.sqlite' in dev only)

### 8) Identify any conflicting / duplicate env vars

**Conflicts Found:**

1. **PORT vs WEBHOOK_PORT:**
   - **Location:** `backend/config/index.js:53`
   - **Resolution:** `PORT` takes precedence, `WEBHOOK_PORT` is fallback
   - **Runtime behavior:** `config.port = getEnv('PORT', getEnv('WEBHOOK_PORT', 3001, 'number'), 'number')`

2. **TRADINGVIEW_WEBHOOK_SECRET vs WEBHOOK_SECRET:**
   - **Location:** `backend/config/index.js:57`
   - **Resolution:** `TRADINGVIEW_WEBHOOK_SECRET` takes precedence, `WEBHOOK_SECRET` is fallback alias
   - **Runtime behavior:** `webhookSecret: getEnv('TRADINGVIEW_WEBHOOK_SECRET', getEnv('WEBHOOK_SECRET', null))`

3. **BROKER_TYPE vs BROKER:**
   - **Location:** `backend/config/index.js:81`, `backend/adapters/brokerAdapterFactory.js:28`
   - **Resolution:** `BROKER_TYPE` takes precedence, `BROKER` is fallback alias
   - **Runtime behavior:** `brokerType: getEnv('BROKER_TYPE', getEnv('BROKER', 'paper'))`

**No conflicts for trading enablement:**
- `TRADING_ENABLED` is the single source of truth for kill switch
- `ENABLE_RISK_ENGINE` controls risk engine feature flag (separate concern)
- Both are used independently: `riskEngine.tradingEnabled` comes from `TRADING_ENABLED`, `riskEngine.enabled` comes from `ENABLE_RISK_ENGINE`

---

## C) HEALTH ENDPOINT TRUTH

### 9) Where does /health build risk.tradingEnabled?

**Answer:** `simple_webhook_server.js` line 752

```751:792:simple_webhook_server.js
app.get('/health', async (req, res) => {
    const riskStats = riskEngine.getStats();
    const dedupeStats = deduplicationService.getStats();
    const learningMetrics = tradingLearningService ? tradingLearningService.getMetrics() : { enabled: false };
    
    // Get broker adapter and account summary
    let accountSummary = null;
    let brokerHealth = null;
    try {
        const brokerAdapter = getBrokerAdapter();
        accountSummary = await brokerAdapter.getAccountSummary();
        brokerHealth = await brokerAdapter.healthCheck();
    } catch (error) {
        console.error('❌ Error getting broker adapter:', error.message);
        // Fallback to paper trading service for backward compatibility
        accountSummary = paperTradingService.getAccountSummary();
        brokerHealth = { connected: false, error: error.message };
    }
    
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: port,
        features: {
            auth: config.enableWebhookAuth,
            validation: config.enableWebhookValidation,
            deduplication: dedupeStats.enabled,
            riskEngine: riskStats.enabled,
            tradeLedger: config.enableTradeLedger,
            paperTrading: config.enablePaperTrading,
            learning: tradingLearningService ? tradingLearningService.enabled : false
        },
        broker: {
            type: config.brokerType,
            health: brokerHealth
        },
        risk: riskStats,
        deduplication: dedupeStats,
        account: accountSummary,
        learning: learningMetrics
    });
});
```

- **Line 752:** `riskStats = riskEngine.getStats()`
- **Line 787:** `risk: riskStats` (includes `tradingEnabled` field)

### 10) Is risk.tradingEnabled derived from TRADING_ENABLED or something else?

**Answer:** YES, derived from `TRADING_ENABLED`

- **File:** `backend/services/riskEngine.js` line 11
- **Code:** `this.tradingEnabled = process.env.TRADING_ENABLED !== 'false';`
- **Default:** `true` (if env var not set or set to anything other than 'false')
- **Health endpoint:** `risk.tradingEnabled` comes from `riskEngine.getStats()` which returns `this.tradingEnabled` (line 299)

### 11) Confirm what /health returns for broker health and ledger features

**Answer:**

**Broker Health:**
- **Field:** `broker.health` (line 785)
- **Source:** `brokerAdapter.healthCheck()` (line 762)
- **Fallback:** If broker adapter fails, returns `{ connected: false, error: error.message }` (line 767)
- **Additional:** `broker.type` shows `config.brokerType` (line 784)

**Ledger Features:**
- **Field:** `features.tradeLedger` (line 779)
- **Source:** `config.enableTradeLedger` (derived from `ENABLE_TRADE_LEDGER` env var)
- **Type:** Boolean (true/false)

**Full Response Structure:**
```json
{
  "status": "healthy",
  "timestamp": "ISO string",
  "port": 3001,
  "features": {
    "auth": true,
    "validation": true,
    "deduplication": true,
    "riskEngine": true,
    "tradeLedger": true,
    "paperTrading": true,
    "learning": false
  },
  "broker": {
    "type": "paper",
    "health": { "connected": true, ... }
  },
  "risk": {
    "enabled": true,
    "tradingEnabled": true,
    "dailyStats": { ... },
    "limits": { ... }
  },
  "deduplication": { ... },
  "account": { ... },
  "learning": { ... }
}
```

---

## D) WEBHOOK AUTH EXPECTATIONS

### 12) What authentication methods are supported for POST /webhook/tradingview?

**Answer:** Two methods supported (priority order):

1. **HMAC Signature Header (Priority):**
   - **Header name:** `X-TradingView-Signature` (case-insensitive, also checks `x-tradingview-signature`)
   - **File:** `backend/middleware/webhookAuth.js` lines 85-86
   - **Algorithm:** SHA-256 HMAC
   - **File:** `backend/middleware/webhookAuth.js` lines 23-26
   - **Format:** Hex string (64 chars), optional `sha256=` prefix is stripped

2. **Body Secret Field (Fallback):**
   - **Field name:** `secret` (exact, case-sensitive)
   - **File:** `backend/middleware/webhookAuth.js` line 149
   - **Comparison:** Timing-safe string comparison using `crypto.timingSafeEqual()`
   - **File:** `backend/middleware/webhookAuth.js` lines 154-157
   - **Behavior:** Secret is removed from body after validation (line 163) to prevent logging/storage

**Priority Logic:**
- If `X-TradingView-Signature` header present → verify HMAC, reject if invalid
- Else if `body.secret` present → verify body secret, reject if invalid
- Else → return 401 Unauthorized

**Feature Flag:**
- Controlled by `ENABLE_WEBHOOK_AUTH` (default: true)
- If disabled, auth middleware is bypassed (line 69-72)

### 13) Provide a SAFE example of how to call the webhook with placeholders:

**Example 1: HMAC Signature Header**

```bash
curl -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: [HMAC_SHA256_HEX_64_CHARS]" \
  -d '{
    "symbol": "BTCUSDT",
    "action": "BUY",
    "price": 50000,
    "quantity": 0.001,
    "alert_id": "alert_123",
    "timestamp": 1640995200000
  }'
```

**Example 2: Body Secret Field**

```bash
curl -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "action": "BUY",
    "price": 50000,
    "quantity": 0.001,
    "alert_id": "alert_123",
    "timestamp": 1640995200000,
    "secret": "[YOUR_TRADINGVIEW_WEBHOOK_SECRET]"
  }'
```

**Note:** The `secret` field is removed from the body after authentication, so it won't appear in logs or be stored in the ledger.

### 14) What error messages exist for missing auth, invalid signature, invalid payload?

**Missing Auth:**
- **File:** `backend/middleware/webhookAuth.js` lines 215-218
- **Status:** 401
- **Message:** `"Missing authentication: Provide either X-TradingView-Signature header or \"secret\" field in request body"`

**Invalid Signature (HMAC):**
- **File:** `backend/middleware/webhookAuth.js` lines 126-129
- **Status:** 401
- **Message:** `"Invalid signature"`
- **Also:** Invalid format returns `"Invalid signature format"` (line 137)

**Invalid Body Secret:**
- **File:** `backend/middleware/webhookAuth.js` lines 184-187
- **Status:** 401
- **Message:** `"Invalid secret"`

**Invalid Payload (Validation):**
- **File:** `backend/middleware/webhookValidation.js` lines 116-120
- **Status:** 400
- **Message:** `"Validation failed"` with `errors` array containing specific field errors
- **Example errors:** `"Missing required field: symbol"`, `"Invalid action: INVALID. Must be BUY, SELL, or CLOSE"`, `"Invalid price: -100. Must be a positive number"`

**Missing Secret Config:**
- **File:** `backend/middleware/webhookAuth.js` lines 78-81
- **Status:** 500
- **Message:** `"Webhook authentication not configured"` with detail: `"TRADINGVIEW_WEBHOOK_SECRET environment variable is required"`

---

## E) SYMBOL SCANNING & "TradingView-only excluded"

### 15) Why did logs show: "Skipping OANDA:XAUUSD - TradingView-only symbol (not scanning)"?

**Answer:** Symbol router classifies symbols and excludes TradingView-only symbols from scanning

- **File:** `backend/services/symbolRouter.js` (referenced but file not found in trading subdirectory - may be in parent repo)
- **Evidence from codebase search:** Symbol router's `shouldScanSymbol()` method returns `false` for TradingView-only symbols when autotrader data source is 'binance'
- **Log location:** `backend/services/symbolRouter.js` line 71 (from search results)
- **Message:** `"ℹ️  Skipping ${classification.normalizedSymbol} - TradingView-only symbol (not scanning)"`

**Code Path:**
1. `automatedScalpingTrader.getSymbolsToMonitor()` calls `symbolRouter.filterScannableSymbols()`
2. `symbolRouter.shouldScanSymbol()` checks classification
3. If `classification.source === 'tradingview_only'` and `autotraderDataSource === 'binance'` → returns `false`
4. Logs warning once per symbol (using `warnedSymbols` Set to prevent spam)

### 16) What qualifies a symbol as "TradingView-only" vs "scannable"?

**Answer:** Classification rules (from `symbolRouter.classifySymbol()`):

**TradingView-only symbols:**
- Contains `:` (colon) - e.g., `OANDA:XAUUSD`
- Contains `!` (exclamation) - e.g., `BTCUSDT!`
- Starts with `OANDA:`, `FX:`, `COMEX:`, `TVC:` prefixes

**Binance symbols (scannable):**
- Matches regex: `/^[A-Z0-9]{5,15}$/`
- Ends with `USDT`

**Unknown symbols:**
- Everything else (treated as unknown source)

**Location:** Classification logic in `symbolRouter.classifySymbol()` (file not in trading subdirectory, likely in parent repo)

**Additional check in webhook handler:**
- **File:** `simple_webhook_server.js` line 209
- **Code:** `const isTradingViewOnlySymbol = symbolClassification.source === 'tradingview_only';`
- **Also:** Simple check in `riskCheck.js` line 87: `orderIntent.symbol.includes(':') || orderIntent.symbol.includes('!')`

### 17) How to make the bot scan at least 1 symbol in paper mode without external broker?

**Answer:** Use Binance symbols (not TradingView-only)

**Options:**

1. **Use Binance symbols in TradingView alerts:**
   - Format: `BTCUSDT`, `ETHUSDT`, etc. (no `:` or `!`)
   - These are classified as 'binance' and will be scanned

2. **Enable TradingView-only execution allowlist:**
   - Set `ALLOW_TRADINGVIEW_ONLY_EXECUTION=true`
   - Add symbol to `TRADINGVIEW_ONLY_SYMBOL_ALLOWLIST=OANDA:XAUUSD`
   - **Note:** This allows webhook execution but does NOT enable scanning (scanner still skips TradingView-only symbols)

3. **Change autotrader data source (if configurable):**
   - If `autotraderDataSource !== 'binance'`, TradingView-only symbols may be scannable
   - **File:** `backend/services/symbolRouter.js` line 63 (from search results)
   - **Logic:** Only blocks scanning when `autotraderDataSource === 'binance'`

**Recommended:** Use Binance symbols (`BTCUSDT`, `ETHUSDT`) for paper trading without external broker connection.

---

## F) LEDGER & IMMUTABILITY

### 18) What tables exist? migrations? schema versioning?

**Answer:**

**Table:** `trades`

**Schema (File:** `backend/db/tradeLedger.js` lines 107-136):**
```sql
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT UNIQUE NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  confidence REAL,
  account_balance REAL,
  pnl REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  alert_id TEXT,
  alert_timestamp INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT,
  filled_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_idempotency_key ON trades(idempotency_key);
```

**Schema Versioning:**
- **File:** `backend/db/tradeLedger.js` lines 68-100
- **Method:** Uses SQLite `PRAGMA user_version`
- **Current version:** 1 (line 78)
- **Migration logic:** Placeholder for future migrations (line 91-93)

**Migrations:**
- **Status:** No migration system yet
- **Future:** Migration logic stubbed at lines 90-93 (warns on version mismatch but doesn't migrate)

### 19) Are updates/deletes prevented in any way? (code or triggers)

**Answer:** PARTIAL IMMUTABILITY - Updates allowed for status changes only, deletes prevented

**Updates:**
- **Allowed:** Status updates via `updateTradeStatus()` method
- **File:** `backend/db/tradeLedger.js` lines 215-323
- **Restrictions:**
  - Only `status` field and related timestamp fields can be updated
  - Invariants enforced (lines 221-254):
    - `FILLED` → `rejection_reason` MUST be NULL
    - `REJECTED` → `executed_at` & `filled_at` MUST be NULL
    - `ALERT_ONLY` → `executed_at` & `filled_at` MUST be NULL
  - Updates logged (status changes tracked)

**Deletes:**
- **Prevented:** No DELETE statements in codebase
- **No triggers:** SQLite triggers not used
- **Enforcement:** Code-level only (no DELETE methods exist)

**Inserts:**
- **Append-only:** `insertTrade()` is the only insert method
- **File:** `backend/db/tradeLedger.js` lines 153-203
- **Idempotency:** `idempotency_key` UNIQUE constraint prevents duplicates (line 192-194)

### 20) What API routes write to the ledger? what event causes insert?

**Answer:**

**Routes that write to ledger:**

1. **POST /webhook/tradingview** (primary)
   - **File:** `simple_webhook_server.js` line 137
   - **Insert location:** Line 297
   - **Code:** `await tradeLedger.insertTrade(tradeData);`
   - **Event:** TradingView webhook alert received and validated

**No other routes write to ledger:**
- Dev endpoints (`/api/dev/positions/close`, `/api/dev/paper/reset`) do NOT write to ledger
- Dashboard endpoints are read-only
- Status updates use `updateTradeStatus()` (not inserts)

**Event Flow:**
1. Webhook received → `POST /webhook/tradingview`
2. Auth validated → `webhookAuth` middleware
3. Payload validated → `webhookValidation` middleware
4. Deduplication checked → `deduplicationService`
5. Risk check → `riskCheck` middleware
6. **Trade record created** → `tradeData` object built (lines 258-290)
7. **Ledger insert** → `tradeLedger.insertTrade(tradeData)` (line 297)
8. Response returned → 200 OK with trade details

**Initial Status:**
- `VALIDATED` if symbol is scannable or allowlisted TradingView-only (line 247)
- `ALERT_ONLY` if TradingView-only and not allowlisted (line 247)

---

## G) CURRENT STATE SUMMARY

### 21) List all current endpoints (routes) with methods and files

**Endpoints in `simple_webhook_server.js`:**

| Method | Route | File | Line |
|--------|-------|------|------|
| POST | `/webhook/tradingview` | `simple_webhook_server.js` | 137 |
| GET | `/webhook/tradingview` | `simple_webhook_server.js` | 741 |
| GET | `/health` | `simple_webhook_server.js` | 751 |
| GET | `/api/account` | `simple_webhook_server.js` | 795 |
| GET | `/api/learning` | `simple_webhook_server.js` | 809 |
| GET | `/api/dedupe/stats` | `simple_webhook_server.js` | 822 |
| POST | `/api/dev/positions/close` | `simple_webhook_server.js` | 860 |
| POST | `/api/dev/positions/flatten` | `simple_webhook_server.js` | 929 |
| POST | `/api/dev/paper/reset` | `simple_webhook_server.js` | 994 |
| POST | `/api/dedupe/reset` | `simple_webhook_server.js` | 1079 |
| GET | `/api/dashboard/trades` | `simple_webhook_server.js` | 1120 |
| GET | `/api/dashboard/positions` | `simple_webhook_server.js` | 1143 |
| GET | `/api/dashboard/account` | `simple_webhook_server.js` | 1163 |
| GET | `/api/dashboard/health` | `simple_webhook_server.js` | 1189 |
| GET | `/api/dashboard/learning` | `simple_webhook_server.js` | 1229 |
| GET | `/api/patterns` | `simple_webhook_server.js` | 1248 |
| GET | `/api/patterns/stats` | `simple_webhook_server.js` | 1281 |
| GET | `/api/patterns/:id` | `simple_webhook_server.js` | 1376 |
| GET | `/api/patterns/daily` | `simple_webhook_server.js` | 1403 |
| GET | `/api/patterns/opening-trends` | `simple_webhook_server.js` | 1414 |
| GET | `/api/automated/performance` | `simple_webhook_server.js` | 1428 |
| POST | `/api/automated/start` | `simple_webhook_server.js` | 1439 |
| POST | `/api/automated/stop` | `simple_webhook_server.js` | 1450 |
| GET | `/api/automated/status` | `simple_webhook_server.js` | 1461 |
| GET | `/api/patterns/best-times` | `simple_webhook_server.js` | 1489 |
| GET | `/api/tradingview/telemetry` | `simple_webhook_server.js` | 1502 |
| GET | `/api/tradingview/connection` | `simple_webhook_server.js` | 1530 |
| GET | `/api/whales/signals` | `simple_webhook_server.js` | 1626 |
| GET | `/api/whales/signals/:symbol` | `simple_webhook_server.js` | 1638 |
| GET | `/api/whales/stats` | `simple_webhook_server.js` | 1650 |
| GET | `/api/patterns/opening/:timeframe` | `simple_webhook_server.js` | 1662 |
| POST | `/api/patterns/match` | `simple_webhook_server.js` | 1689 |
| POST | `/api/patterns/sync` | `simple_webhook_server.js` | 1730 |
| GET | `/learn/health` | `simple_webhook_server.js` | 1760 |
| GET | `/learn/status` | `simple_webhook_server.js` | 1795 |
| GET | `/learn/storage/status` | `simple_webhook_server.js` | 1990 |
| GET | `/learn/backfill/status` | `simple_webhook_server.js` | 2009 |
| GET | `/learn/metrics/latest` | `simple_webhook_server.js` | 2051 |
| GET | `/trading_dashboard.html` | `simple_webhook_server.js` | 2099 |
| GET | `/monitor` | `simple_webhook_server.js` | 2104 |
| GET | `/api/tradingview/export` | `simple_webhook_server.js` | 2111 |
| GET | `/api/tradingview/trades` | `simple_webhook_server.js` | 2128 |
| GET | `/` | `simple_webhook_server.js` | 2145 |

**Total:** 40 endpoints

### 22) Identify untracked docs/scripts that should move into /docs or /scripts

**Current Structure:**
- `/scripts/` exists and contains: `env-check.js`, `ledger-smoke.js`, `secret-scan.sh`
- No `/docs/` directory found

**Files that should be organized:**

**Should move to `/docs/`:**
- `README.md` (keep in root, but could have detailed docs in `/docs/`)
- `RUNBOOK.md` (operational documentation)
- `SMOKE_TEST_CHECKLIST.md` (testing documentation)
- `PLAN.md` (if planning docs)
- `SETUP_COMPLETE.md` (setup documentation)

**Already in correct location:**
- `ENV_EXAMPLE.txt` (root is fine for env examples)
- `package.json` (root)
- `simple_webhook_server.js` (root, main entrypoint)

**Recommendation:**
- Create `/docs/` directory
- Move: `RUNBOOK.md`, `SMOKE_TEST_CHECKLIST.md`, `SETUP_COMPLETE.md`, `PLAN.md`
- Keep `README.md` in root (standard practice)

### 23) Give a recommended "minimum safe production config" env list (names only)

**Minimum Safe Production Config (Required + Security):**

```env
# Server (required)
PORT=3001
NODE_ENV=production

# Webhook Security (required if auth enabled)
TRADINGVIEW_WEBHOOK_SECRET=YOUR_SECRET_HERE
ENABLE_WEBHOOK_AUTH=true
ENABLE_WEBHOOK_VALIDATION=true
ENABLE_WEBHOOK_DEDUPE=true

# Risk Management (required for safety)
ENABLE_RISK_ENGINE=true
TRADING_ENABLED=true
MAX_DAILY_LOSS_PERCENT=2.0
MAX_POSITION_SIZE_PERCENT=25.0
MAX_OPEN_POSITIONS=5
REQUIRE_STOP_LOSS=true

# Account (required)
ACCOUNT_BALANCE=100000

# Trade Ledger (required in production)
ENABLE_TRADE_LEDGER=true
LEDGER_DB_PATH=/path/to/production/ledger.sqlite

# Broker (required)
BROKER_TYPE=paper
ENABLE_PAPER_TRADING=true

# Security (recommended)
WEBHOOK_MAX_BODY_SIZE=1048576
CORS_ORIGIN=https://yourdomain.com
ENABLE_DEV_ENDPOINTS=false
```

**Optional but recommended:**
- `SYMBOL_COOLDOWN_MS=180000`
- `GUARD_ORDER=position_first`
- `WEBHOOK_RATE_LIMIT=10`
- `REQUIRE_TAKE_PROFIT=false` (optional)

**NOT required for minimum:**
- `ALLOW_TRADINGVIEW_ONLY_EXECUTION` (default: false)
- `TRADINGVIEW_ONLY_SYMBOL_ALLOWLIST` (default: '')
- Google Drive sync vars
- Learning/pattern vars (optional features)

---

## NEXT: Ready-to-run smoke tests

### 1. Environment Check
```bash
cd /Users/davidmikulis/neuro-pilot-ai/neuro-pilot-ai-trading
npm run test:env
```

### 2. Ledger Smoke Test
```bash
npm run test:ledger
```

### 3. Full Smoke Test Suite
```bash
npm run test:smoke
```

### 4. Health Endpoint Check
```bash
curl http://localhost:3001/health | jq
```

### 5. Webhook Auth Test (HMAC)
```bash
# Generate HMAC signature (replace SECRET and payload)
SECRET="YOUR_SECRET_HERE"
PAYLOAD='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.001,"alert_id":"test","timestamp":1640995200000}'
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
curl -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: $SIG" \
  -d "$PAYLOAD"
```

### 6. Webhook Auth Test (Body Secret)
```bash
curl -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "action": "BUY",
    "price": 50000,
    "quantity": 0.001,
    "alert_id": "test",
    "timestamp": 1640995200000,
    "secret": "YOUR_SECRET_HERE"
  }'
```

### 7. Ledger Verification
```bash
# Check ledger file exists and is writable
ls -la ./data/ledger.sqlite
sqlite3 ./data/ledger.sqlite "SELECT COUNT(*) FROM trades;"
```

### 8. Config Validation
```bash
# Start server (will validate config on startup)
npm start
# Should exit with error if required vars missing
```

---

**Report Complete**

