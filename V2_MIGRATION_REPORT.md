# NeuroPilot Trading v2 — Migration Report

**Date:** 2026-03-06  
**Scope:** Minimal runnable v2 core. No archive, no moves of `trading/backend`, no deletes.

---

## 1. Files Copied Into v2

### 1.1 From `trading/` (exact copies, no edits)

| Path in v2 | Source |
|------------|--------|
| **Config** | |
| `config/championPath.js` | trading/config/championPath.js |
| `config/regimeStrategyMapping.js` | trading/config/regimeStrategyMapping.js |
| `config/paperUniverse.js` | trading/config/paperUniverse.js |
| `config/strategy_registry.json` | trading/config/strategy_registry.json |
| `config/tradingview_universe.json` | trading/config/tradingview_universe.json |
| `config/profiles/*` | trading/config/profiles/ |
| **DB & paths** | |
| `backend/brainPaths.js` | trading/backend/brainPaths.js |
| `backend/db/tradeLedger.js` | trading/backend/db/tradeLedger.js |
| `backend/db/evaluationDb.js` | trading/backend/db/evaluationDb.js |
| `backend/db/evaluationSchema.sql` | trading/backend/db/evaluationSchema.sql |
| **Middleware** | |
| `backend/middleware/webhookAuth.js` | trading/backend/middleware/webhookAuth.js |
| `backend/middleware/webhookValidation.js` | trading/backend/middleware/webhookValidation.js |
| `backend/middleware/riskCheck.js` | trading/backend/middleware/riskCheck.js |
| **Services** | |
| `backend/services/deduplicationService.js` | trading/backend/services/deduplicationService.js |
| `backend/services/riskEngine.js` | trading/backend/services/riskEngine.js |
| `backend/services/paperTradingService.js` | trading/backend/services/paperTradingService.js |
| `backend/services/webhookIntegration.js` | trading/backend/services/webhookIntegration.js |
| `backend/services/liveExecutionGate.js` | trading/backend/services/liveExecutionGate.js |
| `backend/services/reconciliationService.js` | trading/backend/services/reconciliationService.js |
| `backend/services/alertManager.js` | trading/backend/services/alertManager.js |
| `backend/services/bosAtFilter.js` | trading/backend/services/bosAtFilter.js |
| `backend/services/tradingViewTelemetry.js` | trading/backend/services/tradingViewTelemetry.js |
| `backend/services/symbolRouter.js` | trading/backend/services/symbolRouter.js |
| **Adapters** | |
| `backend/adapters/BrokerAdapter.js` | trading/backend/adapters/BrokerAdapter.js |
| `backend/adapters/PaperBrokerAdapter.js` | trading/backend/adapters/PaperBrokerAdapter.js |
| `backend/adapters/OANDABrokerAdapter.js` | trading/backend/adapters/OANDABrokerAdapter.js |
| `backend/adapters/IBKRBrokerAdapter.js` | trading/backend/adapters/IBKRBrokerAdapter.js |
| `backend/adapters/brokerAdapterFactory.js` | trading/backend/adapters/brokerAdapterFactory.js |
| **Entry & CLI** | |
| `server.js` | trading/simple_webhook_server.js |
| `cli/_bootstrap_env.js` | trading/cli/_bootstrap_env.js |
| `scripts/verify_tradingview_webhook.sh` | trading/scripts/verify_tradingview_webhook.sh |

### 1.2 Created in v2 (stubs / new files)

| Path in v2 | Purpose |
|------------|--------|
| `backend/services/tradingLearningService.js` | Stub so paperTradingService loads (no pattern/learning chain). |
| `backend/services/indicatorGenerator.js` | Stub (enabled: false, evaluateMarketConditions → []). |
| `backend/services/automatedScalpingTrader.js` | Stub (enabled: false, getPerformance/start/stop/getStatus no-ops). |
| `backend/services/patternLearningEngine.js` | Stub (getStats → {}). |
| `backend/services/tradingViewSync.js` | Stub (exportTrades, getTradesForWebhook, formatTradeForDisplay no-ops). |
| `backend/services/learningDaemon.js` | Stub (enabled: false). |
| `backend/services/universeLoader.js` | Stub (load, getSymbolTimeframePairs → []). |
| `backend/services/dailyPatternTracker.js` | Stub (getBestTradingTimes → {}). |
| `backend/services/patternRecognitionService.js` | Stub (patterns Map, getStats, loadPatterns, detectPatterns). |
| `backend/services/patternLearningAgents.js` | Stub (getPredictions → []). |
| `package.json` | v2 package (name: neuropilot-trading-v2, minimal deps: dotenv, express, express-rate-limit, sqlite3). |
| `.env.example` | Minimal env template for v2. |

**Total:** 33 files copied from trading, 12 files created in v2 (stubs + package + env.example).

---

## 2. Files Still Pending Review

