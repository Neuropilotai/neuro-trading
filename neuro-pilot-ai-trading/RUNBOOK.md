# TradingView Webhook Server - Runbook

## ⚠️ Important: Trading Folder is the Source of Truth

**The trading server MUST be run from the `neuro-pilot-ai-trading/` folder.**

- The `.env` file in this folder is explicitly loaded (not from parent repo)
- The parent repo's `simple_webhook_server.js` is deprecated and will exit if executed
- Always `cd neuro-pilot-ai-trading` before running any commands

## Local Setup

### 1. Prerequisites
- Node.js 20+ installed
- npm installed
- SQLite3 (usually bundled with Node.js)

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
```bash
# Copy environment template
cp ENV_EXAMPLE.txt .env

# Edit .env and set required variables:
# - TRADINGVIEW_WEBHOOK_SECRET (required if ENABLE_WEBHOOK_AUTH=true)
# - BROKER_TYPE (required, e.g., "paper")
# - LEDGER_DB_PATH (required in production, optional in dev)
```

### 4. Validate Configuration
```bash
# Check environment variables
npm run test:env
```

### 5. Start Server
```bash
# Production mode
npm start

# Development mode (with additional logging)
npm run dev
```

### 6. Verify Health
```bash
curl http://localhost:3001/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-01-21T...",
  "port": 3001,
  "features": {
    "auth": true,
    "validation": true,
    "deduplication": true,
    "riskEngine": true,
    "tradeLedger": true
  }
}
```

## Setting TRADINGVIEW_WEBHOOK_SECRET

### Option 1: HMAC Signature (Recommended)
1. Generate a strong secret:
   ```bash
   openssl rand -hex 32
   ```
2. Set in `.env`:
   ```
   TRADINGVIEW_WEBHOOK_SECRET=YOUR_SECRET_HERE
   ```
3. In TradingView alert, configure webhook with HMAC signature header

### Option 2: Body Secret (Fallback)
1. Set in `.env`:
   ```
   TRADINGVIEW_WEBHOOK_SECRET=YOUR_SECRET_HERE
   ```
2. In TradingView alert message, include:
   ```json
   {
     "secret": "YOUR_SECRET_HERE",
     "symbol": "{{ticker}}",
     "action": "BUY",
     ...
   }
   ```

## Testing Webhook

### 1. Test with curl (HMAC)
```bash
# Generate HMAC signature
SECRET="YOUR_SECRET_HERE"
PAYLOAD='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"alert_id":"test-001","timestamp":1234567890}'
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

# Send webhook
curl -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: $SIGNATURE" \
  -d "$PAYLOAD"
```

### 2. Test with curl (Body Secret)
```bash
curl -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "YOUR_SECRET_HERE",
    "symbol": "BTCUSDT",
    "action": "BUY",
    "price": 50000,
    "quantity": 0.1,
    "alert_id": "test-001",
    "timestamp": 1234567890
  }'
```

### 3. Test with Automated Script (Body Secret)
```bash
# Load .env first (if not already loaded)
export $(cat .env | grep -v '^#' | xargs)

# Run test script (never prints secret)
./scripts/test-webhook-body-secret.sh
```

### 4. Verify Ledger Entry
```bash
# Check ledger database
sqlite3 ./data/ledger.sqlite "SELECT * FROM trades ORDER BY created_at DESC LIMIT 1;"
```

Or use the API:
```bash
curl http://localhost:3001/api/dashboard/trades?limit=1
```

## Symbol-Specific Policies (XAUUSD)

The system supports symbol-specific risk policies to handle different asset classes safely. XAUUSD (Gold) has conservative defaults to avoid overtrading and volatility traps.

### XAUUSD Policy Configuration

XAUUSD uses the following conservative risk settings:
- **maxRiskPctPerTrade**: 0.25% (0.0025) - Lower than default 0.5%
- **maxTradesPerDay**: 5 - Limited to prevent overtrading
- **cooldownMs**: 15 minutes (900000ms) - Longer cooldown for gold volatility
- **maxPositionSizePercent**: 25% - Same as default

These policies are defined in `backend/config/symbolPolicies.js` and can be customized per symbol.

### Running XAUUSD Smoke Test

A complete end-to-end smoke test is available for XAUUSD:

```bash
# Run XAUUSD smoke test
./scripts/smoke-xauusd-local.sh
```

This test:
1. Starts the server with proper environment variables
2. Waits for `/health` endpoint to be ready
3. Sends a test XAUUSD webhook payload
4. Verifies the trade appears in `/api/dashboard/trades`
5. Tests idempotency by sending the same payload again
6. Cleans up and prints a summary

**Environment Variables Used:**
- `NODE_ENV=development`
- `ENABLE_TRADE_LEDGER=true`
- `LEDGER_DB_PATH=/Users/davidmikulis/neuro-pilot-ai-data/ledger.sqlite`
- `ENABLE_WEBHOOK_AUTH=false` (for local testing)
- `ENABLE_WEBHOOK_DEDUPE=true`
- `ENABLE_WEBHOOK_VALIDATION=true`
- `ENABLE_RISK_ENGINE=true`
- `ENABLE_PAPER_TRADING=true`
- `TRADING_ENABLED=false` (paper trading only)

### Testing XAUUSD Manually

```bash
# Send XAUUSD test webhook
curl -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d @scripts/test-webhook-xauusd.json
```

