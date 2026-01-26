# Trading System Isolation - Complete Summary

**Date:** 2026-01-21  
**Repository:** `/Users/davidmikulis/neuro-pilot-ai`  
**Target:** Isolate trading system into `/trading` folder and `trading/main` branch

---

## 📋 Deliverables

### 1. Documentation Files Created

| File | Purpose |
|------|---------|
| `TRADING_ISOLATION_PLAN.md` | Complete migration plan with file map |
| `TRADING_ISOLATION_GUIDE.md` | Step-by-step execution guide |
| `TRADING_ISOLATION_COMMANDS.md` | Quick command reference |
| `EXECUTE_TRADING_ISOLATION.sh` | Automated file migration script |
| `UPDATE_TRADING_PATHS.js` | Automated path update script |

### 2. Execution Scripts

**`EXECUTE_TRADING_ISOLATION.sh`**
- Creates `/trading` folder structure
- Moves all trading files
- Creates `trading/package.json`
- Preserves inventory system

**`UPDATE_TRADING_PATHS.js`**
- Updates all `require()` paths
- Fixes relative imports
- Updates config/data paths

---

## 🗂️ File Move Map

### Root → trading/

| From | To | Count |
|------|-----|-------|
| `simple_webhook_server.js` | `trading/server.js` | 1 |
| `check_tradingview_status.sh` | `trading/scripts/check_status.sh` | 1 |
| `start_scalping_trading.sh` | `trading/scripts/start.sh` | 1 |
| `setup_ngrok.sh` | `trading/scripts/setup_ngrok.sh` | 1 |
| `elite_v2_pinescript_clean.pine` | `trading/pinescript/elite_v2.pine` | 1 |
| Trading dashboards | `trading/public/` | 2 |

### scripts/ → trading/scripts/

| Files | Count |
|-------|-------|
| Trading verification scripts | 11 |

### backend/services/ → trading/services/

| Files | Count |
|-------|-------|
| Trading services | 20 |
| Providers folder | 3 |

### backend/middleware/ → trading/middleware/

| Files | Count |
|-------|-------|
| Trading middleware | 3 |

### backend/adapters/ → trading/adapters/

| Files | Count |
|-------|-------|
| Broker adapters | 5 |

### backend/db/ → trading/db/

| Files | Count |
|-------|-------|
| Trade ledger | 1 |

### config/ → trading/config/

| Files | Count |
|-------|-------|
| Trading config | 2 |

### data/ → trading/data/ (copied)

| Folders | Count |
|---------|-------|
| Patterns, logs, checkpoints, OHLCV | 8 |

### Docs → trading/docs/

| Files | Count |
|-------|-------|
| Trading documentation | ~30 |

**Total Files Moved:** ~80 files

---

## 📝 Modified Files (After Migration)

### Files Requiring Manual Updates

1. **`trading/scripts/daemon_start.sh`**
   - Update: `DAEMON_SCRIPT` path
   - Reason: Service moved from `backend/services/` to `services/`

2. **`trading/scripts/learn_backfill.sh`**
   - Update: All `$PROJECT_ROOT/backend/` references
   - Reason: Services moved

3. **`trading/server.js`**
   - Update: File path references (heartbeat, logs)
   - Reason: Data directory structure changed

4. **`trading/services/learningDaemon.js`**
   - Update: `logPath` and `heartbeatPath`
   - Reason: Data directory moved

5. **`trading/services/patternLearningEngine.js`**
   - Update: `patternsPath`
   - Reason: Data directory moved

6. **`trading/services/googleDrivePatternStorage.js`**
   - Update: `cachePath`
   - Reason: Data directory moved

7. **`trading/services/universeLoader.js`**
   - Update: `configPath`
   - Reason: Config directory moved

---

## ✅ Verification Checklist

### Pre-Migration
- [ ] All changes committed
- [ ] Branch `trading/main` created and pushed
- [ ] Backup created (optional)

### Post-Migration
- [ ] `trading/` folder exists
- [ ] `trading/package.json` exists
- [ ] `npm install` completes
- [ ] `npm start` → server on port 3014
- [ ] `curl http://localhost:3014/health` → 200 OK
- [ ] `npm run verify:webhook` → all pass
- [ ] `npm run verify:status` → all pass
- [ ] `npm run daemon:start` → daemon starts
- [ ] `npm run daemon:status` → shows running
- [ ] `curl http://localhost:3014/learn/status` → returns status
- [ ] `curl http://localhost:3014/api/patterns/stats` → returns patterns

---

## 🚀 Deployment Configurations

### Strategy A: Deploy Only /trading

**Railway/Render:**
- Working Directory: `trading/`
- Start Command: `npm start`
- Port: `3014` (or `$PORT`)

**railway.toml:**
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm start"
healthcheckPath = "/health"
```

### Strategy B: Monorepo Deployment

**Two Services:**
1. Inventory: `inventory-enterprise/backend/` (port 3000)
2. Trading: `trading/` (port 3014)

**docker-compose.yml:**
```yaml
services:
  inventory:
    build: ./inventory-enterprise/backend
    ports: ["3000:3000"]
  
  trading:
    build: ./trading
    ports: ["3014:3014"]
```

---

## 📊 Execution Order

1. ✅ **Planning** - Complete
   - File map created
   - Scripts written
   - Documentation complete

2. ⏳ **Git Setup** - User executes
   ```bash
   git checkout -b trading/main
   git push -u origin trading/main
   ```

3. ⏳ **File Migration** - User executes
   ```bash
   ./EXECUTE_TRADING_ISOLATION.sh
   ```

4. ⏳ **Path Updates** - User executes
   ```bash
   node UPDATE_TRADING_PATHS.js
   ```

5. ⏳ **Manual Updates** - User executes
   - Update shell scripts (see guide)
   - Update service file paths

6. ⏳ **Verification** - User executes
   ```bash
   cd trading && npm install && npm start
   ```

---

## 🎯 Success Criteria

✅ Trading system isolated in `/trading`  
✅ Inventory system untouched  
✅ All imports/paths updated  
✅ Scripts work from `trading/` directory  
✅ Server runs on port 3014  
✅ All tests pass  
✅ Deployment configs ready  

---

## 📚 Quick Reference

**Start trading:**
```bash
cd trading && npm start
```

**Start daemon:**
```bash
cd trading && npm run daemon:start
```

**Check status:**
```bash
cd trading && npm run verify:status
```

**Verify webhook:**
```bash
cd trading && npm run verify:webhook
```

---

## 🔧 Troubleshooting

**Issue:** "Cannot find module './backend/...'"  
**Fix:** Run `node UPDATE_TRADING_PATHS.js` again

**Issue:** "Port 3014 in use"  
**Fix:** `lsof -ti:3014 | xargs kill -9`

**Issue:** "Daemon not starting"  
**Fix:** Check `trading/data/logs/daemon.log` and verify paths

---

## 📦 Package.json Scripts

```json
{
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
  }
}
```

---

## ✅ Status

**Planning:** ✅ Complete  
**Scripts:** ✅ Ready  
**Documentation:** ✅ Complete  
**Execution:** ⏳ Ready for user  

---

**Next Step:** Run commands from `TRADING_ISOLATION_COMMANDS.md`

