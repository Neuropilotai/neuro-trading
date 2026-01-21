#!/usr/bin/env bash
set -euo pipefail

# Check Learning Daemon Status

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_ROOT/data/pids/learning.pid"

echo "📊 Learning Daemon Status"
echo "========================="

# Check for pm2
if command -v pm2 > /dev/null 2>&1; then
    if pm2 list | grep -q "learning-daemon"; then
        echo "✅ Status: RUNNING (pm2)"
        pm2 info learning-daemon | grep -E "(status|pid|uptime|memory)" || true
    else
        echo "❌ Status: NOT RUNNING (pm2)"
    fi
else
    # Check PID file
    if [ -f "$PID_FILE" ]; then
        DAEMON_PID=$(cat "$PID_FILE")
        if ps -p "$DAEMON_PID" > /dev/null 2>&1; then
            echo "✅ Status: RUNNING (PID: $DAEMON_PID)"
            ps -p "$DAEMON_PID" -o pid,etime,command | tail -1 || true
        else
            echo "❌ Status: NOT RUNNING (stale PID file)"
        fi
    else
        echo "❌ Status: NOT RUNNING (no PID file)"
    fi
fi

echo ""
echo "📋 Health Check:"
if curl -s http://localhost:3014/learn/health > /dev/null 2>&1; then
    curl -s http://localhost:3014/learn/health | jq '.' 2>/dev/null || curl -s http://localhost:3014/learn/health
else
    echo "⚠️  Health endpoint not available (server may not be running)"
fi


