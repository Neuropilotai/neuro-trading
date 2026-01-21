# Automated Testing - Quick Start

## 🚀 Step-by-Step Instructions

### Step 1: Install Dependencies

Open a terminal and run:

```bash
cd /Users/davidmikulis/neuro-pilot-ai
npm install express-rate-limit sqlite3
```

**Expected output:** Packages install successfully

---

### Step 2: Set Environment Variable

Generate and set the webhook secret:

```bash
# Generate a secure secret
export TRADINGVIEW_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Verify it's set
echo "Secret: $TRADINGVIEW_WEBHOOK_SECRET"

# Add to .env file (optional, for persistence)
echo "TRADINGVIEW_WEBHOOK_SECRET=$TRADINGVIEW_WEBHOOK_SECRET" >> .env
```

**Or add to your `.env` file manually:**
```bash
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
```

---

### Step 3: Start the Server

**In Terminal 1**, start the webhook server:

```bash
cd /Users/davidmikulis/neuro-pilot-ai
node simple_webhook_server.js
```

**Expected output:**
```
🎯 Secure TradingView Webhook Server started on port 3014
📡 TradingView webhook URL: http://localhost:3014/webhook/tradingview
🏥 Health check: http://localhost:3014/health
✅ Ready to receive TradingView alerts!
```

**Keep this terminal open!** The server must be running for tests to work.

---

### Step 4: Run Automated Tests

**In Terminal 2** (new terminal window), run the test script:

```bash
cd /Users/davidmikulis/neuro-pilot-ai

# Make sure the secret is set
export TRADINGVIEW_WEBHOOK_SECRET=$(grep TRADINGVIEW_WEBHOOK_SECRET .env | cut -d'=' -f2 || echo "test-secret-$(date +%s)")

# Run the guided test script
./start_testing.sh
```

**Or run the test suite directly:**
```bash
export TRADINGVIEW_WEBHOOK_SECRET=$(grep TRADINGVIEW_WEBHOOK_SECRET .env | cut -d'=' -f2 || echo "test-secret-$(date +%s)")
./test_system.sh
```

---

## 📊 What the Tests Check

The automated test suite verifies:

1. ✅ **Health Check** - Server is running
2. ✅ **Account Summary** - Account API works
3. ✅ **Authentication** - Invalid signatures rejected (401)
4. ✅ **Validation** - Missing fields rejected (400)
5. ✅ **Valid Request** - Correct requests execute (200)
6. ✅ **Deduplication** - Duplicate alerts rejected (409)
7. ✅ **Paper Trading** - Orders execute and update account

---

## 🎯 Expected Test Results

### Successful Test Run:

```
🧪 Trading System Test Suite
============================
Base URL: http://localhost:3014
Secret: abc123...

1️⃣  Health Check
Testing: Health Check... ✅ PASS (Status: 200)

2️⃣  Account Summary
Testing: Account Summary... ✅ PASS (Status: 200)

3️⃣  Authentication Tests
Testing: Invalid Signature... ✅ PASS (Status: 401)
Testing: Missing Signature... ✅ PASS (Status: 401)

4️⃣  Valid Request Test
Testing: Valid Request with Signature... ✅ PASS (Status: 200)

5️⃣  Validation Tests
Testing: Missing Required Field (symbol)... ✅ PASS (Status: 400)

6️⃣  Deduplication Test
Testing: First Request (should pass)... ✅ PASS (Status: 200)
Testing: Duplicate Request (should fail)... ✅ PASS (Status: 409)

============================
Test Summary
============================
Passed: 8
Failed: 0

✅ All tests passed!
```

---

## 🐛 Troubleshooting

### Test fails: "Connection refused"
- **Problem:** Server not running
- **Solution:** Start server in Terminal 1: `node simple_webhook_server.js`

### Test fails: "401 Unauthorized" on valid request
- **Problem:** Secret mismatch
- **Solution:** Ensure `TRADINGVIEW_WEBHOOK_SECRET` is set correctly in both terminals

### Test fails: "Module not found"
- **Problem:** Dependencies not installed
- **Solution:** Run `npm install express-rate-limit sqlite3`

### Test fails: "Port already in use"
- **Problem:** Another process using port 3014
- **Solution:** 
  ```bash
  lsof -i :3014  # Find process
  kill <PID>     # Kill it
  ```

---

## ✅ After Tests Pass

Once all tests pass:

1. **Verify account updated:**
   ```bash
   curl http://localhost:3014/api/account | jq '.'
   ```

2. **Check trade ledger:**
   ```bash
   sqlite3 ./data/trade_ledger.db "SELECT * FROM trades ORDER BY created_at DESC LIMIT 5;"
   ```

3. **Generate daily report:**
   ```bash
   node backend/scripts/dailyReport.js
   ```

4. **Review test results:**
   - All tests should show ✅ PASS
   - No errors in server logs
   - Account balance should reflect executed trades

---

## 🎉 Success!

If all tests pass, your trading system is:
- ✅ Securely receiving alerts
- ✅ Validating and deduplicating
- ✅ Enforcing risk limits
- ✅ Executing paper trades
- ✅ Persisting to ledger
- ✅ Ready for production testing!

---

**Ready to test?** Follow the steps above, starting with Step 1!



