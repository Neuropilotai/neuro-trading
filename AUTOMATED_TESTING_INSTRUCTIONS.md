# Automated Testing - Quick Instructions

## 🎯 Option 1: Fully Automated (Recommended)

### Single Command Setup & Test

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./setup_and_test.sh
```

**What it does:**
1. ✅ Checks Node.js version
2. ✅ Installs dependencies (express-rate-limit, sqlite3)
3. ✅ Creates data directory
4. ✅ Sets up environment variables
5. ✅ Checks if server is running
6. ✅ Runs all automated tests

**Note:** You'll need to start the server in a separate terminal if it's not already running.

---

## 🚀 Manual Steps (If Automated Script Doesn't Work)

### Terminal 1: Start Server

```bash
cd /Users/davidmikulis/neuro-pilot-ai

# Install dependencies (if not done)
npm install express-rate-limit sqlite3

# Set secret
export TRADINGVIEW_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Start server
node simple_webhook_server.js
```

**Keep this terminal open!**

---

### Terminal 2: Run Tests

```bash
cd /Users/davidmikulis/neuro-pilot-ai

# Set the same secret
export TRADINGVIEW_WEBHOOK_SECRET=$(grep TRADINGVIEW_WEBHOOK_SECRET .env | cut -d'=' -f2 || echo "test-secret-$(date +%s)")

# Run automated tests
./test_system.sh
```

---

## 📊 What Gets Tested

The automated test suite (`test_system.sh`) verifies:

1. **Health Check** - Server responds (200)
2. **Account Summary** - Account API works (200)
3. **Authentication** - Invalid signatures rejected (401)
4. **Validation** - Missing fields rejected (400)
5. **Valid Request** - Correct requests execute (200)
6. **Deduplication** - Duplicate alerts rejected (409)
7. **Paper Trading** - Orders execute successfully

---

## ✅ Expected Results

### Successful Test Run:

```
🧪 Trading System Test Suite
============================
Base URL: http://localhost:3014

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

### "Connection refused"
- **Fix:** Start server in Terminal 1: `node simple_webhook_server.js`

### "Module not found"
- **Fix:** Run `npm install express-rate-limit sqlite3`

### "401 Unauthorized" on valid request
- **Fix:** Ensure `TRADINGVIEW_WEBHOOK_SECRET` is set in both terminals

### "Port already in use"
- **Fix:** 
  ```bash
  lsof -i :3014  # Find process
  kill <PID>     # Kill it
  ```

---

## 🎉 After Tests Pass

1. **Verify account:**
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

---

## 📚 Full Documentation

- **`RUN_TESTS.md`** - Detailed step-by-step guide
- **`TESTING_GUIDE.md`** - Manual testing instructions
- **`QUICK_START.md`** - Quick reference

---

**Ready?** Run `./setup_and_test.sh` to get started!



