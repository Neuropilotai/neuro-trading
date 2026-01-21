# Testing Guide - Trading System

**Status:** Ready for Testing  
**Time Required:** ~10 minutes

---

## 📋 Pre-Test Checklist

Before testing, ensure:

- [ ] Node.js 20+ installed (`node -v`)
- [ ] Dependencies installed: `npm install express-rate-limit sqlite3`
- [ ] `.env` file configured with `TRADINGVIEW_WEBHOOK_SECRET`
- [ ] `data/` directory exists

---

## 🚀 Step-by-Step Testing

### Step 1: Install Dependencies

```bash
npm install express-rate-limit sqlite3
```

**Expected:** Packages install successfully

---

### Step 2: Configure Environment

Add to your `.env` file:

```bash
# Generate a secure secret
TRADINGVIEW_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Add to .env:
TRADINGVIEW_WEBHOOK_SECRET=your-generated-secret-here
ENABLE_WEBHOOK_AUTH=true
ENABLE_WEBHOOK_VALIDATION=true
ENABLE_WEBHOOK_DEDUPE=true
ENABLE_RISK_ENGINE=true
ENABLE_TRADE_LEDGER=true
ENABLE_PAPER_TRADING=true
TRADING_ENABLED=true
WEBHOOK_PORT=3014
ACCOUNT_BALANCE=100000
MAX_DAILY_LOSS_PERCENT=2.0
MAX_POSITION_SIZE_PERCENT=25.0
MAX_OPEN_POSITIONS=5
```

---

### Step 3: Start the Server

```bash
node simple_webhook_server.js
```

**Expected Output:**
```
🎯 Secure TradingView Webhook Server started on port 3014
📡 TradingView webhook URL: http://localhost:3014/webhook/tradingview
🏥 Health check: http://localhost:3014/health
✅ Ready to receive TradingView alerts!
```

**If errors occur:**
- Check Node.js version: `node -v` (needs 20+)
- Verify dependencies: `npm list express-rate-limit sqlite3`
- Check port availability: `lsof -i :3014`

---

### Step 4: Run Automated Tests

**Option A: Use the test script**
```bash
./test_system.sh
```

**Option B: Use the guided test script**
```bash
./start_testing.sh
```

**Option C: Manual testing (see below)**

---

## 🧪 Manual Test Cases

### Test 1: Health Check ✅

```bash
curl http://localhost:3014/health | jq '.'
```

**Expected:**
- Status: `200 OK`
- All features show `enabled: true`
- Account summary included

---

### Test 2: Account Summary ✅

```bash
curl http://localhost:3014/api/account | jq '.'
```

**Expected:**
- Status: `200 OK`
- Balance: `100000` (or configured amount)
- Open positions: `0` (initially)
- Total trades: `0` (initially)

---

### Test 3: Authentication - Invalid Signature ❌

```bash
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: sha256=invalid" \
  -d '{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"stop_loss":49000,"alert_id":"test-1","timestamp":1234567890}'
```

**Expected:**
- Status: `401 Unauthorized`
- Error message about invalid signature

---

### Test 4: Authentication - Missing Signature ❌

```bash
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"stop_loss":49000,"alert_id":"test-2","timestamp":1234567890}'
```

**Expected:**
- Status: `401 Unauthorized`
- Error message about missing signature

---

### Test 5: Validation - Missing Required Field ❌

```bash
# Generate valid signature for invalid payload
PAYLOAD='{"action":"BUY","price":50000}'
SECRET="your-secret-from-env"
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: sha256=$SIG" \
  -d "$PAYLOAD"
```

**Expected:**
- Status: `400 Bad Request`
- Error message about missing `symbol` field

---

### Test 6: Valid Request - Should Execute ✅

```bash
# Generate HMAC signature
PAYLOAD='{"symbol":"BTCUSDT","action":"BUY","price":50000,"quantity":0.1,"stop_loss":49000,"take_profit":51000,"alert_id":"test-valid-1","timestamp":1234567890}'
SECRET="your-secret-from-env"
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: sha256=$SIG" \
  -d "$PAYLOAD" | jq '.'
```

**Expected:**
- Status: `200 OK`
- `execution.executed: true`
- `trade_id` returned
- Account balance should decrease (check via `/api/account`)

