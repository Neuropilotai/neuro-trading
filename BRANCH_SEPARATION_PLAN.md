# Branch Separation Plan: Inventory vs Trading Systems

## Current Situation
- **Current Branch:** `2026-01-21-p922` (trading-focused)
- **Problem:** Inventory and trading systems are mixed on the same branch
- **Solution:** Create separate branches for each system

---

## Step 1: Identify System Files

### Inventory System Files
**Core Inventory:**
- `inventory-enterprise/` (entire directory)
- `backend/enterprise_inventory_manager.js`
- `backend/unified_order_inventory_system.js`
- `backend/models/inventory.js`
- `backend/routes/inventory*.js`
- `backend/services/*inventory*.js`
- `backend/AI_INVENTORY_SYSTEM_GUIDE.md`
- `backend/INVENTORY_*.md` (all inventory docs)
- `CAMP_INVENTORY_README.md`
- `MINING_CAMP_INVENTORY_SETUP_GUIDE.md`
- `start-inventory-only.sh`
- `inventory*.js` (root level)
- `inventory*.csv` (root level)
- `inventory*.log` (root level)

**Data Directories:**
- `data/inventory/`
- `data/catalog/`
- `data/gfs_orders/`
- `data/storage_locations/`
- `data/inventory_backups/`
- `data/inventory_imports/`

### Trading System Files
**Core Trading:**
- `simple_webhook_server.js`
- `backend/services/riskEngine.js`
- `backend/services/paperTradingService.js`
- `backend/services/patternLearningEngine.js`
- `backend/services/learningDaemon.js`
- `backend/services/backtestEngine.js`
- `backend/services/walkForwardValidator.js`
- `backend/middleware/webhookAuth.js`
- `backend/middleware/webhookValidation.js`
- `backend/middleware/riskCheck.js`
- `backend/adapters/*` (trading adapters)
- `backend/strategies/*` (trading strategies)
- `backend/db/evaluationDb.js`
- `cli/backtest.js`
- `cli/walkforward.js`
- `scripts/verify_tradingview_webhook.sh`
- `check_tradingview_status.sh`
- `opening_range_breakout_strategy.pine`
- `TRADING_*.md` (all trading docs)
- `PATTERN_LEARNING_*.md`
- `BACKTESTING_DOCUMENTATION.md`
- `EVALUATION_SPINE_*.md`

**Data Directories:**
- `data/trades/`
- `data/patterns/`
- `data/learning/`
- `data/backtests/`

---

## Step 2: Create Branch Structure

### Recommended Branch Names:
1. **`inventory/main`** - Main inventory system branch
2. **`trading/main`** - Main trading system branch
3. **`main`** - Shared/common code only

---

## Step 3: Execution Plan

### Phase 1: Create Inventory Branch
```bash
# From current branch
git checkout -b inventory/main

# Keep only inventory files
# (Remove trading files or move to trading branch)
```

### Phase 2: Create Trading Branch
```bash
# From current branch
git checkout -b trading/main

# Keep only trading files
# (Remove inventory files or move to inventory branch)
```

### Phase 3: Clean Main Branch
```bash
# Keep only shared/common code
# Remove system-specific files
```

---

## Step 4: File Organization Strategy

### Option A: Separate Repositories (Recommended)
- Create `neuro-pilot-inventory` repository
- Create `neuro-pilot-trading` repository
- Keep shared code in main repo or as npm packages

### Option B: Monorepo with Clear Separation
- Use branch protection rules
- Separate CI/CD pipelines
- Clear directory structure

### Option C: Submodules
- Inventory as submodule
- Trading as submodule
- Main repo orchestrates

---

## Step 5: Migration Script

I'll create a script to help identify and move files:

```bash
# Run analysis
./scripts/analyze_system_separation.sh

# This will:
# 1. List all inventory files
# 2. List all trading files
# 3. List shared/common files
# 4. Generate migration plan
```

---

## Immediate Action Plan

### Quick Fix (Keep on Same Branch but Organize):
1. Create `inventory/` directory for all inventory code
2. Create `trading/` directory for all trading code
3. Update import paths accordingly

### Proper Fix (Separate Branches):
1. Create `inventory/main` branch
2. Create `trading/main` branch  
3. Migrate files to appropriate branches
4. Set up branch protection

---

## Next Steps

Would you like me to:
1. **Create the branch separation script** to analyze and move files?
2. **Create separate branches** now and migrate files?
3. **Reorganize within current branch** first (easier, less risky)?

Let me know which approach you prefer!

