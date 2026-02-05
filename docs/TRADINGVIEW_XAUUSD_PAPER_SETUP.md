# TradingView XAUUSD Paper Trading Setup Guide

Complete guide for setting up paper trading with XAUUSD using OANDA practice account and TradingView webhooks.

## 📋 Prerequisites

- Node.js 18+ installed
- OANDA practice account (optional, for OANDA_PRACTICE_EXECUTION=true)
- TradingView account with Pro/Pro+ plan (for webhooks)
- ngrok or similar tunnel service (for local testing)

## 🚀 Quick Start

### 1. Environment Setup

Copy `TRADING_ENV.example` to `.env` and configure:

```bash
# Required
TRADINGVIEW_WEBHOOK_SECRET=your-secret-here
TRADING_MODE=paper
TRADING_ENABLED=true

# OANDA (optional, for practice execution)
OANDA_ENV=practice
OANDA_API_TOKEN=your-token-here
OANDA_ACCOUNT_ID=your-account-id-here
OANDA_PRACTICE_EXECUTION=false  # Set to true to also send to OANDA practice API

# Symbol allowlist (recommended for production)
ALLOWED_SYMBOLS=XAUUSD

# Cooldown protection
COOLDOWN_SECONDS=180  # 3 minutes between same symbol+action
```

### 2. Start Server

```bash
npm install  # If first time
node simple_webhook_server.js
```

Server starts on port 3014 (configurable via `PORT`).

### 3. Expose Webhook (Local Testing)

Using ngrok:

```bash
ngrok http 3014
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok-free.app`).

### 4. Configure TradingView Alert

1. Open TradingView chart for XAUUSD
2. Create alert with these settings:
   - **Condition:** Your strategy condition
   - **Webhook URL:** `https://your-ngrok-url.ngrok-free.app/webhook/tradingview`
   - **Message (JSON):**

```json
{
  "symbol": "XAUUSD",
  "action": "{{strategy.order.action}}",
  "price": {{close}},
  "quantity": 0.01,
  "alert_id": "{{ticker}}_{{time}}",
  "timestamp": {{time}},
  "stop_loss": {{strategy.order.stop_loss}},
  "take_profit": {{strategy.order.take_profit}},
  "secret": "your-secret-here"
}
```

**Important:**
- `action` must be `BUY` or `SELL`
- `quantity` is in lots/units (0.01 = 1 micro lot for XAUUSD)
- `stop_loss` and `take_profit` are required for XAUUSD (volatile instrument)
- `secret` must match `TRADINGVIEW_WEBHOOK_SECRET` in `.env`

## 🧪 Testing

### Smoke Test

Run the provided test script:

```bash
# Set your webhook secret
export WEBHOOK_SECRET=your-secret-here

# Run test
./scripts/test_webhook_xauusd.sh
```

This will:
1. Send a BUY order for XAUUSD
2. Send a SELL order to close the position
3. Verify both are accepted

### Test Idempotency

```bash
./scripts/test_duplicate_webhook.sh
```

