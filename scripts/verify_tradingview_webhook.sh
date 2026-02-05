#!/usr/bin/env bash

# TradingView Webhook Verification Script
# 
# How to run:
#   cd /Users/davidmikulis/neuro-pilot-ai
#   export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
#   ./scripts/verify_tradingview_webhook.sh
#
# Prerequisites:
#   - Server running: node simple_webhook_server.js
#   - curl, openssl, awk, sed available
#   - Optional: ngrok running for public URL tests

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
# Support both PORT (standard) and WEBHOOK_PORT (legacy) for consistency
LOCAL_PORT="${PORT:-${WEBHOOK_PORT:-3014}}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"
SECRET="${TRADINGVIEW_WEBHOOK_SECRET:-[YOUR_TRADINGVIEW_WEBHOOK_SECRET]}"
PASSED=0
FAILED=0

# Create temp file for response bodies
BODY_FILE=$(mktemp /tmp/verify_body_XXXXXX.json)
trap "rm -f $BODY_FILE" EXIT

echo "🧪 TradingView Webhook Verification"
echo "===================================="
echo ""
echo "Local URL: ${LOCAL_URL}"
echo "Secret: ${SECRET:0:20}..."
echo ""

# Root cause fix: Previous version used -w "\nHTTP_CODE:%{http_code}" which mixed body and status.
# New approach: Use -o for body and -w for status code separately, with proper timeouts.

# Helper function to generate HMAC signature
generate_signature() {
    local payload="$1"
    printf "%s" "$payload" | openssl dgst -sha256 -hmac "$SECRET" 2>/dev/null | awk '{print $2}' || echo "invalid"
}

# Helper function to get HTTP status code
# Bug fix: Properly separates body (-o) and status code (-w) with timeouts
http_code() {
    local method="$1"
    local url="$2"
    local data="$3"
    local sig="$4"
    local out="${5:-$BODY_FILE}"
    
    local code="000"
    
    if [ -n "$sig" ]; then
        # POST with signature header
        code=$(curl -sS --max-time 5 --connect-timeout 2 \
            -X "$method" "$url" \
            -H "Content-Type: application/json" \
            -H "X-TradingView-Signature: $sig" \
            -d "$data" \
            -o "$out" \
            -w "%{http_code}" 2>/dev/null || echo "000")
    elif [ -n "$data" ]; then
        # POST without signature
        code=$(curl -sS --max-time 5 --connect-timeout 2 \
            -X "$method" "$url" \
            -H "Content-Type: application/json" \
            -d "$data" \
            -o "$out" \
            -w "%{http_code}" 2>/dev/null || echo "000")
    else
        # GET request
        code=$(curl -sS --max-time 5 --connect-timeout 2 \
            -X "$method" "$url" \
            -o "$out" \
            -w "%{http_code}" 2>/dev/null || echo "000")
    fi
    
    echo "$code"
}

# Test function
test_endpoint() {
    local name="$1"
    local method="$2"
    local url="$3"
    local data="$4"
    local sig="$5"
    local expected_status="$6"
    local expected_keyword="$7"  # Optional: keyword to check in response
    
    echo -n "Testing: ${name}... "
    
    local http_code=$(http_code "$method" "$url" "$data" "$sig")
    
    if [ "$http_code" = "000" ] || [ -z "$http_code" ]; then
        echo -e "${RED}❌ FAIL${NC} (Connection error or timeout)"
        if [ -f "$BODY_FILE" ] && [ -s "$BODY_FILE" ]; then
            echo "   Response: $(head -c 2000 "$BODY_FILE" 2>/dev/null || echo "empty")"
        fi
        ((FAILED++))
        return 1
    fi
    
    if [ "$http_code" = "$expected_status" ]; then
        # Check for keyword if provided
        if [ -n "$expected_keyword" ]; then
            if [ -f "$BODY_FILE" ] && grep -q "$expected_keyword" "$BODY_FILE" 2>/dev/null; then
                echo -e "${GREEN}✅ PASS${NC} (Status: $http_code)"
                ((PASSED++))
                return 0
            else
                echo -e "${YELLOW}⚠️  PARTIAL${NC} (Status: $http_code, but missing keyword: $expected_keyword)"
                if [ -f "$BODY_FILE" ] && [ -s "$BODY_FILE" ]; then
                    echo "   Response: $(head -c 2000 "$BODY_FILE" 2>/dev/null || echo "empty")"
                fi
                ((FAILED++))
                return 1
            fi
        else
            echo -e "${GREEN}✅ PASS${NC} (Status: $http_code)"
            ((PASSED++))
            return 0
        fi
    else
        echo -e "${RED}❌ FAIL${NC} (Expected: $expected_status, Got: $http_code)"
        if [ -f "$BODY_FILE" ] && [ -s "$BODY_FILE" ]; then
            echo "   Response: $(head -c 2000 "$BODY_FILE" 2>/dev/null || echo "empty")"
        fi
        ((FAILED++))
        return 1
    fi
}

