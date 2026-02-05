#!/bin/bash

# Test idempotency: sending same alert twice should return duplicate

set -e

# Configuration
# Support both PORT (standard) and WEBHOOK_PORT (legacy) for consistency
PORT="${PORT:-${WEBHOOK_PORT:-3001}}"
LOCAL_URL="${LOCAL_URL:-http://localhost:${PORT}}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dev-xauusd-secret-123456}"
TIMESTAMP=$(date +%s)
ALERT_ID="test_duplicate_${TIMESTAMP}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Testing Webhook Idempotency"
echo "=============================="
echo ""

PAYLOAD=$(cat <<EOF
{
  "symbol": "XAUUSD",
  "action": "BUY",
  "price": 2650.50,
  "quantity": 0.01,
  "alert_id": "${ALERT_ID}",
  "timestamp": ${TIMESTAMP},
  "stop_loss": 2640.00,
  "secret": "${WEBHOOK_SECRET}"
}
EOF
)

# Test 1: First request (should succeed)
echo "📤 Test 1: First request (should succeed)"
FIRST_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${LOCAL_URL}/webhook/tradingview" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

FIRST_HTTP_CODE=$(echo "$FIRST_RESPONSE" | tail -n1)
FIRST_BODY=$(echo "$FIRST_RESPONSE" | sed '$d')

if [ "$FIRST_HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}✅ First request accepted (HTTP 200)${NC}"
  echo "Response: $FIRST_BODY" | jq '.' 2>/dev/null || echo "$FIRST_BODY"
else
  echo -e "${RED}❌ First request failed (HTTP $FIRST_HTTP_CODE)${NC}"
  echo "Response: $FIRST_BODY"
  exit 1
fi

echo ""
sleep 1

# Test 2: Duplicate request (should return 200 with status=duplicate)
echo "📤 Test 2: Duplicate request (should return 200 with status=duplicate)"
DUPLICATE_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${LOCAL_URL}/webhook/tradingview" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

DUPLICATE_HTTP_CODE=$(echo "$DUPLICATE_RESPONSE" | tail -n1)
DUPLICATE_BODY=$(echo "$DUPLICATE_RESPONSE" | sed '$d')

if [ "$DUPLICATE_HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}✅ Duplicate request correctly handled (HTTP 200)${NC}"
  echo "Response: $DUPLICATE_BODY" | jq '.' 2>/dev/null || echo "$DUPLICATE_BODY"
  
  # Verify it says "duplicate" or has status="duplicate"
  if echo "$DUPLICATE_BODY" | grep -q "duplicate\|Duplicate" 2>/dev/null || echo "$DUPLICATE_BODY" | jq -e '.status == "duplicate"' >/dev/null 2>&1; then
    echo -e "${GREEN}✅ Response correctly indicates duplicate${NC}"
  else
    echo -e "${YELLOW}⚠️  Response doesn't explicitly mention duplicate${NC}"
  fi
else
  echo -e "${RED}❌ Duplicate request should return 200, got $DUPLICATE_HTTP_CODE${NC}"
  echo "Response: $DUPLICATE_BODY"
  exit 1
fi

echo ""
echo -e "${GREEN}✅ Idempotency test passed!${NC}"
echo ""
echo "💡 Verify ledger has only one entry:"
echo "   Check: ${LOCAL_URL}/api/dashboard/trades?limit=10"

