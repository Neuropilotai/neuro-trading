#!/bin/bash

# TradingView Connection Auditor
# Checks server health, ngrok status, URL configuration, and last webhook telemetry
# Detects drift between expected and actual ngrok URLs

set -euo pipefail

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
LOCAL_URL="http://localhost:3014"
NGROK_API="http://127.0.0.1:4040/api/tunnels"
WEBHOOK_AGE_THRESHOLD="${TRADINGVIEW_WEBHOOK_AGE_THRESHOLD:-3600}" # Default: 1 hour in seconds

PASSED=0
FAILED=0
WARNINGS=0

echo "🔍 TradingView Connection Auditor"
echo "=================================="
echo ""

# Function to check if server is healthy
check_server_health() {
    echo "1️⃣  Server Health Check"
    local response=$(curl -s --max-time 5 "${LOCAL_URL}/health" 2>/dev/null || echo "")
    
    if echo "$response" | grep -q '"status":"healthy"'; then
        echo -e "   ${GREEN}✅ PASS${NC} - Server is healthy"
        ((PASSED++))
        return 0
    else
        echo -e "   ${RED}❌ FAIL${NC} - Server is not responding or unhealthy"
        echo "   Response: ${response:0:200}"
        ((FAILED++))
        return 1
    fi
}

# Function to get ngrok URL
get_ngrok_url() {
    local response=$(curl -s --max-time 2 "${NGROK_API}" 2>/dev/null || echo "")
    
    if [ -z "$response" ]; then
        return 1
    fi
    
    # Extract HTTPS tunnel URL
    local url=$(echo "$response" | grep -o '"public_url":"https://[^"]*"' | head -1 | sed 's/"public_url":"\(.*\)"/\1/' || echo "")
    
    if [ -n "$url" ]; then
        echo "$url"
        return 0
    fi
    
    return 1
}

# Function to check ngrok
check_ngrok() {
    echo ""
    echo "2️⃣  ngrok Status Check"
    local ngrok_url=$(get_ngrok_url)
    
    if [ -n "$ngrok_url" ]; then
        echo -e "   ${GREEN}✅ PASS${NC} - ngrok is running"
        echo "   Public URL: ${ngrok_url}"
        ((PASSED++))
        echo "$ngrok_url" # Return URL for later use
    else
        echo -e "   ${YELLOW}⚠️  WARN${NC} - ngrok is not running"
        echo "   Start with: ngrok http 3014"
        ((WARNINGS++))
        echo "" # Return empty
    fi
}

# Function to check URL configuration
check_url_config() {
    echo ""
    echo "3️⃣  URL Configuration Check"
    
    local expected_url="${TRADINGVIEW_PUBLIC_WEBHOOK_URL:-}"
    local ngrok_url="$1"
    
    if [ -z "$expected_url" ]; then
        echo -e "   ${YELLOW}⚠️  WARN${NC} - TRADINGVIEW_PUBLIC_WEBHOOK_URL not set"
        echo "   Set in .env: TRADINGVIEW_PUBLIC_WEBHOOK_URL=https://xxxx.ngrok-free.app"
        ((WARNINGS++))
        
        if [ -n "$ngrok_url" ]; then
            echo -e "   ${BLUE}ℹ️  INFO${NC} - Using detected ngrok URL: ${ngrok_url}"
            echo "   Recommended: Set TRADINGVIEW_PUBLIC_WEBHOOK_URL=${ngrok_url}"
        fi
        return 0
    fi
    
    echo "   Expected URL: ${expected_url}"
    
    if [ -z "$ngrok_url" ]; then
        echo -e "   ${YELLOW}⚠️  WARN${NC} - ngrok not running, cannot verify URL"
        ((WARNINGS++))
        return 0
    fi
    
    if [ "$expected_url" = "$ngrok_url" ]; then
        echo -e "   ${GREEN}✅ PASS${NC} - URLs match"
        ((PASSED++))
        return 0
    else
        echo -e "   ${RED}❌ FAIL${NC} - URL mismatch detected!"
        echo "   Expected: ${expected_url}"
        echo "   Actual:   ${ngrok_url}"
        echo ""
        echo -e "   ${YELLOW}📋 ACTION REQUIRED:${NC}"
        echo "   Update TradingView alert webhook URL to:"
        echo -e "   ${BLUE}${ngrok_url}/webhook/tradingview${NC}"
        echo ""
        ((FAILED++))
        return 1
    fi
}

