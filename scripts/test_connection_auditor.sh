#!/bin/bash

# Test TradingView Connection Auditor
# Tests telemetry recording and connection status endpoints

set -euo pipefail

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

LOCAL_URL="http://localhost:3014"
SECRET="${TRADINGVIEW_WEBHOOK_SECRET:-11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784}"

PASSED=0
FAILED=0

echo "🧪 TradingView Connection Auditor Test"
echo "======================================"
echo ""

# Helper function to generate HMAC signature
generate_signature() {
    local payload="$1"
    printf "%s" "$payload" | openssl dgst -sha256 -hmac "$SECRET" 2>/dev/null | awk '{print $2}' || echo "invalid"
}

# Test 1: Check telemetry endpoint (should be 404 initially)
echo "1️⃣  Telemetry Endpoint (Initial - No Webhooks)"
response=$(curl -s --max-time 5 "${LOCAL_URL}/api/tradingview/telemetry" 2>/dev/null || echo "")
http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${LOCAL_URL}/api/tradingview/telemetry" 2>/dev/null || echo "000")

if [ "$http_code" = "404" ]; then
    echo -e "   ${GREEN}✅ PASS${NC} - Returns 404 when no webhooks received"
    ((PASSED++))
elif [ "$http_code" = "200" ]; then
    echo -e "   ${BLUE}ℹ️  INFO${NC} - Telemetry exists (webhooks already received)"
    ((PASSED++))
else
    echo -e "   ${RED}❌ FAIL${NC} - Unexpected status: $http_code"
    ((FAILED++))
fi
echo ""

# Test 2: Send test webhook and check telemetry
echo "2️⃣  Telemetry Recording Test"
PAYLOAD='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-telemetry-'$(date +%s)'","timestamp":'$(date +%s)'}'
SIG=$(generate_signature "$PAYLOAD")

if [ "$SIG" != "invalid" ] && [ -n "$SIG" ]; then
    # Send webhook
    curl -s --max-time 5 -X POST "${LOCAL_URL}/webhook/tradingview" \
      -H "Content-Type: application/json" \
      -H "X-TradingView-Signature: sha256=$SIG" \
      -d "$PAYLOAD" > /dev/null 2>&1 || true
    
    # Wait a moment for telemetry to be recorded
    sleep 1
    
    # Check telemetry
    telemetry_response=$(curl -s --max-time 5 "${LOCAL_URL}/api/tradingview/telemetry" 2>/dev/null || echo "")
    
    if echo "$telemetry_response" | grep -q '"success":true'; then
        echo -e "   ${GREEN}✅ PASS${NC} - Telemetry recorded successfully"
        echo "   Auth mode: $(echo "$telemetry_response" | grep -o '"authModeUsed":"[^"]*"' | cut -d'"' -f4 || echo "N/A")"
        echo "   Result: $(echo "$telemetry_response" | grep -o '"result":"[^"]*"' | cut -d'"' -f4 || echo "N/A")"
        ((PASSED++))
    else
        echo -e "   ${RED}❌ FAIL${NC} - Telemetry not recorded"
        echo "   Response: ${telemetry_response:0:200}"
        ((FAILED++))
    fi
else
    echo -e "   ${YELLOW}⚠️  SKIP${NC} - openssl not available"
    ((FAILED++))
fi
echo ""

# Test 3: Connection status endpoint
echo "3️⃣  Connection Status Endpoint"
connection_response=$(curl -s --max-time 5 "${LOCAL_URL}/api/tradingview/connection" 2>/dev/null || echo "")

if echo "$connection_response" | grep -q '"success":true'; then
    echo -e "   ${GREEN}✅ PASS${NC} - Connection status endpoint works"
    
    # Check for key fields
    if echo "$connection_response" | grep -q '"serverHealth"'; then
        echo "   ✅ Server health included"
    fi
    if echo "$connection_response" | grep -q '"webhookEndpoint"'; then
        echo "   ✅ Webhook endpoint included"
    fi
    if echo "$connection_response" | grep -q '"recommendations"'; then
        echo "   ✅ Recommendations included"
    fi
    
    ((PASSED++))
else
    echo -e "   ${RED}❌ FAIL${NC} - Connection status endpoint failed"
    echo "   Response: ${connection_response:0:200}"
    ((FAILED++))
fi
echo ""

# Test 4: Verify no secrets in telemetry
echo "4️⃣  Security Check - No Secrets in Telemetry"
telemetry_response=$(curl -s --max-time 5 "${LOCAL_URL}/api/tradingview/telemetry" 2>/dev/null || echo "")

if echo "$telemetry_response" | grep -q "$SECRET"; then
    echo -e "   ${RED}❌ FAIL${NC} - Secret found in telemetry!"
    ((FAILED++))
else
    echo -e "   ${GREEN}✅ PASS${NC} - No secrets in telemetry"
    ((PASSED++))
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
TOTAL=$((PASSED + FAILED))
echo "Passed: ${PASSED}"
echo "Failed: ${FAILED}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some tests failed${NC}"
    exit 1
fi

