# Trading System Isolation - Complete Guide

**Repository:** `/Users/davidmikulis/neuro-pilot-ai`  
**Target Branch:** `trading/main`  
**Target Folder:** `/trading`

---

## 🎯 Overview

This guide isolates the trading system into its own Git branch (`trading/main`) and folder structure (`/trading`) without affecting the inventory system on `main`.

---

## 📋 Prerequisites

- Git installed and configured
- Node.js >= 20.0.0
- All current changes committed or stashed

---

## 🚀 Step-by-Step Execution

### Phase 1: Git Branch Setup

**Run these commands in order:**

```bash
cd /Users/davidmikulis/neuro-pilot-ai

# 1. Commit current changes
git add .
git commit -m "Pre-isolation: Trading system fixes and improvements"

# 2. Push current branch
git push origin 2026-01-21-p922

# 3. Create trading/main branch from current state
git checkout -b trading/main

# 4. Push trading/main to origin
git push -u origin trading/main

# 5. Verify branch exists
git branch -a | grep trading
```

**Expected output:**
```
* trading/main
  remotes/origin/trading/main
```

---

### Phase 2: Execute File Migration

**Run the migration script:**

```bash
cd /Users/davidmikulis/neuro-pilot-ai

# Make script executable
chmod +x EXECUTE_TRADING_ISOLATION.sh

# Execute (will prompt for Git completion)
./EXECUTE_TRADING_ISOLATION.sh
```

**What this does:**
- Creates `/trading` folder structure
- Moves all trading files to `/trading`
- Creates `trading/package.json`
- Preserves inventory system untouched

---

### Phase 3: Update Import Paths

**Run the path update script:**

```bash
cd /Users/davidmikulis/neuro-pilot-ai

# Update all require() paths
node UPDATE_TRADING_PATHS.js
```

**What this does:**
- Updates all `require('./backend/...')` → `require('./...')`
- Fixes relative paths in moved files
- Updates config and data paths

---

### Phase 4: Update Shell Scripts

**Manual updates required in shell scripts:**

The following scripts need `PROJECT_ROOT` and path updates:

#### `trading/scripts/daemon_start.sh`

**Find:**
```bash
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_SCRIPT="$PROJECT_ROOT/backend/services/learningDaemon.js"
```

**Replace:**
```bash
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_SCRIPT="$PROJECT_ROOT/services/learningDaemon.js"
```

#### `trading/scripts/learn_backfill.sh`

**Find:**
```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
```

**Update all references:**
- `$PROJECT_ROOT/backend/services/` → `$PROJECT_ROOT/services/`
- `$PROJECT_ROOT/config/` → `$PROJECT_ROOT/config/`
- `$PROJECT_ROOT/data/` → `$PROJECT_ROOT/data/`

#### `trading/scripts/check_status.sh`

**Find:**
```bash
LOCAL_PORT="${PORT:-${WEBHOOK_PORT:-3014}}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"
```

**Keep as-is** (already correct)

#### `trading/scripts/verify_webhook.sh`

**Find:**
```bash
LOCAL_PORT="${PORT:-${WEBHOOK_PORT:-3014}}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"
```

**Keep as-is** (already correct)

#### `trading/scripts/setup_ngrok.sh`

**Find:**
```bash
if ! curl -s --max-time 2 http://localhost:3014/health > /dev/null 2>&1; then
```

**Keep as-is** (port 3014 is correct)

---

### Phase 5: Update Server Entry Point

**File:** `trading/server.js` (was `simple_webhook_server.js`)

**Update these sections:**

1. **Line ~24-41: Import statements**
   - Already updated by path script
   - Verify all paths are relative to `trading/`

2. **Line ~705: File paths**
   ```javascript
   // Find:
   const heartbeatPath = path.join(__dirname, '../../data/learning/heartbeat.json');
   
   // Replace:
   const heartbeatPath = path.join(__dirname, '../data/learning/heartbeat.json');
   ```

3. **Line ~838: Universe loader**
   ```javascript
   // Find:
   const universeLoader = require('./backend/services/universeLoader');
   
   // Replace:
   const universeLoader = require('./services/universeLoader');
   ```

4. **Line ~654: Google Drive storage**
   ```javascript
   // Find:
   const googleDriveStorage = require('./backend/services/googleDrivePatternStorage');
   
   // Replace:
   const googleDriveStorage = require('./services/googleDrivePatternStorage');
   ```

---

### Phase 6: Update Service Files

**Files that need path updates:**

#### `trading/services/learningDaemon.js`

**Find:**
```javascript
const path = require('path');
this.logPath = path.join(__dirname, '../../data/logs/learning.log');
this.heartbeatPath = path.join(__dirname, '../../data/learning/heartbeat.json');
```

**Replace:**
```javascript
const path = require('path');
this.logPath = path.join(__dirname, '../data/logs/learning.log');
this.heartbeatPath = path.join(__dirname, '../data/learning/heartbeat.json');
```

#### `trading/services/patternLearningEngine.js`

**Find:**
```javascript
const patternsPath = path.join(__dirname, '../../data/patterns.json');
```

**Replace:**
```javascript
const patternsPath = path.join(__dirname, '../data/patterns.json');
```

