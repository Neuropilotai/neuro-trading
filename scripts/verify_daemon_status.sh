#!/usr/bin/env bash
set -euo pipefail

# Verify Daemon Status Script
# Tests that /learn/status accurately reports daemon running state

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
LOCAL_PORT="${PORT:-${WEBHOOK_PORT:-3014}}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"
STATUS_URL="${LOCAL_URL}/learn/status"
HEARTBEAT_FILE="${PROJECT_ROOT}/data/learning/heartbeat.json"
PID_FILE="${PROJECT_ROOT}/data/pids/learning.pid"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}🔍 Daemon Status Verification${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if server is running
if ! curl -sS --max-time 2 "${LOCAL_URL}/health" > /dev/null 2>&1; then
    echo -e "${RED}❌ Server is not running on ${LOCAL_URL}${NC}"
    echo "   Start server: node simple_webhook_server.js"
    exit 1
fi

# Check heartbeat file
echo -e "${BLUE}1️⃣  Checking heartbeat file...${NC}"
if [ -f "$HEARTBEAT_FILE" ]; then
    echo -e "${GREEN}   ✅ Heartbeat file exists${NC}"
    if command -v jq > /dev/null 2>&1; then
        HEARTBEAT_PID=$(jq -r '.pid // null' "$HEARTBEAT_FILE" 2>/dev/null || echo "null")
        HEARTBEAT_LAST_CYCLE=$(jq -r '.lastCycleAt // null' "$HEARTBEAT_FILE" 2>/dev/null || echo "null")
        echo -e "${BLUE}   PID: ${HEARTBEAT_PID}${NC}"
        echo -e "${BLUE}   Last Cycle: ${HEARTBEAT_LAST_CYCLE}${NC}"
    fi
else
    echo -e "${YELLOW}   ⚠️  Heartbeat file not found${NC}"
fi

# Check PID file
echo ""
echo -e "${BLUE}2️⃣  Checking PID file...${NC}"
if [ -f "$PID_FILE" ]; then
    PID_FROM_FILE=$(cat "$PID_FILE" 2>/dev/null | tr -d ' \n' || echo "")
    echo -e "${GREEN}   ✅ PID file exists: ${PID_FROM_FILE}${NC}"
    
    # Check if process is running
    if ps -p "$PID_FROM_FILE" > /dev/null 2>&1; then
        echo -e "${GREEN}   ✅ Process ${PID_FROM_FILE} is running${NC}"
    else
        echo -e "${RED}   ❌ Process ${PID_FROM_FILE} is NOT running (stale PID file)${NC}"
    fi
else
    echo -e "${YELLOW}   ⚠️  PID file not found${NC}"
fi

# Check /learn/status endpoint
echo ""
echo -e "${BLUE}3️⃣  Checking /learn/status endpoint...${NC}"
STATUS_RESPONSE=$(curl -sS --max-time 3 "${STATUS_URL}" 2>/dev/null || echo "")

if [ -z "$STATUS_RESPONSE" ]; then
    echo -e "${RED}   ❌ Failed to get status response${NC}"
    exit 1
fi

if command -v jq > /dev/null 2>&1; then
    DAEMON_RUNNING=$(echo "$STATUS_RESPONSE" | jq -r '.daemon.running // false' 2>/dev/null || echo "false")
    DAEMON_PID=$(echo "$STATUS_RESPONSE" | jq -r '.daemon.pid // null' 2>/dev/null || echo "null")
    LAST_CYCLE=$(echo "$STATUS_RESPONSE" | jq -r '.daemon.lastCycleAt // null' 2>/dev/null || echo "null")
    
    echo -e "${BLUE}   Response:${NC}"
    echo -e "   Running: ${DAEMON_RUNNING}"
    echo -e "   PID: ${DAEMON_PID}"
    echo -e "   Last Cycle: ${LAST_CYCLE}"
    
    # Validation
    echo ""
    echo -e "${BLUE}4️⃣  Validation...${NC}"
    
    if [ "$DAEMON_RUNNING" = "true" ]; then
        echo -e "${GREEN}   ✅ daemon.running = true${NC}"
    else
        echo -e "${RED}   ❌ daemon.running = false (expected true)${NC}"
    fi
    
    if [ "$LAST_CYCLE" != "null" ] && [ -n "$LAST_CYCLE" ]; then
        echo -e "${GREEN}   ✅ daemon.lastCycleAt is set: ${LAST_CYCLE}${NC}"
    else
        echo -e "${RED}   ❌ daemon.lastCycleAt is null (expected timestamp)${NC}"
    fi
    
    if [ "$DAEMON_PID" != "null" ] && [ -n "$DAEMON_PID" ]; then
        echo -e "${GREEN}   ✅ daemon.pid is set: ${DAEMON_PID}${NC}"
        
        # Verify PID is actually running
        if ps -p "$DAEMON_PID" > /dev/null 2>&1; then
            echo -e "${GREEN}   ✅ PID ${DAEMON_PID} is actually running${NC}"
        else
            echo -e "${RED}   ❌ PID ${DAEMON_PID} is NOT running (status mismatch)${NC}"
        fi
    else
        echo -e "${YELLOW}   ⚠️  daemon.pid is not set${NC}"
    fi
    
    # Summary
    echo ""
    if [ "$DAEMON_RUNNING" = "true" ] && [ "$LAST_CYCLE" != "null" ]; then
        echo -e "${GREEN}✅ PASS: Daemon status is accurate${NC}"
        exit 0
    else
        echo -e "${RED}❌ FAIL: Daemon status is inaccurate${NC}"
        echo ""
        echo -e "${BLUE}💡 Troubleshooting:${NC}"
        echo -e "   1. Check if daemon is running: ps aux | grep learningDaemon"
        echo -e "   2. Check heartbeat file: cat ${HEARTBEAT_FILE}"
        echo -e "   3. Check daemon logs: tail -f ${PROJECT_ROOT}/data/logs/daemon.log"
        echo -e "   4. Restart daemon: ./scripts/stop_learning_daemon.sh && ./scripts/start_learning_daemon.sh"
        exit 1
    fi
else
    echo -e "${YELLOW}   ⚠️  jq not installed, showing raw response:${NC}"
    echo "$STATUS_RESPONSE" | head -20
    echo -e "${BLUE}   Install jq: brew install jq${NC}"
fi

