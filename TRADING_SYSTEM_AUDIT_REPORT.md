# Trading System Audit Report
**Date:** 2025-01-20  
**Auditor:** Senior DevOps Engineer & Trading Systems Specialist  
**System:** Neuro-Pilot-AI Trading System

---

## DELIVERABLE A: Repository Map

### Candidate Root Folders
- **`/backend/`** - Main Node.js backend (484 files)
  - `/backend/agents/trading/` - Trading agent implementations
  - `/backend/super_trading_agent.js` - Core trading agent (2000+ lines)
  - `/backend/enhanced_trading_agent.js` - Enhanced trading logic
  - `/backend/autonomous_trading_system.js` - Autonomous trading system
  - `/backend/trading_monitor.js` - Trade monitoring
- **`/TradingDrive/`** - Trading data storage
  - `/TradingDrive/pinescript_strategies/` - Pine Script strategies
  - `/TradingDrive/webhook_logs/` - Webhook trade logs
  - `/TradingDrive/performance_logs/` - Performance tracking
  - `/TradingDrive/live_signals/` - Live signal storage
- **`/inventory-enterprise/`** - Enterprise inventory system (separate from trading)

### Entry Points (Server Start Files)
1. **`simple_webhook_server.js`** (Port 3014)
   - TradingView webhook endpoint: `/webhook/tradingview`
   - Basic file-based logging
   
2. **`webhook_integration_server.js`** (Port 3009)
   - Generic webhook server for Zapier/n8n
   - NOT trading-specific
   
3. **`connect_tradingview.js`**
   - TradingView connection setup script
   - Creates webhook server on port 8080
   
4. **`start-trading-only.sh`**
   - Starts trading system on port 8084
   - Basic Express server

5. **`backend/server.js`** (Main backend server)
   - Full application server
   - May include trading routes

### Config Files and Env Templates
- **`.env`** - Main environment file (exists, filtered)
- **`.env.example`** - Template (filtered)
- **`.env.production`** - Production config
- **`.env.deployment`** - Deployment config
- **`package.json`** - Root package (minimal, points to inventory-enterprise)
- **`Dockerfile`** - Docker config (for inventory-enterprise, not trading)
- **`railway.toml`** - Railway deployment config
- **`Procfile`** - Process file

### Pine Script Folder(s)
- **`/TradingDrive/pinescript_strategies/`**
  - `elite_v2_pinescript_clean.pine` (root level)
  - `super_ai_elite_v2.pine`
  - `super_ai_visual_strategy.pine`
  - `neuro_pilot_enhanced_strategy.pine`
  - `neuro_pilot_adaptive.pine`
  - `neuro_pilot_momentum.pine`
  - `neuro_pilot_mean_reversion.pine`
  - `ai_adaptive_indicators.pine`

### Dashboard/UI Folders
- **`/frontend/`** - React TypeScript frontend
- **`/backend/public/`** - Static HTML dashboards
- **`trading_dashboard.html`** - Trading dashboard (root level)
- **`backend/super_dashboard.js`** - Super dashboard server
- **`backend/live_agent_dashboard.js`** - Live agent dashboard

---

## DELIVERABLE B: Boot + Data Flow

### Runtime & Boot Sequence

**Language/Runtime:**
- **Node.js** (v20+) - Primary runtime
- **Python 3.8+** - For TradingView Pro agent (`backend/agents/trading/tradingview_pro_agent.py`)

**Start Commands:**
```bash
# Simple webhook server
node simple_webhook_server.js  # Port 3014

# Trading system only
./start-trading-only.sh  # Port 8084

# Full system
npm start  # Runs: cd inventory-enterprise/backend && node server-v21_1.js
```

**Webhook Server Startup:**
- `simple_webhook_server.js` starts Express server on port 3014
- Listens for POST requests to `/webhook/tradingview`
- No authentication or validation currently

**Queue/Worker/Cron:**
- **No dedicated queue system** found
- **No worker processes** for async order processing
- **No cron jobs** for scheduled tasks
- Trading agents run in-memory event loops

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ TradingView Alert (Pine Script)                                 │
│ - JSON payload with symbol, action, price, confidence         │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Webhook Endpoint: POST /webhook/tradingview (Port 3014)         │
│ File: simple_webhook_server.js                                  │
│ ❌ NO AUTHENTICATION                                             │
│ ❌ NO VALIDATION                                                 │
│ ❌ NO DEDUPLICATION                                              │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Processing (simple_webhook_server.js)                           │
│ - Parses JSON body                                               │
│ - Extracts: symbol, action, price, ai_score, confidence        │
│ - Creates tradeData object                                       │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ File-Based Logging                                               │
│ - Saves to: ./TradingDrive/webhook_logs/trades.json            │
│ - Appends to array (no database)                                 │
│ - No persistence guarantees                                      │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Response: 200 OK                                                 │
│ { status: 'success', message: 'Trade alert received' }          │
└─────────────────────────────────────────────────────────────────┘