Or update the timestamp in the payload:
```bash
# Update timestamp to current time
TIMESTAMP=$(date +%s)000
jq --arg ts "$TIMESTAMP" '.timestamp = ($ts | tonumber)' scripts/test-webhook-xauusd.json | \
  curl -X POST http://localhost:3001/webhook/tradingview \
    -H "Content-Type: application/json" \
    -d @-
```

### Enabling Webhook Auth After Local Test

After local testing, enable authentication:

```bash
export ENABLE_WEBHOOK_AUTH=true
export TRADINGVIEW_WEBHOOK_SECRET=YOUR_SECRET_HERE
```

Then restart the server and include the HMAC signature in your TradingView webhook configuration.

### Adding New Symbol Policies

To add policies for other symbols, edit `backend/config/symbolPolicies.js`:

```javascript
const SYMBOL_POLICIES = {
  'XAUUSD': {
    maxRiskPctPerTrade: 0.0025,
    maxTradesPerDay: 5,
    cooldownMs: 900000,
    maxPositionSizePercent: 25.0
  },
  'YOUR_SYMBOL': {
    maxRiskPctPerTrade: 0.005,  // 0.5%
    maxTradesPerDay: 10,
    cooldownMs: 180000,  // 3 minutes
    maxPositionSizePercent: 25.0
  }
};
```

Symbols not in the policy map will use the default policy (0.5% risk, 10 trades/day, 3min cooldown).

## Smoke Tests

### Run All Smoke Tests
```bash
# Run all smoke tests (env + ledger)
npm run test:smoke

# Or run individually:
npm run test:env      # Environment check
npm run test:ledger   # Ledger integrity test

# Or use the bash script:
./scripts/smoke.sh

# Full smoke test checklist
# See SMOKE_TEST_CHECKLIST.md
```

### Manual Smoke Test
1. **Syntax Check**: `node --check simple_webhook_server.js`
2. **Start Server**: `npm start`
3. **Health Check**: `curl http://localhost:3001/health`
4. **Send Test Webhook**: Use curl commands above
5. **Verify Ledger**: Check database or API
6. **Stop Server**: `Ctrl+C` (graceful shutdown)

## Common Failure Modes

### 1. Missing Environment Variables
**Symptom**: Server exits with "Missing required environment variables"
**Fix**: 
- Run `npm run test:env` to see what's missing
- Copy from `ENV_EXAMPLE.txt` to `.env`
- Set required variables

### 2. Webhook Authentication Fails
**Symptom**: 401 Unauthorized response
**Fix**:
- Verify `TRADINGVIEW_WEBHOOK_SECRET` matches TradingView configuration
- Check HMAC signature calculation
- Or use body secret method

### 3. Ledger Write Fails
**Symptom**: 503 Service Unavailable, "LEDGER_WRITE_FAILED"
**Fix**:
- Check `LEDGER_DB_PATH` is writable
- Ensure directory exists: `mkdir -p ./data`
- Check disk space
- Verify SQLite3 is installed

### 4. Rate Limit Exceeded
**Symptom**: 429 Too Many Requests
**Fix**:
- Wait 1 minute (rate limit window)
- Or increase `WEBHOOK_RATE_LIMIT` in `.env`

### 5. Request Too Large
**Symptom**: 413 Payload Too Large
**Fix**:
- Reduce webhook payload size
- Or increase `WEBHOOK_MAX_BODY_SIZE` in `.env` (default: 1MB)

### 6. Broker Connection Fails
**Symptom**: Broker health check fails
**Fix**:
- For paper broker: Usually works out of the box
- For live brokers: Check API keys, network connectivity
- Verify `BROKER_TYPE` is correct

## Production Deployment

### 1. Environment Variables
- Set `NODE_ENV=production`
- Set `LEDGER_DB_PATH` (required, no default in production)
- Use strong `TRADINGVIEW_WEBHOOK_SECRET`
- Set `CORS_ORIGIN` to your domain (not `*`)

### 2. Process Management
Use PM2 or systemd:
```bash
# PM2 example
pm2 start simple_webhook_server.js --name tradingview-webhook
pm2 save
```

### 3. Monitoring
- Monitor `/health` endpoint
- Check logs for errors
- Monitor ledger database size
- Set up alerts for 5xx responses

### 4. Backup
- Backup ledger database regularly
- Store backups off-server
- Test restore procedure

## Troubleshooting

### View Logs
```bash
# If using PM2
pm2 logs tradingview-webhook

# If running directly
# Logs go to stdout/stderr
```

### Check Ledger Integrity
```bash
# Run ledger smoke test
npm run test:ledger

# Query ledger directly
sqlite3 ./data/ledger.sqlite "SELECT COUNT(*) FROM trades;"

# Verify ledger has rows
sqlite3 ./data/ledger.sqlite "SELECT COUNT(*) FROM trades;"
```

### Test Configuration
```bash
# Validate environment
npm run test:env

# Check server health
curl http://localhost:3001/health
```

## Security Checklist

- [ ] `TRADINGVIEW_WEBHOOK_SECRET` is strong (32+ characters)
- [ ] `.env` file is not committed to git
- [ ] `CORS_ORIGIN` is set to specific domain (not `*`) in production
- [ ] `ENABLE_WEBHOOK_AUTH=true` in production
- [ ] `ENABLE_WEBHOOK_VALIDATION=true` in production
- [ ] Rate limiting is enabled
- [ ] Request size limit is set appropriately
- [ ] Ledger database is backed up regularly

