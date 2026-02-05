# Test Commands for Paper State Rebuild

## 1. Kill Server (Correct Command)

```bash
# Kill process on port 3001
lsof -ti :3001 | xargs kill -9

# Or if that fails, find and kill manually:
ps aux | grep simple_webhook_server.js | grep -v grep | awk '{print $2}' | xargs kill -9
```

## 2. Reset State File

```bash
rm -f data/paper_trading_state.json
```

## 3. Restart Server

```bash
node simple_webhook_server.js
```

## 4. Test A: Clean Rebuild

```bash
curl -s http://localhost:3001/health | grep -E '"openPositions"|"totalTrades"|"balance"|"tradingEnabled"'
```

**Expected Output:**
- `"openPositions": 0`
- `"totalTrades": 0`
- `"tradingEnabled": false`
- `"balance": <ACCOUNT_BALANCE>`

## 5. Test B: XAUUSD Webhook-Only

```bash
curl -s -X POST http://localhost:3001/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{"symbol":"OANDA:XAUUSD","action":"BUY","price":2050,"quantity":0.1,"alert_id":"test_xau_1","timestamp":1738230000,"secret":"[DEV_SECRET_PLACEHOLDER]"}'
```

**Expected:**
- HTTP 200 response
- Log shows: `ℹ️ TradingView-only symbol detected (OANDA:XAUUSD)`
- Log shows: `ALERT_ONLY` status
- No Binance API errors
- Trade logged in ledger but not executed

## 6. Verify .env Settings

```bash
grep -E "^TRADING_ENABLED|^PAPER_STATE_REBUILD_ON_BOOT|^PAPER_STATE_RESET_ON_BOOT|^TRADINGVIEW_WEBHOOK_SECRET" .env
```

**Expected:**
```
TRADING_ENABLED=false
PAPER_STATE_REBUILD_ON_BOOT=true
PAPER_STATE_RESET_ON_BOOT=false
TRADINGVIEW_WEBHOOK_SECRET=[DEV_SECRET_PLACEHOLDER]
```

## 7. Check Server Logs for Rebuild Message

After restart, look for:
```
🔁 Rebuilt paper state from ledger: trades=X positions=Y cash=$Z
```

Or if no trades:
```
🔁 Rebuilt paper state: no executed trades found (clean state)
```

