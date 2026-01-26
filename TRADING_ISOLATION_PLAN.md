# Trading System Isolation Plan

**Goal:** Isolate trading system into `/trading` folder and `trading/main` branch without breaking inventory.

---

## Phase 1: Git Branch Setup

### Commands to Run (in order):

```bash
# 1. Commit current changes
cd /Users/davidmikulis/neuro-pilot-ai
git add .
git commit -m "Pre-isolation: Fix indicator override and account balance bugs"

# 2. Push current branch
git push origin 2026-01-21-p922

# 3. Create trading/main branch from current state
git checkout -b trading/main

# 4. Push trading/main to origin
git push -u origin trading/main

# 5. Verify branch exists
git branch -a | grep trading
```

---

## Phase 2: File Move Map

### Root → trading/

| From | To | Type |
|------|-----|------|
| `simple_webhook_server.js` | `trading/server.js` | Server entry point |
| `check_tradingview_status.sh` | `trading/scripts/check_status.sh` | Status check |
| `start_scalping_trading.sh` | `trading/scripts/start.sh` | Start script |
| `setup_ngrok.sh` | `trading/scripts/setup_ngrok.sh` | ngrok setup |
| `elite_v2_pinescript_clean.pine` | `trading/pinescript/elite_v2.pine` | Pine script |
| `trading_dashboard.html` | `trading/public/dashboard.html` | Dashboard |
| `trading_system_monitor.html` | `trading/public/monitor.html` | Monitor |

### scripts/ → trading/scripts/

| From | To |
|------|-----|
| `scripts/verify_tradingview_webhook.sh` | `trading/scripts/verify_webhook.sh` |
| `scripts/start_learning_daemon.sh` | `trading/scripts/daemon_start.sh` |
| `scripts/stop_learning_daemon.sh` | `trading/scripts/daemon_stop.sh` |
| `scripts/status_learning_daemon.sh` | `trading/scripts/daemon_status.sh` |
| `scripts/learn_backfill.sh` | `trading/scripts/learn_backfill.sh` |
| `scripts/learn_once.sh` | `trading/scripts/learn_once.sh` |
| `scripts/learn_daily_maintenance.sh` | `trading/scripts/learn_maintenance.sh` |
| `scripts/import_tradingview_csvs.sh` | `trading/scripts/import_csvs.sh` |
| `scripts/verify_daemon_status.sh` | `trading/scripts/verify_daemon.sh` |
| `scripts/check_tradingview_connection.sh` | `trading/scripts/check_connection.sh` |
| `scripts/go_live.sh` | `trading/scripts/go_live.sh` |

### backend/services/ → trading/services/

**Trading Services (move):**
- `automatedScalpingTrader.js`
- `checkpointManager.js`
- `dailyPatternTracker.js`
- `googleDrivePatternStorage.js`
- `indicatorGenerator.js`
- `learningDaemon.js`
- `marketDataProvider.js`
- `ohlcvCache.js`
- `paperTradingService.js`
- `patternLearningAgents.js`
- `patternLearningEngine.js`
- `patternRecognitionService.js`
- `providerFactory.js`
- `riskEngine.js`
- `tradingLearningService.js`
- `tradingViewSync.js`
- `tradingViewTelemetry.js`
- `universeLoader.js`
- `whaleDetectionAgent.js`
- `deduplicationService.js`

**Providers (move entire folder):**
- `backend/services/providers/` → `trading/services/providers/`

### backend/middleware/ → trading/middleware/

**Trading Middleware (move):**
- `webhookAuth.js`
- `webhookValidation.js`
- `riskCheck.js`

### backend/db/ → trading/db/

**Trading DB (move):**
- `tradeLedger.js` (if exists)
- Any trading-specific DB files

### backend/adapters/ → trading/adapters/

**Trading Adapters (move):**
- `brokerAdapterFactory.js`
- All broker adapter files

### Docs → trading/docs/

**Trading Documentation (move):**
- `TRADINGVIEW_ALERT_CONFIG.md`
- `TRADINGVIEW_*.md` (all TradingView docs)
- `PATTERN_LEARNING_*.md` (all pattern learning docs)
- `TRADING_LEARNING_SETUP.md`
- `TRADING_SYSTEM_*.md`
- `SCALPING_*.md`
- `AUTOMATED_TRADING_*.md`
- `WHALE_DETECTION_AGENT.md`
- `MULTI_SYMBOL_SCALPING.md`
- `QUICK_START_SCALPING.md`
- `INDICATOR_GENERATION_SYSTEM.md`
- `LEARNING_ENV_VARS.md`
- `LEARNING_SYSTEM_FILE_TREE.md`
- `ALWAYS_ON_LEARNING_IMPLEMENTATION_COMPLETE.md`