MISSING COMPONENTS:
❌ Validation/Auth layer
❌ Risk Engine
❌ Broker Adapter (OANDA/IBKR)
❌ Order Normalization
❌ Idempotency
❌ Database/Immutable Ledger
❌ Dashboard/Reports (separate systems exist but not connected)
```

**Current State:**
- TradingView alerts → Webhook → File logging → End
- **No broker integration** (paper trading only, in-memory)
- **No risk management** in webhook path
- **No order execution** from webhook
- Trading agents exist but operate independently

---

## DELIVERABLE C: Audit Report

| Category | Status | Key Files | Risks | Recommended Fix |
|----------|--------|-----------|-------|-----------------|
| **A) Alert Ingestion & Security** | 🔴 **CRITICAL GAPS** | `simple_webhook_server.js:28-86` | **CRITICAL:** No authentication, no HMAC, no IP allowlist, no rate limiting, no replay protection, no input validation | 1. Add HMAC signature verification using TradingView secret<br>2. Implement rate limiting (express-rate-limit)<br>3. Add alert ID + timestamp deduplication<br>4. Validate JSON schema (Joi/Zod)<br>5. IP allowlist (optional, env var) |
| **B) Order Normalization & Idempotency** | 🔴 **MISSING** | N/A (no order processing) | **CRITICAL:** No OrderIntent structure, no idempotency keys, no state machine, no retry logic | 1. Create OrderIntent schema (symbol, side, quantity, price, stopLoss, takeProfit)<br>2. Generate idempotency key (alert_id + timestamp hash)<br>3. Implement order state machine (PENDING → VALIDATED → RISK_CHECKED → EXECUTED → FILLED/REJECTED)<br>4. Store idempotency keys in Redis/file to prevent duplicates |
| **C) Risk Management** | 🟡 **PARTIAL** | `backend/super_trading_agent.js:2142-2162`<br>`backend/enhanced_trading_agent.js:244-279` | **HIGH:** Risk rules exist in agents but NOT enforced in webhook path. No daily loss limit, no kill switch, no position limits | 1. Add risk engine middleware before order execution<br>2. Enforce daily loss limit (env var: MAX_DAILY_LOSS_PERCENT)<br>3. Implement kill switch (env var: TRADING_ENABLED=false)<br>4. Check max open positions per symbol<br>5. Validate position sizing (max % of equity)<br>6. Enforce stop loss/take profit on all orders |
| **D) Broker Adapters** | 🔴 **MISSING** | `backend/agents/trading/tradingview_pro_agent.py:461-488` (paper only) | **CRITICAL:** No OANDA/IBKR integration. Only in-memory paper trading exists. No real broker API calls. | 1. Create broker adapter interface (BrokerAdapter.js)<br>2. Implement OANDA adapter (oanda-v20 SDK)<br>3. Implement IBKR adapter (ib_insync or TWS API)<br>4. Add paper trading mode (env var: BROKER_MODE=paper|oanda|ibkr)<br>5. Error handling with exponential backoff<br>6. Connection health checks |
| **E) Persistence & Observability** | 🟡 **BASIC** | `simple_webhook_server.js:52-71` (file-based)<br>`backend/trading_monitor.js:32-37` | **HIGH:** File-based logging only. No database, no immutable ledger, no metrics aggregation, no health checks | 1. Create trade ledger table (PostgreSQL/SQLite)<br>2. Append-only trade records (immutable)<br>3. Add metrics: PnL, drawdown, win rate, Sharpe ratio<br>4. Health check endpoint with uptime<br>5. Structured logging (Winston/Pino)<br>6. Daily PnL reports (cron job) |
| **F) Strategy Layer** | 🟢 **GOOD** | `TradingDrive/pinescript_strategies/*.pine`<br>`elite_v2_pinescript_clean.pine` | **LOW:** Pine scripts exist and are well-structured. No strategy config storage, no parameterization system | 1. Store strategy configs in database<br>2. Parameter versioning<br>3. Backtesting vs live parity checks<br>4. Strategy performance tracking |
| **G) Deployment Readiness** | 🟡 **PARTIAL** | `Dockerfile` (inventory only)<br>`railway.toml`<br>`Procfile` | **MEDIUM:** Docker exists for inventory, not trading. Env vars not documented. No CI/CD for trading. | 1. Create trading-specific Dockerfile<br>2. Document all env vars in README<br>3. Add docker-compose.yml for local dev<br>4. Create CI/CD pipeline (GitHub Actions)<br>5. Add health check endpoint<br>6. Secrets management (no secrets in repo) |

### Risk Summary
- **CRITICAL (3):** Alert security, Broker adapters, Order normalization
- **HIGH (2):** Risk management enforcement, Persistence
- **MEDIUM (1):** Deployment readiness
- **LOW (1):** Strategy layer

---

## DELIVERABLE D: Finish Plan

### Track 1: Fast Track (TradingView Paper Trading + Logging + Daily Report)

**Goal:** Get TradingView alerts → Paper trading → Logging → Daily report working end-to-end

#### Milestone M1: Secure Webhook Endpoint
**Acceptance Tests:**
- [ ] POST `/webhook/tradingview` with invalid HMAC → 401 Unauthorized
- [ ] POST with duplicate alert_id → 409 Conflict (deduplication)
- [ ] POST with malformed JSON → 400 Bad Request
- [ ] Rate limit: >10 requests/minute → 429 Too Many Requests
- [ ] Valid request → 200 OK + trade logged

**Effort:** M (Medium)

#### Milestone M2: Order Normalization & Idempotency
**Acceptance Tests:**
- [ ] Alert → OrderIntent created with idempotency_key
- [ ] Duplicate alert_id → OrderIntent retrieved (no duplicate)
- [ ] OrderIntent schema validation (all required fields)
- [ ] State machine: PENDING → VALIDATED → RISK_CHECKED

**Effort:** M (Medium)

#### Milestone M3: Risk Engine Integration
**Acceptance Tests:**
- [ ] Order exceeds daily loss limit → REJECTED
- [ ] Order exceeds max position size → REJECTED
- [ ] Kill switch enabled → All orders REJECTED
- [ ] Stop loss/take profit enforced on all orders
- [ ] Risk check passes → Order proceeds

**Effort:** M (Medium)

#### Milestone M4: Paper Trading Execution
**Acceptance Tests:**
- [ ] OrderIntent → Paper trade executed (in-memory wallet)
- [ ] Position tracking (quantity, avgPrice)
- [ ] PnL calculation on exit
- [ ] Trade saved to ledger

**Effort:** S (Small)

#### Milestone M5: Immutable Trade Ledger
**Acceptance Tests:**
- [ ] All trades saved to database (append-only)
- [ ] Trade records immutable (no updates/deletes)
- [ ] Query: GET `/api/trades` returns all trades
- [ ] Query: GET `/api/trades/:id` returns single trade

**Effort:** S (Small)

#### Milestone M6: Daily Report Generation
**Acceptance Tests:**
- [ ] Cron job runs daily at 9 AM UTC
- [ ] Report includes: total PnL, win rate, trades count, drawdown
- [ ] Report saved to file: `TradingDrive/reports/daily_YYYY-MM-DD.json`
- [ ] Report emailed (if EMAIL_REPORTS=true)

**Effort:** S (Small)

**Total Track 1 Effort:** M+M+M+S+S+S = **Medium-Large**

---

### Track 2: Full Track (TradingView → Broker Practice/Paper → Dashboard)

**Goal:** Complete system with broker integration (OANDA/IBKR) and full dashboard

#### Milestone M1-M6: (Same as Track 1)

#### Milestone M7: Broker Adapter Interface
**Acceptance Tests:**
- [ ] BrokerAdapter interface defined
- [ ] Paper broker adapter implemented
- [ ] OANDA adapter skeleton (env var: BROKER=oanda)
- [ ] IBKR adapter skeleton (env var: BROKER=ibkr)
- [ ] Adapter selection via env var works

**Effort:** L (Large)

#### Milestone M8: OANDA Integration
**Acceptance Tests:**
- [ ] OANDA API connection established
- [ ] Order placement works (paper account)
- [ ] Position query works
- [ ] Error handling with retry/backoff
- [ ] Connection health check

**Effort:** L (Large)

#### Milestone M9: IBKR Integration
**Acceptance Tests:**
- [ ] TWS/IB Gateway connection
- [ ] Order placement works (paper account)
- [ ] Position query works
- [ ] Error handling
- [ ] Connection health check

**Effort:** L (Large)

#### Milestone M10: Dashboard Integration
**Acceptance Tests:**
- [ ] Dashboard shows live trades
- [ ] Dashboard shows PnL metrics
- [ ] Dashboard shows positions
- [ ] Dashboard shows risk limits status
- [ ] Real-time updates (WebSocket or polling)

**Effort:** M (Medium)

#### Milestone M11: Health Checks & Monitoring
**Acceptance Tests:**
- [ ] GET `/health` returns system status
- [ ] Health check includes: webhook status, broker connection, database, risk limits
- [ ] Uptime monitoring
- [ ] Alerting on failures (email/Slack)

**Effort:** S (Small)

#### Milestone M12: Production Deployment
**Acceptance Tests:**
- [ ] Dockerfile builds successfully
- [ ] docker-compose.yml works locally
- [ ] All env vars documented
- [ ] Secrets in env vars (not in code)
- [ ] CI/CD pipeline runs tests
- [ ] Deployment to Railway/Render works

**Effort:** M (Medium)

**Total Track 2 Effort:** Track 1 + L+L+L+M+S+M = **Very Large**

---

## DELIVERABLE E: Implementation Plan for Top 3 Fixes

### Fix #1: Alert Security (Auth + Validation + Dedupe)
**Priority:** CRITICAL  
**Files to Create/Modify:**
- `backend/middleware/webhookAuth.js` (NEW)
- `backend/middleware/webhookValidation.js` (NEW)
- `backend/services/deduplicationService.js` (NEW)
- `simple_webhook_server.js` (MODIFY - add middleware)

**Feature Flags:**
- `ENABLE_WEBHOOK_AUTH=true` (default: true)
- `ENABLE_WEBHOOK_DEDUPE=true` (default: true)
- `TRADINGVIEW_WEBHOOK_SECRET=your-secret-here` (required if auth enabled)

**Test Commands:**
```bash
# Test valid request
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: <hmac>" \
  -d '{"symbol":"BTCUSDT","action":"BUY","price":50000,"alert_id":"test-123","timestamp":1234567890}'

# Test duplicate (should return 409)
curl -X POST ... (same alert_id)

# Test invalid signature (should return 401)
curl -X POST ... (wrong signature)
```

---

### Fix #2: Risk Controls (Daily Loss Limit + Kill Switch)
**Priority:** CRITICAL  
**Files to Create/Modify:**
- `backend/services/riskEngine.js` (NEW)
- `backend/middleware/riskCheck.js` (NEW)
- `simple_webhook_server.js` (MODIFY - add risk check)

**Feature Flags:**
- `ENABLE_RISK_ENGINE=true` (default: true)
- `TRADING_ENABLED=true` (default: true, set to false for kill switch)
- `MAX_DAILY_LOSS_PERCENT=2.0` (default: 2%)
- `MAX_POSITION_SIZE_PERCENT=25.0` (default: 25%)
- `MAX_OPEN_POSITIONS=5` (default: 5)

**Test Commands:**
```bash
# Test kill switch (should reject all orders)
TRADING_ENABLED=false node simple_webhook_server.js
curl -X POST ... # Should return 503 Service Unavailable

# Test daily loss limit (simulate losses, then try order)
# After daily loss exceeds limit, orders should be rejected
```

---

### Fix #3: Immutable Trade Ledger
**Priority:** HIGH  
**Files to Create/Modify:**
- `backend/db/tradeLedger.js` (NEW - SQLite/PostgreSQL)
- `backend/models/Trade.js` (NEW)
- `backend/migrations/001_create_trade_ledger.sql` (NEW)
- `simple_webhook_server.js` (MODIFY - save to ledger)

**Feature Flags:**
- `ENABLE_TRADE_LEDGER=true` (default: true)
- `LEDGER_DB_PATH=./data/trade_ledger.db` (SQLite) or `DATABASE_URL=postgresql://...`

**Test Commands:**
```bash
# Test trade saved to ledger
curl -X POST ... # Valid trade
sqlite3 ./data/trade_ledger.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 1;"

# Test immutability (try to update/delete - should fail)
sqlite3 ./data/trade_ledger.db "UPDATE trades SET ..." # Should fail (no UPDATE allowed)
```

---

## Next Steps

1. **Review this audit report**
2. **Approve implementation plan**
3. **Implement top 3 fixes with feature flags**
4. **Test each fix independently**
5. **Update README with env vars and instructions**

---

**Report Generated:** 2025-01-20  
**System Status:** 🔴 **NOT PRODUCTION READY** - Critical security and risk management gaps