These are in **trading/** and were not copied. They may be needed later to make v2 feature-complete or to run CLI/worker.

| Category | Paths | Notes |
|----------|--------|------|
| **CLI (backtest / walkforward / learning)** | trading/cli/backtest.js, walkforward.js, validate_patterns.js, run_learning_cycle.js, smoke_pattern_pipeline.js, backtest_patterns.js, compare_profiles.js, orb2_to_research.js, backfill_ohlcv.js, seed_research_db.js, env_doctor.js | Depend on backtestEngine, evaluationDb, providerFactory, ohlcvCache, patterns, etc. Add when porting backtest pipeline. |
| **Scripts** | trading/scripts/paper_autopilot.js, learn_once.sh, push_brain_latest.sh, import_tv_latest.sh, prod_path_lock_verify.sh, regression_suite_production.sh, validate_trading_prod.sh, smoke_test_ai_import.sh, smoke_tradingview_zip_import.sh | Depend on trading server or learning stack. |
| **Services (learning / patterns / data)** | trading/backend/services/learningDaemon.js (full), patternRecognitionService.js (full), patternLearningAgents.js (full), patternLearningEngine.js (full), patternAttributionService.js, indicatorGenerator.js (full), dailyPatternTracker.js (full), tradingViewSync.js (full), automatedScalpingTrader.js (full), universeLoader.js (full), ohlcvCache.js, providerFactory.js, marketRegimeService.js, setupEngine.js, metricsScoreboard.js, brainBootstrap.js, brainImport.js, strategiesCatalog.js, opportunitySelector.js, or15Classifier.js, patternAgingService.js, checkpointManager.js, googleDrivePatternStorage.js, walkForwardValidator.js, deduplicationService (already copied), riskEngine (already copied), etc. | Full implementations; v2 currently uses stubs where needed. |
| **DB** | trading/backend/db/researchDb.js, researchSchema.sql | For research/backtest import; not required for webhook-only. |
| **Providers / patterns** | trading/backend/services/providers/*, trading/backend/services/patterns/fxNyOpenOrb2.js | For backtest and OHLCV; not required for minimal webhook. |
| **Utils** | trading/backend/utils/patternIds.js, instrumentId.js | Used by full patternRecognitionService; not needed for stubs. |
| **Routes / server** | trading/server.js (full API), trading/backend/routes/* | Full API and proxy to worker; v2 only has webhook server copy. |

---

## 3. Files That Are Definitely Non-Trading

From the audit, these **trading/backend** (and root) areas are inventory/enterprise/resume/PDF/Canva/Fiverr and should not be copied into v2:

- **trading/backend:** PDF processors, invoice extraction, resume generators, Canva/Fiverr integrations, super_agent*, admin_dashboard*, stripe_integration (billing), Gmail/OneDrive setup, multilocation, 2FA, user management, case tracking, accounting categories, inventory-related routes and services.
- **Root:** webhook_integration_server.js (Zapier/n8n/gig), stripe-payment-integration.js, super-gig-opportunity-dashboard.js, resume/test_improved_resume, upload_to_google_drive, setup-google-sheets, etc.

No non-trading files were copied into v2.

---

## 4. Next Steps to Make v2 Runnable

1. **Install dependencies (from repo root or v2):**
   ```bash
   cd neuropilot_trading_v2 && npm install
   ```
   If `sqlite3` native build fails (e.g. missing Python `distutils` or build tools), fix the local build environment or use a prebuilt sqlite3; v2 does not change sqlite3 usage.

2. **Create data directory and optional .env:**
   ```bash
   cd neuropilot_trading_v2 && mkdir -p data
   cp .env.example .env   # then edit .env if needed (DATA_DIR, PORT, WEBHOOK_SECRET, etc.)
   ```

3. **Start the server:**
   ```bash
   cd neuropilot_trading_v2 && npm start
   ```
   Default port 3014; health: `GET /health`.

4. **Verify webhook path:**
   - `POST /webhook/tradingview` with valid auth and payload (see trading docs).
   - Use `scripts/verify_tradingview_webhook.sh` from v2 root if script paths are updated for v2.

5. **Optional — replace stubs with full implementations:**
   - When adding learning: replace stub `tradingLearningService`, `patternRecognitionService`, `patternLearningAgents`, `patternLearningEngine`, `learningDaemon`, `dailyPatternTracker`, `indicatorGenerator`, `automatedScalpingTrader`, `tradingViewSync`, `universeLoader` with copies (or ports) from trading/ and add their dependencies (e.g. patternAttributionService, utils/patternIds, googleDrivePatternStorage, ohlcvCache, providerFactory).

6. **Optional — add backtest CLI to v2:**
   - Copy trading/cli/backtest.js, walkforward.js, validate_patterns.js and their dependencies (backtestEngine, providerFactory, ohlcvCache, strategies, etc.) when you want v2 to run backtests locally.

7. **Do not archive or move trading/backend yet** (per safety rule). Archive only after v2 is validated and you are ready to follow the full migration plan.

---

## 5. Summary

| Item | Count / status |
|------|-----------------|
| **v2 root** | `/neuropilot_trading_v2` created with full folder structure. |
| **Files copied from trading** | 33 (config, db, middleware, services, adapters, server, cli, scripts). |
| **Files created in v2** | 12 (stubs + package.json + .env.example). |
| **trading/backend** | Not archived; not moved. |
| **Deletes** | None. |
| **Minimal runnable** | Yes, after `npm install` and `mkdir -p data` (+ optional .env). Webhook and health routes are functional; learning/indicator/automated endpoints use stubs and return empty or no-op behavior. |
