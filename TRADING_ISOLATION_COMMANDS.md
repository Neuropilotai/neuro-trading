# Trading Isolation - Command Sequence

**Run these commands in order from `/Users/davidmikulis/neuro-pilot-ai`**

---

## Step 1: Git Branch Setup

```bash
# Commit current changes
git add .
git commit -m "Pre-isolation: Trading system fixes and improvements"

# Push current branch
git push origin 2026-01-21-p922

# Create trading/main branch
git checkout -b trading/main

# Push trading/main to origin
git push -u origin trading/main

# Verify
git branch -a | grep trading
```

**Expected:** `* trading/main` and `remotes/origin/trading/main`

---

## Step 2: Execute File Migration

```bash
# Make script executable
chmod +x EXECUTE_TRADING_ISOLATION.sh

# Run migration (will prompt for Git completion)
./EXECUTE_TRADING_ISOLATION.sh
```

**What happens:**
- Creates `/trading` folder structure
- Moves all trading files
- Creates `trading/package.json`

---

## Step 3: Update Import Paths

```bash
# Update all require() paths
node UPDATE_TRADING_PATHS.js
```

**Expected output:**
```
🔄 Updating paths in trading system...
✅ Updated: server.js
✅ Updated: services/learningDaemon.js
...
✅ Updated 25 files
```

---

## Step 4: Manual Script Updates

**Update these files manually:**

### `trading/scripts/daemon_start.sh`

```bash
# Find line with:
DAEMON_SCRIPT="$PROJECT_ROOT/backend/services/learningDaemon.js"

# Replace with:
DAEMON_SCRIPT="$PROJECT_ROOT/services/learningDaemon.js"
```

### `trading/scripts/learn_backfill.sh`

```bash
# Find all instances of:
$PROJECT_ROOT/backend/services/

# Replace with:
$PROJECT_ROOT/services/
```

---

## Step 5: Install Dependencies

```bash
cd trading
npm install
```

---

## Step 6: Verification

```bash
# Start server
npm start &
SERVER_PID=$!
sleep 3

# Health check
curl http://localhost:3014/health

# Status check
npm run verify:status

# Webhook verification
npm run verify:webhook

# Learning daemon
npm run daemon:start
sleep 5
npm run daemon:status

# Endpoints
curl http://localhost:3014/learn/status | jq .
curl http://localhost:3014/api/patterns/stats | jq .

# Stop
kill $SERVER_PID
npm run daemon:stop
```

---

## Quick Reference

**Start trading system:**
```bash
cd trading
npm start
```

**Start learning daemon:**
```bash
cd trading
npm run daemon:start
```

**Check status:**
```bash
cd trading
npm run verify:status
```

**Verify webhook:**
```bash
cd trading
npm run verify:webhook
```

---

## File Locations After Migration

| Component | Location |
|-----------|----------|
| Server | `trading/server.js` |
| Services | `trading/services/` |
| Middleware | `trading/middleware/` |
| Adapters | `trading/adapters/` |
| Scripts | `trading/scripts/` |
| Config | `trading/config/` |
| Data | `trading/data/` |
| Docs | `trading/docs/` |

---

## Rollback (if needed)

```bash
# Switch back to original branch
git checkout 2026-01-21-p922

# Remove trading folder (if needed)
rm -rf trading/
```

---

**Ready to execute!** 🚀

