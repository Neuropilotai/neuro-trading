# Quick Test Guide

## 🚀 Fastest Way to Test

### Option 1: Auto-Start Server + Test (Recommended)

```bash
cd /Users/davidmikulis/neuro-pilot-ai
./start_server_and_test.sh
```

This will:
- ✅ Start the server automatically
- ✅ Wait for it to be ready
- ✅ Run all tests
- ✅ Show you the results

---

### Option 2: Manual (Two Terminals)

**Terminal 1 - Start Server:**
```bash
cd /Users/davidmikulis/neuro-pilot-ai
export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
node simple_webhook_server.js
```

**Terminal 2 - Run Tests:**
```bash
cd /Users/davidmikulis/neuro-pilot-ai
export TRADINGVIEW_WEBHOOK_SECRET=[YOUR_TRADINGVIEW_WEBHOOK_SECRET]
./test_system.sh
```

---

## ✅ What Success Looks Like

You should see:
```
🧪 Trading System Test Suite
============================
...
✅ PASS (Status: 200)
✅ PASS (Status: 401)
✅ PASS (Status: 400)
✅ PASS (Status: 409)
...
============================
Test Summary
============================
Passed: 8
Failed: 0

✅ All tests passed!
```

---

## 🎯 Try It Now

Run this single command:

```bash
cd /Users/davidmikulis/neuro-pilot-ai && ./start_server_and_test.sh
```

That's it! The script handles everything.