---

### Test 7: Deduplication - Duplicate Alert ❌

```bash
# Send the same request again with same alert_id
curl -X POST http://localhost:3014/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-TradingView-Signature: sha256=$SIG" \
  -d "$PAYLOAD"
```

**Expected:**
- Status: `409 Conflict`
- Error message about duplicate alert

---

### Test 8: Risk Check - Kill Switch ❌

```bash
# Stop current server (Ctrl+C)
# Start with kill switch enabled
TRADING_ENABLED=false node simple_webhook_server.js

# In another terminal, send valid request
# (Use same PAYLOAD and SIG from Test 6)
```

**Expected:**
- Status: `503 Service Unavailable`
- Error message about trading disabled

---

### Test 9: Paper Trading Execution ✅

```bash
# After successful order (Test 6), check account
curl http://localhost:3014/api/account | jq '.'
```

**Expected:**
- Balance decreased by order cost
- Open positions: `1`
- Position details show BTCUSDT with quantity `0.1`

---

### Test 10: Trade Ledger ✅

```bash
# Check if trade was saved to database
sqlite3 ./data/trade_ledger.db "SELECT trade_id, symbol, action, quantity, price, status FROM trades ORDER BY created_at DESC LIMIT 5;"
```

**Expected:**
- Trade record exists
- Status: `FILLED`
- All fields populated correctly

---

### Test 11: Daily Report ✅

```bash
# Generate daily report
node backend/scripts/dailyReport.js
```

**Expected:**
- Report generated successfully
- File created: `TradingDrive/reports/daily_YYYY-MM-DD.json`
- Console shows summary with metrics

---

## ✅ Success Criteria

All tests pass when:

- [x] Health check returns 200 with all features enabled
- [x] Account summary returns 200 with balance info
- [x] Invalid requests are rejected (401, 400, 409, 503)
- [x] Valid requests execute successfully (200)
- [x] Trades are saved to ledger
- [x] Account balance updates after trades
- [x] Daily report generates successfully

---

## 🐛 Troubleshooting

### Server won't start
```bash
# Check Node.js
node -v  # Should be 20+

# Check dependencies
npm list express-rate-limit sqlite3

# Check port
lsof -i :3014
```

### Authentication always fails
- Verify `TRADINGVIEW_WEBHOOK_SECRET` in `.env`
- Check signature format: `sha256=<hash>`
- Ensure secret matches in test script

### Trades not executing
- Check `ENABLE_PAPER_TRADING=true`
- Verify `TRADING_ENABLED=true`
- Check risk limits (daily loss, position size)
- Ensure stop loss provided

### Database errors
```bash
# Ensure directory exists
mkdir -p data

# Check permissions
ls -la data/

# Verify SQLite3
sqlite3 --version
```

---

## 📊 Expected Test Results

| Test | Expected Status | Purpose |
|------|----------------|---------|
| Health Check | 200 | Verify server is running |
| Account Summary | 200 | Verify account service works |
| Invalid Signature | 401 | Test authentication |
| Missing Signature | 401 | Test authentication |
| Missing Field | 400 | Test validation |
| Valid Request | 200 | Test full flow |
| Duplicate Alert | 409 | Test deduplication |
| Kill Switch | 503 | Test risk engine |
| Account Update | 200 | Test paper trading |
| Trade Ledger | - | Test persistence |
| Daily Report | - | Test reporting |

---

## 🎯 Next Steps After Testing

Once all tests pass:

1. **Schedule daily reports:**
   ```bash
   # Add to crontab
   0 9 * * * cd /path/to/neuro-pilot-ai && node backend/scripts/dailyReport.js
   ```

2. **Connect TradingView:**
   - Configure TradingView alert with webhook URL
   - Set secret in TradingView alert settings
   - Test with real alerts

3. **Monitor:**
   - Check `/api/account` regularly
   - Review daily reports
   - Monitor server logs

4. **Track 2 (Optional):**
   - Implement broker adapters (OANDA/IBKR)
   - Add dashboard integration
   - Production deployment

---

**Ready to test!** Run `./start_testing.sh` for guided testing or follow manual tests above.



