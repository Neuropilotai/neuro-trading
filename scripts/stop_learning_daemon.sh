#!/usr/bin/env bash
set -euo pipefail

# Stop Learning Daemon

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_ROOT/data/pids/learning.pid"

# Check for pm2
if command -v pm2 > /dev/null 2>&1; then
    if pm2 list | grep -q "learning-daemon"; then
        echo "🛑 Stopping learning daemon (pm2)..."
        pm2 stop learning-daemon
        pm2 delete learning-daemon
        pm2 save
        echo "✅ Learning daemon stopped"
    else
        echo "ℹ️  Learning daemon not running (pm2)"
    fi
else
    # Use PID file
    if [ -f "$PID_FILE" ]; then
        DAEMON_PID=$(cat "$PID_FILE")
        if ps -p "$DAEMON_PID" > /dev/null 2>&1; then
            echo "🛑 Stopping learning daemon (PID: $DAEMON_PID)..."
            kill "$DAEMON_PID" || true
            sleep 2
            
            # Force kill if still running
            if ps -p "$DAEMON_PID" > /dev/null 2>&1; then
                kill -9 "$DAEMON_PID" || true
            fi
            
            rm -f "$PID_FILE"
            echo "✅ Learning daemon stopped"
        else
            echo "ℹ️  Learning daemon not running (stale PID file)"
            rm -f "$PID_FILE"
        fi
    else
        echo "ℹ️  Learning daemon not running (no PID file)"
    fi
fi


