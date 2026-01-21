# TradingView Connection Auditor & Drift Prevention

## Overview

The TradingView Connection Auditor prevents silent failures from ngrok URL changes or alert misconfiguration. It tracks webhook telemetry and provides actionable diagnostics.

## Features

### 1. **Webhook Telemetry**
- Tracks every webhook receive (successful or failed)
- Records authentication method used (HMAC, body_secret, none)
- Stores result (200, 400, 401, 409)
- Persists to `data/telemetry/last_tradingview_webhook.json`
- **No secrets are logged or persisted**

### 2. **Connection Status API**
- Server health check
- ngrok URL detection
- Expected URL from config
- URL mismatch detection
- Last webhook age
- Actionable recommendations

### 3. **Connection Check Script**
- Automated daily checks
- Detects ngrok URL drift
- Validates configuration
- Provides exact text to paste into TradingView

## Quick Start

### Run Connection Check

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./scripts/check_tradingview_connection.sh
```

### Check Telemetry via API

```bash
curl http://localhost:3014/api/tradingview/telemetry | jq
```

### Check Connection Status

```bash
curl http://localhost:3014/api/tradingview/connection | jq
```

## Configuration

### Environment Variable

Add to `.env`:

```bash
# Expected public webhook URL (for drift detection)
TRADINGVIEW_PUBLIC_WEBHOOK_URL=https://xxxx.ngrok-free.app

# Optional: Webhook age threshold (seconds, default: 3600 = 1 hour)
TRADINGVIEW_WEBHOOK_AGE_THRESHOLD=3600
```

## API Endpoints

### GET /api/tradingview/telemetry

Returns last webhook telemetry.

**Response:**
```json
{
  "success": true,
  "telemetry": {
    "receivedAt": "2026-01-21T12:00:00.000Z",
    "remoteIp": "127.0.0.1",
    "userAgent": "TradingView/1.0",
    "authModeUsed": "hmac",
    "result": "200",
    "httpStatus": 200,
    "alertId": "tv_1234567890",
    "symbol": "BTCUSDT",
    "action": "BUY",
    "idempotencyOutcome": "new",
    "ageSeconds": 120,
    "ageFormatted": "2 minutes ago"
  }
}
```

**404 if no webhooks received yet:**
```json
{
  "success": false,
  "error": "No webhook telemetry found",
  "message": "No webhooks have been received yet"
}
```

### GET /api/tradingview/connection

Returns connection status and recommendations.

**Response:**
```json
{
  "success": true,
  "connection": {
    "serverHealth": {
      "status": "healthy",
      "timestamp": "2026-01-21T12:00:00.000Z"
    },
    "ngrokDetectedUrl": "https://abc123.ngrok-free.app",
    "expectedPublicUrl": "https://xyz789.ngrok-free.app",
    "webhookEndpoint": "https://abc123.ngrok-free.app/webhook/tradingview",
    "urlMatch": false,
    "lastWebhook": {
      "receivedAt": "2026-01-21T12:00:00.000Z",
      "ageSeconds": 120,
      "ageFormatted": "2 minutes ago",
      "symbol": "BTCUSDT",
      "action": "BUY"
    },
    "recommendations": [
      "⚠️  URL mismatch detected! Expected: https://xyz789.ngrok-free.app, but ngrok shows: https://abc123.ngrok-free.app",
      "📋 Update TradingView alert webhook URL to: https://abc123.ngrok-free.app/webhook/tradingview"
    ]
  }
}
```

## Check Script Usage

### Basic Usage

```bash
./scripts/check_tradingview_connection.sh
```

### With Custom Age Threshold

```bash
TRADINGVIEW_WEBHOOK_AGE_THRESHOLD=7200 ./scripts/check_tradingview_connection.sh
```

### Sample Output

**✅ All Checks Pass:**
```
🔍 TradingView Connection Auditor
==================================

1️⃣  Server Health Check
   ✅ PASS - Server is healthy

2️⃣  ngrok Status Check
   ✅ PASS - ngrok is running
   Public URL: https://abc123.ngrok-free.app

3️⃣  URL Configuration Check
   Expected URL: https://abc123.ngrok-free.app
   ✅ PASS - URLs match

4️⃣  Last Webhook Telemetry
   Last webhook: 2026-01-21T12:00:00Z
   Age: 2 minutes ago
   ✅ PASS - Recent webhook received

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Audit Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Passed: 4
Failed: 0
Warnings: 0

✅ PASS - All checks passed
```

**❌ URL Mismatch Detected:**
```
🔍 TradingView Connection Auditor
==================================

1️⃣  Server Health Check
   ✅ PASS - Server is healthy

2️⃣  ngrok Status Check
   ✅ PASS - ngrok is running
   Public URL: https://abc123.ngrok-free.app

3️⃣  URL Configuration Check
   Expected URL: https://xyz789.ngrok-free.app
   ❌ FAIL - URL mismatch detected!
   
   📋 ACTION REQUIRED:
   Update TradingView alert webhook URL to:
   https://abc123.ngrok-free.app/webhook/tradingview