# Test 1: Health Check
echo "1️⃣  Health Check"
# Try health check, with port detection if it fails
HEALTH_CODE=$(http_code "GET" "${LOCAL_URL}/health" "" "")
if [ "$HEALTH_CODE" != "200" ]; then
    # Try to detect server on other ports
    DETECTED_PORT=""
    for check_port in 3014 3000; do
        if [ "$check_port" != "$LOCAL_PORT" ] && lsof -ti:${check_port} > /dev/null 2>&1; then
            TEST_URL="http://localhost:${check_port}/health"
            TEST_CODE=$(http_code "GET" "${TEST_URL}" "" "")
            if [ "$TEST_CODE" = "200" ]; then
                DETECTED_PORT="${check_port}"
                break
            fi
        fi
    done
    
    if [ -n "$DETECTED_PORT" ]; then
        echo -e "${YELLOW}⚠️  Health check failed on port ${LOCAL_PORT}, but server detected on port ${DETECTED_PORT}${NC}"
        echo -e "${BLUE}ℹ️  Updating to use port ${DETECTED_PORT}${NC}"
        LOCAL_PORT="${DETECTED_PORT}"
        LOCAL_URL="http://localhost:${LOCAL_PORT}"
    fi
fi
test_endpoint "Health Check" "GET" "${LOCAL_URL}/health" "" "" "200" "healthy"
echo ""

# Test 2: Invalid Signature (should return 401)
echo "2️⃣  Authentication Tests"
PAYLOAD='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-auth-1","timestamp":1234567890}'
test_endpoint "Invalid Signature" "POST" "${LOCAL_URL}/webhook/tradingview" \
    "$PAYLOAD" "sha256=invalid" "401"
echo ""

# Test 3: Missing Signature (should return 401)
test_endpoint "Missing Signature" "POST" "${LOCAL_URL}/webhook/tradingview" \
    "$PAYLOAD" "" "401"
echo ""

# Test 3b: Body Secret Auth - Valid Secret (should return 200)
echo "3️⃣  Body Secret Authentication Tests"
PAYLOAD_WITH_SECRET='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-body-secret-'$(date +%s)'","timestamp":'$(date +%s)',"secret":"'$SECRET'"}'
test_endpoint "Valid Body Secret" "POST" "${LOCAL_URL}/webhook/tradingview" \
    "$PAYLOAD_WITH_SECRET" "" "200" "success"

# Test 3c: Body Secret Auth - Invalid Secret (should return 401)
PAYLOAD_INVALID_SECRET='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-invalid-secret-'$(date +%s)'","timestamp":'$(date +%s)',"secret":"invalid_secret_12345"}'
test_endpoint "Invalid Body Secret" "POST" "${LOCAL_URL}/webhook/tradingview" \
    "$PAYLOAD_INVALID_SECRET" "" "401"

# Test 3d: Body Secret Auth - Missing Required Fields (should return 400)
# Note: Valid secret but missing alert_id/timestamp - should pass auth, fail validation
BAD_BODY_WITH_SECRET='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"secret":"'$SECRET'"}'
test_endpoint "Missing Required Fields (Valid Body Secret)" "POST" "${LOCAL_URL}/webhook/tradingview" \
    "$BAD_BODY_WITH_SECRET" "" "400"
echo ""

# Test 4: Valid Signature (should return 200)
echo "4️⃣  HMAC Signature Authentication Tests"
PAYLOAD_VALID='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-valid-'$(date +%s)'","timestamp":'$(date +%s)'}'
SIG=$(generate_signature "$PAYLOAD_VALID")

if [ "$SIG" != "invalid" ] && [ -n "$SIG" ]; then
    test_endpoint "Valid Signature" "POST" "${LOCAL_URL}/webhook/tradingview" \
        "$PAYLOAD_VALID" "sha256=$SIG" "200" "success"
else
    echo -e "${YELLOW}⚠️  SKIP${NC} (openssl not available for signature generation)"
    ((FAILED++))
fi
echo ""

# Test 5: Missing Required Fields (should return 400)
# Note: Must use valid signature so auth passes and validation catches missing fields
echo "5️⃣  Validation Tests"
BAD_BODY='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1}'
BAD_SIG=$(generate_signature "$BAD_BODY")
if [ "$BAD_SIG" != "invalid" ] && [ -n "$BAD_SIG" ]; then
    test_endpoint "Missing Required Fields (Valid Signature)" "POST" "${LOCAL_URL}/webhook/tradingview" \
        "$BAD_BODY" "sha256=$BAD_SIG" "400"
