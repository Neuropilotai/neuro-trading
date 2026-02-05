#!/bin/bash
# Script pour créer la PR: sync-trading-main -> main

set -euo pipefail

# Hardening: s'assurer qu'on est à la racine du repo
cd "$(git rev-parse --show-toplevel)"

# Protection: nettoyer les fichiers accidentels avec le nom de la branche (seulement si vide)
BRANCH_NAME="sync-trading-main"
if [ -f "$BRANCH_NAME" ]; then
  if [ ! -s "$BRANCH_NAME" ]; then
    echo "⚠️  Found accidental EMPTY file: $BRANCH_NAME (removing...)"
    rm -f "$BRANCH_NAME"
    echo "✅ Cleaned up accidental file"
  else
    echo "❌ Refusing to remove non-empty file named $BRANCH_NAME (size > 0)."
    echo "   Please review it manually."
    exit 1
  fi
fi

echo "📦 Pushing $BRANCH_NAME to origin..."
git push origin "$BRANCH_NAME"

# Vérifier que gh est installé
command -v gh >/dev/null 2>&1 || { echo "❌ gh CLI not installed. Install it from: https://cli.github.com/"; exit 1; }

echo "🔍 Checking if PR already exists..."
if gh pr view "$BRANCH_NAME" --repo Neuropilotai/neuro-pilot-ai >/dev/null 2>&1; then
  echo "ℹ️  PR already exists for $BRANCH_NAME. Skipping creation."
else
  echo "🔍 Creating PR..."
  gh pr create \
    --base main \
    --head "$BRANCH_NAME" \
    --title "Fix pattern attribution idempotency + NULL profit_factor handling" \
    --body "This PR merges sync-trading-main into main.

Key changes:
- Idempotent trade ↔ pattern attribution to prevent double-counting
- Correct profit_factor calculation with NULL handling (no-loss scenarios)
- Improved pattern performance statistics (running mean)
- Full test coverage (mocha) with 100% passing
- Updated runbooks, audit reports, and TradingView integration guides

All tests passing locally.
No secrets detected (pre-push secret scan enforced)."

  echo "✅ PR created successfully!"
fi