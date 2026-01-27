#!/usr/bin/env bash
set -euo pipefail

# System Separation Analysis Script
# Analyzes repository to identify inventory vs trading files

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
echo -e "${BLUE}📊 System Separation Analysis${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Output files
INVENTORY_FILES=".inventory_files.txt"
TRADING_FILES=".trading_files.txt"
SHARED_FILES=".shared_files.txt"
UNKNOWN_FILES=".unknown_files.txt"

# Clear previous runs
> "$INVENTORY_FILES"
> "$TRADING_FILES"
> "$SHARED_FILES"
> "$UNKNOWN_FILES"

# Inventory patterns
INVENTORY_PATTERNS=(
    "inventory"
    "Inventory"
    "INVENTORY"
    "sysco"
    "Sysco"
    "SYSCO"
    "gfs"
    "GFS"
    "order.*inventory"
    "receiving"
    "Receiving"
    "snapshot"
    "Snapshot"
    "count.*inventory"
    "waste.*inventory"
    "fifo"
    "FIFO"
    "enterprise.*inventory"
    "camp.*inventory"
    "mining.*camp"
)

# Trading patterns
TRADING_PATTERNS=(
    "trading"
    "Trading"
    "TRADING"
    "webhook"
    "Webhook"
    "tradingview"
    "TradingView"
    "TRADINGVIEW"
    "pattern.*learning"
    "Pattern.*Learning"
    "backtest"
    "Backtest"
    "BACKTEST"
    "risk.*engine"
    "Risk.*Engine"
    "paper.*trading"
    "Paper.*Trading"
    "strategy"
    "Strategy"
    "STRATEGY"
    "pine.*script"
    "Pine.*Script"
    "evaluation"
    "Evaluation"
    "walk.*forward"
    "Walk.*Forward"
    "scalping"
    "Scalping"
    "broker"
    "Broker"
)

# Shared/common patterns (files that both systems might use)
SHARED_PATTERNS=(
    "package.json"
    "package-lock.json"
    "README.md"
    "\.git"
    "\.gitignore"
    "\.env"
    "\.env.example"
    "node_modules"
    "Dockerfile"
    "docker-compose"
    "Procfile"
    "railway"
    "\.md$"
    "docs/"
    "config/"
    "scripts/.*common"
    "backend/db/.*common"
    "backend/middleware/.*common"
)

echo -e "${CYAN}🔍 Analyzing repository structure...${NC}"
echo ""

# Find all files (excluding node_modules, .git, etc.)
# Use 2>/dev/null to suppress permission errors
find . -type f \
    -not -path "*/node_modules/*" \
    -not -path "*/.git/*" \
    -not -path "*/dist/*" \
    -not -path "*/build/*" \
    -not -path "*/.next/*" \
    -not -path "*/venv/*" \
    -not -path "*/.venv/*" \
    -not -path "*/__pycache__/*" \
    -not -path "*/.DS_Store" \
    -not -path "*/.cursor/*" \
    -not -path "*/trading_env/*" \
    2>/dev/null | sort > .all_files.txt

TOTAL_FILES=$(wc -l < .all_files.txt | tr -d ' ')

echo -e "${BLUE}📁 Total files to analyze: ${TOTAL_FILES}${NC}"
echo ""

# Categorize files
INVENTORY_COUNT=0
TRADING_COUNT=0
SHARED_COUNT=0
UNKNOWN_COUNT=0

while IFS= read -r file; do
    file_lower=$(echo "$file" | tr '[:upper:]' '[:lower:]')
    classified=false
    
    # Check inventory patterns
    for pattern in "${INVENTORY_PATTERNS[@]}"; do
        if echo "$file" | grep -qiE "$pattern"; then
            echo "$file" >> "$INVENTORY_FILES"
            INVENTORY_COUNT=$((INVENTORY_COUNT + 1))
            classified=true
            break
        fi
    done
    
    # Check trading patterns (if not already classified)
    if [ "$classified" = false ]; then
        for pattern in "${TRADING_PATTERNS[@]}"; do
            if echo "$file" | grep -qiE "$pattern"; then
                echo "$file" >> "$TRADING_FILES"
                TRADING_COUNT=$((TRADING_COUNT + 1))
                classified=true
                break
            fi
        done
    fi
    
    # Check shared patterns (if not already classified)
    if [ "$classified" = false ]; then
        for pattern in "${SHARED_PATTERNS[@]}"; do
            if echo "$file" | grep -qiE "$pattern"; then
                echo "$file" >> "$SHARED_FILES"
                SHARED_COUNT=$((SHARED_COUNT + 1))
                classified=true
                break
            fi
        done
    fi
    
    # Unknown files
    if [ "$classified" = false ]; then
        echo "$file" >> "$UNKNOWN_FILES"
        UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1))
    fi
    
done < .all_files.txt

# Print summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}📊 Analysis Results${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}✅ Inventory Files: ${INVENTORY_COUNT}${NC}"
echo -e "${YELLOW}📈 Trading Files: ${TRADING_COUNT}${NC}"
echo -e "${CYAN}🔗 Shared Files: ${SHARED_COUNT}${NC}"
echo -e "${RED}❓ Unknown Files: ${UNKNOWN_COUNT}${NC}"
echo ""

# Show top inventory directories
echo -e "${GREEN}📦 Top Inventory Directories:${NC}"
grep -E "^\./inventory" "$INVENTORY_FILES" | cut -d'/' -f1-3 | sort | uniq -c | sort -rn | head -10
echo ""

# Show top trading directories
echo -e "${YELLOW}📈 Top Trading Directories:${NC}"
grep -E "^\./(backend|scripts|cli|data)" "$TRADING_FILES" | cut -d'/' -f1-2 | sort | uniq -c | sort -rn | head -10
echo ""

# Show unknown files (need manual review)
if [ "$UNKNOWN_COUNT" -gt 0 ]; then
    echo -e "${RED}❓ Files Needing Manual Review (showing first 20):${NC}"
    head -20 "$UNKNOWN_FILES"
    echo ""
    echo -e "${YELLOW}   (Full list: $UNKNOWN_FILES)${NC}"
    echo ""
fi

# Generate migration report
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}📋 Migration Report Generated${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "Files created:"
echo -e "  ${GREEN}✅ $INVENTORY_FILES${NC} - Inventory system files"
echo -e "  ${YELLOW}📈 $TRADING_FILES${NC} - Trading system files"
echo -e "  ${CYAN}🔗 $SHARED_FILES${NC} - Shared/common files"
echo -e "  ${RED}❓ $UNKNOWN_FILES${NC} - Files needing review"
echo ""

# Cleanup temp file
rm -f .all_files.txt

echo -e "${GREEN}✅ Analysis complete!${NC}"
echo ""
echo -e "${BLUE}💡 Next Steps:${NC}"
echo -e "  1. Review the generated file lists"
echo -e "  2. Manually review files in $UNKNOWN_FILES"
echo -e "  3. Run: ${CYAN}./scripts/create_separate_branches.sh${NC} to create branches"
echo ""

