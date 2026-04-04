# NeuroPilot Trading v2 — Validation & Hardening Report

**Date:** 2026-03-06  
**Scope:** Validate and harden v2 only; no moves, archive, or deletes outside v2.

---

## 1. Minimum Execution Path (Webhook → Response)

Single path that must work end-to-end:

```
POST /webhook/tradingview
  → rate limiter
  → webhookAuth (HMAC or body secret; can be disabled with ENABLE_WEBHOOK_AUTH=false)
  → webhookValidation (payload schema; can be disabled with ENABLE_WEBHOOK_VALIDATION=false)
  → deduplicationService.checkDuplicate(req.body)
  → riskCheck (riskEngine + bosAtFilter) → sets req.orderIntent, req.bosMetrics
  → createWebhookIntegration(handler) → attaches req.liveExecutionGate
  → handler:
       symbolRouter.classifySymbol(orderIntent.symbol)
       → tradeLedger.initialize() + tradeLedger.insertTrade(tradeData)
       → (optional) file backup to TradingDrive/webhook_logs
       → (optional) indicatorGenerator.evaluateMarketConditions if enabled
       → liveExecutionGate.executeOrder(orderIntent) OR getBrokerAdapter().placeOrder(orderIntent)
       → (optional) tradingLearningService.learnFromTrade(...)
       → tradingViewTelemetry.recordWebhook(...)
  → response 200 (or 409 duplicate, 503 ledger failure, 4xx auth/validation/risk)
```

---

## 2. Dependency Map (Exact Path Only)

| Step | Module | Dependency type |
|------|--------|------------------|
| **Entry** | server.js | express, dotenv, rateLimit |
| **Auth** | backend/middleware/webhookAuth.js | crypto (built-in), optional tradingViewTelemetry |
| **Validation** | backend/middleware/webhookValidation.js | optional tradingViewTelemetry |
| **Dedupe** | backend/services/deduplicationService.js | fs, path, crypto (built-in) |
| **Risk** | backend/middleware/riskCheck.js | riskEngine, bosAtFilter |
| **Risk engine** | backend/services/riskEngine.js | evaluationDb |
| **BOS filter** | backend/services/bosAtFilter.js | (none – env only) |
| **Integration** | backend/services/webhookIntegration.js | liveExecutionGate, reconciliationService, alertManager |
| **Live gate** | backend/services/liveExecutionGate.js | riskEngine, tradeLedger, paperTradingService, brokerAdapterFactory |
| **Reconciliation** | backend/services/reconciliationService.js | liveExecutionGate, tradeLedger, brokerAdapterFactory, paperTradingService |
| **Alert manager** | backend/services/alertManager.js | fs, path |
| **Ledger** | backend/db/tradeLedger.js | sqlite3, path, fs, brainPaths |
| **Brain paths** | backend/brainPaths.js | path, fs |
| **Paper service** | backend/services/paperTradingService.js | tradeLedger, riskEngine, tradingLearningService |
| **Broker factory** | backend/adapters/brokerAdapterFactory.js | PaperBrokerAdapter, OANDABrokerAdapter, IBKRBrokerAdapter |
| **Paper adapter** | backend/adapters/PaperBrokerAdapter.js | BrokerAdapter, paperTradingService, tradeLedger, riskEngine, tradingLearningService |
| **Handler** | (inline in server.js) | symbolRouter, tradeLedger, indicatorGenerator (.enabled), tradingLearningService.learnFromTrade, getBrokerAdapter, tradingViewTelemetry |
| **Symbol router** | backend/services/symbolRouter.js | path, fs |
| **Telemetry** | backend/services/tradingViewTelemetry.js | fs, path |
| **Evaluation DB** | backend/db/evaluationDb.js | sqlite3, path, fs |

**Stubs used on this path:** tradingLearningService (learnFromTrade no-op, getMetrics for /health), indicatorGenerator (enabled: false so branch skipped). All other modules on the path are real (no stubs).

---

## 3. Stubs: Required vs Removable

### 3.1 Required for startup (top-level require in server.js)

These are loaded when server.js loads; removing them would require lazy-require or deleting routes that use them.