This verifies that duplicate alerts return 200 OK with status=duplicate (so TradingView won't retry) and don't create duplicate ledger entries.

### Manual Testing

```bash
# Test BUY
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "XAUUSD",
    "action": "BUY",
    "price": 2650.50,
    "quantity": 0.01,
    "alert_id": "test_123",
    "timestamp": '$(date +%s)',
    "stop_loss": 2640.00,
    "take_profit": 2660.00,
    "secret": "your-secret-here"
  }'

# Check status
curl http://localhost:3014/api/status/trading | jq
```

## 📊 Monitoring

### Status Endpoint

```bash
GET /api/status/trading
```

Returns:
- `mode`: paper or live
- `trading_enabled`: boolean
- `risk_enabled`: boolean
- `oanda_configured`: boolean
- `last_webhook_timestamp`: ISO timestamp
- `open_positions_count`: number
- `ledger_path`: file path
- `last_error`: error message (if any)
- `cooldown`: cooldown guard stats

### Dashboard

Open in browser:
```
http://localhost:3014/trading_dashboard.html
```

Shows:
- Recent trades
- Open positions
- Account summary
- Daily PnL

### Health Check

```bash
GET /health
```

Returns comprehensive system health including broker status, risk engine stats, and feature flags.

## 🔒 Security Features

### 1. Webhook Authentication

Two methods supported:
- **HMAC Signature:** `X-TradingView-Signature` header
- **Body Secret:** `secret` field in JSON payload

Both must match `TRADINGVIEW_WEBHOOK_SECRET`.

### 2. Symbol Allowlist

Set `ALLOWED_SYMBOLS` to restrict which symbols can be traded:

```bash
ALLOWED_SYMBOLS=XAUUSD,GBPUSD
```

If empty, all symbols allowed (not recommended for production).

### 3. Cooldown Guard

Prevents spam by enforcing cooldown per symbol+action:

```bash
COOLDOWN_SECONDS=180  # 3 minutes
```

If same symbol+action is sent within cooldown period, returns 429 (Too Many Requests).

### 4. Idempotency

Duplicate alerts (same `alert_id`) return 200 OK with `status: "duplicate"` (so TradingView won't retry) and don't create duplicate ledger entries.

## 📝 Trade Flow

1. **Webhook Received** → Authentication & validation
2. **Deduplication Check** → Returns 200 with status=duplicate if duplicate (prevents TradingView retries)
3. **Cooldown Check** → Returns 429 if in cooldown
4. **Risk Engine** → Validates stop loss, position size, daily loss limits
5. **Ledger Write** → Append-only trade record (idempotent)
6. **Broker Execution** → Paper trading or OANDA practice
7. **Pattern Attribution** → On trade close, attributes to patterns (idempotent)

## 🐛 Common Issues

### Issue: "Invalid signature"

**Cause:** `TRADINGVIEW_WEBHOOK_SECRET` mismatch or missing.

**Fix:**
1. Verify `.env` has correct `TRADINGVIEW_WEBHOOK_SECRET`
2. Verify TradingView alert message includes `"secret": "your-secret"`
3. Or use HMAC signature header instead

### Issue: "Symbol not allowed"

**Cause:** Symbol not in `ALLOWED_SYMBOLS`.

**Fix:**
1. Add symbol to `ALLOWED_SYMBOLS` in `.env`
2. Or remove `ALLOWED_SYMBOLS` (not recommended)

### Issue: "Cooldown active"

**Cause:** Same symbol+action sent within `COOLDOWN_SECONDS`.

**Fix:**
1. Wait for cooldown to expire
2. Or adjust `COOLDOWN_SECONDS` in `.env`

### Issue: "Stop loss is required"

**Cause:** XAUUSD requires stop loss (volatile instrument).

**Fix:**
1. Include `stop_loss` in TradingView alert message
2. Or set `REQUIRE_STOP_LOSS=false` (not recommended for XAUUSD)

### Issue: OANDA execution fails

**Cause:** Invalid credentials or network issue.

**Fix:**
1. Verify `OANDA_API_TOKEN` and `OANDA_ACCOUNT_ID` are correct
2. Check `OANDA_ENV` is `practice` (not `live`)
3. If `OANDA_PRACTICE_EXECUTION=true`, paper trading continues even if OANDA fails

## 📚 Response Format

### Success (200)

```json
{
  "status": "success",
  "message": "Trade alert received and validated and executed",
  "trade_id": "TRADE_1234567890_abc123",
  "idempotency_key": "alert_test_123",
  "execution": {
    "executed": true,
    "tradeId": "TRADE_1234567890_abc123",
    "fillPrice": 2650.50,
    "filledQuantity": 0.01,
    "pnl": 0
  },
  "data": {
    "trade_id": "TRADE_1234567890_abc123",
    "symbol": "XAUUSD",
    "action": "BUY",
    "price": 2650.50,
    "quantity": 0.01,
    "status": "FILLED"
  }
}
```

### Duplicate (200 OK)

```json
{
  "ok": true,
  "status": "duplicate",
  "message": "Duplicate alert ignored (idempotency key alert_test_123)",
  "idempotencyKey": "alert_test_123"
}
```

**Note:** Returns 200 OK (not 409) so TradingView won't retry duplicate alerts.

### Cooldown (429)

```json
{
  "error": "Cooldown active",
  "message": "Cooldown active: 120s remaining for XAUUSD BUY",
  "remainingSeconds": 120
}
```

### Validation Error (400)

```json
{
  "error": "Validation failed",
  "message": "Invalid alert payload",
  "errors": [
    "Missing required field: stop_loss"
  ]
}
```

## 🎯 Next Steps

1. **Monitor Performance:** Check `/api/dashboard/trades` regularly
2. **Review Patterns:** Check `/api/patterns` for pattern attribution
3. **Adjust Risk Limits:** Tune `MAX_DAILY_LOSS_PERCENT`, `MAX_POSITION_SIZE_PERCENT`
4. **Enable OANDA Practice:** Set `OANDA_PRACTICE_EXECUTION=true` to test real API
5. **Go Live:** Set `TRADING_MODE=live` and `TRADING_LIVE_CONFIRM=true` (after thorough testing)

## 📖 Additional Resources

- [TradingView Alert Configuration](./TRADINGVIEW_ALERT_CONFIG.md)
- [Risk Management Guide](../backend/services/riskEngine.js)
- [Trade Ledger Documentation](../backend/db/tradeLedger.js)

