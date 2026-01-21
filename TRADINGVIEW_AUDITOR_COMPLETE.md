# ✅ TradingView Connection Auditor - Implementation Complete

## What Was Built

### 1. **Telemetry Service** (`backend/services/tradingViewTelemetry.js`)
- Tracks every webhook receive (200, 400, 401, 409)
- Records authentication method (HMAC, body_secret, none)
- Stores webhook metadata (symbol, action, alert_id)
- Persists atomically to `data/telemetry/last_tradingview_webhook.json`
- **No secrets are logged or persisted**

### 2. **API Endpoints**
- `GET /api/tradingview/telemetry` - Last webhook telemetry
- `GET /api/tradingview/connection` - Connection status with recommendations

### 3. **Connection Check Script** (`scripts/check_tradingview_connection.sh`)
- Checks server health
- Detects ngrok URL
- Validates URL configuration
- Checks last webhook age
- Provides actionable recommendations
- Prints exact text to paste into TradingView

### 4. **Integration**
- Telemetry recording in webhook auth middleware
- Telemetry recording in validation middleware
- Telemetry recording in main webhook handler
- Telemetry initialization on server startup

## How to Use

### Daily Check

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./scripts/check_tradingview_connection.sh
```

### Check Telemetry

```bash
curl http://localhost:3014/api/tradingview/telemetry | jq
```

### Check Connection Status

```bash
curl http://localhost:3014/api/tradingview/connection | jq
```

## Configuration

Add to `.env`:

```bash
# Expected public webhook URL (for drift detection)
TRADINGVIEW_PUBLIC_WEBHOOK_URL=https://xxxx.ngrok-free.app

# Optional: Webhook age threshold (seconds, default: 3600 = 1 hour)
TRADINGVIEW_WEBHOOK_AGE_THRESHOLD=3600
```

## Sample Output

### Connection Check Script

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
   Last webhook: 2026-01-21T12:00:00Z
   Age: 2 minutes ago
   ✅ PASS - Recent webhook received

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Audit Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Passed: 3
Failed: 1
Warnings: 0

❌ FAIL - Issues detected. Review output above.
```

### Telemetry API Response

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

### Connection Status API Response

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

## Files Modified

1. **`backend/services/tradingViewTelemetry.js`** (NEW)
   - Telemetry service with atomic persistence

2. **`backend/middleware/webhookAuth.js`** (MODIFIED)
   - Records telemetry for auth failures (401)
   - Sets `req.authModeUsed` for successful auth

3. **`backend/middleware/webhookValidation.js`** (MODIFIED)
   - Records telemetry for validation failures (400)

4. **`simple_webhook_server.js`** (MODIFIED)
   - Imports telemetry service
   - Records telemetry in deduplication middleware (409)
   - Records telemetry in main handler (200)
   - Initializes telemetry on startup
   - Adds `/api/tradingview/telemetry` endpoint
   - Adds `/api/tradingview/connection` endpoint

5. **`scripts/check_tradingview_connection.sh`** (NEW)
   - Executable connection check script

6. **`TRADINGVIEW_ALERT_CONFIG.md`** (MODIFIED)
   - Added daily routine section
   - Added URL update instructions
   - Added body secret templates

7. **`TRADINGVIEW_CONNECTION_AUDITOR.md`** (NEW)
   - Complete documentation

## Security

✅ **No secrets are logged or persisted:**
- Body secrets are removed before telemetry storage
- Only authentication method is recorded
- Telemetry file contains no sensitive data

## Testing

### Test Telemetry Recording

1. Send a test webhook:
```bash
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: sha256=$(echo -n '{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-1","timestamp":1234567890}' | openssl dgst -sha256 -hmac "$TRADINGVIEW_WEBHOOK_SECRET" | awk '{print $2}')" \
  -d '{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-1","timestamp":1234567890}'
```

2. Check telemetry:
```bash
curl http://localhost:3014/api/tradingview/telemetry | jq
```

### Test Connection Check

```bash
./scripts/check_tradingview_connection.sh
```

## Acceptance Criteria ✅

- ✅ Running `./scripts/check_tradingview_connection.sh` gives actionable output
- ✅ Script catches ngrok URL drift
- ✅ `GET /api/tradingview/telemetry` shows last received alert details
- ✅ No secrets are logged or persisted
- ✅ Works on macOS zsh
- ✅ Atomic file writes prevent corruption
- ✅ Telemetry recorded for all webhook outcomes (200, 400, 401, 409)

## Next Steps

1. **Set environment variable:**
   ```bash
   echo "TRADINGVIEW_PUBLIC_WEBHOOK_URL=https://your-ngrok-url.ngrok-free.app" >> .env
   ```

2. **Run daily check:**
   ```bash
   ./scripts/check_tradingview_connection.sh
   ```

3. **Monitor telemetry:**
   ```bash
   curl http://localhost:3014/api/tradingview/telemetry | jq
   ```

---

**The system now prevents silent TradingView connection failures!** 🔍✅

