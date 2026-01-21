#!/bin/bash

# Check and kill process on port 3014

PORT=3014
PID=$(lsof -ti:$PORT 2>/dev/null)

if [ -z "$PID" ]; then
    echo "✅ Port $PORT is free"
    exit 0
else
    echo "⚠️  Port $PORT is in use by PID: $PID"
    echo "🛑 Killing process..."
    kill -9 "$PID" 2>/dev/null
    sleep 1
    
    # Verify it's killed
    if lsof -ti:$PORT >/dev/null 2>&1; then
        echo "❌ Failed to kill process on port $PORT"
        exit 1
    else
        echo "✅ Port $PORT is now free"
        exit 0
    fi
fi