4️⃣  Last Webhook Telemetry
   Last webhook: 2026-01-21T10:00:00Z
   Age: 2 hours ago
   ❌ FAIL - Last webhook is older than threshold (3600s)
   Check TradingView alert configuration

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Audit Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Passed: 2
Failed: 2
Warnings: 0

❌ FAIL - Issues detected. Review output above.
```

## Daily Routine

### Recommended Workflow

1. **Morning Check:**
   ```bash
   ./scripts/check_tradingview_connection.sh
   ```

2. **If URL Changed:**
   - Copy new URL from script output
   - Update TradingView alerts (see below)
   - Update `.env` file with new URL
   - Re-run check script to verify

3. **Monitor Throughout Day:**
   ```bash
   # Quick telemetry check
   curl -s http://localhost:3014/api/tradingview/telemetry | jq '.telemetry.ageFormatted'
   ```

### Updating TradingView When URL Changes

1. **Get new URL from check script output**

2. **Update each alert in TradingView:**
   - Go to TradingView.com → Alerts (bell icon)
   - Find your alerts (🎯 Elite AI Long, 🎯 Elite AI Short)
   - Click "Edit" on each alert
   - Update "Webhook URL" field
   - Paste: `https://NEW-URL.ngrok-free.app/webhook/tradingview`
   - Click "Save"

3. **Verify:**
   ```bash
   ./scripts/check_tradingview_connection.sh
   ```

## Telemetry Data

### What's Tracked

- **receivedAt**: ISO timestamp of webhook
- **remoteIp**: Client IP address
- **userAgent**: User agent string
- **authModeUsed**: "hmac" | "body_secret" | "none"
- **result**: "200" | "400" | "401" | "409"
- **httpStatus**: HTTP status code
- **alertId**: TradingView alert ID
- **symbol**: Trading symbol
- **action**: BUY | SELL | CLOSE
- **idempotencyOutcome**: "new" | "duplicate"

### What's NOT Tracked

- ❌ Secrets (removed from body before storage)
- ❌ Raw request body
- ❌ Full payload data

## Troubleshooting

### Script Shows "ngrok not running"

**Solution:**
```bash
# Start ngrok
ngrok http 3014

# Or use setup script
./setup_ngrok.sh
```

### Script Shows "URL mismatch"

**Solution:**
1. Copy new ngrok URL from script output
2. Update TradingView alerts (see above)
3. Update `.env`:
   ```bash
   TRADINGVIEW_PUBLIC_WEBHOOK_URL=https://NEW-URL.ngrok-free.app
   ```
4. Re-run check script

### Script Shows "Last webhook too old"

**Possible causes:**
- TradingView alerts not triggering
- Webhook URL incorrect in TradingView
- ngrok URL changed but alerts not updated
- Server was down

**Solution:**
1. Check TradingView alerts are enabled
2. Verify webhook URL in TradingView matches ngrok
3. Test alert manually in TradingView
4. Check server logs for errors

### Telemetry API Returns 404

**Meaning:** No webhooks have been received yet.

**Solution:**
- This is normal if you just started the server
- Trigger a test alert from TradingView
- Check ngrok is running and URL is correct

## Security

### Secret Handling

- ✅ Secrets are **never logged**
- ✅ Secrets are **removed from body** before telemetry storage
- ✅ Only authentication method is recorded, not the secret value
- ✅ Telemetry file is readable only by server process

### File Permissions

Telemetry file is stored at:
```
data/telemetry/last_tradingview_webhook.json
```

Ensure proper permissions:
```bash
chmod 600 data/telemetry/last_tradingview_webhook.json
```

## Integration

### With Monitoring Systems

The connection check script can be integrated into:
- Cron jobs (daily checks)
- Monitoring systems (Nagios, Prometheus)
- CI/CD pipelines
- Health check endpoints

### Example Cron Job

```bash
# Add to crontab (crontab -e)
# Run daily at 9 AM
0 9 * * * cd /Users/davidmikulis/neuro-pilot-ai && ./scripts/check_tradingview_connection.sh >> /tmp/tradingview_audit.log 2>&1
```

## Files Created

- `backend/services/tradingViewTelemetry.js` - Telemetry service
- `scripts/check_tradingview_connection.sh` - Connection check script
- `data/telemetry/last_tradingview_webhook.json` - Telemetry storage (auto-created)

## API Endpoints Added

- `GET /api/tradingview/telemetry` - Last webhook telemetry
- `GET /api/tradingview/connection` - Connection status

## Environment Variables

- `TRADINGVIEW_PUBLIC_WEBHOOK_URL` - Expected public URL (for drift detection)
- `TRADINGVIEW_WEBHOOK_AGE_THRESHOLD` - Max age in seconds before warning (default: 3600)

---

**The connection auditor makes it impossible for TradingView to silently fail due to URL changes!** 🔍✅

