# Trading System Setup Guide

## Quick Start

### 1. Install Dependencies

```bash
npm install express-rate-limit sqlite3
```

### 2. Configure Environment Variables

Create or update your `.env` file:

```bash
# Required for webhook authentication
TRADINGVIEW_WEBHOOK_SECRET=your-secret-here

# Feature flags (all default to true)
ENABLE_WEBHOOK_AUTH=true
ENABLE_WEBHOOK_VALIDATION=true
ENABLE_WEBHOOK_DEDUPE=true
ENABLE_RISK_ENGINE=true
ENABLE_TRADE_LEDGER=true
TRADING_ENABLED=true

# Risk limits
MAX_DAILY_LOSS_PERCENT=2.0
MAX_POSITION_SIZE_PERCENT=25.0
MAX_OPEN_POSITIONS=5
REQUIRE_STOP_LOSS=true

# Server
WEBHOOK_PORT=3014
ACCOUNT_BALANCE=100000
```

### 3. Start the Webhook Server

```bash
node simple_webhook_server.js
```

### 4. Test the Server

```bash
# Health check
curl http://localhost:3014/health

# Run test suite
./test_webhook_fixes.sh
```

## TradingView Alert Configuration

In your TradingView Pine Script alert, use this webhook URL:

```
http://your-server:3014/webhook/tradingview
```

### Alert Message Format

```json
{
  "symbol": "{{ticker}}",
  "action": "BUY",
  "price": {{close}},
  "quantity": 0.1,
  "stop_loss": {{close}} * 0.98,
  "take_profit": {{close}} * 1.02,
  "confidence": 0.85,
  "alert_id": "{{time}}",
  "timestamp": {{time}}
}
```

### TradingView Alert Settings

1. **Condition:** Your Pine Script signal condition
2. **Webhook URL:** `http://your-server:3014/webhook/tradingview`
3. **Message:** JSON payload (see above)
4. **Secret:** Set in TradingView alert settings (must match `TRADINGVIEW_WEBHOOK_SECRET`)

## Feature Flags

All security and risk features can be toggled:

| Flag | Default | Description |
|------|---------|-------------|
| `ENABLE_WEBHOOK_AUTH` | `true` | HMAC signature verification |
| `ENABLE_WEBHOOK_VALIDATION` | `true` | Payload schema validation |
| `ENABLE_WEBHOOK_DEDUPE` | `true` | Alert deduplication |
| `ENABLE_RISK_ENGINE` | `true` | Risk management |
| `ENABLE_TRADE_LEDGER` | `true` | Immutable trade ledger |
| `TRADING_ENABLED` | `true` | Kill switch |

## Monitoring

### Health Check

```bash
curl http://localhost:3014/health
```

Returns:
- Feature status
- Risk engine stats
- Deduplication cache stats

### View Trades

Trades are saved to:
- **Database:** `./data/trade_ledger.db` (SQLite)
- **File:** `./TradingDrive/webhook_logs/trades.json` (backup)

Query trades:
```bash
sqlite3 ./data/trade_ledger.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 10;"
```

## Troubleshooting

### "Unauthorized" Error

- Check `TRADINGVIEW_WEBHOOK_SECRET` is set
- Verify TradingView alert secret matches
- Check `ENABLE_WEBHOOK_AUTH` is not `false`

### "Duplicate alert" Error

- Normal behavior for duplicate alerts
- Check `ENABLE_WEBHOOK_DEDUPE` if you want to disable
- Clear cache: `rm ./data/alert_cache.json`

### "Risk check failed" Error

- Check daily loss limit: `MAX_DAILY_LOSS_PERCENT`
- Check position size: `MAX_POSITION_SIZE_PERCENT`
- Check kill switch: `TRADING_ENABLED=true`
- Verify stop loss is provided if `REQUIRE_STOP_LOSS=true`

### Database Errors

- Ensure `./data/` directory exists
- Check file permissions
- Verify SQLite3 is installed

## Production Deployment

1. **Set strong secret:**
   ```bash
   export TRADINGVIEW_WEBHOOK_SECRET=$(openssl rand -hex 32)
   ```

2. **Configure risk limits:**
   - Adjust `MAX_DAILY_LOSS_PERCENT` based on your risk tolerance
   - Set `MAX_POSITION_SIZE_PERCENT` appropriately
   - Configure `MAX_OPEN_POSITIONS`

3. **Enable all features:**
   - All feature flags default to `true`
   - Only disable for testing/debugging

4. **Monitor logs:**
   - Check server logs for errors
   - Monitor health endpoint
   - Review trade ledger regularly

## Security Best Practices

1. **Never commit secrets to version control**
2. **Use environment variables or secrets management**
3. **Rotate `TRADINGVIEW_WEBHOOK_SECRET` regularly**
4. **Monitor for suspicious activity**
5. **Keep feature flags enabled in production**
6. **Use HTTPS in production (reverse proxy)**

## Next Steps

See `TRADING_SYSTEM_AUDIT_REPORT.md` for:
- Complete system analysis
- Finish plan (Track 1 & Track 2)
- Future enhancements (broker integration, dashboard, etc.)


