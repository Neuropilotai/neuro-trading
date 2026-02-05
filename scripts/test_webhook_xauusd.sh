#!/bin/bash

# Smoke test script for XAUUSD webhook endpoint
# Tests paper trading flow: BUY then SELL

set -e

# Configuration
# Support both PORT (standard) and WEBHOOK_PORT (legacy) for consistency
PORT="${PORT:-${WEBHOOK_PORT:-3001}}"
LOCAL_URL="${LOCAL_URL:-http://localhost:${PORT}}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dev-xauusd-secret-123456}"
TIMESTAMP=$(date +%s)

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Testing XAUUSD Webhook Endpoint"
echo "=================================="
echo ""

# Test 1: BUY order
echo "📈 Test 1: BUY XAUUSD"
BUY_PAYLOAD=$(cat <<EOF
{
  "symbol": "XAUUSD",
  "action": "BUY",
  "price": 2650.50,
  "quantity": 0.01,
  "alert_id": "test_buy_${TIMESTAMP}",
  "timestamp": ${TIMESTAMP},
  "stop_loss": 2640.00,
  "take_profit": 2660.00,
  "webhook_secret": "${WEBHOOK_SECRET}"
}
EOF
)

BUY_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${LOCAL_URL}/webhook/tradingview" \
  -H "Content-Type: application/json" \
  -d "${BUY_PAYLOAD}")

BUY_HTTP_CODE=$(echo "$BUY_RESPONSE" | tail -n1)
BUY_BODY=$(echo "$BUY_RESPONSE" | sed '$d')

if [ "$BUY_HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}✅ BUY order accepted${NC}"
  echo "Response: $BUY_BODY" | jq '.' 2>/dev/null || echo "$BUY_BODY"
  
  # Extract trade_id for later use
  TRADE_ID=$(echo "$BUY_BODY" | jq -r '.trade_id' 2>/dev/null || echo "")
  echo "Trade ID: $TRADE_ID"
else
  echo -e "${RED}❌ BUY order failed (HTTP $BUY_HTTP_CODE)${NC}"
  echo "Response: $BUY_BODY"
  exit 1
fi

echo ""
sleep 2

# Test 2: SELL order (closes BUY)
echo "📉 Test 2: SELL XAUUSD (closes BUY)"
SELL_PAYLOAD=$(cat <<EOF
{
  "symbol": "XAUUSD",
  "action": "SELL",
  "price": 2655.00,
  "quantity": 0.01,
  "alert_id": "test_sell_${TIMESTAMP}",
  "timestamp": $(date +%s),
  "webhook_secret": "${WEBHOOK_SECRET}"
}
EOF
)

SELL_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${LOCAL_URL}/webhook/tradingview" \
  -H "Content-Type: application/json" \
  -d "${SELL_PAYLOAD}")

SELL_HTTP_CODE=$(echo "$SELL_RESPONSE" | tail -n1)
SELL_BODY=$(echo "$SELL_RESPONSE" | sed '$d')

if [ "$SELL_HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}✅ SELL order accepted${NC}"
  echo "Response: $SELL_BODY" | jq '.' 2>/dev/null || echo "$SELL_BODY"
else
  echo -e "${RED}❌ SELL order failed (HTTP $SELL_HTTP_CODE)${NC}"
  echo "Response: $SELL_BODY"
  exit 1
fi

echo ""
echo -e "${GREEN}✅ All tests passed!${NC}"
echo ""
echo "💡 Check trading status:"
echo "   curl ${LOCAL_URL}/api/status/trading | jq"

