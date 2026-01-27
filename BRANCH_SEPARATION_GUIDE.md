# Branch Separation Guide: Inventory vs Trading Systems

## Problem
Inventory and trading systems are currently mixed on the same branch (`2026-01-21-p922`), making it difficult to:
- Manage separate deployments
- Maintain independent version control
- Avoid conflicts between systems
- Scale each system independently

## Solution
Create separate branches:
- **`inventory/main`** - All inventory system code
- **`trading/main`** - All trading system code
- **`main`** - Shared/common code (optional)

---

## Quick Start

### Step 1: Analyze Current State
```bash
# Run analysis to identify which files belong to which system
./scripts/analyze_system_separation.sh
```

This will create:
- `.inventory_files.txt` - List of inventory files
- `.trading_files.txt` - List of trading files
- `.shared_files.txt` - List of shared files
- `.unknown_files.txt` - Files needing manual review

### Step 2: Create Separate Branches
```bash
# Create branches (requires git write permission)
./scripts/create_separate_branches.sh
```

This will:
1. Create `inventory/main` branch
2. Create `trading/main` branch
3. Generate `.gitignore` patterns for each branch

### Step 3: Manual Cleanup (Required)

After creating branches, you need to manually clean up each branch:

#### On `inventory/main` branch:
```bash
git checkout inventory/main

# Remove trading-specific files
git rm simple_webhook_server.js
git rm -r backend/adapters/
git rm -r backend/strategies/
git rm backend/services/riskEngine.js
git rm backend/services/paperTradingService.js
# ... (remove other trading files)

# Commit
git commit -m "Remove trading system files from inventory branch"
```

#### On `trading/main` branch:
```bash
git checkout trading/main

# Remove inventory-specific files
git rm -r inventory-enterprise/
git rm backend/enterprise_inventory_manager.js
git rm backend/unified_order_inventory_system.js
# ... (remove other inventory files)

# Commit
git commit -m "Remove inventory system files from trading branch"
```

---

## Detailed File Lists

### Inventory System Files (Keep on `inventory/main`)

**Core Files:**
- `inventory-enterprise/` (entire directory)
- `backend/enterprise_inventory_manager.js`
- `backend/unified_order_inventory_system.js`
- `backend/models/inventory.js`
- `backend/routes/inventory*.js`
- `backend/services/*inventory*.js`
- `backend/routes/owner*.js` (if inventory-related)
- `start-inventory-only.sh`

**Documentation:**
- `backend/AI_INVENTORY_SYSTEM_GUIDE.md`
- `backend/INVENTORY_*.md`
- `backend/ENTERPRISE_*.md` (inventory-related)
- `CAMP_INVENTORY_README.md`
- `MINING_CAMP_INVENTORY_SETUP_GUIDE.md`

**Data:**
- `data/inventory/`
- `data/catalog/`
- `data/gfs_orders/`
- `data/storage_locations/`
- `data/inventory_backups/`
- `data/inventory_imports/`

### Trading System Files (Keep on `trading/main`)

**Core Files:**
- `simple_webhook_server.js`
- `backend/services/riskEngine.js`
- `backend/services/paperTradingService.js`
- `backend/services/patternLearningEngine.js`
- `backend/services/learningDaemon.js`
- `backend/services/backtestEngine.js`
- `backend/services/walkForwardValidator.js`
- `backend/services/patternAttributionService.js`
- `backend/middleware/webhookAuth.js`
- `backend/middleware/webhookValidation.js`
- `backend/middleware/riskCheck.js`
- `backend/adapters/` (entire directory)
- `backend/strategies/` (entire directory)
- `backend/db/evaluationDb.js`
- `cli/backtest.js`
- `cli/walkforward.js`
- `scripts/verify_tradingview_webhook.sh`
- `check_tradingview_status.sh`
- `opening_range_breakout_strategy.pine`

**Documentation:**
- `TRADING_*.md`
- `PATTERN_LEARNING_*.md`
- `BACKTESTING_DOCUMENTATION.md`
- `EVALUATION_SPINE_*.md`
- `ORB_*.md` (Opening Range Breakout)
- `TRADINGVIEW_*.md`

**Data:**
- `data/trades/`
- `data/patterns/`
- `data/learning/`
- `data/backtests/`

### Shared Files (Keep on Both Branches)

- `package.json` (may need separate versions)
- `package-lock.json`
- `README.md`
- `.gitignore`
- `.env.example`
- `Dockerfile` (if shared)
- `docker-compose.yml` (if shared)
- `Procfile` (may need separate)
- `railway.json` (may need separate)

---

## Alternative: Directory-Based Separation

If you prefer to keep everything on one branch but organized:

### Option 1: Move Files to Subdirectories
```bash
# Create directories
mkdir -p inventory-system trading-system

# Move inventory files
mv inventory-enterprise/ inventory-system/
mv backend/enterprise_inventory_manager.js inventory-system/
# ... (move other inventory files)

# Move trading files
mv simple_webhook_server.js trading-system/
mv backend/services/riskEngine.js trading-system/
# ... (move other trading files)
```

### Option 2: Use .gitignore to Hide Files
- Add inventory files to `.gitignore` when working on trading
- Add trading files to `.gitignore` when working on inventory
- Use `git update-index --skip-worktree` for local ignores

---

## Recommended Approach

**For Production:**
1. ✅ Create separate branches (`inventory/main`, `trading/main`)
2. ✅ Set up separate CI/CD pipelines
3. ✅ Use branch protection rules
4. ✅ Keep shared code minimal

**For Development:**
- Use feature branches from respective main branches
- `inventory/feature/*` for inventory features
- `trading/feature/*` for trading features

---

## Verification

After separation, verify each branch:

### Check Inventory Branch:
```bash
git checkout inventory/main
# Should NOT contain:
# - simple_webhook_server.js
# - backend/services/riskEngine.js
# - backend/adapters/
# - TRADING_*.md files
```

### Check Trading Branch:
```bash
git checkout trading/main
# Should NOT contain:
# - inventory-enterprise/
# - backend/enterprise_inventory_manager.js
# - backend/INVENTORY_*.md files
```

---

## Next Steps After Separation

1. **Update CI/CD:**
   - Separate deployment pipelines
   - Different environment variables
   - Independent versioning

2. **Update Documentation:**
   - Branch-specific README files
   - Separate setup guides
   - Clear contribution guidelines

3. **Set Up Branch Protection:**
   - Require PR reviews
   - Prevent direct pushes to main branches
   - Enforce testing before merge

---

## Rollback Plan

If you need to revert:
```bash
# Go back to original branch
git checkout 2026-01-21-p922

# Delete new branches (if needed)
git branch -D inventory/main
git branch -D trading/main
```

---

## Questions?

- **Q: Can files be shared between branches?**
  - A: Yes, but it's better to duplicate shared code or use npm packages

- **Q: What about database schemas?**
  - A: Each system should have its own database or clearly separated schemas

- **Q: How do I merge changes from one branch to another?**
  - A: Use `git cherry-pick` for specific commits, or create a shared branch

---

**Ready to proceed?** Run the scripts and follow the manual cleanup steps above!