#### `trading/services/googleDrivePatternStorage.js`

**Find:**
```javascript
const cachePath = path.join(__dirname, '../../data/patterns.json');
```

**Replace:**
```javascript
const cachePath = path.join(__dirname, '../data/patterns.json');
```

#### `trading/services/universeLoader.js`

**Find:**
```javascript
const configPath = path.join(__dirname, '../../config/tradingview_universe.json');
```

**Replace:**
```javascript
const configPath = path.join(__dirname, '../config/tradingview_universe.json');
```

---

### Phase 7: Install Dependencies

```bash
cd /Users/davidmikulis/neuro-pilot-ai/trading
npm install
```

---

### Phase 8: Verification

**Run verification tests:**

```bash
cd /Users/davidmikulis/neuro-pilot-ai/trading

# 1. Start server
npm start &
SERVER_PID=$!
sleep 3

# 2. Health check
curl http://localhost:3014/health
# Expected: {"status":"healthy",...}

# 3. Status check
npm run verify:status
# Expected: All checks pass

# 4. Webhook verification
npm run verify:webhook
# Expected: All tests pass

# 5. Learning daemon
npm run daemon:start
sleep 5
npm run daemon:status
# Expected: Daemon running

# 6. Learning status endpoint
curl http://localhost:3014/learn/status | jq .
# Expected: JSON with daemon.running=true

# 7. Patterns stats
curl http://localhost:3014/api/patterns/stats | jq .
# Expected: JSON with totalPatterns > 0

# 8. Stop services
kill $SERVER_PID
npm run daemon:stop
```

---

## ✅ Verification Checklist

### Pre-Migration
- [ ] All changes committed
- [ ] Branch `trading/main` created and pushed
- [ ] Backup created (optional but recommended)

### Post-Migration
- [ ] `trading/` folder exists with correct structure
- [ ] `trading/package.json` exists
- [ ] `npm install` completes without errors
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

## 📦 File Move Summary

### Moved Files (Total: ~80 files)

**Server:**
- `simple_webhook_server.js` → `trading/server.js`

**Scripts (11 files):**
- All trading scripts → `trading/scripts/`

**Services (20 files):**
- All trading services → `trading/services/`
- Providers folder → `trading/services/providers/`

**Middleware (3 files):**
- Trading middleware → `trading/middleware/`

**Adapters (5 files):**
- Broker adapters → `trading/adapters/`

**Database (1 file):**
- `tradeLedger.js` → `trading/db/`

**Config (2 files):**
- Trading config → `trading/config/`

**Data (copied):**
- Patterns, logs, checkpoints, OHLCV → `trading/data/`

**Docs (~30 files):**
- All trading docs → `trading/docs/`

---

## 🚀 Deployment Strategies

### Strategy A: Deploy Only /trading

**Railway Configuration:**
```toml
# trading/railway.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "npm start"
healthcheckPath = "/health"
healthcheckTimeout = 100
restartPolicyType = "on_failure"
```

**Environment Variables:**
- `PORT=3014` (or use `$PORT` from Railway)
- `WEBHOOK_PORT=3014` (fallback)
- All trading env vars (see `.env.example`)

**Working Directory:** `trading/`

---

### Strategy B: Monorepo Deployment

**Two Separate Services:**

1. **Inventory Service**
   - Root: `inventory-enterprise/backend/`
   - Port: `3000`
   - Service name: `inventory`

2. **Trading Service**
   - Root: `trading/`
   - Port: `3014`
   - Service name: `trading`

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  inventory:
    build:
      context: ./inventory-enterprise/backend
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./inventory-enterprise/backend/data:/app/data
  
  trading:
    build:
      context: ./trading
    ports:
      - "3014:3014"
    environment:
      - NODE_ENV=production
      - PORT=3014
    volumes:
      - ./trading/data:/app/data
```

---

## 🔧 Troubleshooting

### Issue: "Cannot find module './backend/...'"

**Solution:**
- Run `node UPDATE_TRADING_PATHS.js` again
- Manually check files in `trading/services/` for remaining `backend/` references

### Issue: "Port 3014 already in use"

**Solution:**
```bash
lsof -ti:3014 | xargs kill -9
```

### Issue: "Daemon not starting"

**Solution:**
- Check `trading/data/logs/daemon.log`
- Verify `trading/scripts/daemon_start.sh` has correct paths
- Ensure `.env` is in `trading/` directory

### Issue: "Patterns not loading"

**Solution:**
- Verify `trading/data/patterns.json` exists
- Check Google Drive credentials in `.env`
- Run `npm run learn:backfill` to populate patterns

---

## 📝 Next Steps After Isolation

1. **Test thoroughly** using verification checklist
2. **Update CI/CD** to deploy `trading/` separately
3. **Document** trading system architecture
4. **Set up monitoring** for trading service
5. **Create separate** `.env.example` for trading

---

## 🎯 Success Criteria

✅ Trading system runs independently  
✅ Inventory system untouched  
✅ All tests pass  
✅ Deployment configs ready  
✅ Documentation updated  

---

**Status:** Ready for Execution  
**Last Updated:** 2026-01-21