| Stub | Required for startup? | Used in webhook path? | Recommendation |
|------|------------------------|------------------------|----------------|
| tradingLearningService | Yes (paperTradingService, PaperBrokerAdapter) | Yes (learnFromTrade) | **Keep** – required for startup and webhook path. |
| patternRecognitionService | Yes | No (other routes only) | **Keep** – required for startup; used by /api/patterns*, /learn/status, startup loadPatterns. |
| patternLearningAgents | Yes | No | **Keep** – required for startup. |
| patternLearningEngine | Yes | No | **Keep** – required for startup (/learn/status, etc.). |
| learningDaemon | Yes | No | **Keep** – required for startup. |
| indicatorGenerator | Yes | Yes (optional branch) | **Keep** – required for startup; webhook path only if .enabled. |
| dailyPatternTracker | Yes | No | **Keep** – required for startup (/api/patterns/best-times, etc.). |
| automatedScalpingTrader | Yes | No | **Keep** – required for startup (/api/automated/*, startup). |
| tradingViewSync | Yes | No | **Keep** – required for startup (/api/tradingview/export, trades). |
| universeLoader | Yes (lazy in /api/automated/status) | No | **Keep** – required when that route is hit. |
| whaleDetectionAgent | Yes (startup + /api/whales/*) | No | **Keep** – required for startup. |

### 3.2 Required for webhook path only

- **tradingLearningService** – handler calls learnFromTrade; stub is sufficient (no-op).
- **indicatorGenerator** – handler checks .enabled and evaluateMarketConditions; stub has enabled: false so branch is skipped.

### 3.3 Not currently needed for webhook path

These are used only by other routes or startup logging; they are still required for **startup** because they are required at top level in server.js.

- patternRecognitionService, patternLearningAgents, patternLearningEngine, learningDaemon, dailyPatternTracker, automatedScalpingTrader, tradingViewSync, universeLoader, whaleDetectionAgent.

### 3.4 Recommendation: which stubs can be removed immediately

**None.** All current stubs are required for startup (server.js requires them at load time). To remove a stub you would need to:

1. **Lazy-require** the module only inside the routes that use it (and handle missing module), or  
2. **Remove or stub the routes** that use that module, and remove the top-level require.

So: **do not remove any stubs** until you refactor server.js to lazy-load or drop the routes that depend on them.

---

## 4. Endpoints Added in v2

| Endpoint | Purpose |
|----------|---------|
| **GET /health** | Already present; returns status, features, broker, risk, dedupe, account, learning. |
| **GET /debug/routes** | **Added.** Returns `{ ok: true, count, routes }` with registered path + methods. |

No separate “simple” /health was added; the existing /health is the main one. For a minimal liveness check you can use **GET /health** or **GET /** (which returns JSON with endpoint links).

---

## 5. Smoke Test

**File:** `tests/smoke.js`

**What it does:**

1. **Server startup** – Requires app, calls `app.listen(0)`, asserts listen succeeds.
2. **GET /health** – Asserts status 200.
3. **GET /debug/routes** – Asserts status 200 and `body.ok === true`, `body.routes` array.
4. **POST /webhook/tradingview** – Sends minimal valid payload (symbol, action, price, quantity, alert_id, timestamp) with auth disabled; asserts status in 2xx or 503 (503 allowed for ledger/DB not configured).

**Run:** From v2 root (after `npm install`):

```bash
npm run test:smoke
```

Or:

```bash
node tests/smoke.js
```

**Env:** Smoke script sets `ENABLE_WEBHOOK_AUTH=false`, `ENABLE_WEBHOOK_VALIDATION=true`, `TRADING_ENABLED=false`, and `DATA_DIR=./data` so that validation passes and execution path can be tested without broker execution.

---

## 6. Code Changes Made (Inside v2 Only)

| File | Change |
|------|--------|
| backend/services/tradingLearningService.js | Added `getMetrics()` returning `{}` so /health does not throw. |
| backend/services/whaleDetectionAgent.js | **New stub** – required by server startup and /api/whales/*. |
| server.js | Added **GET /debug/routes** (list registered routes). Wrapped startup in `startServer()` and only call it when `require.main === module`. **module.exports = app** for smoke test. Root response version set to 2.0.0 and debug_routes link added. |

No files outside `neuropilot_trading_v2/` were modified.

---

## 7. Validation Status

| Check | Status |
|-------|--------|
| v2 runs end-to-end (start → webhook → ledger → response) | **Designed** – path and dependencies documented; smoke test added. |
| Stubs documented (startup vs webhook path vs not needed) | **Done** – see §3. |
| Minimum execution path identified | **Done** – see §1. |
| Dependency map for that path | **Done** – see §2. |
| /health endpoint | **Present** – unchanged. |
| /debug/routes endpoint | **Added.** |
| Smoke test (startup, health, webhook) | **Added** – `tests/smoke.js` + `npm run test:smoke`. |
| Stubs: required vs removable | **Done** – see §3; recommend keeping all until refactor. |
| README with startup and test commands | **Updated** – see README.md. |

**Note:** Full run (including `npm run test:smoke`) requires `npm install` to succeed (e.g. sqlite3 native build). If sqlite3 fails to build, install system deps or use a prebuilt sqlite3; see README.

---

## 8. Exact Commands to Run Locally

From repo root:

```bash
cd neuropilot_trading_v2
npm install
mkdir -p data
cp .env.example .env
# optional: edit .env (PORT, DATA_DIR, TRADING_ENABLED, ENABLE_WEBHOOK_AUTH, etc.)
npm start
```

In another terminal:

```bash
curl -s http://localhost:3014/health | jq .
curl -s http://localhost:3014/debug/routes | jq .
# webhook (with auth disabled): 
curl -s -X POST http://localhost:3014/webhook/tradingview -H "Content-Type: application/json" -d '{"symbol":"XAUUSD","action":"BUY","price":2650,"quantity":0.01,"alert_id":"test1","timestamp":'$(date +%s)'}' | jq .
```

Run smoke test (from v2 directory):

```bash
cd neuropilot_trading_v2
npm run test:smoke
```
