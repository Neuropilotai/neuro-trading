#!/usr/bin/env bash

# TradingView Operations - One Command Status & Setup
# Complete operational check and setup guide for TradingView integration
#
# Usage:
#   ./scripts/tradingview_ops.sh
#
# Exit codes:
#   0: Health OK and (if secret provided) verify passes
#   1: Health fails or verify fails

set -euo pipefail

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration
LOCAL_URL="http://localhost:3014"
HEALTH_URL="${LOCAL_URL}/health"
PORT=3014
SECRET="${TRADINGVIEW_WEBHOOK_SECRET:-}"

# Counters
HEALTH_OK=false
VERIFY_PASSED=false

# Helper functions
section() {
    echo ""
    echo -e "${CYAN}$1${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

info() {
    echo -e "   ${BLUE}ℹ️  $1${NC}"
}

warn() {
    echo -e "   ${YELLOW}⚠️  $1${NC}"
}

pass() {
    echo -e "   ${GREEN}✅ $1${NC}"
}

fail() {
    echo -e "   ${RED}❌ $1${NC}"
}

echo "🎯 TradingView Operations - Status & Setup"
echo "=========================================="

# 1. Status Summary
section "1️⃣  Status Summary"

# Server listener PID
if lsof -ti:${PORT} > /dev/null 2>&1; then
    PID=$(lsof -ti:${PORT} | head -1)
    PROCESS=$(ps -p "$PID" -o comm= 2>/dev/null || echo "unknown")
    pass "Server listening on port ${PORT} (PID: ${PID}, Process: ${PROCESS})"
else
    fail "No process listening on port ${PORT}"
    echo ""
    echo "   Start server with:"
    echo "   export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]"
    echo "   node simple_webhook_server.js"
    echo ""
    exit 1
fi

# Health check
HEALTH_CODE=$(curl -sS --max-time 3 --connect-timeout 2 -o /dev/null -w "%{http_code}" "${HEALTH_URL}" 2>/dev/null || echo "000")
if [ "$HEALTH_CODE" = "200" ]; then
    pass "Health endpoint returns 200"
    HEALTH_OK=true
else
    fail "Health endpoint returned ${HEALTH_CODE} (expected 200)"
    HEALTH_OK=false
fi

# ngrok public URL
if [ -f "./scripts/get_public_webhook_url.sh" ]; then
    if WEBHOOK_URL=$(./scripts/get_public_webhook_url.sh 2>/dev/null); then
        pass "ngrok public URL available"
        info "Webhook URL: ${WEBHOOK_URL}"
    else
        warn "ngrok not running or URL not available"
        info "Start ngrok with: ./setup_ngrok.sh"
        WEBHOOK_URL=""
    fi
else
    warn "get_public_webhook_url.sh not found"
    WEBHOOK_URL=""
fi

# 2. Webhook URL and Alert Messages
section "2️⃣  Webhook URL & Alert Messages"

if [ -n "$WEBHOOK_URL" ]; then
    echo ""
    echo -e "${GREEN}📋 Webhook URL to paste into TradingView:${NC}"
    echo ""
    echo "   ${WEBHOOK_URL}"
    echo ""
else
    warn "Webhook URL not available (ngrok not running)"
    echo ""
    echo "   Run: ./setup_ngrok.sh"
    echo "   Then re-run this script to get the webhook URL"
    echo ""
fi

# Alert message templates
echo -e "${CYAN}📝 Alert Message Templates:${NC}"
echo ""

if [ -f "./ALERT_MESSAGE_BUY.txt" ]; then
    echo -e "${GREEN}BUY Alert Message:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    cat ./ALERT_MESSAGE_BUY.txt
    echo ""
else
    warn "ALERT_MESSAGE_BUY.txt not found"
fi

if [ -f "./ALERT_MESSAGE_SELL.txt" ]; then
    echo -e "${GREEN}SELL Alert Message:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    cat ./ALERT_MESSAGE_SELL.txt
    echo ""
else
    warn "ALERT_MESSAGE_SELL.txt not found"
fi

# 3. Verification Suite
section "3️⃣  Verification Suite"

if [ -z "$SECRET" ]; then
    warn "TRADINGVIEW_WEBHOOK_SECRET not set - skipping verification"
    info "Set secret to run verification: export TRADINGVIEW_WEBHOOK_SECRET=..."
else
    if [ -f "./scripts/verify_tradingview_webhook.sh" ]; then
        if [ -x "./scripts/verify_tradingview_webhook.sh" ]; then
            info "Running verification suite..."
            echo ""
            export TRADINGVIEW_WEBHOOK_SECRET="$SECRET"
            if ./scripts/verify_tradingview_webhook.sh; then
                pass "Verification suite passed"
                VERIFY_PASSED=true
            else
                fail "Verification suite had failures"
                VERIFY_PASSED=false
            fi
        else
            warn "Verification script not executable"
        fi
    else
        warn "Verification script not found: ./scripts/verify_tradingview_webhook.sh"
    fi
fi

# 4. TradingView UI Checklist
section "4️⃣  TradingView UI Checklist"

echo ""
echo "Go to: https://www.tradingview.com/alerts"
echo ""
echo "For each alert (BUY and SELL):"
echo ""
echo "  [ ] 1. Click the three dots (⋯) → Edit"
echo ""
if [ -n "$WEBHOOK_URL" ]; then
    echo "  [ ] 2. Update Webhook URL to:"
    echo "      ${WEBHOOK_URL}"
else
    echo "  [ ] 2. Update Webhook URL (run ./setup_ngrok.sh first)"
fi
echo ""
echo "  [ ] 3. Verify Webhook Secret:"
echo "      [YOUR_TRADINGVIEW_WEBHOOK_SECRET]"
echo ""
echo "  [ ] 4. Update Alert Message:"
echo "      - BUY alert: Use template from ALERT_MESSAGE_BUY.txt"
echo "      - SELL alert: Use template from ALERT_MESSAGE_SELL.txt"
echo ""
echo "  [ ] 5. Verify settings:"
echo "      - Condition: 🎯 Elite AI Long (BUY) or 🎯 Elite AI Short (SELL)"
echo "      - Frequency: Once Per Bar Close"
echo "      - Status: Enabled (green dot)"
echo ""
echo "  [ ] 6. Click Save"
echo ""

# Summary
section "📊 Summary"

if [ "$HEALTH_OK" = true ]; then
    pass "Server health: OK"
else
    fail "Server health: FAILED"
fi

if [ -n "$WEBHOOK_URL" ]; then
    pass "Webhook URL: Available"
else
    warn "Webhook URL: Not available (ngrok not running)"
fi

if [ -n "$SECRET" ]; then
    if [ "$VERIFY_PASSED" = true ]; then
        pass "Verification: PASSED"
    else
        fail "Verification: FAILED"
    fi
else
    warn "Verification: SKIPPED (secret not set)"
fi

echo ""

# Exit code logic
if [ "$HEALTH_OK" = true ]; then
    if [ -z "$SECRET" ] || [ "$VERIFY_PASSED" = true ]; then
        echo -e "${GREEN}✅ Operations Check: PASSED${NC}"
        echo ""
        exit 0
    else
        echo -e "${RED}❌ Operations Check: FAILED (verification failed)${NC}"
        echo ""
        exit 1
    fi
else
    echo -e "${RED}❌ Operations Check: FAILED (health check failed)${NC}"
    echo ""
    exit 1
fi