# Function to check webhook telemetry
check_webhook_telemetry() {
    echo ""
    echo "4️⃣  Last Webhook Telemetry"
    
    local response=$(curl -s --max-time 5 "${LOCAL_URL}/api/tradingview/telemetry" 2>/dev/null || echo "")
    
    if echo "$response" | grep -q '"success":true'; then
        local received_at=$(echo "$response" | grep -o '"receivedAt":"[^"]*"' | cut -d'"' -f4 || echo "")
        local age_seconds=$(echo "$response" | grep -o '"ageSeconds":[0-9]*' | cut -d':' -f2 || echo "")
        local age_formatted=$(echo "$response" | grep -o '"ageFormatted":"[^"]*"' | cut -d'"' -f4 || echo "")
        local symbol=$(echo "$response" | grep -o '"symbol":"[^"]*"' | cut -d'"' -f4 || echo "")
        local action=$(echo "$response" | grep -o '"action":"[^"]*"' | cut -d'"' -f4 || echo "")
        local auth_mode=$(echo "$response" | grep -o '"authModeUsed":"[^"]*"' | cut -d'"' -f4 || echo "")
        
        if [ -n "$received_at" ]; then
            echo "   Last webhook: ${received_at}"
            echo "   Age: ${age_formatted:-${age_seconds}s}"
            echo "   Symbol: ${symbol:-N/A}"
            echo "   Action: ${action:-N/A}"
            echo "   Auth mode: ${auth_mode:-N/A}"
            
            if [ -n "$age_seconds" ] && [ "$age_seconds" -gt "$WEBHOOK_AGE_THRESHOLD" ]; then
                echo -e "   ${RED}❌ FAIL${NC} - Last webhook is older than threshold (${WEBHOOK_AGE_THRESHOLD}s)"
                echo "   Check TradingView alert configuration"
                ((FAILED++))
                return 1
            else
                echo -e "   ${GREEN}✅ PASS${NC} - Recent webhook received"
                ((PASSED++))
                return 0
            fi
        fi
    else
        echo -e "   ${YELLOW}⚠️  WARN${NC} - No webhooks received yet"
        echo "   This is normal if you just started the server"
        ((WARNINGS++))
        return 0
    fi
}

# Function to get connection status
get_connection_status() {
    echo ""
    echo "5️⃣  Connection Status Summary"
    
    local response=$(curl -s --max-time 5 "${LOCAL_URL}/api/tradingview/connection" 2>/dev/null || echo "")
    
    if echo "$response" | grep -q '"success":true'; then
        local webhook_endpoint=$(echo "$response" | grep -o '"webhookEndpoint":"[^"]*"' | cut -d'"' -f4 || echo "")
        local url_match=$(echo "$response" | grep -o '"urlMatch":[^,}]*' | cut -d':' -f2 || echo "")
        
        if [ -n "$webhook_endpoint" ]; then
            echo "   Webhook endpoint: ${webhook_endpoint}"
        fi
        
        if [ "$url_match" = "true" ]; then
            echo -e "   ${GREEN}✅ URLs match${NC}"
        elif [ "$url_match" = "false" ]; then
            echo -e "   ${RED}❌ URLs do not match${NC}"
        fi
        
        # Extract recommendations
        echo "$response" | grep -o '"recommendations":\[[^]]*\]' | grep -o '"[^"]*"' | sed 's/"//g' | while read -r rec; do
            if [ -n "$rec" ]; then
                echo "   ${YELLOW}⚠️  ${rec}${NC}"
            fi
        done
    fi
}

# Main execution
SERVER_HEALTHY=false
if check_server_health; then
    SERVER_HEALTHY=true
fi

NGROK_URL=$(check_ngrok)

if [ "$SERVER_HEALTHY" = true ]; then
    check_url_config "$NGROK_URL"
    check_webhook_telemetry
    get_connection_status
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Audit Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Passed: ${PASSED}"
echo "Failed: ${FAILED}"
echo "Warnings: ${WARNINGS}"
echo ""

if [ $FAILED -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✅ PASS${NC} - All checks passed"
    exit 0
elif [ $FAILED -eq 0 ]; then
    echo -e "${YELLOW}⚠️  WARN${NC} - Some warnings, but no failures"
    exit 0
else
    echo -e "${RED}❌ FAIL${NC} - Issues detected. Review output above."
    exit 1
fi

