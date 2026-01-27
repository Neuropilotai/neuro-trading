#!/usr/bin/env bash
set -euo pipefail

# NeuroPilot Trading System - Go Live Script
# Starts server, ngrok, and learning daemon with health checks

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PORT="${PORT:-${WEBHOOK_PORT:-3014}}"
LOCAL_URL="http://localhost:${PORT}"
NGROK_API="http://127.0.0.1:4040/api/tunnels"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}🚀 NeuroPilot Trading System - Go Live${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check .env exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file not found. Creating from .env.example if available...${NC}"
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${GREEN}✅ Created .env from .env.example${NC}"
        echo -e "${YELLOW}⚠️  Please configure .env with your credentials before continuing${NC}"
    else
        echo -e "${RED}❌ .env.example not found. Please create .env manually${NC}"
        exit 1
    fi
fi

# Load .env
set -a
source .env
set +a

# Check if server is already running
if lsof -ti:${PORT} > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Server already running on port ${PORT}${NC}"
    read -p "Kill existing server? (y/N): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        kill -9 $(lsof -ti:${PORT}) 2>/dev/null || true
        sleep 2
    else
        echo -e "${RED}❌ Cannot start: port ${PORT} in use${NC}"
        exit 1
    fi
fi

# 1. Start webhook server
echo -e "${BLUE}1️⃣  Starting webhook server...${NC}"
node simple_webhook_server.js > /tmp/neuropilot_server.log 2>&1 &
SERVER_PID=$!
sleep 3

# Check if server started
if ! ps -p $SERVER_PID > /dev/null 2>&1; then
    echo -e "${RED}❌ Server failed to start. Check /tmp/neuropilot_server.log${NC}"
    exit 1
fi

# Wait for health endpoint
echo -e "${BLUE}   Waiting for server to be healthy...${NC}"
for i in {1..10}; do
    if curl -sS --max-time 2 "${LOCAL_URL}/health" > /dev/null 2>&1; then
        echo -e "${GREEN}   ✅ Server is healthy${NC}"
        break
    fi
    if [ $i -eq 10 ]; then
        echo -e "${RED}   ❌ Server health check failed after 10 attempts${NC}"
        kill $SERVER_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

# 2. Start ngrok (if available)
echo ""
echo -e "${BLUE}2️⃣  Starting ngrok tunnel...${NC}"
if command -v ngrok > /dev/null 2>&1; then
    # Kill existing ngrok if running
    pkill -f "ngrok http ${PORT}" 2>/dev/null || true
    sleep 1
    
    ngrok http ${PORT} > /tmp/ngrok.log 2>&1 &
    NGROK_PID=$!
    sleep 3
    
    # Get ngrok URL
    WEBHOOK_URL=""
    for i in {1..10}; do
        NGROK_RESPONSE=$(curl -sS "${NGROK_API}" 2>/dev/null || echo "")
        if [ -n "$NGROK_RESPONSE" ]; then
            WEBHOOK_URL=$(echo "$NGROK_RESPONSE" | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
            if [ -n "$WEBHOOK_URL" ]; then
                break
            fi
        fi
        sleep 1
    done
    
    if [ -n "$WEBHOOK_URL" ]; then
        echo -e "${GREEN}   ✅ Ngrok tunnel active${NC}"
        echo -e "${BLUE}   Webhook URL: ${WEBHOOK_URL}/webhook/tradingview${NC}"
    else
        echo -e "${YELLOW}   ⚠️  Ngrok started but URL not available yet${NC}"
        echo -e "${BLUE}   Check: http://127.0.0.1:4040${NC}"
    fi
else
    echo -e "${YELLOW}   ⚠️  ngrok not found. Install: brew install ngrok/ngrok/ngrok${NC}"
    echo -e "${BLUE}   Using local URL: ${LOCAL_URL}/webhook/tradingview${NC}"
    WEBHOOK_URL="${LOCAL_URL}"
fi

# 3. Start learning daemon
echo ""
echo -e "${BLUE}3️⃣  Starting learning daemon...${NC}"
if [ -f "./scripts/start_learning_daemon.sh" ]; then
    ./scripts/start_learning_daemon.sh
    sleep 2
else
    echo -e "${YELLOW}   ⚠️  start_learning_daemon.sh not found${NC}"
fi

# 4. Health checks
echo ""
echo -e "${BLUE}4️⃣  Running health checks...${NC}"
echo ""

# Server health
if curl -sS --max-time 2 "${LOCAL_URL}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}   ✅ Server health: OK${NC}"
else
    echo -e "${RED}   ❌ Server health: FAILED${NC}"
fi

# Learning status
LEARN_STATUS=$(curl -sS --max-time 2 "${LOCAL_URL}/learn/status" 2>/dev/null || echo "")
if [ -n "$LEARN_STATUS" ]; then
    if command -v jq > /dev/null 2>&1; then
        DRIVE_ENABLED=$(echo "$LEARN_STATUS" | jq -r '.storage.googleDriveEnabled // false' 2>/dev/null || echo "false")
        DAEMON_RUNNING=$(echo "$LEARN_STATUS" | jq -r '.daemon.running // false' 2>/dev/null || echo "false")
        PATTERNS_TOTAL=$(echo "$LEARN_STATUS" | jq -r '.patterns.total // 0' 2>/dev/null || echo "0")
        
        if [ "$DAEMON_RUNNING" = "true" ]; then
            echo -e "${GREEN}   ✅ Learning daemon: RUNNING${NC}"
        else
            echo -e "${YELLOW}   ⚠️  Learning daemon: NOT RUNNING${NC}"
        fi
        
        if [ "$DRIVE_ENABLED" = "true" ]; then
            echo -e "${GREEN}   ✅ Google Drive: ENABLED${NC}"
        else
            echo -e "${YELLOW}   ⚠️  Google Drive: DISABLED${NC}"
        fi
        
        echo -e "${BLUE}   📊 Patterns: ${PATTERNS_TOTAL}${NC}"
    else
        echo -e "${GREEN}   ✅ Learning status: OK${NC}"
    fi
else
    echo -e "${YELLOW}   ⚠️  Learning status: Not available${NC}"
fi

# Storage status
STORAGE_STATUS=$(curl -sS --max-time 2 "${LOCAL_URL}/learn/storage/status" 2>/dev/null || echo "")
if [ -n "$STORAGE_STATUS" ]; then
    if command -v jq > /dev/null 2>&1; then
        STORAGE_CONNECTED=$(echo "$STORAGE_STATUS" | jq -r '.connected // false' 2>/dev/null || echo "false")
        if [ "$STORAGE_CONNECTED" = "true" ]; then
            echo -e "${GREEN}   ✅ Storage: CONNECTED${NC}"
        else
            echo -e "${YELLOW}   ⚠️  Storage: NOT CONNECTED${NC}"
        fi
    else
        echo -e "${GREEN}   ✅ Storage status: OK${NC}"
    fi
fi

# Summary
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✅ System is LIVE!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${BLUE}📊 Endpoints:${NC}"
echo -e "   Health: ${LOCAL_URL}/health"
echo -e "   Dashboard: ${LOCAL_URL}/trading_dashboard.html"
echo -e "   Learning Status: ${LOCAL_URL}/learn/status"
echo -e "   Storage Status: ${LOCAL_URL}/learn/storage/status"
echo -e "   Patterns Stats: ${LOCAL_URL}/api/patterns/stats"
echo ""
if [ -n "$WEBHOOK_URL" ] && [ "$WEBHOOK_URL" != "$LOCAL_URL" ]; then
    echo -e "${BLUE}🔗 TradingView Webhook URL:${NC}"
    echo -e "   ${WEBHOOK_URL}/webhook/tradingview"
    echo ""
fi
echo -e "${BLUE}📝 Logs:${NC}"
echo -e "   Server: /tmp/neuropilot_server.log"
echo -e "   Ngrok: /tmp/ngrok.log (or http://127.0.0.1:4040)"
echo -e "   Daemon: data/logs/daemon.log"
echo ""
echo -e "${BLUE}🛑 To stop:${NC}"
echo -e "   kill $SERVER_PID"
if [ -n "$NGROK_PID" ]; then
    echo -e "   kill $NGROK_PID"
fi
echo -e "   ./scripts/stop_learning_daemon.sh"
echo ""