else
    echo -e "${YELLOW}⚠️  SKIP${NC} (openssl not available)"
    ((FAILED++))
fi

# Optional: Demonstrate auth-first behavior (non-fatal, informational)
echo -n "Testing: Missing Required Fields (No Signature - Auth First)... "
NO_SIG_CODE=$(http_code "POST" "${LOCAL_URL}/webhook/tradingview" "$BAD_BODY" "")
if [ "$NO_SIG_CODE" = "401" ]; then
    echo -e "${BLUE}ℹ️  INFO${NC} (Status: 401 - Auth-first behavior confirmed)"
else
    echo -e "${YELLOW}⚠️  INFO${NC} (Status: $NO_SIG_CODE - Expected 401 for auth-first)"
fi
echo ""

# Test 6: Idempotency (same alert_id twice)
echo "6️⃣  Idempotency Tests"
# Use unique alert_id with timestamp and random to avoid conflicts from previous test runs
# Format: test_idempo_<timestamp>_<random>
ALERT_ID="test_idempo_$(date +%s)_${RANDOM}"
TIMESTAMP=$(date +%s)
PAYLOAD_DEDUPE='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"'$ALERT_ID'","timestamp":'$TIMESTAMP'}'

SIG_DEDUPE=$(generate_signature "$PAYLOAD_DEDUPE")

if [ "$SIG_DEDUPE" != "invalid" ] && [ -n "$SIG_DEDUPE" ]; then
    # First request should succeed (unique alert_id)
    test_endpoint "First Request (should pass)" "POST" "${LOCAL_URL}/webhook/tradingview" \
        "$PAYLOAD_DEDUPE" "sha256=$SIG_DEDUPE" "200" "success"
    
    # Small delay to ensure first request is processed
    sleep 0.5
    
    # Duplicate with same alert_id and timestamp should fail with 409
    # Use exact same payload and signature (true duplicate)
    test_endpoint "Duplicate Request (should return 409)" "POST" "${LOCAL_URL}/webhook/tradingview" \
        "$PAYLOAD_DEDUPE" "sha256=$SIG_DEDUPE" "409" "Duplicate"
else
    echo -e "${YELLOW}⚠️  SKIP${NC} (openssl not available)"
    ((FAILED++))
fi
echo ""

# Test 7: ngrok Public URL (if running) - Optional, non-fatal
echo "7️⃣  ngrok Public URL Test (Optional)"
NGROK_API_RESPONSE=$(curl -s --max-time 2 --connect-timeout 1 http://127.0.0.1:4040/api/tunnels 2>/dev/null || echo "")

if [ -n "$NGROK_API_RESPONSE" ]; then
    PUBLIC_URL=$(echo "$NGROK_API_RESPONSE" | grep -o '"public_url":"https://[^"]*"' | head -1 | sed 's/"public_url":"\(.*\)"/\1/' || echo "")
    
    if [ -n "$PUBLIC_URL" ]; then
        echo "   Found ngrok URL: ${PUBLIC_URL}"
        echo ""
        
        # Test health endpoint via ngrok
        test_endpoint "ngrok Health Check" "GET" "${PUBLIC_URL}/health" "" "" "200" "healthy"
        
        # Test webhook via ngrok
        PAYLOAD_NGROK='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-ngrok-'$(date +%s)'","timestamp":'$(date +%s)'}'
        SIG_NGROK=$(generate_signature "$PAYLOAD_NGROK")
        
        if [ "$SIG_NGROK" != "invalid" ] && [ -n "$SIG_NGROK" ]; then
            test_endpoint "ngrok Public Webhook" "POST" "${PUBLIC_URL}/webhook/tradingview" \
                "$PAYLOAD_NGROK" "sha256=$SIG_NGROK" "200" "success"
        else
            echo -e "${YELLOW}⚠️  SKIP${NC} (openssl not available)"
        fi
    else
        echo -e "${YELLOW}⚠️  SKIP${NC} (ngrok running but could not extract URL)"
    fi
else
    echo -e "${YELLOW}⚠️  SKIP${NC} (ngrok not running - start with: ./setup_ngrok.sh)"
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
TOTAL=$((PASSED + FAILED))
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC} ($PASSED/$TOTAL)"
    echo ""
    exit 0
else
    echo -e "${RED}❌ Some tests failed${NC} (Passed: $PASSED, Failed: $FAILED)"
    echo ""
    exit 1
fi
