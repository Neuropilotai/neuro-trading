#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}🔒 Secret Scan (git tracked files only)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

command -v rg >/dev/null 2>&1 || { echo -e "${RED}❌ rg not found${NC}"; exit 1; }
command -v git >/dev/null 2>&1 || { echo -e "${RED}❌ git not found${NC}"; exit 1; }

# Always scan from repo root, even if launched from subdir
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo -e "${RED}❌ Not inside a git repo.${NC}"
  exit 1
fi
cd "$REPO_ROOT"

HITS=0

scan() {
  local label="$1"
  local pattern="$2"
  local found=0

  echo -e "${BLUE}🔍 ${label}${NC}"

  # Read tracked files line by line (no xargs, no ARG_MAX issues)
  while IFS= read -r file; do
    if [ -f "$file" ]; then
      # -S = smart case, -n = line numbers, show file path
      if rg -n -S --no-heading --color=never "$pattern" "$file" 2>/dev/null \
          | rg -n -S --no-heading --color=never -v 'YOUR_SECRET_HERE|\[CHANGE_ME\]|\[DEV_SECRET_PLACEHOLDER\]|\[YOUR_TRADINGVIEW_WEBHOOK_SECRET\]|your-secure-password|paper_trading|\$TRADINGVIEW_WEBHOOK_SECRET|\$SECRET|invalid_secret' 2>/dev/null \
          | sed "s|^|$file:|"; then
        found=1
        HITS=1
      fi
    fi
  done < <(git ls-files)

  # Always return 0 - HITS is updated when matches are found
  # The main script checks HITS at the end to determine exit code
  return 0
}

# 1) Generic hardcoded credential-like assignments
scan "Hardcoded key/token/password assignments" \
'(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*["'"'"'][^"'"'"']{8,}["'"'"']'

# 2) JSON secret fields with non-placeholder values
scan 'Hardcoded JSON secret fields ("secret": "...")' \
'"secret"\s*:\s*"[^"]{8,}"'

# 3) Private key blocks
scan "Private key blocks" \
'-----BEGIN (RSA|EC|OPENSSH|DSA)? ?PRIVATE KEY-----'

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "$HITS" -eq 0 ]; then
  echo -e "${GREEN}✅ No secret patterns detected in tracked files.${NC}"
  exit 0
else
  echo -e "${RED}❌ Potential secrets detected in tracked files. Review hits above.${NC}"
  exit 1
fi
