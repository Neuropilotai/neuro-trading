#!/usr/bin/env bash

# Get Public Webhook URL
# Outputs the current public webhook URL from ngrok (one line only)
#
# Usage:
#   ./scripts/get_public_webhook_url.sh
#   Output: https://xxxx.ngrok-free.app/webhook/tradingview
#
# Exit codes:
#   0: Success, URL printed
#   1: ngrok not running or URL not found

set -euo pipefail

NGROK_API="http://127.0.0.1:4040/api/tunnels"

# Check if ngrok API is accessible
NGROK_RESPONSE=$(curl -sS --max-time 3 --connect-timeout 2 "${NGROK_API}" 2>/dev/null || echo "")

if [ -z "$NGROK_RESPONSE" ]; then
    echo "ERROR: ngrok is not running. Start with: ./setup_ngrok.sh" >&2
    exit 1
fi

# Check if jq is available
HAS_JQ=false
if command -v jq &> /dev/null; then
    HAS_JQ=true
fi

# Extract public URL (prefer HTTPS)
if [ "$HAS_JQ" = true ]; then
    # Use jq to find HTTPS tunnel
    PUBLIC_URL=$(echo "$NGROK_RESPONSE" | jq -r '.tunnels[] | select(.proto == "https") | .public_url' 2>/dev/null | head -1 || echo "")
    
    # Fallback to HTTP if no HTTPS
    if [ -z "$PUBLIC_URL" ]; then
        PUBLIC_URL=$(echo "$NGROK_RESPONSE" | jq -r '.tunnels[0].public_url // empty' 2>/dev/null || echo "")
    fi
else
    # Fallback: grep/sed for HTTPS URL
    PUBLIC_URL=$(echo "$NGROK_RESPONSE" | grep -o '"public_url":"https://[^"]*"' | head -1 | sed 's/"public_url":"\(.*\)"/\1/' || echo "")
    
    # Fallback to HTTP if no HTTPS
    if [ -z "$PUBLIC_URL" ]; then
        PUBLIC_URL=$(echo "$NGROK_RESPONSE" | grep -o '"public_url":"http://[^"]*"' | head -1 | sed 's/"public_url":"\(.*\)"/\1/' || echo "")
    fi
fi

if [ -z "$PUBLIC_URL" ]; then
    echo "ERROR: Could not extract public URL from ngrok API" >&2
    exit 1
fi

# Append webhook path
WEBHOOK_URL="${PUBLIC_URL}/webhook/tradingview"

# Output only the URL (one line)
echo "$WEBHOOK_URL"


