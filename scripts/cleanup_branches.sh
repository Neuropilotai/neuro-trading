#!/usr/bin/env bash
set -euo pipefail

# Cleanup Branches - Remove Opposite System Files
# This script removes trading files from inventory/main and inventory files from trading/main

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
echo -e "${BLUE}🧹 Cleanup Branches${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if file lists exist
if [ ! -f ".trading_files.txt" ] || [ ! -f ".inventory_files.txt" ]; then
    echo -e "${RED}❌ File lists not found. Run analysis first:${NC}"
    echo -e "   ${CYAN}./scripts/analyze_system_separation_simple.sh${NC}"
    exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)
echo -e "${CYAN}📍 Current branch: ${CURRENT_BRANCH}${NC}"
echo ""

# Confirm action
echo -e "${YELLOW}⚠️  This will remove files from branches:${NC}"
echo -e "  1. On ${GREEN}inventory/main${NC}: Remove trading files"
echo -e "  2. On ${YELLOW}trading/main${NC}: Remove inventory files"
echo ""
read -p "Continue? (y/N): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}❌ Cancelled${NC}"
    exit 1
fi

# Step 1: Clean inventory/main branch
echo -e "${BLUE}📦 Step 1: Cleaning inventory/main branch...${NC}"
git checkout inventory/main

TRADING_FILES_TO_REMOVE=$(cat .trading_files.txt | wc -l | tr -d ' ')
echo -e "${CYAN}   Found ${TRADING_FILES_TO_REMOVE} trading files to remove${NC}"

# Remove trading files (only if they exist and are tracked)
REMOVED_COUNT=0
while IFS= read -r file; do
    if git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
        git rm --cached "$file" 2>/dev/null && REMOVED_COUNT=$((REMOVED_COUNT + 1)) || true
    fi
done < .trading_files.txt

echo -e "${GREEN}✅ Removed ${REMOVED_COUNT} trading files from inventory/main${NC}"
echo ""

# Step 2: Clean trading/main branch
echo -e "${BLUE}📈 Step 2: Cleaning trading/main branch...${NC}"
git checkout trading/main

INVENTORY_FILES_TO_REMOVE=$(cat .inventory_files.txt | wc -l | tr -d ' ')
echo -e "${CYAN}   Found ${INVENTORY_FILES_TO_REMOVE} inventory files to remove${NC}"

# Remove inventory files (only if they exist and are tracked)
REMOVED_COUNT=0
while IFS= read -r file; do
    if git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
        git rm --cached "$file" 2>/dev/null && REMOVED_COUNT=$((REMOVED_COUNT + 1)) || true
    fi
done < .inventory_files.txt

echo -e "${GREEN}✅ Removed ${REMOVED_COUNT} inventory files from trading/main${NC}"
echo ""

# Step 3: Show status
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}✅ Cleanup Complete${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if there are changes to commit
echo -e "${CYAN}📊 Checking for changes to commit...${NC}"
echo ""

git checkout inventory/main
if ! git diff --cached --quiet 2>/dev/null; then
    echo -e "${GREEN}📦 inventory/main has changes ready to commit${NC}"
    echo -e "   Run: ${CYAN}git commit -m 'Remove trading system files'${NC}"
else
    echo -e "${YELLOW}📦 inventory/main: No changes (files may not be tracked)${NC}"
fi
echo ""

git checkout trading/main
if ! git diff --cached --quiet 2>/dev/null; then
    echo -e "${GREEN}📈 trading/main has changes ready to commit${NC}"
    echo -e "   Run: ${CYAN}git commit -m 'Remove inventory system files'${NC}"
else
    echo -e "${YELLOW}📈 trading/main: No changes (files may not be tracked)${NC}"
fi
echo ""

# Return to original branch
git checkout "$CURRENT_BRANCH" 2>/dev/null || true

echo -e "${BLUE}💡 Next Steps:${NC}"
echo -e "  1. Review changes on each branch"
echo -e "  2. Commit changes: ${CYAN}git checkout inventory/main && git commit -m 'Remove trading files'${NC}"
echo -e "  3. Commit changes: ${CYAN}git checkout trading/main && git commit -m 'Remove inventory files'${NC}"
echo -e "  4. Push branches: ${CYAN}git push -u origin inventory/main${NC}"
echo -e "                    ${CYAN}git push -u origin trading/main${NC}"
echo ""

