#!/usr/bin/env bash
set -euo pipefail

# Simplified System Separation Analysis
# Uses git ls-files to avoid permission issues

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

echo -e "${CYAN}🔍 Analyzing repository using git ls-files...${NC}"
echo ""

# Get all tracked files from git (avoids permission issues)
git ls-files > .all_files.txt 2>/dev/null || {
    echo -e "${YELLOW}⚠️  Not a git repository or git ls-files failed. Using find instead...${NC}"
    find . -type f \
        -not -path "*/node_modules/*" \
        -not -path "*/.git/*" \
        -not -path "*/dist/*" \
        -not -path "*/build/*" \
        -not -path "*/venv/*" \
        -not -path "*/.venv/*" \
        -not -path "*/__pycache__/*" \
        -not -path "*/.DS_Store" \
        2>/dev/null | sed 's|^\./||' | sort > .all_files.txt
}

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
    
    # Inventory patterns
    if echo "$file" | grep -qiE "(inventory|sysco|gfs|receiving|snapshot|count.*inventory|waste.*inventory|fifo|enterprise.*inventory|camp.*inventory|mining.*camp)"; then
        echo "$file" >> "$INVENTORY_FILES"
        INVENTORY_COUNT=$((INVENTORY_COUNT + 1))
        classified=true
    fi
    
    # Trading patterns (if not already classified)
    if [ "$classified" = false ]; then
        if echo "$file" | grep -qiE "(trading|webhook|tradingview|pattern.*learning|backtest|risk.*engine|paper.*trading|strategy|pine.*script|evaluation|walk.*forward|scalping|broker)"; then
            echo "$file" >> "$TRADING_FILES"
            TRADING_COUNT=$((TRADING_COUNT + 1))
            classified=true
        fi
    fi
    
    # Shared patterns (if not already classified)
    if [ "$classified" = false ]; then
        if echo "$file" | grep -qiE "(package\.json|package-lock\.json|readme\.md|\.gitignore|\.env|dockerfile|docker-compose|procfile|railway|^docs/|^config/)"; then
            echo "$file" >> "$SHARED_FILES"
            SHARED_COUNT=$((SHARED_COUNT + 1))
            classified=true
        fi
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

# Show sample files
if [ "$INVENTORY_COUNT" -gt 0 ]; then
    echo -e "${GREEN}📦 Sample Inventory Files (first 10):${NC}"
    head -10 "$INVENTORY_FILES" | sed 's/^/   /'
    echo ""
fi

if [ "$TRADING_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}📈 Sample Trading Files (first 10):${NC}"
    head -10 "$TRADING_FILES" | sed 's/^/   /'
    echo ""
fi

# Show top directories
if [ "$INVENTORY_COUNT" -gt 0 ]; then
    echo -e "${GREEN}📦 Top Inventory Directories:${NC}"
    grep -E "^inventory" "$INVENTORY_FILES" | cut -d'/' -f1 | sort | uniq -c | sort -rn | head -5
    echo ""
fi

if [ "$TRADING_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}📈 Top Trading Directories:${NC}"
    grep -E "^(backend|scripts|cli|simple_webhook)" "$TRADING_FILES" | cut -d'/' -f1 | sort | uniq -c | sort -rn | head -5
    echo ""
fi

# Show unknown files (need manual review)
if [ "$UNKNOWN_COUNT" -gt 0 ] && [ "$UNKNOWN_COUNT" -lt 100 ]; then
    echo -e "${RED}❓ Files Needing Manual Review (showing first 20):${NC}"
    head -20 "$UNKNOWN_FILES" | sed 's/^/   /'
    echo ""
elif [ "$UNKNOWN_COUNT" -ge 100 ]; then
    echo -e "${YELLOW}⚠️  ${UNKNOWN_COUNT} unknown files (too many to display)${NC}"
    echo -e "   Review: ${CYAN}$UNKNOWN_FILES${NC}"
    echo ""
fi

# Generate migration report
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}📋 Migration Report Generated${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "Files created:"
echo -e "  ${GREEN}✅ $INVENTORY_FILES${NC} - ${INVENTORY_COUNT} inventory system files"
echo -e "  ${YELLOW}📈 $TRADING_FILES${NC} - ${TRADING_COUNT} trading system files"
echo -e "  ${CYAN}🔗 $SHARED_FILES${NC} - ${SHARED_COUNT} shared/common files"
echo -e "  ${RED}❓ $UNKNOWN_FILES${NC} - ${UNKNOWN_COUNT} files needing review"
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

