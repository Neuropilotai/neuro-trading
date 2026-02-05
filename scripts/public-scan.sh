#!/usr/bin/env bash
set -euo pipefail
echo "🔎 Public scan..."
rg -n "TRADINGVIEW_WEBHOOK_SECRET|WEBHOOK_SECRET|api_key|token|password|ledger\.sqlite|/Volumes/" . && {
  echo "❌ Found suspicious patterns. Remove/replace before pushing."
  exit 1
} || true
echo "✅ Public scan OK"

