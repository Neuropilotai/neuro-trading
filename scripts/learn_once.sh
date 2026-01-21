#!/usr/bin/env bash
set -euo pipefail

# Run one incremental learning cycle

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ONCE_SCRIPT="$PROJECT_ROOT/backend/scripts/runOnce.js"

cd "$PROJECT_ROOT"

echo "🔄 Running single learning cycle..."
echo "===================================="

# Check environment
if [ "${ENABLE_GOOGLE_DRIVE_SYNC:-false}" != "true" ]; then
    echo "⚠️  WARN: Google Drive sync disabled, using local cache only"
fi

# Run once script with timeout (10 minutes)
if timeout 600 node "$ONCE_SCRIPT"; then
    echo ""
    echo "✅ PASS: Learning cycle completed"
    exit 0
else
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo ""
        echo "❌ FAIL: Learning cycle timed out (10 minutes)"
    else
        echo ""
        echo "❌ FAIL: Learning cycle failed (exit code: $EXIT_CODE)"
    fi
    exit 1
fi