### Config → trading/config/

**Trading Config (move):**
- `config/tradingview_universe.json` (if exists)
- Any trading-specific config files

### Data → trading/data/

**Trading Data (move):**
- `data/patterns.json` → `trading/data/patterns.json`
- `data/logs/learning.log` → `trading/data/logs/learning.log`
- `data/pids/learning.pid` → `trading/data/pids/learning.pid`
- `data/learning/heartbeat.json` → `trading/data/learning/heartbeat.json`
- `data/csv/` → `trading/data/csv/` (if exists)
- `data/ohlcv/` → `trading/data/ohlcv/` (if exists)
- `data/checkpoints/` → `trading/data/checkpoints/` (if exists)
- `data/metrics/` → `trading/data/metrics/` (if exists)

---

## Phase 3: Path Updates Required

### Files to Update (imports):

1. **trading/server.js** (was simple_webhook_server.js)
   - Change `./backend/` → `./`
   - Update all require paths

2. **All trading/services/*.js**
   - Update relative paths to other services
   - Update paths to config, data directories

3. **All trading/scripts/*.sh**
   - Update PROJECT_ROOT paths
   - Update file references
   - Update working directory assumptions

4. **trading/middleware/*.js**
   - Update service imports

---

## Phase 4: Package.json Structure

### trading/package.json

```json
{
  "name": "neuro-pilot-trading",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js",
    "daemon:start": "./scripts/daemon_start.sh",
    "daemon:stop": "./scripts/daemon_stop.sh",
    "daemon:status": "./scripts/daemon_status.sh",
    "verify:webhook": "./scripts/verify_webhook.sh",
    "verify:status": "./scripts/check_status.sh",
    "learn:backfill": "./scripts/learn_backfill.sh",
    "learn:once": "./scripts/learn_once.sh",
    "learn:maintenance": "./scripts/learn_maintenance.sh",
    "setup:ngrok": "./scripts/setup_ngrok.sh"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "express": "^4.18.2",
    "dotenv": "^16.3.1",
    "express-rate-limit": "^7.1.5",
    "googleapis": "^126.0.1",
    "sqlite3": "^5.1.6"
  }
}
```

---

## Phase 5: Verification Checklist

### Pre-Migration
- [ ] All changes committed
- [ ] Branch created and pushed
- [ ] Backup created (optional)

### Post-Migration
- [ ] `cd trading && npm install`
- [ ] `npm start` → server starts on port 3014
- [ ] `curl http://localhost:3014/health` → 200 OK
- [ ] `npm run verify:webhook` → all tests pass
- [ ] `npm run verify:status` → all checks pass
- [ ] `npm run daemon:start` → daemon starts
- [ ] `npm run daemon:status` → shows running
- [ ] `curl http://localhost:3014/learn/status` → returns status
- [ ] `curl http://localhost:3014/api/patterns/stats` → returns patterns
- [ ] TradingView webhook test → receives alerts

---

## Phase 6: Deployment Strategies

### Strategy A: Deploy Only /trading

**Railway/Render Config:**
- Working Directory: `trading/`
- Start Command: `npm start`
- Port: `3014` (or `$PORT`)

**railway.toml (in trading/):**
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm start"
healthcheckPath = "/health"
healthcheckTimeout = 100
```

### Strategy B: Monorepo Deployment

**Two Services:**
1. **Inventory Service**
   - Root: `inventory-enterprise/backend/`
   - Port: `3000`

2. **Trading Service**
   - Root: `trading/`
   - Port: `3014`

**docker-compose.yml:**
```yaml
services:
  inventory:
    build: ./inventory-enterprise/backend
    ports:
      - "3000:3000"
  
  trading:
    build: ./trading
    ports:
      - "3014:3014"
```

---

## Execution Order

1. ✅ Create plan document (this file)
2. ⏳ Execute Git branch setup
3. ⏳ Create folder structure
4. ⏳ Move files systematically
5. ⏳ Update all imports/paths
6. ⏳ Create package.json
7. ⏳ Update scripts
8. ⏳ Run verification tests
9. ⏳ Document deployment options

---

**Status:** Planning Complete - Ready for Execution

