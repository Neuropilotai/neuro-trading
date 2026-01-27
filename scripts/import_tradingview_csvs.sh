#!/usr/bin/env bash
set -euo pipefail

# TradingView CSV Import Validation Script
# Validates presence of expected CSV files and reports missing pairs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CSV_DIR="$PROJECT_ROOT/data/csv"
CONFIG_FILE="$PROJECT_ROOT/config/tradingview_universe.json"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}📊 TradingView CSV Import Validation${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if CSV directory exists
if [ ! -d "$CSV_DIR" ]; then
    echo -e "${YELLOW}⚠️  CSV directory not found. Creating: $CSV_DIR${NC}"
    mkdir -p "$CSV_DIR"
fi

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}❌ Config file not found: $CONFIG_FILE${NC}"
    exit 1
fi

# Load symbols and timeframes from config
if ! command -v jq > /dev/null 2>&1; then
    echo -e "${RED}❌ jq is required but not installed. Install: brew install jq${NC}"
    exit 1
fi

SYMBOLS=$(jq -r '.symbols[]?' "$CONFIG_FILE" 2>/dev/null || echo "")
TIMEFRAMES=$(jq -r '.timeframes[]?' "$CONFIG_FILE" 2>/dev/null || echo "")

if [ -z "$SYMBOLS" ] || [ -z "$TIMEFRAMES" ]; then
    echo -e "${RED}❌ Failed to load symbols or timeframes from config${NC}"
    exit 1
fi

echo -e "${BLUE}📋 Expected CSV Files${NC}"
echo -e "   Format: SYMBOL_TIMEFRAME.csv (e.g., SPY_1.csv, AAPL_60.csv)"
echo -e "   Location: $CSV_DIR"
echo ""

# Count expected vs found
EXPECTED_COUNT=0
FOUND_COUNT=0
MISSING_FILES=()

while IFS= read -r symbol; do
    while IFS= read -r timeframe; do
        EXPECTED_COUNT=$((EXPECTED_COUNT + 1))
        CSV_FILE="${CSV_DIR}/${symbol}_${timeframe}.csv"
        
        if [ -f "$CSV_FILE" ]; then
            FOUND_COUNT=$((FOUND_COUNT + 1))
            SIZE=$(du -h "$CSV_FILE" | cut -f1)
            LINES=$(wc -l < "$CSV_FILE" 2>/dev/null || echo "0")
            echo -e "${GREEN}   ✅ ${symbol}_${timeframe}.csv${NC} (${SIZE}, ${LINES} lines)"
        else
            MISSING_FILES+=("${symbol}_${timeframe}.csv")
            echo -e "${RED}   ❌ ${symbol}_${timeframe}.csv${NC} (MISSING)"
        fi
    done <<< "$TIMEFRAMES"
done <<< "$SYMBOLS"

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}📊 Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "   Expected: ${EXPECTED_COUNT} files"
echo -e "   Found: ${FOUND_COUNT} files"
echo -e "   Missing: ${#MISSING_FILES[@]} files"
echo ""

if [ ${#MISSING_FILES[@]} -eq 0 ]; then
    echo -e "${GREEN}✅ All CSV files present!${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠️  Missing CSV Files:${NC}"
    for file in "${MISSING_FILES[@]}"; do
        echo -e "   - ${file}"
    done
    echo ""
    echo -e "${BLUE}💡 Next Steps:${NC}"
    echo -e "   1. Export CSV files from TradingView"
    echo -e "   2. Place files in: $CSV_DIR"
    echo -e "   3. Ensure filename format: SYMBOL_TIMEFRAME.csv"
    echo -e "   4. CSV format: timestamp,open,high,low,close,volume"
    echo ""
    echo -e "${BLUE}   Or enable auto-fetch in providerFactory.js${NC}"
    exit 1
fi

