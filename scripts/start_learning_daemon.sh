#!/usr/bin/env bash
set -euo pipefail

# Start Learning Daemon
# Supports pm2 or nohup + PID file

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_SCRIPT="$PROJECT_ROOT/backend/services/learningDaemon.js"
PID_FILE="$PROJECT_ROOT/data/pids/learning.pid"
LOG_FILE="$PROJECT_ROOT/data/logs/daemon.log"

# Ensure directories exist
mkdir -p "$(dirname "$PID_FILE")"
mkdir -p "$(dirname "$LOG_FILE")"

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "⚠️  Learning daemon is already running (PID: $OLD_PID)"
        exit 1
    else
        # Stale PID file
        rm -f "$PID_FILE"
    fi
fi

# Check for pm2
if command -v pm2 > /dev/null 2>&1; then
    echo "✅ Using pm2 to start learning daemon"
    cd "$PROJECT_ROOT"
    pm2 start "$DAEMON_SCRIPT" --name "learning-daemon" --log "$LOG_FILE" --time
    pm2 save
    echo "✅ Learning daemon started with pm2"
    echo "   View logs: pm2 logs learning-daemon"
    echo "   Stop: pm2 stop learning-daemon"
else
    echo "✅ Using nohup to start learning daemon"
    cd "$PROJECT_ROOT"
    nohup node "$DAEMON_SCRIPT" >> "$LOG_FILE" 2>&1 &
    DAEMON_PID=$!
    echo "$DAEMON_PID" > "$PID_FILE"
    echo "✅ Learning daemon started (PID: $DAEMON_PID)"
    echo "   Logs: $LOG_FILE"
    echo "   PID file: $PID_FILE"
fi

echo ""
echo "📊 Check status: ./scripts/status_learning_daemon.sh"
echo "🛑 Stop daemon: ./scripts/stop_learning_daemon.sh"


