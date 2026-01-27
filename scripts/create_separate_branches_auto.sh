#!/usr/bin/env bash
set -euo pipefail

# Create Separate Branches for Inventory and Trading Systems (Auto - No Prompt)
# This script creates branches automatically without user confirmation

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}🌳 Create Separate Branches (Auto)${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if analysis has been run
if [ ! -f ".inventory_files.txt" ] || [ ! -f ".trading_files.txt" ]; then
    echo -e "${YELLOW}⚠️  Analysis files not found. Running analysis first...${NC}"
    ./scripts/analyze_system_separation_simple.sh
    echo ""
fi

# Check git status
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Working directory has uncommitted changes.${NC}"
    echo -e "${CYAN}   Proceeding anyway (branches will include current changes)...${NC}"
    echo ""
fi

CURRENT_BRANCH=$(git branch --show-current)
echo -e "${CYAN}📍 Current branch: ${CURRENT_BRANCH}${NC}"
echo ""

# Step 1: Create inventory branch
echo -e "${BLUE}📦 Step 1: Creating inventory/main branch...${NC}"
if git show-ref --verify --quiet refs/heads/inventory/main 2>/dev/null; then
    echo -e "${YELLOW}   Branch inventory/main already exists. Checking it out...${NC}"
    git checkout inventory/main
else
    git checkout -b inventory/main
fi
echo -e "${GREEN}✅ On inventory/main branch${NC}"
echo ""

# Step 2: Create trading branch from current
echo -e "${BLUE}📈 Step 2: Creating trading/main branch...${NC}"
git checkout "$CURRENT_BRANCH"
if git show-ref --verify --quiet refs/heads/trading/main 2>/dev/null; then
    echo -e "${YELLOW}   Branch trading/main already exists. Checking it out...${NC}"
    git checkout trading/main
else
    git checkout -b trading/main
fi
echo -e "${GREEN}✅ On trading/main branch${NC}"
echo ""

# Step 3: Generate .gitignore patterns for each branch
echo -e "${BLUE}📝 Step 3: Generating branch-specific .gitignore patterns...${NC}"

# For inventory branch: ignore trading files
cat > .gitignore.inventory << 'EOF'
# Trading system files (ignore on inventory branch)
simple_webhook_server.js
backend/services/riskEngine.js
backend/services/paperTradingService.js
backend/services/patternLearningEngine.js
backend/services/learningDaemon.js
backend/services/backtestEngine.js
backend/services/walkForwardValidator.js
backend/services/patternAttributionService.js
backend/middleware/webhookAuth.js
backend/middleware/webhookValidation.js
backend/middleware/riskCheck.js
backend/adapters/
backend/strategies/
backend/db/evaluationDb.js
cli/backtest.js
cli/walkforward.js
scripts/verify_tradingview_webhook.sh
check_tradingview_status.sh
opening_range_breakout_strategy.pine
TRADING_*.md
PATTERN_LEARNING_*.md
BACKTESTING_DOCUMENTATION.md
EVALUATION_SPINE_*.md
ORB_*.md
data/trades/
data/patterns/
data/learning/
data/backtests/
EOF

# For trading branch: ignore inventory files
cat > .gitignore.trading << 'EOF'
# Inventory system files (ignore on trading branch)
inventory-enterprise/
backend/enterprise_inventory_manager.js
backend/unified_order_inventory_system.js
backend/models/inventory.js
backend/routes/inventory*.js
backend/services/*inventory*.js
backend/AI_INVENTORY_SYSTEM_GUIDE.md
backend/INVENTORY_*.md
backend/ENTERPRISE_*.md
backend/BILINGUAL_INVENTORY_GUIDE.md
CAMP_INVENTORY_README.md
MINING_CAMP_INVENTORY_SETUP_GUIDE.md
start-inventory-only.sh
inventory*.js
inventory*.csv
inventory*.log
data/inventory/
data/catalog/
data/gfs_orders/
data/storage_locations/
data/inventory_backups/
data/inventory_imports/
EOF

echo -e "${GREEN}✅ Generated .gitignore patterns${NC}"
echo ""

# Step 4: Show summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}✅ Branch Creation Complete${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}📦 inventory/main branch:${NC}"
echo -e "   - Contains inventory system files"
echo -e "   - Trading files will be ignored (see .gitignore.inventory)"
echo ""
echo -e "${YELLOW}📈 trading/main branch:${NC}"
echo -e "   - Contains trading system files"
echo -e "   - Inventory files will be ignored (see .gitignore.trading)"
echo ""
echo -e "${CYAN}📍 Current branch: $(git branch --show-current)${NC}"
echo ""
echo -e "${BLUE}💡 Next Steps:${NC}"
echo -e "  1. Review .gitignore.inventory and .gitignore.trading"
echo -e "  2. Manually remove files from each branch as needed"
echo -e "  3. Commit changes to each branch"
echo -e "  4. Push branches: ${CYAN}git push -u origin inventory/main${NC}"
echo -e "                    ${CYAN}git push -u origin trading/main${NC}"
echo ""
echo -e "${YELLOW}⚠️  Note: Files are NOT automatically removed.${NC}"
echo -e "   You need to manually remove opposite-system files from each branch."
echo ""

