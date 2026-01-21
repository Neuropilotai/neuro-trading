#!/usr/bin/env bash
set -euo pipefail

# Daily maintenance: compact, prune, metrics, verify sync

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAINTENANCE_SCRIPT="$PROJECT_ROOT/backend/scripts/dailyMaintenance.js"

cd "$PROJECT_ROOT"

echo "🧹 Running daily maintenance..."
echo "==============================="

# Check environment
if [ "${ENABLE_GOOGLE_DRIVE_SYNC:-false}" != "true" ]; then
    echo "⚠️  WARN: Google Drive sync disabled, skipping sync verification"
fi

# Run maintenance with timeout (15 minutes)
if timeout 900 node "$MAINTENANCE_SCRIPT"; then
    echo ""
    echo "✅ PASS: Daily maintenance completed"
    exit 0
else
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo ""
        echo "❌ FAIL: Maintenance timed out (15 minutes)"
    else
        echo ""
        echo "❌ FAIL: Maintenance failed (exit code: $EXIT_CODE)"
    fi
    exit 1
fi


