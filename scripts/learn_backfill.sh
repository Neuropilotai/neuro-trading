#!/usr/bin/env bash
set -euo pipefail

# Backfill historical data and run learning pass

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKFILL_SCRIPT="$PROJECT_ROOT/backend/scripts/backfillHistory.js"

cd "$PROJECT_ROOT"

echo "🔄 Starting backfill process..."
echo "================================"

# Check environment
if [ "${ENABLE_GOOGLE_DRIVE_SYNC:-false}" != "true" ]; then
    echo "⚠️  WARN: Google Drive sync disabled, using local cache only"
fi

# Run backfill script
if node "$BACKFILL_SCRIPT"; then
    echo ""
    echo "✅ PASS: Backfill completed successfully"
    echo ""
    echo "📊 Next steps:"
    echo "   1. Check patterns: curl http://localhost:3014/api/patterns/stats"
    echo "   2. Start daemon: ./scripts/start_learning_daemon.sh"
    exit 0
else
    echo ""
    echo "❌ FAIL: Backfill failed"
    exit 1
fi


