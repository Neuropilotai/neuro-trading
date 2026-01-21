# Running the Test Suite - Step by Step

## 🎯 Quick Start

### Option 1: One-Command Test (Easiest)

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./run_tests_now.sh
```

This script will:
- ✅ Auto-detect your secret from `.env` or use the default
- ✅ Check if server is running
- ✅ Run all tests automatically

---

### Option 2: Manual Test Run

**Step 1: Set the secret**
```bash
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
```

**Step 2: Run tests**
```bash
cd /Users/davidmikulis/neuro-pilot-ai
./test_system.sh
```

---

## 📋 What the Tests Do

The test suite (`test_system.sh`) runs 7 test categories:

1. **Health Check** - Verifies server is running (200)
2. **Account Summary** - Tests account API (200)
3. **Authentication** - Tests invalid/missing signatures (401)
4. **Valid Request** - Tests correct request with valid signature (200)
5. **Validation** - Tests missing required fields (400)
6. **Deduplication** - Tests duplicate alert rejection (409)
7. **Rate Limiting** - Manual test (send 11+ requests)

---

## ✅ Expected Output

When tests pass, you'll see:

```
🧪 Trading System Test Suite
============================
Base URL: http://localhost:3014
Secret: 11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784

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

7️⃣  Rate Limiting Test
⚠️  Manual test required - Send 11+ requests quickly to test rate limit

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
- **Fix:** Start server: `node simple_webhook_server.js`

### Test fails: "401 Unauthorized" on valid request
- **Problem:** Secret mismatch
- **Fix:** Ensure `TRADINGVIEW_WEBHOOK_SECRET` matches in both terminals

### Test fails: "openssl not available"
- **Problem:** openssl not installed
- **Fix:** Install openssl or use `run_tests_now.sh` which handles this

### Test hangs on "Invalid Signature"
- **Problem:** Server might be slow or curl is waiting
- **Fix:** Wait a few seconds, or press Ctrl+C and check server logs

---

## 🔍 After Tests Pass

Once all tests pass, verify the system worked:

### 1. Check Account Was Updated
```bash
curl http://localhost:3014/api/account | jq '.'
```

**Expected:** Balance should be less than $100,000 if a trade executed

### 2. Check Trade Ledger
```bash
sqlite3 ./data/trade_ledger.db "SELECT trade_id, symbol, action, quantity, price, status, created_at FROM trades ORDER BY created_at DESC LIMIT 5;"
```

**Expected:** Should see trade records with status: FILLED

### 3. Check Positions
```bash
curl http://localhost:3014/api/account | jq '.positions'
```

**Expected:** Should show open positions if trades executed

---

## 🚀 Ready to Test?

Run this command:

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./run_tests_now.sh
```

Or manually:

```bash
export TRADINGVIEW_WEBHOOK_SECRET=11703bfc4ecb43b4307c8a82bcc0f8c01eb5eb3959933d6b7623868850c88784
./test_system.sh
```

---

**The server is running and ready!** The tests should complete successfully. 🎉



